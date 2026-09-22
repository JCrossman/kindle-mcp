/** A stand-in for read.amazon.com that serves the fixtures and insists on the session cookie. */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FX = fileURLToPath(new URL("../fixtures", import.meta.url));

export interface FakeAmazon {
  base: string;
  seenCookies: string[];
  redirects: number;
  close(): Promise<void>;
}

export async function startFakeAmazon(): Promise<FakeAmazon> {
  const state = { seenCookies: [] as string[], redirects: 0 };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    state.seenCookies.push(req.headers.cookie ?? "");
    if (!url.searchParams.has("hop")) {
      // A benign redirect (think trailing slash or regional host): the fetcher must follow it with cookies.
      url.searchParams.set("hop", "1");
      state.redirects++;
      res.writeHead(301, { Location: url.pathname + url.search }).end();
      return;
    }
    if (!(req.headers.cookie ?? "").includes("session-id=abc")) {
      res.writeHead(302, { Location: "https://www.amazon.com/ap/signin" }).end();
      return;
    }
    const asin = url.searchParams.get("asin");
    const body =
      asin === "B0FAKE0004" ? readFileSync(join(FX, "annotations.html"))
      : asin ? '<html><body><input type="hidden" class="kp-notebook-annotations-next-page-start" value=""></body></html>'
      : readFileSync(join(FX, "library.html"));
    res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "session-token=rotated; Path=/" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return {
    base,
    get seenCookies() {
      return state.seenCookies;
    },
    get redirects() {
      return state.redirects;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
