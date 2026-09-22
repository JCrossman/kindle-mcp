/**
 * One-time interactive login. A visible browser opens; the user signs in (2FA included) and the
 * session cookies are saved for the plain-HTTP sync path. The Amazon password never touches this code.
 */
import type { Config } from "../config.js";
import { launchContext } from "./fetchers.js";
import { saveSession } from "./session.js";
import * as S from "./selectors.js";

export interface LoginHandle {
  /** Resolves true once the cookies are saved, false on timeout. The browser is closed either way. */
  done: Promise<boolean>;
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
      const host = new URL(cfg.notebookBase).hostname;
      const cookies = (await ctx.cookies()).filter((c) => c.domain.includes("amazon") || host.endsWith(c.domain.replace(/^\./, "")));
      saveSession(cfg.sessionPath, {
        savedAt: new Date().toISOString(),
        cookies: cookies.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires,
          httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
        })),
      });
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
