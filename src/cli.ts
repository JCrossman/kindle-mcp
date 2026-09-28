#!/usr/bin/env node
/**
 * Command line: the scheduled job and the one-time login both live here.
 *
 *   kindle-mcp login                      open a browser, sign in to Amazon once
 *   kindle-mcp sync [--full] [--book X]   pull the cloud notebook (plain HTTP with saved cookies), then
 *              [--browser] [--no-export]  update the Obsidian vault if one is set
 *              [--on-pending CMD]
 *   kindle-mcp import-clippings PATH      merge a My Clippings.txt from the device
 *   kindle-mcp export [--book X]          update the Obsidian vault without contacting Amazon
 *   kindle-mcp link-existing [--apply]    preview (or apply) links in highlights exported before
 *              [--book X] [--always|--never]
 *   kindle-mcp status                     counts, pending @commands, last run
 *   kindle-mcp config [set KEY VALUE]     the settings file every client reads (vault, folder, ...)
 *              [unset KEY]
 *   kindle-mcp doctor [--asin X|--book T] dump live HTML to debug selectors
 *   kindle-mcp prompt NAME [--tag X]      print a router prompt (route-pending | weekly-brief) for any runner
 *              [--dry-run] [--since 7d]
 *   kindle-mcp serve                      run the MCP server over stdio
 */
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ensureDirs, expand, loadConfig, parseOnOff, SETTING_ENV, settingValue, vaultProblem, writeSettingsFile,
  type Config, type SettingKey,
} from "./config.js";
import { normalizeFolder } from "./vault/write.js";
import { quietExperimentalWarnings } from "./warnings.js";

quietExperimentalWarnings();

const USAGE = `kindle-mcp <command> [options]

  login                                  open a browser, sign in to Amazon once
  sync [--full] [--book X] [--browser]   pull the cloud notebook; --browser forces Playwright; then, with
       [--no-export] [--on-pending CMD]  OBSIDIAN_VAULT set, add new highlights and file @todo/@quote/@project
                                         (--no-export skips that); --on-pending runs CMD if @commands are left
  import-clippings PATH                  merge a My Clippings.txt from the device
  export [--book X]                      update the vault without contacting Amazon (needs OBSIDIAN_VAULT)
  link-existing [--apply] [--book X]     preview links for highlights exported before; --apply writes them;
                [--always | --never]     --always also links future matches, --never stops the question
  status                                 counts, pending @commands, last run
  config                                 settings in effect, where each comes from, and the settings file
  config set KEY VALUE                   save one in the settings file every client reads, e.g.
                                         config set vault ~/Documents/Notes (must be an Obsidian vault)
  config unset KEY                       keys: vault, folder, act_on_commands, auto_file, link_notes,
                                         link_exclude, browser_path
  doctor [--asin X | --book TITLE]       dump live HTML to ~/.kindle-mcp and report what the parser finds
  prompt route-pending [--tag X] [--dry-run]
  prompt weekly-brief [--since 7d]       print a router prompt, e.g. claude -p "$(kindle-mcp prompt route-pending)"
  serve                                  run the MCP server over stdio
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      full: { type: "boolean", default: false },
      book: { type: "string" },
      tag: { type: "string" },
      asin: { type: "string" },
      browser: { type: "boolean", default: false },
      export: { type: "boolean", default: false }, // 1.0 flag; the vault step now runs whenever a vault is set
      "no-export": { type: "boolean", default: false },
      apply: { type: "boolean", default: false },
      always: { type: "boolean", default: false },
      never: { type: "boolean", default: false },
      "on-pending": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      since: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  if (cmd === "prompt") {
    const { routePendingPrompt, weeklyBriefPrompt } = await import("./server.js");
    const which = positionals[1];
    if (which === "route-pending") process.stdout.write(routePendingPrompt(values.tag, values["dry-run"]));
    else if (which === "weekly-brief") process.stdout.write(weeklyBriefPrompt(values.since || "7d"));
    else {
      process.stderr.write("prompt needs a name: route-pending | weekly-brief\n");
      return 2;
    }
    return 0;
  }

  const cfg = loadConfig();
  ensureDirs(cfg);

  if (cmd === "config") return configCommand(cfg, positionals.slice(1));

  if (cmd === "serve") {
    const { serveStdio } = await import("./server.js");
    await serveStdio(cfg);
    return 0;
  }
  if (cmd === "login") {
    const { login } = await import("./notebook/login.js");
    console.log(
      'A browser window will open. Sign in to Amazon and tick "Keep me signed in" (it lets later syncs renew the ' +
        "sign-in without you); the window closes itself when your notebook loads.",
    );
    const ok = await login(cfg);
    console.log(ok ? `Logged in. Session saved to ${cfg.sessionPath}.` : "Timed out waiting for login.");
    return ok ? 0 : 1;
  }
  if (cmd === "doctor") return doctor(cfg, values.asin ?? null, values.book ?? null, values.browser);

  const { Store } = await import("./store.js");
  const store = new Store(cfg.dbPath);
  try {
    if (cmd === "sync") {
      const { syncCloud } = await import("./sync.js");
      const { AuthRequired } = await import("./notebook/client.js");
      let signIn: string | null = null;
      try {
        const stats = await syncCloud(cfg, store, { full: values.full, only: values.book ?? null, browser: values.browser });
        console.log(JSON.stringify(stats));
      } catch (e) {
        if (!(e instanceof AuthRequired)) throw e;
        signIn = e.message; // the vault and the queue need no Amazon: finish those, then report it
      }
      if (cfg.obsidianVault && !values["no-export"]) await updateVault(cfg, store, null);
      const hook = values["on-pending"] ?? cfg.onPending;
      const pending = store.status().pending_commands;
      if (hook && pending > 0) {
        console.error(`${pending} highlight(s) with pending @commands; running: ${hook}`);
        const res = spawnSync(hook, { shell: true, stdio: "inherit", env: { ...process.env, KINDLE_PENDING: String(pending) } });
        if (res.status !== 0) {
          console.error(`ERROR: --on-pending command exited with ${res.status ?? "signal"}`);
          return res.status ?? 1;
        }
      }
      if (signIn) {
        console.error(`ERROR: ${signIn}`);
        return 1;
      }
    } else if (cmd === "import-clippings") {
      if (!positionals[1]) throw new Error("import-clippings needs the path to My Clippings.txt");
      const { importClippings } = await import("./sync.js");
      importClippings(store, positionals[1]);
      if (cfg.obsidianVault && !values["no-export"]) await updateVault(cfg, store, null);
    } else if (cmd === "export") {
      if (!cfg.obsidianVault) throw new Error("Set OBSIDIAN_VAULT to your vault path first.");
      if (values.book && !store.findBook(values.book)) throw new Error(`No book matches '${values.book}'.`);
      return (await updateVault(cfg, store, values.book ?? null)) ? 0 : 1;
    } else if (cmd === "link-existing") {
      return await linkExisting(cfg, store, values.book ?? null, values.apply, values.always ? "always" : values.never ? "never" : null);
    } else if (cmd === "status") {
      console.log(JSON.stringify(store.status(), null, 2));
    } else {
      process.stderr.write(`Unknown command '${cmd}'.\n\n${USAGE}`);
      return 2;
    }
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`); // actionable message, non-zero exit for cron
    return 1;
  } finally {
    store.close();
  }
  return 0;
}

async function doctor(cfg: Config, asin: string | null, bookTitle: string | null, browser: boolean): Promise<number> {
  const { NotebookClient } = await import("./notebook/client.js");
  const { openFetcher } = await import("./notebook/fetchers.js");
  const { parseAnnotations, parseLibrary } = await import("./notebook/parser.js");
  const handle = await openFetcher(cfg, browser);
  try {
    const nb = new NotebookClient(handle.fetch, cfg.notebookBase, cfg.requestDelayMs);
    if (bookTitle && !asin) {
      const hits = (await nb.library()).filter((b) => b.title.toLowerCase().includes(bookTitle.toLowerCase()));
      if (!hits.length) {
        console.log(`No library book matches '${bookTitle}'.`);
        return 1;
      }
      asin = hits[0].asin;
      console.log(`Resolved '${hits[0].title}' -> ${asin}`);
    }
    const html = await nb.dump(asin);
    const out = join(cfg.home, asin ? "doctor-annotations.html" : "doctor-library.html");
    writeFileSync(out, html, "utf8");
    const found = asin ? parseAnnotations(html, asin)[0].length : parseLibrary(html)[0].length;
    console.log(`Saved ${out}\nParser found ${found} ${asin ? "annotations" : "books"} with current selectors.`);
    return 0;
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    return 1;
  } finally {
    await handle.close();
  }
}

type StoreT = InstanceType<typeof import("./store.js").Store>;

/** The vault step; prints its summary. False when the vault could not be written. */
async function updateVault(cfg: Config, store: StoreT, book: string | null): Promise<boolean> {
  const { runVaultStep } = await import("./vault/run.js");
  const r = runVaultStep(cfg, store, { restoreBook: book });
  console.log(JSON.stringify({ obsidian: r }));
  if (r.error) console.error(`ERROR: ${r.error}`);
  else if (r.skipped) console.error(`Vault not updated this time (${r.skipped}); the next run continues.`);
  return !r.error;
}

async function linkExisting(cfg: Config, store: StoreT, book: string | null, apply: boolean, remember: "always" | "never" | null): Promise<number> {
  if (!cfg.obsidianVault) throw new Error("Set OBSIDIAN_VAULT to your vault path first.");
  const { applyBackfill, planBackfill } = await import("./vault/backfill.js");
  const { openVault, setLinkExistingPreference, withVaultLease } = await import("./vault/run.js");
  const open = openVault(cfg, store);
  try {
    const out = withVaultLease(store, () => {
      if (remember) setLinkExistingPreference(store, open.ctx.vault, remember);
      if (apply) return { applied: applyBackfill(open.ctx, book) };
      const { blocks, links, samples } = planBackfill(open.ctx, book);
      return { preview: { blocks, links, samples }, next: "Run again with --apply to write these links." };
    });
    if (out === "busy") throw new Error("Another kindle-mcp process is writing to the vault; try again in a minute.");
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } finally {
    open.close();
  }
}

function invokedDirectly(): boolean {
  // Works through npm's bin symlinks and on Windows: compare real paths, not URLs.
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ERROR: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}

/** `kindle-mcp config [set KEY VALUE | unset KEY]`: the settings file every client reads. */
function configCommand(cfg: Config, args: string[]): number {
  // Declared in here: main() runs while this module is still loading, before later top-level consts exist.
  const aliases: Record<string, SettingKey> = { vault: "obsidian_vault", folder: "obsidian_folder" };
  const [action, rawKey = "", ...rest] = args;
  const keys = Object.keys(SETTING_ENV) as SettingKey[];
  if (!action) {
    const settings = Object.fromEntries(keys.map((k) => [k, { value: settingValue(cfg, k), from: cfg.sources[k] }]));
    console.log(JSON.stringify({ settings_file: cfg.settingsPath, settings }, null, 2));
    return 0;
  }
  const key = aliases[rawKey] ?? (rawKey as SettingKey);
  const raw = rest.join(" ").trim();
  if (!keys.includes(key) || !(action === "unset" || (action === "set" && raw))) {
    process.stderr.write(`Usage: kindle-mcp config [set KEY VALUE | unset KEY]. Keys: vault, folder, ${keys.slice(2).join(", ")}.\n`);
    return 2;
  }
  if (action === "unset") {
    writeSettingsFile(cfg.settingsPath, { [key]: null });
    console.log(`Removed ${key} from ${cfg.settingsPath}.`);
    return 0;
  }
  let value: string | boolean | string[];
  if (key === "obsidian_vault") {
    const problem = vaultProblem(raw);
    if (problem) {
      console.error(`ERROR: ${problem}`);
      return 1;
    }
    value = expand(raw);
  } else if (key === "obsidian_folder") value = normalizeFolder(raw);
  else if (key === "browser_path") value = expand(raw);
  else if (key === "link_exclude") value = raw.split(",").map((s) => s.trim()).filter(Boolean);
  else {
    const on = parseOnOff(raw);
    if (on === null) {
      console.error(`ERROR: ${key} takes true or false.`);
      return 2;
    }
    value = on;
  }
  writeSettingsFile(cfg.settingsPath, { [key]: value });
  const shadowed = cfg.sources[key] === "environment" ? ` ${SETTING_ENV[key]} is set here and still wins over it.` : "";
  console.log(`Saved ${key} in ${cfg.settingsPath}.${shadowed}`);
  return 0;
}
