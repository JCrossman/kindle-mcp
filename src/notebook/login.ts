/**
 * One-time interactive login. A visible browser opens; the user signs in (2FA included) and the
 * session cookies are saved for the plain-HTTP sync path. The Amazon password never touches this code.
 * Later, refreshSession renews those cookies from the same browser profile without the user.
 */
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import type { BrowserContext } from "playwright-core";

import type { Config } from "../config.js";
import { launchContext } from "./fetchers.js";
import { saveSession } from "./session.js";
import * as S from "./selectors.js";

export interface LoginHandle {
  /** Resolves true once the cookies are saved, false on timeout. The browser is closed either way. */
  done: Promise<boolean>;
}

/** The browser's Amazon cookies become the session the plain-HTTP sync uses. */
async function saveBrowserSession(cfg: Config, ctx: BrowserContext): Promise<void> {
  const host = new URL(cfg.notebookBase).hostname;
  const cookies = (await ctx.cookies()).filter((c) => c.domain.includes("amazon") || host.endsWith(c.domain.replace(/^\./, "")));
  const now = new Date().toISOString();
  saveSession(cfg.sessionPath, {
    savedAt: now,
    signedInAt: now,
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

/**
 * Renew the saved sign-in without the user. Some of Amazon's sign-in cookies are short-lived, and
 * a browser Amazon remembers ("Keep me signed in") gets them re-issued on its next visit without
 * a password. This opens the profile `login` used, headless, loads the notebook and, if it
 * arrives, saves the fresh cookies. False when Amazon asks for a password or code, when the
 * profile is missing or open elsewhere, when no browser starts, or when time runs out. Never
 * shows a window and never types anything.
 */
export async function refreshSession(cfg: Config, timeoutMs = 20_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  const left = (): number => Math.max(1, end - Date.now());
  const dir = cfg.browserProfile;
  if (!existsSync(dir) || !readdirSync(dir).length || profileInUse(dir)) return false;
  let ctx: BrowserContext;
  try {
    ctx = await launchContext(dir, true, cfg.browserPath, end);
  } catch {
    return false;
  }
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(S.libraryUrl(cfg.notebookBase), { waitUntil: "domcontentloaded", timeout: left() });
    await page.waitForSelector(`${S.LIBRARY_ROOT}, ${S.SIGNIN_FORM}`, { timeout: left() });
    if (!(await page.$(S.LIBRARY_ROOT))) return false;
    await saveBrowserSession(cfg, ctx);
    return true;
  } catch {
    return false;
  } finally {
    await ctx.close().catch(() => {});
  }
}
