/** The two ways to reach read.amazon.com: saved cookies over plain HTTP, or a real browser. */
import type { BrowserContext } from "playwright-core";

import type { Config } from "../config.js";
import type { Fetcher, FetchResult } from "./client.js";
import { applySetCookies, cookieHeader, loadSession, saveSession, type Session } from "./session.js";

export interface FetcherHandle {
  fetch: Fetcher;
  close(): Promise<void>;
}

// Navigation-style headers, the same shape a `page.goto` sends. If Amazon starts refusing the
// plain-HTTP path, compare against the notebook XHR in a HAR capture and adjust here.
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
  return {
    async fetch(url: string): Promise<FetchResult> {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { ...HEADERS, Cookie: cookieHeader(jar.cookies, url), Referer: `${cfg.notebookBase}/notebook` },
      });
      const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
      if (setCookies.length && applySetCookies(jar.cookies, setCookies, url)) dirty = true;
      const location = res.headers.get("location");
      const finalUrl = res.status >= 300 && res.status < 400 && location ? new URL(location, url).toString() : url;
      return { status: res.status, finalUrl, html: res.status < 300 ? await res.text() : "" };
    },
    async close(): Promise<void> {
      if (dirty) saveSession(cfg.sessionPath, { ...jar, savedAt: new Date().toISOString() });
    },
  };
}

/** Launch the user's own Chrome (or Edge, or a Playwright-managed Chromium) with our separate profile. */
export async function launchContext(profileDir: string, headless: boolean): Promise<BrowserContext> {
  const { chromium } = await import("playwright-core");
  const attempts: Array<{ channel?: "chrome" | "msedge" }> = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  const errors: string[] = [];
  for (const opts of attempts) {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...opts, headless });
    } catch (e) {
      errors.push(`${opts.channel ?? "chromium"}: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "No browser found. Install Google Chrome or Microsoft Edge, or run `npx playwright install chromium`.\n" +
      errors.join("\n"),
  );
}

/** A real browser navigating to each URL. Slow, but exactly what a human session looks like. */
export async function browserFetcher(cfg: Config, headless = true): Promise<FetcherHandle> {
  const ctx = await launchContext(cfg.browserProfile, headless);
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
