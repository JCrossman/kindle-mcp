#!/usr/bin/env node
/**
 * Command line: the scheduled job and the one-time login both live here.
 *
 *   kindle-mcp login                      open a browser, sign in to Amazon once
 *   kindle-mcp sync [--full] [--book X]   pull the cloud notebook (plain HTTP with saved cookies)
 *              [--browser] [--export] [--on-pending CMD]
 *   kindle-mcp import-clippings PATH      merge a My Clippings.txt from the device
 *   kindle-mcp export [--book X]          write/append Obsidian notes
 *   kindle-mcp status                     counts, pending @commands, last run
 *   kindle-mcp doctor [--asin X|--book T] dump live HTML to debug selectors
 *   kindle-mcp serve                      run the MCP server over stdio
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { ensureDirs, loadConfig, type Config } from "./config.js";

// node:sqlite still emits an ExperimentalWarning on Node 22. Keep it out of cron logs and stdio.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
  if (type === "ExperimentalWarning" || (warning as Error)?.name === "ExperimentalWarning") return;
  (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const USAGE = `kindle-mcp <command> [options]

  login                                  open a browser, sign in to Amazon once
  sync [--full] [--book X] [--browser]   pull the cloud notebook; --browser forces Playwright
       [--export] [--on-pending CMD]     --export appends to Obsidian; --on-pending runs CMD if @commands are pending
  import-clippings PATH                  merge a My Clippings.txt from the device
  export [--book X]                      write/append Obsidian notes (needs OBSIDIAN_VAULT)
  status                                 counts, pending @commands, last run
  doctor [--asin X | --book TITLE]       dump live HTML to ~/.kindle-mcp and report what the parser finds
  serve                                  run the MCP server over stdio
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      full: { type: "boolean", default: false },
      book: { type: "string" },
      asin: { type: "string" },
      browser: { type: "boolean", default: false },
      export: { type: "boolean", default: false },
      "on-pending": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const cmd = positionals[0];
  if (values.help || !cmd) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 2;
  }

  const cfg = loadConfig();
  ensureDirs(cfg);

  if (cmd === "serve") {
    const { serveStdio } = await import("./server.js");
    await serveStdio(cfg);
    return 0;
  }
  if (cmd === "login") {
    const { login } = await import("./notebook/login.js");
    console.log("A browser window will open. Sign in to Amazon; this window closes itself when your notebook loads.");
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
      const stats = await syncCloud(cfg, store, { full: values.full, only: values.book ?? null, browser: values.browser });
      console.log(JSON.stringify(stats));
      if (values.export) await exportNotes(cfg, store, null);
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
    } else if (cmd === "import-clippings") {
      if (!positionals[1]) throw new Error("import-clippings needs the path to My Clippings.txt");
      const { importClippings } = await import("./sync.js");
      importClippings(store, positionals[1]);
    } else if (cmd === "export") {
      await exportNotes(cfg, store, values.book ?? null);
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

async function exportNotes(cfg: Config, store: InstanceType<typeof import("./store.js").Store>, book: string | null): Promise<void> {
  const { exportAll, exportBook } = await import("./obsidian.js");
  if (!cfg.obsidianVault) throw new Error("Set OBSIDIAN_VAULT to your vault path first.");
  const results = book ? [exportBook(store, book, cfg.obsidianVault, cfg.obsidianFolder)] : exportAll(store, cfg.obsidianVault, cfg.obsidianFolder);
  console.log(`Exported ${results.length} book(s), ${results.reduce((n, r) => n + r.added, 0)} new highlight(s).`);
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`ERROR: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
