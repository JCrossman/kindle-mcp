/**
 * One-time interactive login. A visible browser opens; the user signs in (2FA included) and the
 * session cookies are saved for the plain-HTTP sync path. The Amazon password never touches this code.
 */
import type { Config } from "../config.js";
import { launchContext } from "./fetchers.js";
import { saveSession } from "./session.js";
import * as S from "./selectors.js";

export async function login(cfg: Config, timeoutMs = 600_000): Promise<boolean> {
  const ctx = await launchContext(cfg.browserProfile, false);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(S.libraryUrl(cfg.notebookBase));
    try {
      await page.waitForSelector(S.LIBRARY_ROOT, { timeout: timeoutMs });
    } catch {
      return false;
    }
    const cookies = (await ctx.cookies()).filter((c) => c.domain.includes("amazon"));
    saveSession(cfg.sessionPath, {
      savedAt: new Date().toISOString(),
      cookies: cookies.map((c) => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires,
        httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      })),
    });
    return true;
  } finally {
    await ctx.close();
  }
}
