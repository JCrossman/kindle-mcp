/**
 * Edit-safe Obsidian export: one note per book.
 *
 * Each highlight is written once, as a quote block followed by its block id (^kh-<id>) on its
 * own line. On re-export we only append highlights whose block id is not already in the note,
 * so anything you edit, reorder or annotate in Obsidian is never overwritten. The note is found
 * by its frontmatter wherever you move it, and a note you delete is not recreated by a sync.
 */
import type { Command } from "./commands.js";
import type { BookRecord, HighlightRow, Store } from "./store.js";
import { yamlString } from "./vault/frontmatter.js";
import type { VaultIndex } from "./vault/index.js";
import type { Linker } from "./vault/linkify.js";
import { neutralize, Vault } from "./vault/write.js";

export interface ExportResult {
  /** Vault-relative path of the book note. */
  file: string;
  added: number;
  already_present: number;
  links_added: number;
  /** Set when the note was deleted in Obsidian and a sync left it that way. */
  skipped?: "deleted";
}

export interface ExportContext {
  vault: Vault;
  index?: VaultIndex | null;
  /** Links mentions of vault notes in new blocks; null to write them plain. */
  linker?: Linker | null;
  /** Recreate a book note even if the user deleted it (an explicit export does). */
  restore?: boolean;
}

/** The 1.0 file name for a book note. Never change it: existing notes are found by it. */
export function filename(title: string): string {
  return title.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim().slice(0, 120) || "Untitled";
}

function tag(command: Command): string {
  let t = `#kindle/${command.tag}`;
  if (command.tag === "project" && command.arg) t += "/" + command.arg.replace(/[^\p{L}\p{N}_-]/gu, "-");
  return t;
}

/** What a highlight with no text means: usually not a clipping limit, whatever the old wording said. */
export const TRUNCATED_TEXT =
  "*(Amazon didn't return this text: usually an image or table, sometimes the publisher's copy limit. See the book at this location.)*";
/** The 1.0 wording, still recognised in notes it wrote (and by the tests' 1.0 renderer). */
export const TRUNCATED_TEXT_V1 = "*(text withheld: publisher clipping limit)*";

export function whereOf(h: HighlightRow): string {
  let where = h.location_start !== null ? `Location ${h.location_start}` : "";
  if (h.page) where = `Page ${h.page}` + (where ? ` · ${where}` : "");
  return where;
}

/** The line under the quote: where it is and its @command tags. */
export function metaOf(h: HighlightRow): string {
  return [whereOf(h), h.commands.map(tag).join(" ")].filter(Boolean).join(" · ");
}

/** The note as it appears in the block: as typed on the Kindle, on one line. */
export const noteLine = (h: HighlightRow): string => (h.raw_note || h.note).replace(/\s*\n\s*/g, " ").trim();

export interface Rendered {
  text: string;
  links: number;
}

/**
 * A highlight as a quote block with its id on its own line (the form Obsidian documents for
 * quotes, so [[Book#^kh-id]] links land on it). With a linker, mentions of vault notes in the
 * text and the note become links.
 */
function renderBlock(h: HighlightRow, linker?: Linker | null, self?: string): Rendered {
  let body = h.text || (h.truncated ? TRUNCATED_TEXT : "");
  let note = noteLine(h);
  let links = 0;
  if (linker) {
    const seen = new Set<string>();
    const exclude = new Set(self ? [self] : []);
    if (h.text) {
      const r = linker.linkify(body, { exclude, seen, max: 5 });
      body = r.text;
      links += r.added;
    }
    if (note) {
      const r = linker.linkify(note, { exclude, seen, max: 5 - links });
      note = r.text;
      links += r.added;
    }
  }
  body = neutralize(body);
  note = neutralize(note);
  const lines = body ? body.split(/\r\n|\r|\n/).map((ln) => `> ${ln}`) : [];
  if (note) lines.push(...(lines.length ? [">"] : []), `> **Note:** ${note}`);
  const meta = metaOf(h);
  if (meta) lines.push(`> — ${meta}`);
  if (!lines.length) lines.push(">");
  return { text: `${lines.join("\n")}\n\n^kh-${h.id}`, links };
}

/** Highlight ids with a block in this text, inline or own-line; longer entry ids (^kh-<id>-todo-…) don't count. */
function existingBlockIds(text: string): Set<string> {
  return new Set([...text.matchAll(/\^kh-([0-9a-f]{16})(?![0-9A-Za-z-])/g)].map((m) => m[1]));
}

/** A book as the export needs it: a BookRecord, or a row of kindle_list_books. */
type ExportBook = Pick<BookRecord, "book_id" | "title" | "author" | "asin">;

function header(book: ExportBook): string {
  const { title, author } = book;
  const heading = neutralize(title).replace(/\s*\n\s*/g, " ");
  const byline = neutralize(author).replace(/\s*\n\s*/g, " ");
  return [
    "---",
    `title: ${yamlString(title)}`,
    `author: ${yamlString(author)}`,
    `asin: ${yamlString(book.asin ?? "")}`,
    "source: kindle",
    "tags: [kindle]",
    "---",
    "",
    `# ${heading}`,
    ...(byline ? [`*${byline}*`] : []),
    "",
    "## Highlights",
  ].join("\n");
}

/** Where a book's note is: where the user moved it, where it was written, or the default. Null if deleted. */
export function bookNotePath(store: Store, ctx: ExportContext, book: ExportBook): string | null {
  const found = ctx.index?.findBookNote(book.asin, book.title) ?? null;
  if (found && ctx.vault.exists(found)) return found;
  const recorded = store.bookNote(ctx.vault.root, book.book_id);
  if (recorded && ctx.vault.exists(recorded)) return recorded;
  const fallback = ctx.vault.k(`${filename(book.title)}.md`);
  if (recorded && !ctx.restore && !ctx.vault.exists(fallback)) return null; // deleted in Obsidian: leave it deleted
  return fallback;
}

export function exportBook(store: Store, bookRef: string, vaultOrCtx: string | ExportContext, folder = "Kindle"): ExportResult {
  const ctx: ExportContext = typeof vaultOrCtx === "string" ? { vault: Vault.open(vaultOrCtx, folder) } : vaultOrCtx;
  const book = store.findBook(bookRef);
  if (!book) throw new Error(`No book matches '${bookRef}'. Use kindle_list_books to see what is synced.`);
  const bookId = book.book_id;
  const highlights = store.getHighlights(bookId, 100000);
  const path = bookNotePath(store, ctx, book);
  if (!path) return { file: store.bookNote(ctx.vault.root, bookId) ?? "", added: 0, already_present: 0, links_added: 0, skipped: "deleted" };

  const existing = ctx.vault.read(path);
  const present = existing === null ? new Set<string>() : existingBlockIds(existing);
  const fresh = highlights.filter((h) => !present.has(h.id));
  let links = 0;
  const blocks = fresh.map((h) => {
    const r = renderBlock(h, ctx.linker, path);
    links += r.links;
    return r.text;
  });
  if (existing === null) ctx.vault.create(path, `${[header(book), ...blocks].join("\n\n")}\n`);
  else if (blocks.length) ctx.vault.append(path, blocks.join("\n\n"));
  store.setBookNote(ctx.vault.root, bookId, path);
  return { file: path, added: fresh.length, already_present: highlights.length - fresh.length, links_added: links };
}
