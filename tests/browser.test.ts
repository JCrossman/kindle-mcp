/**
 * The browser paths end to end: headless login against a local stand-in for Amazon, then a
 * `--browser` sync through the same browser. Skipped when no Chromium-based browser can launch
 * (set KINDLE_BROWSER_PATH, or install Chrome/Edge).
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { launchContext } from "../src/notebook/fetchers.js";
import { login } from "../src/notebook/login.js";
import { Store } from "../src/store.js";
import { syncCloud } from "../src/sync.js";

const FX = join(__dirname, "fixtures");

async function browserAvailable(): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), "kindle-probe-"));
  try {
    const ctx = await launchContext(dir, true, process.env.KINDLE_BROWSER_PATH ?? null);
    await ctx.close();
    return true;
  } catch {
    return false;
  }
}
const available = await browserAvailable();

let server: Server;
let base = "";
beforeAll(async () => {
  server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const asin = url.searchParams.get("asin");
    const body = asin === "B0FAKE0004" ? readFileSync(join(FX, "annotations.html"))
      : asin ? '<html><body><input type="hidden" class="kp-notebook-annotations-next-page-start" value=""></body></html>'
      : readFileSync(join(FX, "library.html"));
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session-id=from-browser; Path=/" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe.skipIf(!available)("browser paths", () => {
  it("login (headless here) waits for the library and saves the session cookies", async () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-browser-"));
    const cfg = loadConfig({ KINDLE_MCP_HOME: home, KINDLE_NOTEBOOK_BASE: base, KINDLE_BROWSER_PATH: process.env.KINDLE_BROWSER_PATH });
    expect(await login(cfg, 30_000, true)).toBe(true);
    expect(existsSync(cfg.sessionPath)).toBe(true);
    const session = JSON.parse(readFileSync(cfg.sessionPath, "utf8"));
    expect(session.cookies.some((c: { name: string; value: string }) => c.name === "session-id" && c.value === "from-browser")).toBe(true);
  }, 60_000);

  it("sync --browser reads the notebook through a real browser", async () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-browser-"));
    const cfg = loadConfig({ KINDLE_MCP_HOME: home, KINDLE_NOTEBOOK_BASE: base, KINDLE_REQUEST_DELAY: "0", KINDLE_BROWSER_PATH: process.env.KINDLE_BROWSER_PATH });
    const store = new Store(cfg.dbPath);
    const stats = await syncCloud(cfg, store, { browser: true, log: () => {} });
    expect(stats).toEqual({ books_seen: 2, books_synced: 2, highlights_new: 3, highlights_updated: 0 });
    expect(store.status().last_run?.source).toBe("cloud");
    store.close();
  }, 60_000);
});
