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

/** Why a sync needs the user: nothing saved yet, or Amazon wants the password again. */
export type SignInReason = "missing" | "expired";

/** How an attempt to renew the sign-in without the user ended. */
export type RenewalOutcome =
  | "renewed"
  | "password"
  | "code"
  | "captcha"
  | "timeout"
  | "no-browser"
  | "profile-busy"
  | "no-profile"
  | "error";

export interface Renewal {
  ok: boolean;
  outcome: RenewalOutcome;
  /** Host and path the browser was on when it stopped (never the query string). */
  where?: string;
  /** First line of the error, for no-browser and error. */
  detail?: string;
}

/** A failed renewal in the reader's words. */
export function renewalWords(r: Renewal): string {
  switch (r.outcome) {
    case "password": return "Amazon asked the hidden browser that renews it for your password";
    case "code": return "Amazon asked the hidden browser that renews it for a verification code";
    case "captcha": return "Amazon showed the hidden browser that renews it a puzzle to prove it's a person";
    case "timeout": return `Amazon's page didn't finish loading in the hidden browser that renews it${r.where ? ` (it stopped at ${r.where})` : ""}`;
    case "no-browser": return `the hidden browser that renews it couldn't start${r.detail ? ` (${r.detail})` : ""}`;
    case "profile-busy": return "the Kindle sign-in window was still open";
    case "no-profile": return "there's no saved browser to renew it from yet";
    case "error": return `the hidden browser that renews it hit an error${r.detail ? ` (${r.detail})` : ""}`;
    case "renewed": return "it was renewed";
  }
}

export interface SignInDetail {
  /** The data folder that was searched for a saved sign-in. */
  home?: string;
  /** When the saved sign-in was made or last renewed (ISO). */
  savedAt?: string;
  /** The renewal this sync tried, if it tried one. */
  renewal?: Renewal;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function signInMessage(reason: SignInReason, detail: SignInDetail): string {
  const how = 'In Claude, say "Sign me in to Kindle"; on the command line, run `kindle-mcp login`.';
  if (reason === "missing") {
    return `No Amazon sign-in is saved yet${detail.home ? ` (looked in ${detail.home})` : ""}. ${how} Then sync again.`;
  }
  const when = detail.savedAt ? ` (the saved sign-in is from ${localTime(detail.savedAt)})` : "";
  const why = detail.renewal && !detail.renewal.ok ? `: ${renewalWords(detail.renewal)}` : "";
  return (
    `Amazon wants you to sign in again${when}, and the sign-in couldn't be renewed without you${why}. In Claude, say ` +
    '"Sign me in to Kindle" and tick "Keep me signed in"; on the command line, run `kindle-mcp login`. Nothing is ' +
    "lost: the next sync catches up."
  );
}

export class AuthRequired extends Error {
  constructor(
    readonly reason: SignInReason = "expired",
    detail: SignInDetail = {},
  ) {
    super(signInMessage(reason, detail));
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
