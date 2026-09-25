/** Sync orchestration: cloud notebook and My Clippings.txt both land in the same store. */
import { existsSync } from "node:fs";

import { parseClippings } from "./clippings.js";
import type { Config } from "./config.js";
import type { Book } from "./models.js";
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

/** The sign-in error for this data folder: nothing saved yet, or saved and refused. */
export function signInNeeded(cfg: Config): AuthRequired {
  const session = loadSession(cfg.sessionPath);
  return session
    ? new AuthRequired("expired", { savedAt: session.signedInAt ?? session.savedAt })
    : new AuthRequired("missing", { home: cfg.home });
}

async function renew(cfg: Config, opts: SyncOptions): Promise<boolean> {
  if (opts.browser || opts.signal?.aborted || !existsSync(cfg.sessionPath)) return false;
  const left = (opts.deadline ?? Number.POSITIVE_INFINITY) - Date.now();
  if (left < RENEW_MIN_LEFT_MS) return false;
  return (opts.refresh ?? refreshSession)(cfg, Math.min(RENEW_MS, left - 5_000));
}

interface Opened {
  handle: FetcherHandle;
  nb: NotebookClient;
  /** Null when the budget ran out before the library was read. */
  library: Book[] | null;
  refreshed: boolean;
}

/**
 * Reads the library, the first request of every sync. When Amazon refuses the saved cookies, the
 * sign-in is renewed once without the user (refreshSession) and the read retried; the plain-HTTP
 * path stops at any sign-in redirect, while a browser Amazon remembers passes straight through.
 */
async function openNotebook(cfg: Config, opts: SyncOptions): Promise<Opened> {
  let refreshed = false;
  for (;;) {
    const handle = await openFetcher(cfg, Boolean(opts.browser));
    const nb = new NotebookClient(handle.fetch, cfg.notebookBase, cfg.requestDelayMs, opts.deadline, opts.signal);
    try {
      return { handle, nb, library: await nb.library(), refreshed };
    } catch (e) {
      if (e instanceof DeadlineReached) return { handle, nb, library: null, refreshed };
      await handle.close();
      if (!(e instanceof AuthRequired)) throw e;
      if (refreshed || !(await renew(cfg, opts))) throw signInNeeded(cfg);
      refreshed = true;
    }
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
    const { handle, nb, library, refreshed } = await openNotebook(cfg, opts);
    const renewed = refreshed ? { session_refreshed: true } : {};
    try {
      if (!library) {
        store.finishRun(runId, stats);
        return { ...stats, partial: true, ...renewed };
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
          highlights = await nb.annotations(book.asin!);
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
      await handle.close();
    }
    store.finishRun(runId, stats);
    return { ...stats, ...(partial ? { partial, books_remaining: remaining } : {}), ...renewed };
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
