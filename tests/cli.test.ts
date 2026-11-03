import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { saveSignedIn, startFakeAmazon, type FakeAmazon } from "./helpers/fake-amazon.js";

const FX = join(__dirname, "fixtures");

let amazon: FakeAmazon;
beforeAll(async () => {
  amazon = await startFakeAmazon();
});
afterAll(() => amazon.close());

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kindle-cli-"));
  vi.stubEnv("KINDLE_MCP_HOME", home);
  vi.stubEnv("KINDLE_NOTEBOOK_BASE", amazon.base);
  vi.stubEnv("KINDLE_REQUEST_DELAY", "0");
  mkdirSync(join(home, "vault"));
  vi.stubEnv("OBSIDIAN_VAULT", join(home, "vault"));
  return home;
}

const hook = (out: string): string => `node -e "require('fs').writeFileSync(process.argv[1], String(process.env.KINDLE_PENDING))" "${out}"`;

describe("kindle-mcp CLI", () => {
  it("prints counts, not titles, notes or tags, unless --verbose; a deleted book note included", async () => {
    const home = freshHome();
    saveSignedIn(loadConfig().sessionPath);
    const quiet = vi.spyOn(console, "log").mockImplementation(() => {});
    const errs = vi.spyOn(console, "error").mockImplementation(() => {});
    const both = () => [...quiet.mock.calls, ...errs.mock.calls].map((c) => String(c[0])).join("\n");
    expect(await main(["sync"])).toBe(0);
    rmSync(join(home, "vault", "Kindle", "Placeholder Title, Part One.md")); // deleted in Obsidian: left deleted
    quiet.mockClear();
    errs.mockClear();
    expect(await main(["sync"])).toBe(0);
    const plain = both();
    expect(plain).toContain('"deleted_book_notes":1');
    expect(plain).not.toMatch(/Placeholder Title|garden/);
    quiet.mockClear();
    errs.mockClear();
    expect(await main(["sync", "--verbose"])).toBe(0);
    expect(both()).toContain("Placeholder Title, Part One");
    quiet.mockRestore();
    errs.mockRestore();
  });
  it("syncs over plain HTTP with saved cookies, then runs the --on-pending hook", async () => {
    const home = freshHome();
    const cfg = loadConfig();
    saveSignedIn(cfg.sessionPath);
    const out = join(home, "hook.txt");

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["sync", "--export", "--on-pending", hook(out)])).toBe(0);
    const log = logged.mock.calls.map((c) => String(c[0])).join("\n");
    logged.mockRestore();
    expect(log).toMatch(/book 1 of 2: \d+ annotations/); // the log counts books and never names them
    expect(log).not.toContain("Placeholder Title");
    expect(readFileSync(out, "utf8")).toBe("1"); // one highlight carries @post @project; @project was filed, @post is left
    expect(amazon.seenCookies.at(-1)).toContain("session-id=abc");
    expect(amazon.redirects).toBeGreaterThan(0); // benign redirects are followed, not reported as sign-in
    expect(existsSync(join(home, "vault", "Kindle", "Placeholder Title, Part One.md"))).toBe(true);
    const session = JSON.parse(readFileSync(cfg.sessionPath, "utf8"));
    expect(session.cookies.some((c: { name: string; value: string }) => c.name === "session-token" && c.value === "rotated")).toBe(true); // Set-Cookie written back

    let store = new Store(cfg.dbPath);
    expect(store.status().highlights).toBe(3);
    expect(store.status().last_run?.source).toBe("cloud");
    store.close();

    // Second sync: unchanged books are skipped, the queue is still pending, a failing hook fails the run.
    expect(await main(["sync", "--on-pending", "exit 3"])).toBe(3);
    store = new Store(cfg.dbPath);
    expect(store.status().last_run?.books_synced).toBe(0);
    store.markCommandsDone(store.pendingCommands()[0].id);
    store.close();

    // Nothing pending: the hook does not run.
    const out2 = join(home, "hook2.txt");
    expect(await main(["sync", "--on-pending", hook(out2)])).toBe(0);
    expect(existsSync(out2)).toBe(false);
  });

  it("reports an expired session as an actionable error", async () => {
    freshHome();
    expect(await main(["sync"])).toBe(1); // no session.json at all
    const cfg = loadConfig();
    saveSignedIn(cfg.sessionPath, "wrong");
    expect(await main(["sync"])).toBe(1);
    const store = new Store(cfg.dbPath);
    expect(store.status().last_run?.error).toMatch(/kindle-mcp login/);
    store.close();
  });

  it("keeps settings in the settings file with config set/unset", async () => {
    const home = freshHome();
    vi.stubEnv("OBSIDIAN_VAULT", "");
    const notes = join(home, "Notes");
    mkdirSync(notes);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["config", "set", "vault", notes])).toBe(1); // not a vault yet
    expect(err.mock.calls.at(-1)?.[0]).toMatch(/isn't an Obsidian vault/);
    mkdirSync(join(notes, ".obsidian"));
    expect(await main(["config", "set", "vault", notes])).toBe(0);
    expect(await main(["config", "set", "act_on_commands", "no"])).toBe(0);
    expect(await main(["config", "set", "link_exclude", "Journal, Private"])).toBe(0);
    expect(await main(["config", "set", "auto_file", "maybe"])).toBe(2);
    expect(await main(["config", "set", "colour", "blue"])).toBe(2);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toEqual({
      obsidian_vault: notes, act_on_commands: false, link_exclude: ["Journal", "Private"],
    });
    const cfg = loadConfig();
    expect([cfg.obsidianVault, cfg.actOnCommands, cfg.sources.obsidian_vault]).toEqual([notes, false, "config file"]);
    expect(await main(["config"])).toBe(0);
    expect(JSON.parse(out.mock.calls.at(-1)?.[0]).settings.obsidian_vault).toEqual({ value: notes, from: "config file" });
    expect(await main(["config", "unset", "act_on_commands"])).toBe(0);
    expect(loadConfig().actOnCommands).toBe(true);
    err.mockRestore();
    out.mockRestore();
  });

  it("runs config as a real process (main starts while the module is still loading)", () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-proc-"));
    const vault = join(home, "Notes");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(__dirname, "..", "src", "cli.ts"), ...args], {
        cwd: join(__dirname, ".."),
        env: { ...process.env, KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: "" },
        encoding: "utf8",
      });
    const set = run("config", "set", "vault", vault);
    expect(set.status, set.stderr).toBe(0);
    expect(JSON.parse(run("config").stdout).settings.obsidian_vault).toEqual({ value: vault, from: "config file" });
  });

  it("imports clippings, prints status and exports", async () => {
    const home = freshHome();
    expect(await main(["import-clippings", join(FX, "My Clippings.txt")])).toBe(0);
    expect(await main(["status"])).toBe(0);
    expect(await main(["export"])).toBe(0);
    expect(existsSync(join(home, "vault", "Kindle", "A Sideloaded PDF.md"))).toBe(true);
    expect(await main(["export", "--book", "nothing like this"])).toBe(1);
    expect(await main(["bogus"])).toBe(2);
    expect(await main(["--help"])).toBe(0);
    expect(await main([])).toBe(2);
  });

  it("prints the router prompts for any runner", async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      expect(await main(["prompt", "route-pending", "--tag", "todo", "--dry-run"])).toBe(0);
      expect(chunks.join("")).toContain("`tag` = `todo`");
      expect(chunks.join("")).toContain("DRY RUN");
      chunks.length = 0;
      expect(await main(["prompt", "weekly-brief", "--since", "30d"])).toBe(0);
      expect(chunks.join("")).toContain("`30d`");
      expect(await main(["prompt", "nope"])).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
