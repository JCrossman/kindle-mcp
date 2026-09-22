/** Sync orchestration: cloud notebook and My Clippings.txt both land in the same store. */
import { parseClippings } from "./clippings.js";
import type { Config } from "./config.js";
import { DeadlineReached, NotebookClient } from "./notebook/client.js";
import { openFetcher } from "./notebook/fetchers.js";
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
}

export interface SyncResult extends SyncStats {
  /** True when the time budget ran out; calling again continues with the books still to do. */
  partial?: boolean;
  books_remaining?: number;
}

/** A full re-read that spans several budgeted calls remembers when it started. */
const FULL_PASS = "sync:full_pass_started";

const fresh = (): SyncStats => ({ books_seen: 0, books_synced: 0, highlights_new: 0, highlights_updated: 0 });

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
    const handle = await openFetcher(cfg, Boolean(opts.browser));
    try {
      const nb = new NotebookClient(handle.fetch, cfg.notebookBase, cfg.requestDelayMs, opts.deadline, opts.signal);
      let library;
      try {
        library = await nb.library();
      } catch (e) {
        if (!(e instanceof DeadlineReached)) throw e;
        store.finishRun(runId, stats);
        return { ...stats, partial: true };
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
    return partial ? { ...stats, partial, books_remaining: remaining } : stats;
  } catch (e) {
    store.finishRun(runId, { ...stats, error: String((e as Error).message ?? e).slice(0, 500) });
    throw e;
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
