/**
 * Edit-safe Obsidian export: one note per book.
 *
 * Each highlight is written once, tagged with a block id (^kh-<id>). On re-export we only
 * append highlights whose block id is not already in the file, so anything you edit,
 * reorder, or annotate in Obsidian is never overwritten.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Command } from "./commands.js";
import type { HighlightRow, Store } from "./store.js";

export interface ExportResult {
  file: string;
  added: number;
  already_present: number;
}

function filename(title: string): string {
  return title.replace(/[\\/:*?"<>|#^\[\]]/g, "").trim().slice(0, 120) || "Untitled";
}

function tag(command: Command): string {
  let t = `#kindle/${command.tag}`;
  if (command.tag === "project" && command.arg) t += "/" + command.arg.replace(/[^\p{L}\p{N}_-]/gu, "-");
  return t;
}

export function renderHighlight(h: HighlightRow): string {
  let where = h.location_start !== null ? `Location ${h.location_start}` : "";
  if (h.page) where = `Page ${h.page}` + (where ? ` · ${where}` : "");
  const body = h.text || (h.truncated ? "*(text withheld: publisher clipping limit)*" : "");
  const lines = body ? body.split(/\r\n|\r|\n/).map((ln) => `> ${ln}`) : [];
  if (h.note) lines.push(...(lines.length ? [">"] : []), "> **Note:** " + h.note.replace(/\n/g, " "));
  const tags = h.commands.map(tag).join(" ");
  const meta = [where, tags].filter(Boolean).join(" · ");
  lines.push(meta ? `> — ${meta} ^kh-${h.id}` : `> ^kh-${h.id}`);
  return lines.join("\n");
}

export function existingBlockIds(text: string): Set<string> {
  return new Set([...text.matchAll(/\^kh-([0-9a-f]{16})/g)].map((m) => m[1]));
}

export function exportBook(store: Store, bookRef: string, vault: string, folder = "Kindle"): ExportResult {
  const book = store.findBook(bookRef);
  if (!book) throw new Error(`No book matches '${bookRef}'. Use kindle_list_books to see what is synced.`);
  const bookId = book.book_id as string;
  const title = book.title as string;
  const author = (book.author as string) || "";
  const highlights = store.getHighlights(bookId, 100000);
  const target = join(vault, folder, `${filename(title)}.md`);
  mkdirSync(dirname(target), { recursive: true });

  const exists = existsSync(target);
  let existing = exists
    ? readFileSync(target, "utf8")
    : [
        "---", `title: "${title}"`, `author: "${author}"`, `asin: ${(book.asin as string | null) ?? ""}`,
        "source: kindle", "tags: [kindle]", "---", "",
        `# ${title}`, author ? `*${author}*` : "", "", "## Highlights", "",
      ].join("\n");
  const present = existingBlockIds(existing);
  const fresh = highlights.filter((h) => !present.has(h.id));
  if (fresh.length) existing = existing.replace(/\n+$/, "") + "\n\n" + fresh.map(renderHighlight).join("\n\n") + "\n";
  if (fresh.length || !exists) writeFileSync(target, existing, "utf8");
  return { file: target, added: fresh.length, already_present: highlights.length - fresh.length };
}

export function exportAll(store: Store, vault: string, folder = "Kindle"): ExportResult[] {
  return store
    .listBooks(null, 100000)
    .filter((b) => b.highlight_count)
    .map((b) => exportBook(store, b.book_id, vault, folder));
}
