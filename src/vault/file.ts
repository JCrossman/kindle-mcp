/**
 * Files @commands into the vault: the sync does @todo, @quote, @project and anything it can't
 * route; kindle_complete_command does @post and @research with the agent's text. Every entry
 * links back to its highlight's block and carries its own block id, and nothing is written twice:
 * a recorded output, the entry's id already in the file, or a 1.0 router entry all count as done.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { COMMANDS, commandSpec, resolveTag, type Command } from "../commands.js";
import { bookNotePath, type ExportContext, whereOf } from "../obsidian.js";
import { commandKey, type HighlightRow, type Store } from "../store.js";
import { readFrontmatter, yamlString } from "./frontmatter.js";
import type { IndexedNote, VaultIndex } from "./index.js";
import { fold, linkTarget, type Linker } from "./linkify.js";
import { eolOf, hasBlockId, insertUnderHeading, neutralize, sanitizeName, VaultConflict, VaultError, type Vault } from "./write.js";

export interface FileContext {
  store: Store;
  vault: Vault;
  index: VaultIndex;
  linker: Linker;
  /** Link mentions of vault notes in agent notes (KINDLE_LINK_NOTES). */
  linkNotes: boolean;
}

export type FileOutcome = "filed" | "found" | "unrouted";

/** For a tag no note answers to: what the user may have meant. Never acted on without them. */
export interface Suggestion {
  /** A built-in command one typo away, e.g. `todo` for `@tood`. */
  did_you_mean?: string;
  /** Up to three note titles the tag looks like (prefix, initials, or letters and numbers). */
  candidates?: string[];
}

export interface Filed {
  highlight_id: string;
  tag: string;
  arg: string;
  outcome: FileOutcome;
  /** Vault-relative path of the file the entry is in. */
  to: string;
  reason?: string;
  suggestion?: Suggestion;
}

const LQ = String.fromCharCode(0x201c);
const RQ = String.fromCharCode(0x201d);
const sha = (s: string): string => createHash("sha1").update(s, "utf8").digest("hex");
const normArg = (s: string): string => s.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** `kh-<highlight>-<tag>[-<4 hex of the argument>]`: stable, unique per command, valid in Obsidian. */
export function blockIdFor(hid: string, c: Command): string {
  const slug = c.tag.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "cmd";
  const arg = normArg(c.arg);
  return `kh-${hid}-${slug}${arg ? `-${sha(arg).slice(0, 4)}` : ""}`;
}

/** `Title, Location 12` or `Title, Page 7`: link display text, without characters a link can't hold. */
function citation(h: HighlightRow): string {
  const title = h.title.replace(/[[\]|#^]/g, "").trim();
  const where = h.location_start !== null ? `Location ${h.location_start}` : h.page ? `Page ${h.page}` : "";
  return where ? `${title}, ${where}` : title;
}

/** `[[<book note>#^kh-<id>|Title, Location N]]`, or plain text when the book note was deleted. */
export function sourceLink(ctx: FileContext, h: HighlightRow, bookPath: string): string {
  if (!ctx.vault.exists(bookPath)) return citation(h);
  return `[[${ctx.linker.linkText(bookPath)}#^kh-${h.id}|${citation(h)}]]`;
}

function excerpt(h: HighlightRow, max = 140): string {
  const t = oneLine(h.text);
  if (!t) return "";
  const cut = Array.from(t).length > max ? `${Array.from(t).slice(0, max - 1).join("").trimEnd()}...` : t;
  return `${LQ}${cut}${RQ}`;
}

/** The book note a highlight's block lives in (the export writes it first). */
function bookPathFor(ctx: FileContext, h: HighlightRow): string {
  const book = ctx.store.findBook(h.book_id);
  const ectx: ExportContext = { vault: ctx.vault, index: ctx.index, restore: true };
  return (book && bookNotePath(ctx.store, ectx, book)) || ctx.vault.k(`${h.title}.md`);
}

function quoteBlock(h: HighlightRow, link: string, withNote: boolean): string {
  const lines = oneLine(h.text) ? h.text.split(/\r\n|\r|\n/).map((l) => `> ${l}`) : [];
  if (withNote && h.note) lines.push(...(lines.length ? [">"] : []), `> **Note:** ${oneLine(h.note)}`);
  lines.push(`> ${String.fromCharCode(0x2014)} ${h.author ? `${h.author}, ` : ""}${link}`);
  return lines.join("\n");
}

/** Old 1.0 router sinks: an entry there ending in the bare ^kh-<id> means the command was done. */
function legacyDone(ctx: FileContext, h: HighlightRow, c: Command): string | null {
  const inbox = ctx.vault.k("Inbox");
  const files: Record<string, string[]> = {
    todo: [`${inbox}/Todo.md`],
    quote: [`${inbox}/Quotes.md`],
    post: [`${inbox}/Posts.md`],
    research: [`${inbox}/Research.md`],
    project: c.arg ? [`${inbox}/Projects/${c.arg}.md`] : [],
  };
  for (const f of files[c.tag] ?? [`${inbox}/Unrouted.md`]) {
    let text: string | null = null;
    try {
      text = ctx.vault.read(f);
    } catch {
      continue; // an argument that isn't a usable path had no 1.0 file either
    }
    if (text && hasBlockId(text, `kh-${h.id}`)) return f;
  }
  return null;
}

export interface ProjectTarget {
  path?: string;
  create?: boolean;
  ambiguous?: string[];
}

/** How names compare: case, spaces, hyphens and underscores don't matter; trailing punctuation is dropped. */
const nameKey = (s: string): string =>
  fold(s.normalize("NFC").replace(/[.,;:!?)"'\]]+$/, "")).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Notes that can receive entries: not excluded, not kindle-mcp's own lists, book notes or written
 * outputs. A tag nobody defined (`implicit`) also skips notes marked `kindle-link: false`.
 */
function targetNotes(ctx: FileContext, implicit: boolean): IndexedNote[] {
  const kindle = `${ctx.vault.folder}/`;
  const own = (p: string): boolean => p.startsWith(`${kindle}Inbox/`) && !p.startsWith(`${kindle}Inbox/Projects/`);
  return ctx.index
    .notes()
    .filter((n) => !n.excluded && !own(n.path) && n.source !== "kindle" && !n.kindleHighlight && !(implicit && n.optOut));
}

/** The one note in `pool` named or aliased `name`: your notes before kindle-mcp's, a name before an alias. */
function matchIn(ctx: FileContext, pool: IndexedNote[], rawName: string): { path: string } | { ambiguous: string[] } | null {
  const want = nameKey(rawName);
  if (!want) return null;
  const kindle = `${ctx.vault.folder}/`;
  const candidates = pool
    .map((n) => {
      const byTitle = nameKey(n.title) === want;
      const byAlias = !byTitle && n.aliases.some((a) => nameKey(a) === want);
      if (!byTitle && !byAlias) return null;
      return { path: n.path, rank: (n.path.startsWith(kindle) ? 2 : 0) + (byTitle ? 0 : 1) };
    })
    .filter((x): x is { path: string; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path));
  if (!candidates.length) return null;
  const best = candidates.filter((c) => c.rank === candidates[0].rank);
  return best.length === 1 ? { path: best[0].path } : { ambiguous: best.map((b) => b.path) };
}

/**
 * The note named or aliased <name> (spaces, hyphens and underscores alike, trailing punctuation
 * ignored), if exactly one is the best match; two equally good matches are ambiguous.
 */
export function matchNote(ctx: FileContext, rawName: string, implicit = false): { path: string } | { ambiguous: string[] } | null {
  return matchIn(ctx, targetNotes(ctx, implicit), rawName);
}

/** The note @project <name> goes to: the note named or aliased <name>, otherwise Projects/<name>.md. */
export function resolveProject(ctx: FileContext, rawName: string): ProjectTarget {
  const found = matchNote(ctx, rawName);
  if (found) return found;
  const name = rawName.normalize("NFC").replace(/[.,;:!?)"'\]]+$/, "").trim();
  const safe = sanitizeName(name.replace(/[-_]+/g, " ")) ?? "Project";
  const path = ctx.vault.k(`Projects/${safe}.md`);
  return ctx.vault.exists(path) ? { path } : { path, create: true };
}

function appendList(ctx: FileContext, path: string, heading: string, entry: string): void {
  if (!ctx.vault.exists(path)) ctx.vault.create(path, `# ${heading}\n\n${entry}\n`);
  else ctx.vault.append(path, entry);
}

/** Adds an entry at the end of a note's `From Kindle` section (made if missing), once per block id. */
function addUnderFromKindle(ctx: FileContext, path: string, entry: string, id: string, createWith: string | null): void {
  if (createWith !== null) {
    const title = path.split("/").pop()!.replace(/\.md$/, "");
    if (ctx.vault.create(path, `---\ntags: [${createWith}]\n---\n# ${title}\n\n## From Kindle\n\n${entry}\n`)) return;
  }
  const text = ctx.vault.read(path) ?? "";
  if (hasBlockId(text, id)) return;
  const plan = insertUnderHeading(text, "From Kindle", entry);
  if ("append" in plan) ctx.vault.append(path, plan.append);
  else ctx.vault.replace(path, text, plan.text);
}

// ---- tags no command owns -------------------------------------------------

const tagKey = (vault: Vault, tag: string): string => `tag:${vault.root}:${tag}`;

/** A tag the user pointed at a note once (kindle_teach_tag), per vault. */
export interface LearnedTag {
  tag: string;
  path: string;
  title: string;
}

function parseLearned(tag: string, value: string | null): LearnedTag | null {
  if (!value) return null;
  try {
    const o = JSON.parse(value) as { path?: unknown; title?: unknown };
    if (typeof o.path !== "string") return null;
    return { tag, path: o.path, title: typeof o.title === "string" ? o.title : o.path };
  } catch {
    return null;
  }
}

export function learnedTag(store: Store, vault: Vault, tag: string): LearnedTag | null {
  return parseLearned(tag, store.getState(tagKey(vault, tag)));
}

export function learnedTags(store: Store, vault: Vault): LearnedTag[] {
  const prefix = tagKey(vault, "");
  return store
    .statesWithPrefix(prefix)
    .map(({ key, value }) => parseLearned(key.slice(prefix.length), value))
    .filter((t): t is LearnedTag => t !== null);
}

/** Where an unknown tag goes: the note the user chose for it, else the one note named like it. */
function tagTarget(ctx: FileContext, tag: string): { path: string } | { ambiguous: string[] } | { gone: string } | null {
  const learned = learnedTag(ctx.store, ctx.vault, tag);
  if (learned) {
    let there = false;
    try {
      there = ctx.vault.exists(learned.path);
    } catch {
      // a path we may no longer write through counts as gone
    }
    return there ? { path: learned.path } : { gone: learned.title };
  }
  return matchNote(ctx, tag, true);
}

const BUILT_IN = COMMANDS.map((c) => c.tag);

/** Edit distance where swapping two neighbouring letters counts as one edit. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How well a tag fits a note name: 0 prefix, 1 initials, 2 letters and numbers, 3 a whole word; null if not. */
function fit(tag: string, name: string): number | null {
  const n = nameKey(name);
  if (!n || n === tag) return null;
  const words = n.split(" ");
  if (tag.length >= 3 && n.startsWith(tag)) return 0;
  const letters = tag.replace(/[^\p{L}]/gu, "");
  if (words.length >= 2 && letters.length >= 2 && letters === tag.replace(/ /g, "") && words.map((w) => w[0]).join("") === letters) return 1;
  const runs = tag.match(/\p{L}+|\p{N}+/gu) ?? [];
  const alpha = runs.filter((r) => /\p{L}/u.test(r));
  const digits = runs.filter((r) => /\p{N}/u.test(r));
  if (alpha.length && digits.length && alpha.every((r) => r.length >= 2 && words.some((w) => w.startsWith(r)))) {
    if (digits.every((d) => new RegExp(`(^|[^\\p{N}])${d}`, "u").test(n))) return 2;
  }
  if (tag.length >= 3 && words.includes(tag)) return 3;
  return null;
}

/** What an unplaced tag may have meant: a built-in one typo away, and up to three notes it looks like. */
export function suggestFor(ctx: FileContext, rawTag: string): Suggestion {
  const tag = nameKey(rawTag);
  const out: Suggestion = {};
  if (tag.length >= 3) {
    const near = BUILT_IN.map((b) => ({ b, d: editDistance(tag.replace(/ /g, ""), b) }))
      .filter((x) => x.d > 0 && x.d <= (tag.length >= 6 ? 2 : 1))
      .sort((x, y) => x.d - y.d);
    if (near.length) out.did_you_mean = near[0].b;
  }
  const scored = targetNotes(ctx, true)
    .map((n) => {
      const fits = [n.title, ...n.aliases].map((name) => fit(tag, name)).filter((s): s is number => s !== null);
      return fits.length ? { title: n.title, score: Math.min(...fits) } : null;
    })
    .filter((x): x is { title: string; score: number } => x !== null)
    .sort((a, b) => a.score - b.score || a.title.length - b.title.length || a.title.localeCompare(b.title));
  const titles = [...new Set(scored.map((s) => s.title))].slice(0, 3);
  if (titles.length) out.candidates = titles;
  return out;
}

/** The Unrouted line for one command, exactly as the sync writes it. */
function unroutedLine(h: HighlightRow, c: Command, reason: string, quote: string, link: string, id: string): string {
  const what = `\`@${c.tag}${c.arg ? ` ${oneLine(c.arg)}` : ""}\``;
  const note = h.note ? ` — note: ${LQ}${oneLine(h.note)}${RQ}` : "";
  return `- ${what} ${reason}${note} — ${quote ? `${quote} — ` : ""}${link} ^${id}`;
}

const UNKNOWN_REASON = "is not a known command";
const ambiguousReason = (tag: string, paths: string[]): string =>
  `matches ${paths.length} notes (${paths.join(", ")}); tell Claude which one @${tag} means`;
const goneReason = (tag: string, title: string): string => `was going to ${title}, which is gone; tell Claude where @${tag} goes now`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARK = "\u0000";
/** Any reason above for one tag, as a pattern (the variable parts match any text on the line). */
function reasonPattern(tag: string): string {
  const any = "[^\\n]*";
  return [
    escapeRe(UNKNOWN_REASON),
    escapeRe(ambiguousReason(tag, [MARK])).replace(escapeRe(`1 notes (${MARK})`), `\\d+ notes \\(${any}\\)`),
    escapeRe(goneReason(tag, MARK)).replace(MARK, any),
  ].join("|");
}

/**
 * Files one sync-type command (or an unknown / incomplete one to Unrouted). Callers hold the
 * vault lease and pass only commands that are not done yet.
 */
export function fileCommand(ctx: FileContext, h: HighlightRow, c: Command): Filed {
  const base = { highlight_id: h.id, tag: c.tag, arg: c.arg };
  const legacy = legacyDone(ctx, h, c);
  if (legacy) {
    ctx.store.recordOutput(h, c, { via: "sync", path: legacy });
    return { ...base, outcome: "found", to: legacy };
  }
  const spec = commandSpec(c.tag);
  const bookPath = bookPathFor(ctx, h);
  const link = sourceLink(ctx, h, bookPath);
  const id = blockIdFor(h.id, c);
  const quote = excerpt(h);

  const unrouted = (reason: string, suggestion?: Suggestion): Filed => {
    const path = ctx.vault.k("Inbox/Unrouted.md");
    const text = ctx.vault.read(path);
    if (!text || !hasBlockId(text, id)) appendList(ctx, path, "Kindle: unrouted", unroutedLine(h, c, reason, quote, link, id));
    ctx.store.recordOutput(h, c, { via: "sync", path, blockId: id });
    return { ...base, outcome: "unrouted", to: path, reason, ...(suggestion && Object.keys(suggestion).length ? { suggestion } : {}) };
  };

  if (!spec) {
    // A tag no command owns: the note the user chose for it, else the one note named like it. Never a guess.
    const target = tagTarget(ctx, c.tag);
    if (!target) return unrouted(UNKNOWN_REASON, suggestFor(ctx, c.tag));
    if ("ambiguous" in target) return unrouted(ambiguousReason(c.tag, target.ambiguous));
    if ("gone" in target) return unrouted(goneReason(c.tag, target.gone));
    addUnderFromKindle(ctx, target.path, `${quoteBlock(h, link, true)}\n\n^${id}`, id, null);
    ctx.store.recordOutput(h, c, { via: "sync", path: target.path, blockId: id });
    return { ...base, outcome: "filed", to: target.path };
  }
  if (spec.argRequired && !c.arg.trim()) return unrouted(c.tag === "project" ? "needs a project name" : "needs the task text");
  if (spec.doneBy !== "sync") throw new Error(`@${c.tag} is written by the agent, not filed`);

  let path: string;
  if (c.tag === "todo") {
    path = ctx.vault.k("Inbox/Todo.md");
    const text = ctx.vault.read(path);
    if (!text || !hasBlockId(text, id)) {
      appendList(ctx, path, "Kindle to-dos", `- [ ] ${oneLine(c.arg)} — ${quote ? `${quote} — ` : ""}${link} ^${id}`);
    }
  } else if (c.tag === "quote") {
    path = ctx.vault.k("Inbox/Quotes.md");
    const text = ctx.vault.read(path);
    if (!text || !hasBlockId(text, id)) appendList(ctx, path, "Kindle quotes", `${quoteBlock(h, link, false)}\n\n^${id}`);
  } else {
    const target = resolveProject(ctx, c.arg);
    if (target.ambiguous) {
      return unrouted(`matches ${target.ambiguous.length} notes (${target.ambiguous.join(", ")}); rename one or add the name as an alias to the one you mean`);
    }
    path = target.path!;
    addUnderFromKindle(ctx, path, `${quoteBlock(h, link, true)}\n\n^${id}`, id, target.create ? "kindle/project" : null);
  }
  ctx.store.recordOutput(h, c, { via: "sync", path, blockId: id });
  return { ...base, outcome: "filed", to: path };
}

/** A note by vault-relative path, or by exact name or alias, in `pool`. */
function findIn(ctx: FileContext, pool: IndexedNote[], query: string): { path: string } | { ambiguous: string[] } | null {
  const q = query.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (q.includes("/") || /\.md$/i.test(q)) {
    const rel = /\.md$/i.test(q) ? q : `${q}.md`;
    const hit = pool.find((n) => n.path === rel) ?? pool.find((n) => n.path.toLowerCase() === rel.toLowerCase());
    return hit ? { path: hit.path } : null;
  }
  return matchIn(ctx, pool, q);
}

export interface TeachResult {
  tag: string;
  /** The note the tag now goes to; null when it was forgotten. */
  note: string | null;
  link?: string;
  created?: boolean;
  /** Entries moved out of Unrouted into the note. */
  moved: number;
  /** Entries filed into the note whose Unrouted line was edited, so it was left there. */
  left_in_unrouted: number;
}

/**
 * Points a tag no command owns at a note, on the user's word: future uses file there, and the
 * ones waiting in Unrouted move now. An Unrouted line is removed only if it is still exactly as
 * the sync wrote it. No note: the tag is forgotten. Callers hold the vault lease.
 */
export function teachTag(ctx: FileContext, rawTag: string, rawNote: string | null): TeachResult {
  const tag = rawTag.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z][\w-]*$/.test(tag)) throw new VaultError(`'${rawTag}' isn't a tag. A tag is @ and a word, like @roadmap.`);
  if (commandSpec(resolveTag(tag))) throw new VaultError(`@${tag} is a built-in command, so it can't point at a note.`);
  if (!rawNote?.trim()) {
    ctx.store.deleteState(tagKey(ctx.vault, tag));
    return { tag, note: null, moved: 0, left_in_unrouted: 0 };
  }

  let path: string;
  let created = false;
  const found = findIn(ctx, targetNotes(ctx, false), rawNote);
  if (found && "ambiguous" in found) {
    throw new VaultError(`More than one note is called that: ${found.ambiguous.join(", ")}. Pass the path of the one you mean.`);
  }
  if (found) path = found.path;
  else {
    if (/[/\\]|\.md$/i.test(rawNote.trim())) {
      throw new VaultError(`There is no note kindle-mcp may file into at ${rawNote.trim()}. Pass a note's name or its path in the vault.`);
    }
    const name = sanitizeName(rawNote.trim());
    if (!name) throw new VaultError(`'${rawNote}' can't be a note name.`);
    path = ctx.vault.k(`Topics/${name}.md`);
    if (!ctx.vault.exists(path)) {
      created = ctx.vault.create(path, `---\ntags: [kindle/topic]\n---\n# ${name}\n\n## From Kindle\n`);
    }
  }
  const title = path.split("/").pop()!.replace(/\.md$/, "");
  ctx.store.setState(tagKey(ctx.vault, tag), JSON.stringify({ path, title }));

  // Move what is waiting in Unrouted.
  const inbox = ctx.vault.k("Inbox/Unrouted.md");
  const removals: Array<{ id: string; line: RegExp }> = [];
  let moved = 0;
  for (const out of ctx.store.outputsAt(tag, inbox)) {
    const h = ctx.store.getHighlight(out.highlight_id);
    const c = h?.commands.find((x) => x.tag === tag && commandKey(x, h.note) === out.command_key);
    if (!h || !c) continue;
    const id = blockIdFor(h.id, c);
    const link = sourceLink(ctx, h, bookPathFor(ctx, h));
    addUnderFromKindle(ctx, path, `${quoteBlock(h, link, true)}\n\n^${id}`, id, null);
    ctx.store.moveOutput(h.id, out.command_key, path, id);
    moved++;
    // The line as the sync wrote it, with any reason it gives for this tag.
    const [head, tail] = unroutedLine(h, c, MARK, excerpt(h), link, id).split(MARK).map(escapeRe);
    removals.push({ id, line: new RegExp(`^${head}(?:${reasonPattern(tag)})${tail}$`) });
  }

  let left = 0;
  if (removals.length) {
    const text = ctx.vault.read(inbox);
    if (text === null) left = 0;
    else {
      const eol = eolOf(text);
      const lines = text.split(/\r?\n/);
      const keep: string[] = [];
      let removed = 0;
      for (let i = 0; i < lines.length; i++) {
        const r = removals.find((x) => x.line.test(lines[i]));
        if (!r) {
          keep.push(lines[i]);
          continue;
        }
        removed++;
        // Entries are separated by a blank line: drop one with the entry so no gap is left behind.
        if (lines[i + 1] === "" && (keep.length === 0 || keep[keep.length - 1] === "")) i++;
      }
      const stillThere = removals.filter((r) => hasBlockId(text, r.id)).length;
      left = stillThere - removed;
      if (removed) {
        try {
          ctx.vault.replace(inbox, text, keep.join(eol));
        } catch (e) {
          if (!(e instanceof VaultConflict)) throw e;
          left = stillThere; // Obsidian saved the list meanwhile: leave every line
        }
      }
    }
  }
  return { tag, note: path, link: `[[${ctx.linker.linkText(path)}]]`, ...(created ? { created } : {}), moved, left_in_unrouted: Math.max(0, left) };
}

export interface ReadNote {
  path: string;
  title: string;
  link: string;
  chars: number;
  truncated: boolean;
  text: string;
}

/**
 * A vault note's text for the agent, by path or by name: read-only, up to `maxChars`. Notes in
 * excluded folders and notes marked `kindle-link: false` are refused, as in search.
 */
export function readNote(ctx: FileContext, query: string, maxChars: number): ReadNote {
  const notes = ctx.index.notes();
  const found = findIn(ctx, notes, query);
  if (!found) throw new VaultError(`No note named or at '${query}'. kindle_search_vault finds notes by their words.`);
  if ("ambiguous" in found) throw new VaultError(`More than one note is called that: ${found.ambiguous.join(", ")}. Pass the path of the one you mean.`);
  const n = notes.find((x) => x.path === found.path)!;
  if (n.excluded) throw new VaultError(`${n.path} is in a folder kindle-mcp is set to leave alone (Obsidian's excluded files, templates, or link_exclude).`);
  if (n.optOut) throw new VaultError(`${n.path} is marked kindle-link: false, so kindle-mcp leaves it alone.`);
  const text = ctx.vault.read(n.path) ?? "";
  const chars = Array.from(text);
  return {
    path: n.path,
    title: n.title,
    link: `[[${ctx.linker.linkText(n.path)}]]`,
    chars: chars.length,
    truncated: chars.length > maxChars,
    text: chars.length > maxChars ? chars.slice(0, maxChars).join("") : text,
  };
}

/** Where a pending agent command was already done by the 1.0 router, if it was. */
export function legacyAgentOutput(ctx: FileContext, h: HighlightRow, c: Command): string | null {
  return legacyDone(ctx, h, c);
}

const FOLDERS: Record<string, string> = { post: "Posts", research: "Research" };
const LEAD: Record<string, string> = { post: "Angle", research: "Question" };

export interface AgentNote {
  path: string;
  link: string;
  created: boolean;
  links_added: number;
  /** Links in the agent's text that pointed at no note, turned into plain text. */
  removed_links: string[];
  related: string[];
}

/** An existing note written for this highlight and tag (a retry after a crash), if any. */
function existingAgentNote(ctx: FileContext, h: HighlightRow, tag: string): string | null {
  const dir = ctx.vault.k(FOLDERS[tag]);
  let names: string[] = [];
  try {
    names = readdirSync(ctx.vault.abs(dir)).filter((n) => n.endsWith(".md"));
  } catch {
    return null;
  }
  for (const n of names) {
    const fm = readFrontmatter(ctx.vault.read(`${dir}/${n}`) ?? "");
    if (fm.kindleHighlight === h.id && fm.kindleCommand === tag) return `${dir}/${n}`;
  }
  return null;
}

/** Unresolved [[links]] in model text become their display text, so Obsidian gets no ghost notes. */
function dropUnresolved(ctx: FileContext, md: string): { text: string; removed: string[] } {
  const removed: string[] = [];
  const text = md.replace(/(!?)\[\[([^\]\n]*)\]\]/g, (whole, bang: string, inner: string) => {
    const target = linkTarget(inner);
    if (bang || !target || /\.[A-Za-z0-9]{1,5}$/.test(target) && !/\.md$/i.test(target)) return whole; // embeds and attachments stay
    if (ctx.linker.resolve(target)) return whole;
    removed.push(target);
    const shown = inner.includes("|") ? inner.split("|").slice(1).join("|") : target;
    return shown.trim();
  });
  return { text, removed };
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Writes the agent's @post draft or @research note as its own note, linked to its source. */
export function writeAgentNote(
  ctx: FileContext,
  h: HighlightRow,
  c: Command,
  input: { title?: string; content: string; related?: string[] },
): AgentNote {
  const folder = FOLDERS[c.tag];
  if (!folder) throw new Error(`@${c.tag} is not written by the agent`);
  const bookPath = bookPathFor(ctx, h);
  const link = sourceLink(ctx, h, bookPath);
  const again = existingAgentNote(ctx, h, c.tag);
  if (again) {
    ctx.store.recordOutput(h, c, { via: "agent", path: again });
    return { path: again, link: `[[${ctx.linker.linkText(again)}]]`, created: false, links_added: 0, removed_links: [], related: [] };
  }

  const fallback = `${h.title.slice(0, 60)} ${whereOf(h)}`.trim();
  const base = sanitizeName(input.title?.trim() || fallback) ?? sanitizeName(fallback) ?? "Kindle note";
  let path = ctx.vault.k(`${folder}/${base}.md`);
  for (let n = 2; ctx.vault.exists(path) || ctx.linker.resolve(path.split("/").pop()!.replace(/\.md$/, "")); n++) {
    if (n > 99) throw new Error("Could not find a free note name; pass a different title.");
    path = ctx.vault.k(`${folder}/${base} ${n}.md`);
  }

  const cleaned = dropUnresolved(ctx, neutralize(input.content.trim()));
  let body = cleaned.text;
  let linksAdded = 0;
  if (ctx.linkNotes) {
    const r = ctx.linker.linkify(body, { exclude: new Set([path]), max: 25 });
    body = r.text;
    linksAdded = r.added;
  }
  const related = [...new Set((input.related ?? []).map((r) => ctx.linker.resolve(linkTarget(r))).filter((p): p is string => Boolean(p)))]
    .filter((p) => p !== path)
    .slice(0, 8);
  const title = path.split("/").pop()!.replace(/\.md$/, "");
  const lead = h.note ? `**${LEAD[c.tag]}:** ${oneLine(h.note)}\n\n` : "";
  const text = [
    "---",
    "source: kindle",
    `kindle-command: ${c.tag}`,
    `kindle-highlight: ${h.id}`,
    `book: ${yamlString(h.title)}`,
    ...(h.author ? [`author: ${yamlString(h.author)}`] : []),
    ...(h.location_start !== null ? [`location: ${h.location_start}`] : []),
    `created: ${localDate()}`,
    `tags: [kindle/${c.tag}]`,
    "---",
    `# ${title}`,
    "",
    quoteBlock(h, link, false),
    "",
    `${lead}${body}`,
    ...(related.length ? ["", `Related: ${related.map((p) => `[[${ctx.linker.linkText(p)}]]`).join(" · ")}`] : []),
    "",
  ].join("\n");
  if (!ctx.vault.create(path, text)) throw new Error(`A note appeared at ${path} while writing; try again.`);
  ctx.store.recordOutput(h, c, { via: "agent", path });
  return {
    path,
    link: `[[${ctx.linker.linkText(path)}]]`,
    created: true,
    links_added: linksAdded,
    removed_links: cleaned.removed,
    related,
  };
}
