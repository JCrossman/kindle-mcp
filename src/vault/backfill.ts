/**
 * Links in highlights exported before: only when the user says yes. A block is touched only if
 * its text is still exactly what kindle-mcp wrote (links aside); in such a block, mentions of
 * vault notes become links, a 1.0 inline block id moves to its own line, and the old
 * "clipping limit" wording is corrected. Existing links, including ones the user added, stay.
 */
import { bookNotePath, metaOf, noteLine, TRUNCATED_TEXT, TRUNCATED_TEXT_V1 } from "../obsidian.js";
import type { HighlightRow } from "../store.js";
import type { FileContext } from "./file.js";
import { eolOf, VaultConflict } from "./write.js";

export interface BackfillPlan {
  blocks: number;
  links: number;
  files: Array<{ path: string; before: string; after: string; blocks: number; links: number }>;
  samples: Array<{ book: string; before: string; after: string }>;
}

const unlink = (s: string): string =>
  s.replace(/\[\[([^\]|\n]*)\|([^\]\n]*)\]\]/g, "$2").replace(/\[\[([^\]\n]*)\]\]/g, "$1");

interface Block {
  /** First line of the quote. */
  start: number;
  /** Line holding the id (inclusive). */
  end: number;
  /** Quote lines without their `> ` prefix; for inline ids, with the id removed. */
  content: string[];
  inline: boolean;
}

function findBlock(lines: string[], hid: string): Block | null {
  const idRe = new RegExp(`(^|\\s)\\^kh-${hid}[ \\t]*$`);
  const i = lines.findIndex((l) => idRe.test(l));
  if (i < 0) return null;
  let last = i;
  const inline = lines[i].trimStart().startsWith(">");
  if (!inline) {
    if (lines[i].trim() !== `^kh-${hid}`) return null;
    last = i - 1;
    while (last >= 0 && lines[last].trim() === "") last--;
    if (last < 0 || !lines[last].trimStart().startsWith(">")) return null;
  }
  let start = last;
  while (start > 0 && lines[start - 1].trimStart().startsWith(">")) start--;
  const content = lines.slice(start, last + 1).map((l) => l.replace(/^\s*>[ ]?/, ""));
  if (inline) content[content.length - 1] = content[content.length - 1].replace(new RegExp(`\\s*\\^kh-${hid}[ \\t]*$`), "");
  return { start, end: i, content, inline };
}

/** What kindle-mcp wrote for this highlight, as block content lines (1.0 inline form or 1.1 own-line form). */
function expected(h: HighlightRow, v1: boolean): { lines: string[]; quote: number; note: number | null; meta: number | null } {
  const body = h.text || (h.truncated ? (v1 ? TRUNCATED_TEXT_V1 : TRUNCATED_TEXT) : "");
  const lines = body ? body.split(/\r\n|\r|\n/) : [];
  const quote = lines.length;
  const noteText = v1 ? h.note.replace(/\n/g, " ") : noteLine(h);
  let note: number | null = null;
  if (noteText) {
    if (lines.length) lines.push("");
    note = lines.length;
    lines.push(`**Note:** ${noteText}`);
  }
  const meta = metaOf(h);
  let metaAt: number | null = null;
  if (meta || v1) {
    metaAt = lines.length;
    lines.push(meta ? `— ${meta}` : "");
  }
  if (!lines.length) lines.push("");
  return { lines, quote, note, meta: metaAt };
}

/** The new block lines for an unedited block, or null if the user changed it. */
function relink(ctx: FileContext, h: HighlightRow, block: Block, self: string): { lines: string[]; links: number } | null {
  const exp = expected(h, block.inline);
  if (block.content.length !== exp.lines.length || block.content.some((l, i) => unlink(l) !== exp.lines[i])) return null;
  const content = [...block.content];
  let links = 0;
  const seen = new Set<string>();
  const exclude = new Set([self]);
  if (h.text && exp.quote) {
    const r = ctx.linkNotes ? ctx.linker.linkify(content.slice(0, exp.quote).join("\n"), { exclude, seen, max: 5 }) : null;
    if (r) {
      content.splice(0, exp.quote, ...r.text.split("\n"));
      links += r.added;
    }
  } else if (h.truncated && content[0] === TRUNCATED_TEXT_V1) content[0] = TRUNCATED_TEXT;
  if (exp.note !== null && ctx.linkNotes) {
    const r = ctx.linker.linkify(content[exp.note].slice("**Note:** ".length), { exclude, seen, max: Math.max(0, 5 - links) });
    content[exp.note] = `**Note:** ${r.text}`;
    links += r.added;
  }
  const out = content.filter((l, i) => !(block.inline && exp.meta === i && l === ""));
  const lines = out.map((l) => (l ? `> ${l}` : ">"));
  return { lines: [...lines, "", `^kh-${h.id}`], links };
}

/** What a yes would change, book by book. */
export function planBackfill(ctx: FileContext, book: string | null = null): BackfillPlan {
  const plan: BackfillPlan = { blocks: 0, links: 0, files: [], samples: [] };
  const books = book ? [ctx.store.findBook(book)].filter(Boolean) : ctx.store.listBooks(null, 100000).filter((b) => b.highlight_count);
  for (const b of books as Array<Record<string, unknown>>) {
    const path = bookNotePath(ctx.store, { vault: ctx.vault, index: ctx.index }, b);
    const before = path ? ctx.vault.read(path) : null;
    if (!path || before === null) continue;
    const eol = eolOf(before);
    const lines = before.split(/\r?\n/);
    const edits: Array<{ start: number; end: number; lines: string[] }> = [];
    let blocks = 0;
    let links = 0;
    for (const h of ctx.store.getHighlights(b.book_id as string, 100000)) {
      const block = findBlock(lines, h.id);
      if (!block) continue;
      const next = relink(ctx, h, block, path);
      if (!next) continue;
      const old = lines.slice(block.start, block.end + 1);
      if (old.join("\n") === next.lines.join("\n")) continue;
      edits.push({ start: block.start, end: block.end, lines: next.lines });
      blocks++;
      links += next.links;
      if (next.links && plan.samples.length < 3) {
        plan.samples.push({ book: b.title as string, before: old.join("\n").slice(0, 300), after: next.lines.join("\n").slice(0, 400) });
      }
    }
    if (!edits.length) continue;
    edits.sort((a, c) => c.start - a.start);
    for (const e of edits) lines.splice(e.start, e.end - e.start + 1, ...e.lines);
    plan.files.push({ path, before, after: lines.join(eol), blocks, links });
    plan.blocks += blocks;
    plan.links += links;
  }
  return plan;
}

/** Applies the plan; a note that changed since it was read is left alone and reported. */
export function applyBackfill(ctx: FileContext, book: string | null = null): { blocks: number; links: number; conflicts: string[] } {
  const plan = planBackfill(ctx, book);
  const out = { blocks: 0, links: 0, conflicts: [] as string[] };
  for (const f of plan.files) {
    try {
      ctx.vault.replace(f.path, f.before, f.after);
      out.blocks += f.blocks;
      out.links += f.links;
    } catch (e) {
      if (!(e instanceof VaultConflict)) throw e;
      out.conflicts.push(f.path);
    }
  }
  return out;
}
