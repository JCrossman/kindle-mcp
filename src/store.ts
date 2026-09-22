/**
 * SQLite store shared by the sync job and the MCP server.
 *
 * Merge rule ("keep the fullest copy"): cloud highlights are keyed by Amazon's own annotation id;
 * clippings entries merge into the cloud copy at the same (book, start location) if one exists.
 * A non-truncated copy beats a truncated one, and longer text beats shorter.
 *
 * Ids are sha1 hex prefixes computed exactly as the original Python store did, so an existing
 * kindle.db and the ^kh-<id> block ids in Obsidian keep working.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { parseCommands, withActions, type Command, type CommandWithAction } from "./commands.js";
import type { Book, Highlight } from "./models.js";

export const SCHEMA = `
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
`;

export type UpsertResult = "new" | "updated" | "unchanged";

/** A highlight row as the store hands it out: DB column names, commands decoded. */
export interface HighlightRow {
  id: string;
  book_id: string;
  title: string;
  author: string;
  asin: string | null;
  location_start: number | null;
  location_end: number | null;
  page: string | null;
  text: string;
  note: string;
  color: string | null;
  truncated: boolean;
  source: string;
  highlighted_at: string | null;
  commands: CommandWithAction[];
  commands_done_at: string | null;
  amazon_id: string | null;
  position: number | null;
  first_seen: string;
  updated_at: string;
}

export interface BookRow {
  book_id: string;
  title: string;
  author: string;
  asin: string | null;
  last_annotated: string | null;
  last_synced: string | null;
  highlight_count: number;
  truncated_count: number | null;
  newest_highlight_seen: string | null;
}

export interface SyncStats {
  books_seen: number;
  books_synced: number;
  highlights_new: number;
  highlights_updated: number;
}

type Row = Record<string, unknown>;

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const sha1_16 = (s: string): string => createHash("sha1").update(s, "utf8").digest("hex").slice(0, 16);

/**
 * Normalize a title so cloud and clippings copies of one book land together.
 * Drops subtitles and punctuation: 'Thinking, Fast and Slow: A Book' -> 'thinking fast and slow'.
 */
export function titleKey(title: string): string {
  const base = title.split(/[:(\[]/)[0];
  return base
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

const head80 = (s: string): string => Array.from(s).slice(0, 80).join("");

export function locationId(bookId: string, h: Highlight): string {
  const anchor = h.locationStart !== null ? String(h.locationStart) : h.page || head80(h.text) || head80(h.note);
  return sha1_16(`${bookId}|${anchor}`);
}

/** Cloud annotations carry Amazon's own stable id; clippings fall back to (book, location). */
export function highlightId(bookId: string, h: Highlight): string {
  if (h.amazonId) return sha1_16(`${bookId}|amz|${h.amazonId}`);
  return locationId(bookId, h);
}

function rowToHighlight(r: Row): HighlightRow {
  const { raw_note: _raw, ...rest } = r;
  const commands = JSON.parse(String(r.commands ?? "[]")) as Command[];
  return { ...(rest as unknown as HighlightRow), commands: withActions(commands), truncated: Boolean(r.truncated) };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL"); // sync job and MCP server can share the file
    this.db.exec(SCHEMA);
    this.migrateIds();
  }

  /** Rows written before amazon_id became the key are re-keyed in place (one-time, idempotent). */
  private migrateIds(): void {
    const rows = this.db
      .prepare("SELECT id, book_id, amazon_id FROM highlights WHERE amazon_id IS NOT NULL")
      .all() as Array<{ id: string; book_id: string; amazon_id: string }>;
    for (const r of rows) {
      const fresh = sha1_16(`${r.book_id}|amz|${r.amazon_id}`);
      if (fresh !== r.id) {
        this.db.prepare("UPDATE highlights SET id=? WHERE id=?").run(fresh, r.id);
        this.db.prepare("UPDATE highlights_fts SET id=? WHERE id=?").run(fresh, r.id);
      }
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- books -------------------------------------------------------------
  /** Clippings has no ASIN; attach to an existing cloud book when titles match. */
  resolveBookId(book: Book): string {
    if (book.asin) return book.asin;
    const row = this.db
      .prepare("SELECT book_id FROM books WHERE title_key = ? ORDER BY asin IS NULL LIMIT 1")
      .get(titleKey(book.title)) as { book_id: string } | undefined;
    return row ? row.book_id : book.bookId;
  }

  upsertBook(book: Book): string {
    const bookId = this.resolveBookId(book);
    this.db
      .prepare(
        `INSERT INTO books (book_id, asin, title, author, title_key) VALUES (?,?,?,?,?)
         ON CONFLICT(book_id) DO UPDATE SET
           asin = COALESCE(excluded.asin, books.asin),
           title = CASE WHEN excluded.asin IS NOT NULL THEN excluded.title ELSE books.title END,
           author = CASE WHEN excluded.author != '' THEN excluded.author ELSE books.author END`,
      )
      .run(bookId, book.asin, book.title, book.author, titleKey(book.title));
    return bookId;
  }

  bookLastAnnotated(bookId: string): string | null {
    const row = this.db.prepare("SELECT last_annotated FROM books WHERE book_id=?").get(bookId) as
      | { last_annotated: string | null }
      | undefined;
    return row ? row.last_annotated : null;
  }

  markBookSynced(bookId: string, lastAnnotated: string | null): void {
    this.db.prepare("UPDATE books SET last_annotated=?, last_synced=? WHERE book_id=?").run(lastAnnotated, nowIso(), bookId);
  }

  // ---- highlights --------------------------------------------------------
  upsertHighlight(bookId: string, h: Highlight): UpsertResult {
    let hid = highlightId(bookId, h);
    let { commands, note: cleanNote } = parseCommands(h.note);
    let old = this.db.prepare("SELECT * FROM highlights WHERE id=?").get(hid) as Row | undefined;
    if (!old && !h.amazonId && h.locationStart !== null) {
      // A clippings entry merges into the cloud copy of the same highlight, if one exists.
      old = this.db
        .prepare("SELECT * FROM highlights WHERE book_id=? AND location_start=? ORDER BY amazon_id IS NULL LIMIT 1")
        .get(bookId, h.locationStart) as Row | undefined;
      if (old) hid = old.id as string;
    }
    const ts = nowIso();

    if (!old) {
      this.db
        .prepare(
          `INSERT INTO highlights (id, book_id, location_start, location_end, page, text, note, raw_note,
               color, truncated, source, highlighted_at, commands, first_seen, updated_at, amazon_id, position)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          hid, bookId, h.locationStart, h.locationEnd, h.page, h.text, cleanNote, h.note, h.color,
          h.truncated ? 1 : 0, h.source, h.highlightedAt, JSON.stringify(commands), ts, ts, h.amazonId, h.position,
        );
      this.reindex(hid);
      return "new";
    }

    // Fullest-copy merge.
    const oldText = String(old.text ?? "");
    const oldTruncated = Boolean(old.truncated);
    const takeText =
      (oldTruncated && !h.truncated && h.text !== "") ||
      (h.truncated === oldTruncated && h.text.length > oldText.length);
    const rawNote = h.note ? h.note : String(old.raw_note ?? "");
    const noteChanged = rawNote !== String(old.raw_note ?? "");
    if (noteChanged) ({ commands, note: cleanNote } = parseCommands(rawNote));
    const merged: Row = {
      text: takeText ? h.text : oldText,
      truncated: takeText ? (h.truncated ? 1 : 0) : (old.truncated as number),
      raw_note: rawNote,
      note: noteChanged ? cleanNote : old.note,
      commands: noteChanged ? JSON.stringify(commands) : old.commands,
      location_end: old.location_end ?? h.locationEnd,
      page: (old.page as string | null) || h.page,
      color: (old.color as string | null) || h.color,
      highlighted_at: (old.highlighted_at as string | null) || h.highlightedAt,
      amazon_id: (old.amazon_id as string | null) || h.amazonId,
      position: old.position ?? h.position,
    };
    if (Object.keys(merged).every((k) => (merged[k] ?? null) === (old![k] ?? null))) return "unchanged";
    // A rewritten command note becomes actionable again.
    const doneAt = noteChanged ? null : (old.commands_done_at as string | null);
    this.db
      .prepare(
        `UPDATE highlights SET text=:text, truncated=:truncated, raw_note=:raw_note, note=:note,
             commands=:commands, location_end=:location_end, page=:page, color=:color,
             highlighted_at=:highlighted_at, amazon_id=:amazon_id, position=:position,
             commands_done_at=:done_at, updated_at=:ts WHERE id=:id`,
      )
      .run({ ...merged, done_at: doneAt, ts, id: hid } as Record<string, string | number | null>);
    this.reindex(hid);
    return "updated";
  }

  private reindex(hid: string): void {
    this.db.prepare("DELETE FROM highlights_fts WHERE id=?").run(hid);
    this.db
      .prepare(
        `INSERT INTO highlights_fts (id, text, note, title, author)
         SELECT h.id, h.text, h.note, b.title, b.author FROM highlights h JOIN books b USING(book_id)
         WHERE h.id=?`,
      )
      .run(hid);
  }

  // ---- queries -----------------------------------------------------------
  private static readonly SELECT = "SELECT h.*, b.title, b.author, b.asin FROM highlights h JOIN books b USING(book_id)";

  private rows(sql: string, ...params: Array<string | number | null>): HighlightRow[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map(rowToHighlight);
  }

  listBooks(query: string | null = null, limit = 50, offset = 0): BookRow[] {
    let where = "";
    const args: Array<string | number> = [];
    if (query) {
      where = "WHERE b.title LIKE ? OR b.author LIKE ?";
      args.push(`%${query}%`, `%${query}%`);
    }
    return this.db
      .prepare(
        `SELECT b.book_id, b.title, b.author, b.asin, b.last_annotated, b.last_synced,
                COUNT(h.id) AS highlight_count, SUM(h.truncated) AS truncated_count,
                MAX(h.first_seen) AS newest_highlight_seen
         FROM books b LEFT JOIN highlights h USING(book_id) ${where}
         GROUP BY b.book_id ORDER BY newest_highlight_seen DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as unknown as BookRow[];
  }

  /** Accepts a book_id, ASIN, or a fragment of the title. */
  findBook(book: string): Row | null {
    let row = this.db.prepare("SELECT * FROM books WHERE book_id=? OR asin=?").get(book, book) as Row | undefined;
    if (!row) {
      row = this.db
        .prepare("SELECT * FROM books WHERE title LIKE ? ORDER BY LENGTH(title) LIMIT 1")
        .get(`%${book}%`) as Row | undefined;
    }
    return row ?? null;
  }

  getHighlights(bookId: string, limit = 100, offset = 0): HighlightRow[] {
    return this.rows(
      `${Store.SELECT} WHERE h.book_id=? ORDER BY h.location_start IS NULL, h.location_start LIMIT ? OFFSET ?`,
      bookId, limit, offset,
    );
  }

  getHighlight(id: string): HighlightRow | null {
    const rows = this.rows(`${Store.SELECT} WHERE h.id=?`, id);
    return rows[0] ?? null;
  }

  static ftsQuery(query: string): string {
    const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    return words.map((w) => `"${w}"`).join(" ");
  }

  search(query: string, limit = 20, excludeId: string | null = null): HighlightRow[] {
    const fts = Store.ftsQuery(query);
    if (!fts) return [];
    const exclude = excludeId ? "AND h.id != ?" : "";
    const params: Array<string | number> = excludeId ? [fts, excludeId, limit] : [fts, limit];
    return this.rows(
      `${Store.SELECT} JOIN highlights_fts f ON f.id = h.id
       WHERE highlights_fts MATCH ? ${exclude} ORDER BY bm25(highlights_fts) LIMIT ?`,
      ...params,
    );
  }

  /** Highlights from other books that share content words with the given text, best first. */
  related(text: string, excludeId: string, excludeBookId: string, limit = 5): HighlightRow[] {
    const words = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()));
    const distinct = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 12);
    if (!distinct.length) return [];
    const fts = distinct.map((w) => `"${w}"`).join(" OR ");
    return this.rows(
      `${Store.SELECT} JOIN highlights_fts f ON f.id = h.id
       WHERE highlights_fts MATCH ? AND h.id != ? AND h.book_id != ? ORDER BY bm25(highlights_fts) LIMIT ?`,
      fts, excludeId, excludeBookId, limit,
    );
  }

  /** Up to n highlights either side of a location in the same book, in reading order. */
  neighbours(bookId: string, locationStart: number | null, excludeId: string, n = 3): HighlightRow[] {
    if (locationStart === null) return [];
    const before = this.rows(
      `${Store.SELECT} WHERE h.book_id=? AND h.id != ? AND h.location_start IS NOT NULL AND h.location_start <= ?
       ORDER BY h.location_start DESC LIMIT ?`,
      bookId, excludeId, locationStart, n,
    ).reverse();
    const after = this.rows(
      `${Store.SELECT} WHERE h.book_id=? AND h.id != ? AND h.location_start > ? ORDER BY h.location_start LIMIT ?`,
      bookId, excludeId, locationStart, n,
    );
    return [...before, ...after];
  }

  /** Other highlights in the same book whose note carries the same @tag. */
  sameTagInBook(bookId: string, tag: string, excludeId: string, limit = 10): HighlightRow[] {
    return this.rows(
      `${Store.SELECT} WHERE h.book_id=? AND h.id != ? AND h.commands != '[]'
       ORDER BY h.location_start IS NULL, h.location_start LIMIT ?`,
      bookId, excludeId, 1000,
    )
      .filter((h) => h.commands.some((c) => c.tag === tag))
      .slice(0, limit);
  }

  newSince(sinceIso: string, limit = 200): HighlightRow[] {
    return this.rows(`${Store.SELECT} WHERE h.first_seen >= ? ORDER BY h.first_seen DESC, b.title LIMIT ?`, sinceIso, limit);
  }

  pendingCommands(tag: string | null = null, limit = 100): HighlightRow[] {
    const out = this.rows(
      `${Store.SELECT} WHERE h.commands != '[]' AND h.commands_done_at IS NULL ORDER BY h.first_seen LIMIT ?`,
      limit,
    );
    if (!tag) return out;
    const want = tag.toLowerCase().replace(/^@+/, "");
    return out.filter((h) => h.commands.some((c) => c.tag === want));
  }

  /** Pending highlights per tag, for status. */
  pendingByTag(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const h of this.pendingCommands(null, 100000)) {
      for (const tag of new Set(h.commands.map((c) => c.tag))) counts[tag] = (counts[tag] ?? 0) + 1;
    }
    return counts;
  }

  markCommandsDone(hid: string): boolean {
    const res = this.db.prepare("UPDATE highlights SET commands_done_at=? WHERE id=?").run(nowIso(), hid);
    return Number(res.changes) > 0;
  }

  // ---- sync bookkeeping --------------------------------------------------
  startRun(source: string): number {
    const res = this.db.prepare("INSERT INTO sync_runs (started_at, source) VALUES (?,?)").run(nowIso(), source);
    return Number(res.lastInsertRowid);
  }

  finishRun(runId: number, stats: Partial<SyncStats> & { error?: string } = {}): void {
    const keys = Object.keys(stats);
    const sets = keys.map((k) => `${k}=?`).join(", ");
    this.db
      .prepare(`UPDATE sync_runs SET finished_at=?${sets ? ", " + sets : ""} WHERE id=?`)
      .run(nowIso(), ...keys.map((k) => (stats as Record<string, string | number>)[k]), runId);
  }

  status(): {
    books: number;
    highlights: number;
    truncated_highlights: number;
    pending_commands: number;
    pending_by_tag: Record<string, number>;
    last_run: Row | null;
  } {
    const one = (sql: string): number => Number(Object.values(this.db.prepare(sql).get() as Row)[0]);
    const last = this.db.prepare("SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1").get() as Row | undefined;
    return {
      books: one("SELECT COUNT(*) FROM books"),
      highlights: one("SELECT COUNT(*) FROM highlights"),
      truncated_highlights: one("SELECT COUNT(*) FROM highlights WHERE truncated=1"),
      pending_commands: one("SELECT COUNT(*) FROM highlights WHERE commands!='[]' AND commands_done_at IS NULL"),
      pending_by_tag: this.pendingByTag(),
      last_run: last ?? null,
    };
  }
}

const STOPWORDS = new Set(
  ("that this with from have were they their there what when which while your about into than then them these " +
    "those been being because would could should also more most such only very just like over under after before " +
    "does done make made many much some same other others where here every each both between through during " +
    "people thing things think thought without within").split(" "),
);
