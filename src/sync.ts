/** Sync orchestration: cloud notebook and My Clippings.txt both land in the same store. */
import { parseClippings } from "./clippings.js";
import type { Config } from "./config.js";
import { NotebookClient } from "./notebook/client.js";
import { openFetcher } from "./notebook/fetchers.js";
import type { Store, SyncStats } from "./store.js";

export type Log = (message: string) => void;

export interface SyncOptions {
  full?: boolean;
  only?: string | null;
  browser?: boolean;
  log?: Log;
}

const fresh = (): SyncStats => ({ books_seen: 0, books_synced: 0, highlights_new: 0, highlights_updated: 0 });

/** Pull the notebook. Books whose 'last annotated' date is unchanged are skipped unless full=true. */
export async function syncCloud(cfg: Config, store: Store, opts: SyncOptions = {}): Promise<SyncStats> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const stats = fresh();
  const runId = store.startRun("cloud");
  try {
    const handle = await openFetcher(cfg, Boolean(opts.browser));
    try {
      const nb = new NotebookClient(handle.fetch, cfg.notebookBase, cfg.requestDelayMs);
      const library = await nb.library();
      stats.books_seen = library.length;
      if (!library.length) {
        throw new Error(
          "Logged in, but the notebook listed zero books. Amazon may have changed the page: " +
            "run `kindle-mcp doctor` and check src/notebook/selectors.ts.",
        );
      }
      for (const book of library) {
        const only = opts.only;
        if (only && !book.title.toLowerCase().includes(only.toLowerCase()) && only !== book.asin) continue;
        const unchanged = book.lastAnnotated && store.bookLastAnnotated(book.bookId) === book.lastAnnotated;
        if (unchanged && !opts.full) continue;
        const bookId = store.upsertBook(book);
        const highlights = await nb.annotations(book.asin!);
        for (const h of highlights) {
          const result = store.upsertHighlight(bookId, h);
          if (result === "new") stats.highlights_new++;
          else if (result === "updated") stats.highlights_updated++;
        }
        store.markBookSynced(bookId, book.lastAnnotated);
        stats.books_synced++;
        log(`  ${book.title.slice(0, 60)}: ${highlights.length} annotations`);
      }
    } finally {
      await handle.close();
    }
    store.finishRun(runId, stats);
    return stats;
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
