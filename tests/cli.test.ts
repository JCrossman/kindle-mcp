import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { main } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { saveSession } from "../src/notebook/session.js";
import { Store } from "../src/store.js";
import { startFakeAmazon, type FakeAmazon } from "./helpers/fake-amazon.js";

const FX = join(__dirname, "fixtures");

let amazon: FakeAmazon;
let base = "";
const seenCookies: string[] = [];
let redirects = 0;

beforeAll(async () => {
  amazon = await startFakeAmazon();
  base = amazon.base;
});
afterAll(() => amazon.close());
const sync = (): void => {
  seenCookies.splice(0, seenCookies.length, ...amazon.seenCookies);
  redirects = amazon.redirects;
};

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kindle-cli-"));
  vi.stubEnv("KINDLE_MCP_HOME", home);
  vi.stubEnv("KINDLE_NOTEBOOK_BASE", base);
  vi.stubEnv("KINDLE_REQUEST_DELAY", "0");
  mkdirSync(join(home, "vault"));
  vi.stubEnv("OBSIDIAN_VAULT", join(home, "vault"));
  vi.stubEnv("KINDLE_ON_PENDING", "");
  return home;
}

const hook = (out: string): string => `node -e "require('fs').writeFileSync(process.argv[1], String(process.env.KINDLE_PENDING))" "${out}"`;

describe("kindle-mcp CLI", () => {
  it("syncs over plain HTTP with saved cookies, then runs the --on-pending hook", async () => {
    const home = freshHome();
    const cfg = loadConfig();
    saveSession(cfg.sessionPath, { savedAt: "t", cookies: [{ name: "session-id", value: "abc", domain: "127.0.0.1", path: "/", expires: -1 }] });
    const out = join(home, "hook.txt");

    expect(await main(["sync", "--export", "--on-pending", hook(out)])).toBe(0);
    sync();
    expect(readFileSync(out, "utf8")).toBe("1"); // one highlight carries @post @project; @project was filed, @post is left
    expect(seenCookies.at(-1)).toContain("session-id=abc");
    expect(redirects).toBeGreaterThan(0); // benign redirects are followed, not reported as sign-in
    expect(existsSync(join(home, "vault", "Kindle", "Thinking, Fast and Slow.md"))).toBe(true);
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
    saveSession(cfg.sessionPath, { savedAt: "t", cookies: [{ name: "session-id", value: "wrong", domain: "127.0.0.1", path: "/", expires: -1 }] });
    expect(await main(["sync"])).toBe(1);
    const store = new Store(cfg.dbPath);
    expect(store.status().last_run?.error).toMatch(/kindle-mcp login/);
    store.close();
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
