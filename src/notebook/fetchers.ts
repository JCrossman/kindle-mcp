/** The two ways to reach read.amazon.com: saved cookies over plain HTTP, or a real browser. */
import type { BrowserContext } from "playwright-core";

import type { Config } from "../config.js";
import type { Fetcher, FetchResult } from "./client.js";
import { SIGNIN_URL_MARKERS } from "./selectors.js";
import { applySetCookies, cookieHeader, loadSession, saveSession, type Session } from "./session.js";

export interface FetcherHandle {
  fetch: Fetcher;
  close(): Promise<void>;
}

// Navigation-style headers, the same shape a `page.goto` sends. If Amazon starts refusing the
// plain-HTTP path, compare against the notebook XHR in a HAR capture and adjust here. The user agent
// is the one the browser that saved the sign-in reported (Session.userAgent); this one is for
// sessions saved before 1.3.2.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

/** Plain HTTP with the cookies `kindle-mcp login` saved. Set-Cookie updates are written back. */
export function cookieFetcher(cfg: Config, session: Session | null = loadSession(cfg.sessionPath)): FetcherHandle {
  if (!session) {
    return {
      fetch: async (url: string): Promise<FetchResult> => ({ status: 302, finalUrl: "/ap/signin", html: "" }),
      close: async () => {},
    };
  }
  const jar = session;
  let dirty = false;
  // A reply that sends us to sign-in may also clear cookies; saving those would only make the
  // saved session worse for the next attempt.
  let signedOut = false;
  return {
    async fetch(url: string): Promise<FetchResult> {
      // Follow benign redirects ourselves so cookies travel with them; stop at a sign-in redirect
      // so the client can report it. Redirects are handled here rather than by fetch() because
      // fetch() would not re-read the jar for the new URL.
      let current = url;
      for (let hop = 0; hop < 5; hop++) {
        const res = await fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: { ...HEADERS, ...(jar.userAgent ? { "User-Agent": jar.userAgent } : {}), Cookie: cookieHeader(jar.cookies, current), Referer: `${cfg.notebookBase}/notebook` },
        });
        const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
        if (setCookies.length && applySetCookies(jar.cookies, setCookies, current)) dirty = true;
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          const next = new URL(location, current).toString();
          if (SIGNIN_URL_MARKERS.some((m) => next.includes(m))) {
            signedOut = true;
            return { status: res.status, finalUrl: next, html: "" };
          }
          current = next;
          continue;
        }
        return { status: res.status, finalUrl: current, html: res.status < 300 ? await res.text() : "" };
      }
      return { status: 310, finalUrl: current, html: "" }; // too many redirects
    },
    async close(): Promise<void> {
      if (dirty && !signedOut) saveSession(cfg.sessionPath, { ...jar, savedAt: new Date().toISOString() });
    },
  };
}

/** The name a browser without a window gives itself, as the same browser with a window gives it. */
export function windowedUserAgent(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome\//g, "Chrome/");
}

/** The user agent of the browser behind a context, as its pages report it. */
export async function userAgentOf(ctx: BrowserContext): Promise<string> {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return String(await page.evaluate("navigator.userAgent"));
}

/**
 * Launch a Chromium-based browser with our separate profile: an explicit executable if configured
 * (KINDLE_BROWSER_PATH), else the user's Chrome, then Edge, then a Playwright-managed Chromium.
 * With a deadline (epoch ms), no attempt runs past it; otherwise Playwright's own launch timeout applies.
 *
 * Without a window, Chrome names itself "HeadlessChrome" in the user agent of every request, and
 * Amazon treats that browser as a stranger even with the profile it remembers. So a headless
 * launch is made twice: once to read the browser's own user agent, then with the windowed name
 * (Chrome's `--user-agent` switch, which keeps the browser's own client hints, unlike an override).
 */
export async function launchContext(
  profileDir: string,
  headless: boolean,
  executablePath: string | null = null,
  deadline?: number,
): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  const attempts: Array<{ channel?: "chrome" | "msedge"; executablePath?: string }> = [
    ...(executablePath ? [{ executablePath }] : []),
    { channel: "chrome" },
    { channel: "msedge" },
    {},
  ];
  const timeLeft = (): { timeout?: number } => (deadline === undefined ? {} : { timeout: deadline - Date.now() });
  const errors: string[] = [];
  for (const opts of attempts) {
    if ((timeLeft().timeout ?? 1) <= 0) {
      errors.push("out of time");
      break;
    }
    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(profileDir, { ...opts, headless, ...timeLeft() });
    } catch (e) {
      errors.push(`${opts.executablePath ?? opts.channel ?? "chromium"}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    if (!headless) return ctx;
    let userAgent: string;
    try {
      userAgent = await userAgentOf(ctx);
    } catch (e) {
      await ctx.close().catch(() => {});
      throw e;
    }
    const windowed = windowedUserAgent(userAgent);
    if (windowed === userAgent) return ctx;
    await ctx.close();
    if ((timeLeft().timeout ?? 1) <= 0) throw new Error("Out of time starting the browser.");
    return chromium.launchPersistentContext(profileDir, { ...opts, headless, args: [`--user-agent=${windowed}`], ...timeLeft() });
  }
  throw new Error(
    "No browser found. Install Google Chrome or Microsoft Edge, set KINDLE_BROWSER_PATH to a Chromium-based browser, " +
      "or run `npx playwright install chromium`.\n" +
      errors.join("\n"),
  );
}

/** A real browser navigating to each URL. Slow, but exactly what a human session looks like. */
export async function browserFetcher(cfg: Config, headless = true): Promise<FetcherHandle> {
  const ctx = await launchContext(cfg.browserProfile, headless, cfg.browserPath);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return {
    async fetch(url: string): Promise<FetchResult> {
      const res = await page.goto(url, { waitUntil: "domcontentloaded" });
      return { status: res?.status() ?? 200, finalUrl: page.url(), html: await page.content() };
    },
    close: () => ctx.close(),
  };
}

export async function openFetcher(cfg: Config, browser: boolean): Promise<FetcherHandle> {
  return browser ? browserFetcher(cfg) : cookieFetcher(cfg);
}
