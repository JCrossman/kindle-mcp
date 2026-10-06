/**
 * A cache of the vault's notes: names, aliases, a few frontmatter fields, and full-text search.
 * Lives in its own file per vault (safe to delete; it is rebuilt). A refresh walks the folder tree
 * (cheap), then reads changed files within a time budget and picks up the rest next time.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { STOPWORDS, Store } from "../store.js";
import { readFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { Linker, type LinkableNote } from "./linkify.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
    path TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    size INTEGER NOT NULL,
    title TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    source TEXT,
    asin TEXT,
    fm_title TEXT,
    kindle_highlight TEXT,
    opt_out INTEGER NOT NULL DEFAULT 0,
    ignored INTEGER NOT NULL DEFAULT 0,
    parsed INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(path UNINDEXED, title, aliases, body, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** How much of each note is read: frontmatter and the start of the body are what matter. */
const READ_BYTES = 256 * 1024;
const BODY_CHARS = 64 * 1024;
const WALK_EVERY_MS = 30_000;

export interface IndexedNote extends LinkableNote {
  source: string | null;
  asin: string | null;
  fmTitle: string | null;
  kindleHighlight: string | null;
  excluded: boolean;
  optOut: boolean;
}

export interface RefreshResult {
  /** False when the time budget ran out; callers must not write to the vault on a partial index. */
  complete: boolean;
  notes: number;
  read: number;
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
}

export interface IndexOptions {
  /** The Kindle folder, e.g. `Kindle`: its Inbox lists are never link targets. */
  kindleFolder: string;
  /** Extra folders to leave out (KINDLE_LINK_EXCLUDE), on top of Obsidian's own exclusions. */
  exclude?: string[];
}

interface Exclusions {
  prefixes: string[];
  patterns: string[];
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** Obsidian's "Excluded files", its template folder and Templater's, plus our own setting. */
function exclusions(root: string, extra: string[]): Exclusions {
  const prefixes: string[] = [];
  const patterns: string[] = [];
  const folder = (s: string): string => s.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const app = readJson(join(root, ".obsidian", "app.json"));
  for (const f of (app?.userIgnoreFilters as unknown[]) ?? []) {
    if (typeof f !== "string" || !f.trim()) continue;
    const re = /^\/(.+)\/([a-z]*)$/.exec(f.trim());
    if (re) patterns.push(f.trim());
    else prefixes.push(f.trim().replace(/\\/g, "/").replace(/^\/+/, "")); // Obsidian matches these as path prefixes
  }
  const templates = readJson(join(root, ".obsidian", "templates.json"))?.folder;
  if (typeof templates === "string" && folder(templates)) prefixes.push(`${folder(templates)}/`);
  const templater = readJson(join(root, ".obsidian", "plugins", "templater-obsidian", "data.json"))?.templates_folder;
  if (typeof templater === "string" && folder(templater)) prefixes.push(`${folder(templater)}/`);
  for (const e of extra) if (folder(e)) prefixes.push(`${folder(e)}/`);
  return { prefixes, patterns };
}

function isExcluded(path: string, ex: Exclusions, compiled: RegExp[]): boolean {
  return ex.prefixes.some((p) => path.startsWith(p)) || compiled.some((re) => re.test(path));
}

function compile(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p)!;
    try {
      out.push(new RegExp(m[1], m[2].replace(/[gy]/g, "")));
    } catch {
      // an invalid pattern in the user's settings excludes nothing
    }
  }
  return out;
}

function readHead(path: string, size: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, READ_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export class VaultIndex {
  private readonly db: DatabaseSync;
  private readonly ex: Exclusions;
  private readonly compiled: RegExp[];

  private constructor(
    /** Real path of the vault root. */
    readonly root: string,
    dbPath: string,
    private readonly opts: IndexOptions,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA);
    this.ex = exclusions(root, opts.exclude ?? []);
    this.compiled = compile(this.ex.patterns);
  }

  /** One cache file per vault, named by a hash of its real path. */
  static open(home: string, vaultRoot: string, opts: IndexOptions): VaultIndex {
    const hash = createHash("sha1").update(vaultRoot).digest("hex").slice(0, 8);
    return new VaultIndex(vaultRoot, join(home, `vault-index-${hash}.db`), opts);
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  private excluded(path: string): boolean {
    return isExcluded(path, this.ex, this.compiled);
  }

  /** The `.md` files under the vault, skipping dot folders, node_modules and symlinks. Null when out of time. */
  private walk(deadline: number): Map<string, { mtime: number; size: number }> | null {
    const files = new Map<string, { mtime: number; size: number }>();
    const stack = [""];
    let seen = 0;
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(join(this.root, dir), { withFileTypes: true });
      } catch {
        continue; // unreadable folder: skip it
      }
      for (const e of entries) {
        if (++seen % 500 === 0 && Date.now() > deadline) return null;
        if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) stack.push(rel);
        else if (e.isFile() && /\.md$/i.test(e.name)) {
          try {
            const st = statSync(join(this.root, rel));
            files.set(rel, { mtime: Math.floor(st.mtimeMs), size: st.size });
          } catch {
            // vanished or unreadable: leave it out
          }
        }
      }
    }
    return files;
  }

  /**
   * Brings the cache up to date: new, changed and deleted notes. Reads stop at `deadline`; the
   * result says whether everything was read. Walks at most every 30 s unless `force`.
   */
  refresh(deadline = Number.POSITIVE_INFINITY, force = false): RefreshResult {
    const exKey = JSON.stringify([this.ex, this.opts.kindleFolder]);
    if (this.meta("exclusions") !== exKey) {
      this.db.exec("UPDATE notes SET parsed = 0");
      this.setMeta("exclusions", exKey);
      force = true;
    }
    const count = (sql: string): number => Number((this.db.prepare(sql).get() as { n: number }).n);
    const walkedAt = Number(this.meta("walked_at") ?? 0);
    if (!force && Date.now() - walkedAt < WALK_EVERY_MS && count("SELECT COUNT(*) AS n FROM notes WHERE parsed = 0") === 0) {
      return { complete: true, notes: count("SELECT COUNT(*) AS n FROM notes"), read: 0 };
    }

    const files = this.walk(deadline);
    if (!files) return { complete: false, notes: count("SELECT COUNT(*) AS n FROM notes"), read: 0 };
    const known = new Map(
      (this.db.prepare("SELECT path, mtime_ms, size FROM notes").all() as Array<{ path: string; mtime_ms: number; size: number }>).map(
        (r) => [r.path, r],
      ),
    );
    const upsert = this.db.prepare(
      `INSERT INTO notes (path, mtime_ms, size, title, ignored, parsed) VALUES (?,?,?,?,?,0)
       ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, size=excluded.size, parsed=0`,
    );
    const drop = this.db.prepare("DELETE FROM notes WHERE path=?");
    const dropFts = this.db.prepare("DELETE FROM notes_fts WHERE path=?");
    this.db.exec("BEGIN");
    try {
      for (const path of known.keys()) {
        if (!files.has(path)) {
          drop.run(path);
          dropFts.run(path);
        }
      }
      for (const [path, st] of files) {
        const k = known.get(path);
        if (k && k.mtime_ms === st.mtime && k.size === st.size) continue;
        const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
        upsert.run(path, st.mtime, st.size, title, this.excluded(path) ? 1 : 0);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    const todo = this.db.prepare("SELECT path, size FROM notes WHERE parsed = 0").all() as Array<{ path: string; size: number }>;
    const update = this.db.prepare(
      `UPDATE notes SET aliases=?, source=?, asin=?, fm_title=?, kindle_highlight=?, opt_out=?, ignored=?, parsed=1 WHERE path=?`,
    );
    const addFts = this.db.prepare("INSERT INTO notes_fts (path, title, aliases, body) VALUES (?,?,?,?)");
    let read = 0;
    let complete = true;
    for (let i = 0; i < todo.length; i += 200) {
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
      this.db.exec("BEGIN");
      try {
        for (const { path, size } of todo.slice(i, i + 200)) {
          if (Date.now() > deadline) {
            complete = false;
            break;
          }
          let text = "";
          try {
            text = readHead(join(this.root, path), size);
          } catch {
            // unreadable: indexed by name only
          }
          const fm = readFrontmatter(text);
          const excluded = this.excluded(path);
          const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
          update.run(JSON.stringify(fm.aliases), fm.source, fm.asin, fm.title, fm.kindleHighlight, fm.linkOptOut ? 1 : 0, excluded ? 1 : 0, path);
          dropFts.run(path);
          if (!excluded && !fm.linkOptOut) {
            const start = splitFrontmatter(text).bodyStart;
            addFts.run(path, title, fm.aliases.join(" "), text.slice(start, start + BODY_CHARS));
          }
          read++;
        }
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    this.setMeta("walked_at", String(Date.now()));
    return { complete, notes: files.size, read };
  }

  notes(): IndexedNote[] {
    const inbox = `${this.opts.kindleFolder}/Inbox/`;
    const rows = this.db
      .prepare("SELECT path, title, aliases, source, asin, fm_title, kindle_highlight, opt_out, ignored FROM notes")
      .all() as Array<{
      path: string; title: string; aliases: string; source: string | null; asin: string | null; fm_title: string | null;
      kindle_highlight: string | null; opt_out: number; ignored: number;
    }>;
    return rows.map((r) => ({
      path: r.path,
      title: r.title,
      aliases: JSON.parse(r.aliases) as string[],
      source: r.source,
      asin: r.asin,
      fmTitle: r.fm_title,
      kindleHighlight: r.kindle_highlight,
      excluded: Boolean(r.ignored),
      optOut: Boolean(r.opt_out),
      linkable: !r.ignored && !r.opt_out && !r.path.startsWith(inbox),
    }));
  }

  linker(): Linker {
    return new Linker(this.notes());
  }

  /** Book notes kindle-mcp wrote, found by frontmatter wherever the user moved them. */
  findBookNote(asin: string | null, title: string): string | null {
    const rows = (
      asin
        ? this.db.prepare("SELECT path FROM notes WHERE source='kindle' AND asin=? ORDER BY length(path)").all(asin)
        : this.db.prepare("SELECT path FROM notes WHERE source='kindle' AND (asin IS NULL OR asin='') AND fm_title=? ORDER BY length(path)").all(title)
    ) as Array<{ path: string }>;
    return rows[0]?.path ?? null;
  }

  /** Notes kindle-mcp wrote for one highlight's @command. */
  outputsFor(highlightId: string): string[] {
    return (this.db.prepare("SELECT path FROM notes WHERE kindle_highlight=?").all(highlightId) as Array<{ path: string }>).map((r) => r.path);
  }

  /** Full-text search over note titles, aliases and text. The Kindle folder is left out unless asked. */
  search(query: string, limit = 8, includeKindle = false): SearchHit[] {
    const fts = Store.ftsQuery(query);
    return fts ? this.match(fts, limit, includeKindle) : [];
  }

  /** Notes that share the most distinctive words with a text (for related notes). */
  related(text: string, limit = 5): SearchHit[] {
    const words = (text.match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 3 && !STOPWORDS.has(w.toLowerCase()));
    const distinct = [...new Set(words.map((w) => w.toLowerCase()))].slice(0, 12);
    return distinct.length ? this.match(distinct.map((w) => `"${w}"`).join(" OR "), limit, false) : [];
  }

  private match(fts: string, limit: number, includeKindle: boolean): SearchHit[] {
    const prefix = `${this.opts.kindleFolder}/`;
    const skip = includeKindle ? "" : "AND substr(path, 1, ?) != ?";
    const args: Array<string | number> = [fts];
    if (!includeKindle) args.push(prefix.length, prefix);
    args.push(limit);
    try {
      return this.db
        .prepare(
          `SELECT path, title, snippet(notes_fts, 3, '', '', '...', 16) AS snippet FROM notes_fts
           WHERE notes_fts MATCH ? ${skip} ORDER BY bm25(notes_fts, 0, 10, 5, 1) LIMIT ?`,
        )
        .all(...args) as unknown as SearchHit[];
    } catch {
      return [];
    }
  }
}
