"""Sync orchestration: cloud notebook and My Clippings.txt both land in the same store."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

from .clippings import parse_clippings
from .config import Config
from .scraper import notebook_session
from .store import Store

Log = Callable[[str], None]


def sync_cloud(cfg: Config, store: Store, full: bool = False, only: str | None = None, log: Log = print) -> dict:
    """Pull the notebook. Books whose 'last annotated' date is unchanged are skipped unless full=True."""
    stats = {"books_seen": 0, "books_synced": 0, "highlights_new": 0, "highlights_updated": 0}
    run_id = store.start_run("cloud")
    try:
        with notebook_session(cfg, headless=True) as nb:
            library = nb.library()
            stats["books_seen"] = len(library)
            if not library:
                raise RuntimeError(
                    "Logged in, but the notebook listed zero books. Amazon may have changed the page: "
                    "run `kindle-mcp doctor` and check notebook_selectors.py."
                )
            for book in library:
                if only and only.lower() not in book.title.lower() and only != book.asin:
                    continue
                unchanged = book.last_annotated and store.book_last_annotated(book.book_id) == book.last_annotated
                if unchanged and not full:
                    continue
                book_id = store.upsert_book(book)
                highlights = nb.annotations(book.asin)
                for h in highlights:
                    result = store.upsert_highlight(book_id, h)
                    if result != "unchanged":
                        stats[f"highlights_{result}"] += 1
                store.mark_book_synced(book_id, book.last_annotated)
                stats["books_synced"] += 1
                log(f"  {book.title[:60]}: {len(highlights)} annotations")
        store.finish_run(run_id, **stats)
        return stats
    except Exception as e:
        store.finish_run(run_id, **stats, error=str(e)[:500])
        raise


def import_clippings(store: Store, path: Path | str, log: Log = print) -> dict:
    stats = {"books_seen": 0, "books_synced": 0, "highlights_new": 0, "highlights_updated": 0}
    run_id = store.start_run("clippings")
    try:
        for book, highlights in parse_clippings(path).values():
            stats["books_seen"] += 1
            book_id = store.upsert_book(book)
            for h in highlights:
                result = store.upsert_highlight(book_id, h)
                if result != "unchanged":
                    stats[f"highlights_{result}"] += 1
            stats["books_synced"] += 1
        store.finish_run(run_id, **stats)
        log(f"Imported clippings: {stats}")
        return stats
    except Exception as e:
        store.finish_run(run_id, **stats, error=str(e)[:500])
        raise
