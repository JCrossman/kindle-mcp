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
import { launchContext, userAgentOf } from "../src/notebook/fetchers.js";
import { login, refreshSession, showSignedIn } from "../src/notebook/login.js";
import { loadSession } from "../src/notebook/session.js";
import { Store } from "../src/store.js";
import { lastRenewal, syncCloud } from "../src/sync.js";

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
 * me" cookie, and a sign-in page that sends a remembered browser straight back with a new token,
 * unless the browser calls itself HeadlessChrome (as real Amazon appears to treat it).
 */
async function startSignInAmazon() {
  const state = {
    valid: "t1", remembered: true, userSignsIn: true, captcha: false, stuck: false, hiddenDecoys: false,
    keptSignedIn: null as boolean | null, notebookAgents: [] as string[], signInAgents: [] as string[],
  };
  const srv = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const cookies = req.headers.cookie ?? "";
    const agent = req.headers["user-agent"] ?? "";
    if (url.pathname === "/ap/signin") {
      state.signInAgents.push(agent);
      if (state.hiddenDecoys) {
        // A code prompt behind hidden copies of other fields, earlier in the page.
        const hidden = '<input type="password" style="display:none"><img id="auth-captcha-image" style="display:none">';
        res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><body>${hidden}<form><input id="auth-mfa-otpcode"></form></body></html>`);
      } else if (state.stuck) {
        res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body>One moment…</body></html>");
      } else if (state.captcha) {
        res.writeHead(200, { "Content-Type": "text/html" }).end('<html><body><form action="/errors/validateCaptcha"><input id="captchacharacters"></form></body></html>');
      } else if (state.remembered && cookies.includes("remember=yes") && !agent.includes("HeadlessChrome")) {
        res.writeHead(302, { Location: "/notebook", "Set-Cookie": `token=${state.valid}; Path=/` }).end();
      } else {
        // A password form with Amazon's "Keep me signed in" box, unticked. In the first login the "user" submits
        // it without touching the box.
        const submit = state.userSignsIn ? "<script>setTimeout(() => document.forms.signIn.submit(), 300)</script>" : "";
        const form = '<form name="signIn" action="/ap/do-signin"><input type="password"><input type="checkbox" name="rememberMe" value="true"></form>';
        res.writeHead(200, { "Content-Type": "text/html" }).end(`<html><body>${form}${submit}</body></html>`);
      }
      return;
    }
    if (url.pathname === "/ap/do-signin") {
      // Like Amazon, only a sign-in with "Keep me signed in" ticked makes it remember the browser.
      state.keptSignedIn = url.searchParams.get("rememberMe") === "true";
      res.writeHead(302, {
        Location: "/notebook",
        "Set-Cookie": [`token=${state.valid}; Path=/`, ...(state.keptSignedIn ? ["remember=yes; Max-Age=86400; Path=/"] : [])],
      }).end();
      return;
    }
    if (!cookies.includes(`token=${state.valid}`)) {
      res.writeHead(302, { Location: "/ap/signin" }).end();
      return;
    }
    state.notebookAgents.push(agent);
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
  it("starts the hidden browser under its windowed name, so a browser Amazon remembers gets through", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kindle-ua-"));
    const ctx = await launchContext(dir, true, process.env.KINDLE_BROWSER_PATH ?? null);
    try {
      const ua = await userAgentOf(ctx);
      expect(ua).toMatch(/ Chrome\/\d+/);
      expect(ua).not.toContain("Headless");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("says in the sign-in window that the sign-in is saved, and whether Amazon needed the password", async () => {
    const ctx = await launchContext(mkdtempSync(join(tmpdir(), "kindle-banner-")), true, process.env.KINDLE_BROWSER_PATH ?? null);
    try {
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      await page.setContent("<html><body><div id='kp-notebook-library'></div></body></html>");
      await showSignedIn(page, false);
      const banner = page.locator("#kindle-mcp-signed-in", { hasText: "Signed in" });
      await banner.waitFor({ timeout: 5_000 }); // filled just after it's added, so screen readers announce it
      expect(await banner.getAttribute("role")).toBe("status");
      expect(await banner.textContent()).toMatch(/^Signed in to Kindle\. Amazon already remembers this browser, so it didn't ask for your password\./);
      await page.setContent("<html><body></body></html>");
      await showSignedIn(page, true);
      await banner.waitFor({ timeout: 5_000 });
      expect(await banner.textContent()).toBe("Signed in to Kindle. This window closes by itself in a moment.");
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it("renews it from the saved browser profile without a window, and says what Amazon asked for when it can't", async () => {
    const amazon = await startSignInAmazon();
    try {
      const home = mkdtempSync(join(tmpdir(), "kindle-renew-"));
      const cfg = loadConfig({ KINDLE_MCP_HOME: home, KINDLE_NOTEBOOK_BASE: amazon.base, KINDLE_REQUEST_DELAY: "0", KINDLE_BROWSER_PATH: process.env.KINDLE_BROWSER_PATH });
      expect(await login(cfg, 30_000, true)).toBe(true);
      expect(amazon.state.keptSignedIn).toBe(true); // ticked for the reader, who never touched the box
      const saved = loadSession(cfg.sessionPath)!;
      expect(saved.userAgent).toMatch(/ Chrome\/\d+/);
      const store = new Store(cfg.dbPath);
      expect(await syncCloud(cfg, store, { log: () => {} })).not.toHaveProperty("session_refreshed");
      expect(amazon.state.notebookAgents.at(-1)).toBe(saved.userAgent); // the plain-HTTP sync sends the browser's own name

      amazon.state.valid = "t2"; // the short-lived token expires; Amazon still remembers the browser
      const renewed = await syncCloud(cfg, store, { full: true, log: () => {} });
      expect(renewed).toMatchObject({ books_seen: 2, session_refreshed: true });
      expect(amazon.state.signInAgents.some((a) => a.includes("HeadlessChrome"))).toBe(false);
      const session = loadSession(cfg.sessionPath)!;
      expect(session.cookies.find((c) => c.name === "token")?.value).toBe("t2");
      expect(session.signedInAt).toBeTruthy();
      expect(lastRenewal(store)).toMatchObject({ ok: true, outcome: "renewed" });

      amazon.state.valid = "t3"; // now Amazon forgets the browser too: only the user can sign in
      amazon.state.remembered = false;
      amazon.state.userSignsIn = false;
      let started = Date.now();
      const err = await syncCloud(cfg, store, { log: () => {} }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthRequired);
      expect((err as AuthRequired).reason).toBe("expired");
      expect((err as Error).message).toMatch(/couldn't be renewed without you: Amazon asked the hidden browser that renews it for your password\./);
      expect(Date.now() - started).toBeLessThan(20_000); // the password form ends the attempt, not the timeout
      expect(lastRenewal(store)).toMatchObject({ ok: false, outcome: "password", where: expect.stringMatching(/\/ap\/signin$/) });

      amazon.state.captcha = true; // or Amazon wants proof it's a person
      started = Date.now();
      const puzzle = await syncCloud(cfg, store, { log: () => {} }).catch((e: unknown) => e);
      expect((puzzle as Error).message).toMatch(/a puzzle to prove it's a person/);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(lastRenewal(store)).toMatchObject({ ok: false, outcome: "captcha" });

      amazon.state.captcha = false;
      amazon.state.hiddenDecoys = true; // hidden fields earlier in the page don't hide the one Amazon shows
      started = Date.now();
      expect(await refreshSession(cfg, 15_000)).toMatchObject({ ok: false, outcome: "code" });
      expect(Date.now() - started).toBeLessThan(12_000);

      amazon.state.hiddenDecoys = false;
      amazon.state.stuck = true; // or a page that is none of these, until time runs out
      expect(await refreshSession(cfg, 5_000)).toMatchObject({ ok: false, outcome: "timeout", where: expect.stringMatching(/\/ap\/signin$/) });
      store.close();
    } finally {
      await amazon.close();
    }
  }, 120_000);
});
