import { describe, expect, it } from "vitest";

import { AuthRequired, NotebookClient, type FetchResult } from "../src/notebook/client.js";
import { applySetCookies, cookieHeader, type Cookie } from "../src/notebook/session.js";

const page1 = `<html><body><div id="kp-notebook-annotations">
 <div class="a-row a-spacing-base"><span id="annotationHighlightHeader">Yellow highlight | Location: 10</span>
   <input type="hidden" id="kp-annotation-location" value="10"><div class="kp-notebook-highlight"><span id="highlight">one</span></div></div>
</div><input type="hidden" class="kp-notebook-annotations-next-page-start" value="TOKEN2">
<input type="hidden" class="kp-notebook-content-limit-state" value="STATE"></body></html>`;
const page2 = `<div class="a-row a-spacing-base"><span id="annotationHighlightHeader">Blue highlight | Location: 20</span>
   <input type="hidden" id="kp-annotation-location" value="20"><div class="kp-notebook-highlight"><span id="highlight">two</span></div></div>
<input type="hidden" class="kp-notebook-annotations-next-page-start" value="">`;

describe("NotebookClient", () => {
  it("follows pagination tokens and passes the content limit state back", async () => {
    const urls: string[] = [];
    const fetcher = async (url: string): Promise<FetchResult> => {
      urls.push(url);
      return { status: 200, finalUrl: url, html: url.includes("token=TOKEN2") ? page2 : page1 };
    };
    const nb = new NotebookClient(fetcher, "https://example.test", 0);
    const hs = await nb.annotations("ASIN1");
    expect(hs.map((h) => h.text)).toEqual(["one", "two"]);
    expect(urls).toEqual([
      "https://example.test/notebook?asin=ASIN1&contentLimitState=&token=",
      "https://example.test/notebook?asin=ASIN1&contentLimitState=STATE&token=TOKEN2",
    ]);
  });
  it("raises AuthRequired on a sign-in redirect", async () => {
    const fetcher = async (url: string): Promise<FetchResult> => ({ status: 302, finalUrl: "https://www.amazon.com/ap/signin?x", html: "" });
    const nb = new NotebookClient(fetcher, "https://example.test", 0);
    await expect(nb.library()).rejects.toBeInstanceOf(AuthRequired);
  });
  it("raises on server errors", async () => {
    const fetcher = async (url: string): Promise<FetchResult> => ({ status: 503, finalUrl: url, html: "" });
    const nb = new NotebookClient(fetcher, "https://example.test", 0);
    await expect(nb.library()).rejects.toThrow(/HTTP 503/);
  });
});

describe("session cookies", () => {
  const jar: Cookie[] = [
    { name: "session-id", value: "abc", domain: ".amazon.com", path: "/", expires: -1 },
    { name: "other", value: "x", domain: ".example.org", path: "/", expires: -1 },
    { name: "stale", value: "old", domain: ".amazon.com", path: "/", expires: 1 },
    { name: "scoped", value: "p", domain: "read.amazon.com", path: "/notebook", expires: -1 },
  ];
  it("builds a Cookie header by domain, path and expiry", () => {
    expect(cookieHeader(jar, "https://read.amazon.com/notebook?asin=1")).toBe("session-id=abc; scoped=p");
    expect(cookieHeader(jar, "https://read.amazon.com/")).toBe("session-id=abc");
  });
  it("applies Set-Cookie updates in place", () => {
    const copy = jar.map((c) => ({ ...c }));
    const changed = applySetCookies(copy, ["session-id=def; Domain=.amazon.com; Path=/; Secure; HttpOnly", "fresh=1; Max-Age=60"], "https://read.amazon.com/notebook");
    expect(changed).toBe(true);
    expect(cookieHeader(copy, "https://read.amazon.com/notebook")).toBe("session-id=def; scoped=p; fresh=1");
    expect(applySetCookies(copy, ["session-id=def; Domain=.amazon.com; Path=/"], "https://read.amazon.com/notebook")).toBe(false);
  });
});
