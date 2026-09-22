/**
 * Reads the Kindle notebook through whatever Fetcher it is given: plain HTTP with saved cookies
 * (the cron path) or a real browser (login, doctor, `--browser` fallback). Pagination and
 * sign-in detection live here so both paths behave the same.
 */
import { makeBook, type Book, type Highlight } from "../models.js";
import { parseAnnotations, parseLibrary } from "./parser.js";
import * as S from "./selectors.js";

export interface FetchResult {
  status: number;
  /** Where the request ended up: the redirect target for 3xx, else the requested URL. */
  finalUrl: string;
  html: string;
}

export type Fetcher = (url: string) => Promise<FetchResult>;

export class AuthRequired extends Error {
  constructor() {
    super(
      "Amazon session missing or expired. Run `kindle-mcp login` in a terminal, sign in in the " +
        "browser window that opens, then retry the sync.",
    );
    this.name = "AuthRequired";
  }
}

/** The time budget ran out (or the caller cancelled) before the next request. */
export class DeadlineReached extends Error {
  constructor() {
    super("Out of time for this sync; the next one continues where this stopped.");
    this.name = "DeadlineReached";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class NotebookClient {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base: string,
    private readonly delayMs: number,
    /** Epoch ms after which no new request starts. */
    private readonly deadline = Number.POSITIVE_INFINITY,
    private readonly signal?: AbortSignal,
  ) {}

  private async get(url: string): Promise<string> {
    if (Date.now() > this.deadline || this.signal?.aborted) throw new DeadlineReached();
    const res = await this.fetcher(url);
    if (S.SIGNIN_URL_MARKERS.some((m) => res.finalUrl.includes(m))) throw new AuthRequired();
    if (res.status >= 300 && res.status < 400) throw new AuthRequired(); // any other redirect means no notebook
    if (res.status >= 400) throw new Error(`Amazon answered HTTP ${res.status} for ${url}`);
    await sleep(this.delayMs); // be a polite, low-volume client
    return res.html;
  }

  async library(): Promise<Book[]> {
    const books: Book[] = [];
    const seen = new Set<string>();
    let token = "";
    for (;;) {
      const [pageBooks, next] = parseLibrary(await this.get(S.libraryUrl(this.base, token)));
      for (const b of pageBooks) {
        if (!seen.has(b.bookId)) books.push(makeBook(b));
        seen.add(b.bookId);
      }
      token = next;
      if (!token || !pageBooks.length) return books;
    }
  }

  async annotations(asin: string): Promise<Highlight[]> {
    const out: Highlight[] = [];
    let token = "";
    let state = "";
    for (let i = 0; i < 200; i++) {
      // hard stop against a pagination loop
      const [items, next, nextState] = parseAnnotations(await this.get(S.annotationsUrl(this.base, asin, token, state)), asin);
      out.push(...items);
      token = next;
      state = nextState;
      if (!token) break;
    }
    return out;
  }

  dump(asin: string | null = null): Promise<string> {
    return this.get(asin ? S.annotationsUrl(this.base, asin) : S.libraryUrl(this.base));
  }
}
