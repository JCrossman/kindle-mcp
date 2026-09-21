"""SQLite store shared by the sync job and the MCP server.

Merge rule ("keep the fullest copy"): highlights are keyed by (book, start location).
When the same highlight arrives from both the cloud notebook and My Clippings.txt,
a non-truncated copy beats a truncated one, and longer text beats shorter.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from .commands import parse_commands
from .models import Book, Highlight

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    book_id TEXT PRIMARY KEY,
    asin TEXT,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    title_key TEXT NOT NULL,
    last_annotated TEXT,
    last_synced TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_title_key ON books(title_key);

CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(book_id),
    location_start INTEGER,
    location_end INTEGER,
    page TEXT,
    text TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    raw_note TEXT NOT NULL DEFAULT '',
    color TEXT,
    truncated INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL,
    highlighted_at TEXT,
    commands TEXT NOT NULL DEFAULT '[]',
    commands_done_at TEXT,
    amazon_id TEXT,
    position INTEGER,
    first_seen TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hl_book ON highlights(book_id, location_start);
CREATE INDEX IF NOT EXISTS idx_hl_first_seen ON highlights(first_seen);

CREATE VIRTUAL TABLE IF NOT EXISTS highlights_fts USING fts5(id UNINDEXED, text, note, title, author);

CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    source TEXT NOT NULL,
    books_seen INTEGER DEFAULT 0,
    books_synced INTEGER DEFAULT 0,
    highlights_new INTEGER DEFAULT 0,
    highlights_updated INTEGER DEFAULT 0,
    error TEXT
);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def title_key(title: str) -> str:
    """Normalize a title so cloud and clippings copies of one book land together.
    Drops subtitles and punctuation: 'Thinking, Fast and Slow: A Book' -> 'thinking fast and slow'."""
    base = re.split(r"[:(\[]", title, maxsplit=1)[0]
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", base.lower()).split())


def location_id(book_id: str, h: Highlight) -> str:
    anchor = str(h.location_start) if h.location_start is not None else (h.page or h.text[:80] or h.note[:80])
    return hashlib.sha1(f"{book_id}|{anchor}".encode()).hexdigest()[:16]


def highlight_id(book_id: str, h: Highlight) -> str:
    """Cloud annotations carry Amazon's own stable id; clippings fall back to (book, location)."""
    if h.amazon_id:
        return hashlib.sha1(f"{book_id}|amz|{h.amazon_id}".encode()).hexdigest()[:16]
    return location_id(book_id, h)


class Store:
    def __init__(self, db_path: Path | str):
        self.db = sqlite3.connect(str(db_path))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")   # sync job and MCP server can share the file
        self.db.executescript(SCHEMA)
        self._migrate_ids()

    def _migrate_ids(self) -> None:
        """Rows written before amazon_id became the key are re-keyed in place (one-time, idempotent)."""
        rows = self.db.execute("SELECT id, book_id, amazon_id FROM highlights WHERE amazon_id IS NOT NULL").fetchall()
        for r in rows:
            new = hashlib.sha1(f"{r['book_id']}|amz|{r['amazon_id']}".encode()).hexdigest()[:16]
            if new != r["id"]:
                self.db.execute("UPDATE highlights SET id=? WHERE id=?", (new, r["id"]))
                self.db.execute("UPDATE highlights_fts SET id=? WHERE id=?", (new, r["id"]))
        if rows:
            self.db.commit()

    def close(self) -> None:
        self.db.close()

    # ---- books -------------------------------------------------------------
    def resolve_book_id(self, book: Book) -> str:
        """Clippings has no ASIN; attach to an existing cloud book when titles match."""
        if book.asin:
            return book.asin
        row = self.db.execute(
            "SELECT book_id FROM books WHERE title_key = ? ORDER BY asin IS NULL LIMIT 1", (title_key(book.title),)
        ).fetchone()
        return row["book_id"] if row else book.book_id

    def upsert_book(self, book: Book) -> str:
        book_id = self.resolve_book_id(book)
        self.db.execute(
            """INSERT INTO books (book_id, asin, title, author, title_key) VALUES (?,?,?,?,?)
               ON CONFLICT(book_id) DO UPDATE SET
                 asin = COALESCE(excluded.asin, books.asin),
                 title = CASE WHEN excluded.asin IS NOT NULL THEN excluded.title ELSE books.title END,
                 author = CASE WHEN excluded.author != '' THEN excluded.author ELSE books.author END""",
            (book_id, book.asin, book.title, book.author, title_key(book.title)),
        )
        self.db.commit()
        return book_id

    def book_last_annotated(self, book_id: str) -> str | None:
        row = self.db.execute("SELECT last_annotated FROM books WHERE book_id=?", (book_id,)).fetchone()
        return row["last_annotated"] if row else None

    def mark_book_synced(self, book_id: str, last_annotated: str | None) -> None:
        self.db.execute(
            "UPDATE books SET last_annotated=?, last_synced=? WHERE book_id=?", (last_annotated, now_iso(), book_id)
        )
        self.db.commit()

    # ---- highlights --------------------------------------------------------
    def upsert_highlight(self, book_id: str, h: Highlight) -> str:
        """Returns 'new', 'updated', or 'unchanged'."""
        hid = highlight_id(book_id, h)
        commands, clean_note = parse_commands(h.note)
        old = self.db.execute("SELECT * FROM highlights WHERE id=?", (hid,)).fetchone()
        if old is None and not h.amazon_id and h.location_start is not None:
            # A clippings entry merges into the cloud copy of the same highlight, if one exists.
            old = self.db.execute(
                "SELECT * FROM highlights WHERE book_id=? AND location_start=? ORDER BY amazon_id IS NULL LIMIT 1",
                (book_id, h.location_start),
            ).fetchone()
            if old is not None:
                hid = old["id"]
        ts = now_iso()

        if old is None:
            self.db.execute(
                """INSERT INTO highlights (id, book_id, location_start, location_end, page, text, note, raw_note,
                       color, truncated, source, highlighted_at, commands, first_seen, updated_at, amazon_id, position)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (hid, book_id, h.location_start, h.location_end, h.page, h.text, clean_note, h.note, h.color,
                 int(h.truncated), h.source, h.highlighted_at, json.dumps(commands), ts, ts, h.amazon_id, h.position),
            )
            self._reindex(hid)
            return "new"

        # Fullest-copy merge.
        take_text = (old["truncated"] and not h.truncated and h.text) or (
            bool(h.truncated) == bool(old["truncated"]) and len(h.text) > len(old["text"])
        )
        text = h.text if take_text else old["text"]
        truncated = int(h.truncated) if take_text else old["truncated"]
        raw_note = h.note if h.note else old["raw_note"]
        note_changed = raw_note != old["raw_note"]
        if note_changed:
            commands, clean_note = parse_commands(raw_note)
        merged = {
            "text": text,
            "truncated": truncated,
            "raw_note": raw_note,
            "note": clean_note if note_changed else old["note"],
            "commands": json.dumps(commands) if note_changed else old["commands"],
            "location_end": old["location_end"] if old["location_end"] is not None else h.location_end,
            "page": old["page"] or h.page,
            "color": old["color"] or h.color,
            "highlighted_at": old["highlighted_at"] or h.highlighted_at,
            "amazon_id": old["amazon_id"] or h.amazon_id,
            "position": old["position"] if old["position"] is not None else h.position,
        }
        if all(merged[k] == old[k] for k in merged):
            return "unchanged"
        # A rewritten command note becomes actionable again.
        done_at = None if note_changed else old["commands_done_at"]
        self.db.execute(
            """UPDATE highlights SET text=:text, truncated=:truncated, raw_note=:raw_note, note=:note,
                   commands=:commands, location_end=:location_end, page=:page, color=:color,
                   highlighted_at=:highlighted_at, amazon_id=:amazon_id, position=:position,
                   commands_done_at=:done_at, updated_at=:ts WHERE id=:id""",
            {**merged, "done_at": done_at, "ts": ts, "id": hid},
        )
        self._reindex(hid)
        return "updated"

    def _reindex(self, hid: str) -> None:
        self.db.execute("DELETE FROM highlights_fts WHERE id=?", (hid,))
        self.db.execute(
            """INSERT INTO highlights_fts (id, text, note, title, author)
               SELECT h.id, h.text, h.note, b.title, b.author FROM highlights h JOIN books b USING(book_id)
               WHERE h.id=?""",
            (hid,),
        )
        self.db.commit()

    # ---- queries -----------------------------------------------------------
    _SELECT = """SELECT h.*, b.title, b.author, b.asin FROM highlights h JOIN books b USING(book_id)"""

    def list_books(self, query: str | None = None, limit: int = 50, offset: int = 0) -> list[dict]:
        where, args = "", []
        if query:
            where = "WHERE b.title LIKE ? OR b.author LIKE ?"
            args = [f"%{query}%", f"%{query}%"]
        rows = self.db.execute(
            f"""SELECT b.book_id, b.title, b.author, b.asin, b.last_annotated, b.last_synced,
                       COUNT(h.id) AS highlight_count, SUM(h.truncated) AS truncated_count,
                       MAX(h.first_seen) AS newest_highlight_seen
                FROM books b LEFT JOIN highlights h USING(book_id) {where}
                GROUP BY b.book_id ORDER BY newest_highlight_seen DESC LIMIT ? OFFSET ?""",
            (*args, limit, offset),
        ).fetchall()
        return [dict(r) for r in rows]

    def find_book(self, book: str) -> dict | None:
        """Accepts a book_id, ASIN, or a fragment of the title."""
        row = self.db.execute("SELECT * FROM books WHERE book_id=? OR asin=?", (book, book)).fetchone()
        if not row:
            row = self.db.execute(
                "SELECT * FROM books WHERE title LIKE ? ORDER BY LENGTH(title) LIMIT 1", (f"%{book}%",)
            ).fetchone()
        return dict(row) if row else None

    def get_highlights(self, book_id: str, limit: int = 100, offset: int = 0) -> list[dict]:
        rows = self.db.execute(
            f"{self._SELECT} WHERE h.book_id=? ORDER BY h.location_start IS NULL, h.location_start LIMIT ? OFFSET ?",
            (book_id, limit, offset),
        ).fetchall()
        return [_row(r) for r in rows]

    def search(self, query: str, limit: int = 20) -> list[dict]:
        fts_query = " ".join(f'"{t}"' for t in re.findall(r"\w+", query))
        if not fts_query:
            return []
        rows = self.db.execute(
            f"""{self._SELECT} JOIN highlights_fts f ON f.id = h.id
                WHERE highlights_fts MATCH ? ORDER BY bm25(highlights_fts) LIMIT ?""",
            (fts_query, limit),
        ).fetchall()
        return [_row(r) for r in rows]

    def new_since(self, since_iso: str, limit: int = 200) -> list[dict]:
        rows = self.db.execute(
            f"{self._SELECT} WHERE h.first_seen >= ? ORDER BY h.first_seen DESC, b.title LIMIT ?", (since_iso, limit)
        ).fetchall()
        return [_row(r) for r in rows]

    def pending_commands(self, tag: str | None = None, limit: int = 100) -> list[dict]:
        rows = self.db.execute(
            f"{self._SELECT} WHERE h.commands != '[]' AND h.commands_done_at IS NULL ORDER BY h.first_seen LIMIT ?",
            (limit,),
        ).fetchall()
        out = [_row(r) for r in rows]
        if tag:
            out = [h for h in out if any(c["tag"] == tag.lower().lstrip("@") for c in h["commands"])]
        return out

    def mark_commands_done(self, hid: str) -> bool:
        cur = self.db.execute("UPDATE highlights SET commands_done_at=? WHERE id=?", (now_iso(), hid))
        self.db.commit()
        return cur.rowcount > 0

    # ---- sync bookkeeping --------------------------------------------------
    def start_run(self, source: str) -> int:
        cur = self.db.execute("INSERT INTO sync_runs (started_at, source) VALUES (?,?)", (now_iso(), source))
        self.db.commit()
        return cur.lastrowid

    def finish_run(self, run_id: int, **stats) -> None:
        sets = ", ".join(f"{k}=?" for k in stats)
        self.db.execute(
            f"UPDATE sync_runs SET finished_at=?{', ' + sets if sets else ''} WHERE id=?",
            (now_iso(), *stats.values(), run_id),
        )
        self.db.commit()

    def status(self) -> dict:
        one = lambda sql: self.db.execute(sql).fetchone()[0]
        last = self.db.execute("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").fetchone()
        return {
            "books": one("SELECT COUNT(*) FROM books"),
            "highlights": one("SELECT COUNT(*) FROM highlights"),
            "truncated_highlights": one("SELECT COUNT(*) FROM highlights WHERE truncated=1"),
            "pending_commands": one("SELECT COUNT(*) FROM highlights WHERE commands!='[]' AND commands_done_at IS NULL"),
            "last_run": dict(last) if last else None,
        }


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["commands"] = json.loads(d["commands"])
    d["truncated"] = bool(d["truncated"])
    d.pop("raw_note", None)
    return d
