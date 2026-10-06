/**
 * One-time interactive login. A visible browser opens; the user signs in (2FA included) and the
 * session cookies are saved for the plain-HTTP sync path. The Amazon password never touches this code.
 * Later, refreshSession renews those cookies from the same browser profile without the user.
 */
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext, Page } from "playwright-core";

import type { Config } from "../config.js";
import type { Renewal } from "./client.js";
import { launchContext, userAgentOf } from "./fetchers.js";
import { saveSession } from "./session.js";
import * as S from "./selectors.js";

export interface LoginHandle {
  /** Resolves true once the cookies are saved, false on timeout. The browser is closed either way. */
  done: Promise<boolean>;
}

/** The browser's Amazon cookies, and its user agent, become the session the plain-HTTP sync uses. */
async function saveBrowserSession(cfg: Config, ctx: BrowserContext): Promise<void> {
  const host = new URL(cfg.notebookBase).hostname;
  const cookies = (await ctx.cookies()).filter((c) => c.domain.includes("amazon") || host.endsWith(c.domain.replace(/^\./, "")));
  const userAgent = await userAgentOf(ctx).catch(() => "");
  const now = new Date().toISOString();
  saveSession(cfg.sessionPath, {
    savedAt: now,
    signedInAt: now,
    ...(userAgent ? { userAgent } : {}),
    cookies: cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires,
      httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
    })),
  });
}

/** The few page globals the functions below use (this package compiles without the DOM types). */
interface PageScope {
  document: {
    querySelector(selector: string): { checked: boolean; dataset: Record<string, string | undefined>; dispatchEvent(event: unknown): boolean } | null;
    createElement(tag: string): { id: string; textContent: string | null; setAttribute(name: string, value: string): void };
    addEventListener(type: string, listener: () => void): void;
    body: { appendChild(node: unknown): unknown };
  };
  Event: new (type: string, init?: { bubbles?: boolean }) => unknown;
  setTimeout(handler: () => void, ms: number): unknown;
  MutationObserver: new (callback: () => void) => { observe(target: unknown, options: { childList: boolean; subtree: boolean }): void; disconnect(): void };
}

/**
 * Runs in the sign-in window on every page: ticks "Keep me signed in" once, without moving the
 * focus, so the reader can't forget it (and can still untick it). Later syncs can renew the
 * sign-in only for a browser Amazon remembers. Values come in as arguments, never as code.
 */
function tickKeepSignedIn(selector: string): void {
  const page = globalThis as unknown as PageScope;
  const tick = (): boolean => {
    const box = page.document.querySelector(selector);
    if (!box || box.dataset.kindleMcp) return Boolean(box);
    box.dataset.kindleMcp = "ticked";
    if (!box.checked) {
      box.checked = true;
      box.dispatchEvent(new page.Event("change", { bubbles: true }));
    }
    return true;
  };
  const watch = new page.MutationObserver(() => {
    if (tick()) watch.disconnect();
  });
  watch.observe(page.document, { childList: true, subtree: true });
  page.document.addEventListener("DOMContentLoaded", () => {
    if (tick()) watch.disconnect();
  });
}

/**
 * Runs in the sign-in window: a banner saying the sign-in is saved. It is a live status region,
 * added empty and filled a moment later, so screen readers announce it before the window closes.
 */
function addBanner({ text, style }: { text: string; style: string }): void {
  const page = globalThis as unknown as PageScope;
  const banner = page.document.createElement("div");
  banner.id = "kindle-mcp-signed-in";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.setAttribute("style", style);
  page.document.body.appendChild(banner);
  page.setTimeout(() => {
    banner.textContent = text;
  }, 50);
}

/** How long the sign-in window says it's done before it closes. */
const CONFIRM_MS = 3_000;

/** Say in the window that the sign-in is saved, and whether Amazon needed the password. */
export async function showSignedIn(page: Page, askedForPassword: boolean): Promise<void> {
  const text = askedForPassword
    ? "Signed in to Kindle. This window closes by itself in a moment."
    : "Signed in to Kindle. Amazon already remembers this browser, so it didn't ask for your password. This window closes by itself in a moment.";
  const style = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:16px;font:16px system-ui,sans-serif;background:#1a7f37;color:#fff;text-align:center";
  await page.evaluate(addBanner, { text, style }).catch(() => {});
}

/**
 * Open the browser and return as soon as the sign-in page is up; the returned promise finishes
 * the job. Lets an MCP tool hand the window to the user without holding the call open. When the
 * notebook loads, the window says so for a few seconds (a window that only flashed looks like a
 * failure), then closes.
 */
export async function startLogin(cfg: Config, timeoutMs = 600_000, headless = false): Promise<LoginHandle> {
  const ctx = await launchContext(cfg.browserProfile, headless, cfg.browserPath);
  await ctx.addInitScript(tickKeepSignedIn, S.KEEP_SIGNED_IN);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  // A remembered browser passes Amazon's sign-in redirects without stopping on one of its pages.
  let askedForPassword = false;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && S.SIGNIN_URL_MARKERS.some((m) => frame.url().includes(m))) askedForPassword = true;
  });
  await page.goto(S.libraryUrl(cfg.notebookBase));
  const done = (async () => {
    try {
      try {
        await page.waitForSelector(S.LIBRARY_ROOT, { timeout: timeoutMs });
      } catch {
        return false;
      }
      await saveBrowserSession(cfg, ctx);
      if (!headless) {
        await showSignedIn(page, askedForPassword);
        await page.waitForTimeout(CONFIRM_MS).catch(() => {});
      }
      return true;
    } finally {
      await ctx.close().catch(() => {});
    }
  })();
  return { done };
}

export async function login(cfg: Config, timeoutMs = 600_000, headless = false): Promise<boolean> {
  return (await startLogin(cfg, timeoutMs, headless)).done;
}

/**
 * True while a browser has the profile open (a sign-in window, say). Launching a second one on it
 * would hand our URL to that browser as a stray window instead of starting.
 */
function profileInUse(dir: string): boolean {
  try {
    const pid = Number(readlinkSync(join(dir, "SingletonLock")).split("-").pop()); // "<host>-<pid>"
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM"; // alive, owned by someone else
    }
  } catch {
    return existsSync(join(dir, "lockfile")); // Windows; the browser deletes it on exit
  }
}

/** Host and path of a URL, without the query string (which can carry tokens). */
function place(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

const firstLine = (e: unknown): string => String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200);

/**
 * The visible elements a selector list matches. Playwright's waitForSelector and first() look at
 * the first match in page order only, and Amazon's pages can hold hidden copies of these fields.
 */
const visibleIn = (page: Page, selector: string) => page.locator(selector).filter({ visible: true });

/** Which of Amazon's questions a page that isn't the notebook is asking. */
async function amazonAsks(page: Page): Promise<Renewal> {
  const shown = async (selector: string): Promise<boolean> => (await visibleIn(page, selector).count().catch(() => 0)) > 0;
  const where = place(page.url());
  if ((await shown(S.CAPTCHA_PROMPT)) || /captcha/i.test(where ?? "")) return { ok: false, outcome: "captcha", where };
  if ((await shown(S.CODE_PROMPT)) || /\/ap\/(mfa|cvf)/.test(where ?? "")) return { ok: false, outcome: "code", where };
  return { ok: false, outcome: "password", where };
}

/**
 * Renew the saved sign-in without the user. Some of Amazon's sign-in cookies are short-lived, and
 * a browser Amazon remembers ("Keep me signed in") gets them re-issued on its next visit without
 * a password. This opens the profile `login` used, without a window but under the browser's
 * windowed name (see launchContext), loads the notebook and, if it arrives, saves the fresh
 * cookies. Otherwise it says what stopped it: Amazon asking for a password, a code or a puzzle,
 * the page not loading in time, no browser, or the profile missing or open elsewhere. Never shows
 * a window and never types anything.
 */
export async function refreshSession(cfg: Config, timeoutMs = 25_000): Promise<Renewal> {
  const end = Date.now() + timeoutMs;
  const left = (): number => Math.max(1, end - Date.now());
  const dir = cfg.browserProfile;
  if (!existsSync(dir) || !readdirSync(dir).length) return { ok: false, outcome: "no-profile" };
  if (profileInUse(dir)) return { ok: false, outcome: "profile-busy" };
  let ctx: BrowserContext;
  try {
    ctx = await launchContext(dir, true, cfg.browserPath, end);
  } catch (e) {
    return { ok: false, outcome: "no-browser", detail: firstLine(e) };
  }
  let page: Page | undefined;
  try {
    page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(S.libraryUrl(cfg.notebookBase), { waitUntil: "domcontentloaded", timeout: left() });
    await visibleIn(page, `${S.LIBRARY_ROOT}, ${S.SIGNIN_FORM}`).first().waitFor({ timeout: left() });
    if (!(await page.$(S.LIBRARY_ROOT))) return await amazonAsks(page);
    await saveBrowserSession(cfg, ctx);
    return { ok: true, outcome: "renewed" };
  } catch (e) {
    const where = page ? place(page.url()) : undefined;
    if ((e as Error)?.name === "TimeoutError") return { ok: false, outcome: "timeout", where };
    return { ok: false, outcome: "error", detail: firstLine(e), where };
  } finally {
    await ctx.close().catch(() => {});
  }
}
