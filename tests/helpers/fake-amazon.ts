/** Local stand-ins for read.amazon.com that serve the fixtures, and the saved sign-in they accept. */
import { readFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { saveSession, type Session } from "../../src/notebook/session.js";

const FX = fileURLToPath(new URL("../fixtures", import.meta.url));
const EMPTY_BOOK = '<html><body><input type="hidden" class="kp-notebook-annotations-next-page-start" value=""></body></html>';

/** The notebook page for a URL: the library, the one book with annotations (B0FAKE0004), or an empty book. */
export function fixturePage(url: URL): Buffer | string {
  const asin = url.searchParams.get("asin");
  return asin === "B0FAKE0004" ? readFileSync(join(FX, "annotations.html")) : asin ? EMPTY_BOOK : readFileSync(join(FX, "library.html"));
}

export interface Local {
  base: string;
  close(): Promise<void>;
}

/** Serves `handler` on a free port on 127.0.0.1. */
export async function listenLocal(handler: RequestListener): Promise<Local> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return {
    base: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** A session cookie for the stand-ins; `abc` is the one startFakeAmazon accepts. */
export const sessionCookie = (value = "abc"): Session["cookies"] => [{ name: "session-id", value, domain: "127.0.0.1", path: "/", expires: -1 }];

/** Saves a sign-in the stand-in accepts (or, with another cookie value, one it refuses). */
export function saveSignedIn(path: string, value = "abc", extra: Partial<Session> = {}): void {
  saveSession(path, { savedAt: "t", cookies: sessionCookie(value), ...extra });
}

export interface FakeAmazon extends Local {
  seenCookies: string[];
  seenAgents: string[];
  readonly redirects: number;
}

/** Insists on the session cookie, and redirects once on the way like Amazon's regional hosts do. */
export async function startFakeAmazon(): Promise<FakeAmazon> {
  const seenCookies: string[] = [];
  const seenAgents: string[] = [];
  let redirects = 0;
  const local = await listenLocal((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seenCookies.push(req.headers.cookie ?? "");
    seenAgents.push(req.headers["user-agent"] ?? "");
    if (!url.searchParams.has("hop")) {
      // A benign redirect (think trailing slash or regional host): the fetcher must follow it with cookies.
      url.searchParams.set("hop", "1");
      redirects++;
      res.writeHead(301, { Location: url.pathname + url.search }).end();
      return;
    }
    if (!(req.headers.cookie ?? "").includes("session-id=abc")) {
      // Like Amazon, the sign-in redirect also clears the refused cookie.
      res.writeHead(302, { Location: "https://www.amazon.com/ap/signin", "Set-Cookie": "session-id=; Max-Age=0; Path=/; Secure; HttpOnly" }).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session-token=rotated; Path=/" }).end(fixturePage(url));
  });
  return {
    ...local,
    seenCookies,
    seenAgents,
    get redirects() {
      return redirects;
    },
  };
}
