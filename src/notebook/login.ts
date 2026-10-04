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

/**
 * Open the browser and return as soon as the sign-in page is up; the returned promise finishes
 * the job. Lets an MCP tool hand the window to the user without holding the call open.
 */
export async function startLogin(cfg: Config, timeoutMs = 600_000, headless = false): Promise<LoginHandle> {
  const ctx = await launchContext(cfg.browserProfile, headless, cfg.browserPath);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(S.libraryUrl(cfg.notebookBase));
  const done = (async () => {
    try {
      try {
        await page.waitForSelector(S.LIBRARY_ROOT, { timeout: timeoutMs });
      } catch {
        return false;
      }
      await saveBrowserSession(cfg, ctx);
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
