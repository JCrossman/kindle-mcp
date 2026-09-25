/** Sync orchestration: cloud notebook and My Clippings.txt both land in the same store. */
import { existsSync } from "node:fs";

import { parseClippings } from "./clippings.js";
import type { Config } from "./config.js";
import { AuthRequired, DeadlineReached, NotebookClient } from "./notebook/client.js";
import { openFetcher, type FetcherHandle } from "./notebook/fetchers.js";
import { refreshSession } from "./notebook/login.js";
import { loadSession } from "./notebook/session.js";
import { nowIso, type Store, type SyncStats } from "./store.js";

export type Log = (message: string) => void;

export interface SyncOptions {
  full?: boolean;
  only?: string | null;
  browser?: boolean;
  log?: Log;
  /** Epoch ms after which no new page is fetched; the result is then partial. */
  deadline?: number;
  /** Cancels between pages (the MCP client gave up on the call). */
  signal?: AbortSignal;
  /** Renews a refused sign-in without the user (default refreshSession; tests pass a stand-in). */
  refresh?: (cfg: Config, timeoutMs: number) => Promise<boolean>;
}

export interface SyncResult extends SyncStats {
  /** True when the time budget ran out; calling again continues with the books still to do. */
  partial?: boolean;
  books_remaining?: number;
  /** The saved sign-in had gone stale and was renewed without the user. */
  session_refreshed?: boolean;
}

/** A full re-read that spans several budgeted calls remembers when it started. */
const FULL_PASS = "sync:full_pass_started";

const fresh = (): SyncStats => ({ books_seen: 0, books_synced: 0, highlights_new: 0, highlights_updated: 0 });

/** A renewal starts only with this much of the budget left, and gets at most RENEW_MS. */
const RENEW_MIN_LEFT_MS = 15_000;
const RENEW_MS = 20_000;

/** The sign-in error for this data folder: nothing saved yet, or saved (or unreadable) and refused. */
export function signInNeeded(cfg: Config): AuthRequired {
  if (!existsSync(cfg.sessionPath)) return new AuthRequired("missing", { home: cfg.home });
  const session = loadSession(cfg.sessionPath);
  return new AuthRequired("expired", { savedAt: session?.signedInAt ?? session?.savedAt });
}

/** How long a renewal may take now; 0 on the browser path, when cancelled, with nothing saved, or short of time. */
function renewalBudget(cfg: Config, opts: SyncOptions): number {
  if (opts.browser || opts.signal?.aborted || !existsSync(cfg.sessionPath)) return 0;
  const left = (opts.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  return left < RENEW_MIN_LEFT_MS ? 0 : Math.min(RENEW_MS, left - 5_000);
}

/**
 * One sync's reads from the notebook. When Amazon refuses the saved cookies, on the library or on
 * any book's pages, the sign-in is renewed once per sync without the user (refreshSession) and
 * that read retried: the plain-HTTP path stops at every sign-in redirect, while a browser Amazon
 * remembers passes straight through.
 */
class NotebookReader {
  private tried = false;
  /** The sign-in was renewed during this sync. */
  renewed = false;
  private handle!: FetcherHandle;
  private nb!: NotebookClient;

  private constructor(
    private readonly cfg: Config,
    private readonly opts: SyncOptions,
  ) {}

  static async open(cfg: Config, opts: SyncOptions): Promise<NotebookReader> {
    const reader = new NotebookReader(cfg, opts);
    await reader.connect();
    return reader;
  }

  private async connect(): Promise<void> {
    this.handle = await openFetcher(this.cfg, Boolean(this.opts.browser));
    const { cfg, opts } = this;
    this.nb = new NotebookClient(this.handle.fetch, cfg.notebookBase, cfg.requestDelayMs, opts.deadline, opts.signal);
  }

  async read<T>(fn: (nb: NotebookClient) => Promise<T>): Promise<T> {
    try {
      return await fn(this.nb);
    } catch (e) {
      if (!(e instanceof AuthRequired) || this.tried) throw e;
      this.tried = true;
      const budget = renewalBudget(this.cfg, this.opts);
      if (!budget) throw e;
      await this.handle.close(); // saves nothing: the reply sent it to sign-in
      if (!(await (this.opts.refresh ?? refreshSession)(this.cfg, budget))) throw e;
      this.renewed = true;
      await this.connect(); // the fresh cookies
      return fn(this.nb);
    }
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

/**
 * Pull the notebook. Books whose 'last annotated' date is unchanged are skipped unless full=true.
 * A book is marked synced only after all its pages are read, so a run cut short by its deadline
 * leaves that book for the next run.
 */
export async function syncCloud(cfg: Config, store: Store, opts: SyncOptions = {}): Promise<SyncResult> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const stats = fresh();
  const runId = store.startRun("cloud");
  let partial = false;
  let remaining = 0;
  try {
    const reader = await NotebookReader.open(cfg, opts);
    const renewed = (): Partial<SyncResult> => (reader.renewed ? { session_refreshed: true } : {});
    try {
      let library;
      try {
        library = await reader.read((nb) => nb.library());
      } catch (e) {
        if (!(e instanceof DeadlineReached)) throw e;
        store.finishRun(runId, stats);
        return { ...stats, partial: true, ...renewed() };
      }
      stats.books_seen = library.length;
      if (!library.length) {
        throw new Error(
          "Logged in, but the notebook listed zero books. Amazon may have changed the page: " +
            "run `kindle-mcp doctor` and check src/notebook/selectors.ts.",
        );
      }
      const only = opts.only;
      const passStart = opts.full && !only ? (store.getState(FULL_PASS) ?? nowIso()) : null;
      if (passStart) store.setState(FULL_PASS, passStart);
      const todo = library.filter((book) => {
        if (only && !book.title.toLowerCase().includes(only.toLowerCase()) && only !== book.asin) return false;
        if (passStart) return !((store.bookLastSynced(book.bookId) ?? "") >= passStart);
        const unchanged = book.lastAnnotated && store.bookLastAnnotated(book.bookId) === book.lastAnnotated;
        return !unchanged || opts.full;
      });
      for (const [i, book] of todo.entries()) {
        let highlights;
        try {
          highlights = await reader.read((nb) => nb.annotations(book.asin!));
        } catch (e) {
          if (!(e instanceof DeadlineReached)) throw e;
          partial = true;
          remaining = todo.length - i;
          break;
        }
        const bookId = store.upsertBook(book);
        for (const h of highlights) {
          const result = store.upsertHighlight(bookId, h);
          if (result === "new") stats.highlights_new++;
          else if (result === "updated") stats.highlights_updated++;
        }
        store.markBookSynced(bookId, book.lastAnnotated);
        stats.books_synced++;
        log(`  ${book.title.slice(0, 60)}: ${highlights.length} annotations`);
      }
      if (passStart && !partial) store.deleteState(FULL_PASS);
    } finally {
      await reader.close();
    }
    store.finishRun(runId, stats);
    return { ...stats, ...(partial ? { partial, books_remaining: remaining } : {}), ...renewed() };
  } catch (e) {
    const err = e instanceof AuthRequired ? signInNeeded(cfg) : e; // a sign-in refused mid-sync too
    store.finishRun(runId, { ...stats, error: String((err as Error).message ?? err).slice(0, 500) });
    throw err;
  }
}

export function importClippings(store: Store, path: string, log: Log = (m) => console.error(m)): SyncStats {
  const stats = fresh();
  const runId = store.startRun("clippings");
  try {
    for (const { book, highlights } of parseClippings(path).values()) {
      stats.books_seen++;
      const bookId = store.upsertBook(book);
      for (const h of highlights) {
        const result = store.upsertHighlight(bookId, h);
        if (result === "new") stats.highlights_new++;
        else if (result === "updated") stats.highlights_updated++;
      }
      stats.books_synced++;
    }
    store.finishRun(runId, stats);
    log(`Imported clippings: ${JSON.stringify(stats)}`);
    return stats;
  } catch (e) {
    store.finishRun(runId, { ...stats, error: String((e as Error).message ?? e).slice(0, 500) });
    throw e;
  }
}
