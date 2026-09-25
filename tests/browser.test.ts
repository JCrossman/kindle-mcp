/**
 * The browser paths end to end: headless login against a local stand-in for Amazon, a `--browser`
 * sync through the same browser, and a stale sign-in renewed from the saved profile. Skipped when
 * no Chromium-based browser can launch (set KINDLE_BROWSER_PATH, or install Chrome/Edge).
 */
import { createServer as createHttpServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { AuthRequired } from "../src/notebook/client.js";
import { launchContext } from "../src/notebook/fetchers.js";
import { login } from "../src/notebook/login.js";
import { loadSession } from "../src/notebook/session.js";
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

/**
 * A stand-in with Amazon's shape of sign-in: a short-lived token cookie, a long-lived "remember
 * me" cookie, and a sign-in page that sends a remembered browser straight back with a new token.
 */
async function startSignInAmazon() {
  const state = { valid: "t1", remembered: true, userSignsIn: true };
  const srv = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cookies = req.headers.cookie ?? "";
    if (url.pathname === "/ap/signin") {
      if (state.remembered && cookies.includes("remember=yes")) {
        res.writeHead(302, { Location: "/notebook", "Set-Cookie": `token=${state.valid}; Path=/` }).end();
      } else {
        // A password form; in the first login the "user" submits it at once.
        const submit = state.userSignsIn ? "<script>location.href = '/ap/do-signin'</script>" : "";
        res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><body><form name="signIn"><input type="password"></form>${submit}</body></html>`);
      }
      return;
    }
    if (url.pathname === "/ap/do-signin") {
      res.writeHead(302, {
        Location: "/notebook",
        "Set-Cookie": [`token=${state.valid}; Path=/`, "remember=yes; Max-Age=86400; Path=/"],
      }).end();
      return;
    }
    if (!cookies.includes(`token=${state.valid}`)) {
      res.writeHead(302, { Location: "/ap/signin" }).end();
      return;
    }
    const asin = url.searchParams.get("asin");
    const body = asin === "B0FAKE0004" ? readFileSync(join(FX, "annotations.html"))
      : asin ? '<html><body><input type="hidden" class="kp-notebook-annotations-next-page-start" value=""></body></html>'
      : readFileSync(join(FX, "library.html"));
    res.writeHead(200, { "Content-Type": "text/html" }).end(body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  return {
    state,
    base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

describe.skipIf(!available)("renewing a stale sign-in", () => {
  it("renews it from the saved browser profile without a window, and says so when Amazon wants the password", async () => {
    const amazon = await startSignInAmazon();
    try {
      const home = mkdtempSync(join(tmpdir(), "kindle-renew-"));
      const cfg = loadConfig({ KINDLE_MCP_HOME: home, KINDLE_NOTEBOOK_BASE: amazon.base, KINDLE_REQUEST_DELAY: "0", KINDLE_BROWSER_PATH: process.env.KINDLE_BROWSER_PATH });
      expect(await login(cfg, 30_000, true)).toBe(true);
      const store = new Store(cfg.dbPath);
      expect(await syncCloud(cfg, store, { log: () => {} })).not.toHaveProperty("session_refreshed");

      amazon.state.valid = "t2"; // the short-lived token expires; Amazon still remembers the browser
      const renewed = await syncCloud(cfg, store, { full: true, log: () => {} });
      expect(renewed).toMatchObject({ books_seen: 2, session_refreshed: true });
      const session = loadSession(cfg.sessionPath)!;
      expect(session.cookies.find((c) => c.name === "token")?.value).toBe("t2");
      expect(session.signedInAt).toBeTruthy();

      amazon.state.valid = "t3"; // now Amazon forgets the browser too: only the user can sign in
      amazon.state.remembered = false;
      amazon.state.userSignsIn = false;
      const started = Date.now();
      const err = await syncCloud(cfg, store, { log: () => {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthRequired);
      expect((err as AuthRequired).reason).toBe("expired");
      expect(Date.now() - started).toBeLessThan(15_000); // the password form ends the attempt, not the timeout
      store.close();
    } finally {
      await amazon.close();
    }
  }, 90_000);
});
