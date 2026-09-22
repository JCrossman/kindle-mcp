/**
 * Files @commands into the vault: the sync does @todo, @quote, @project and anything it can't
 * route; kindle_complete_command does @post and @research with the agent's text. Every entry
 * links back to its highlight's block and carries its own block id, and nothing is written twice:
 * a recorded output, the entry's id already in the file, or a 1.0 router entry all count as done.
 */
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { commandSpec, type Command } from "../commands.js";
import { bookNotePath, type ExportContext, whereOf } from "../obsidian.js";
import type { HighlightRow, Store } from "../store.js";
import { readFrontmatter, yamlString } from "./frontmatter.js";
import type { VaultIndex } from "./index.js";
import { fold, linkTarget, type Linker } from "./linkify.js";
import { hasBlockId, insertUnderHeading, neutralize, sanitizeName, type Vault } from "./write.js";

export interface FileContext {
  store: Store;
  vault: Vault;
  index: VaultIndex;
  linker: Linker;
  /** Link mentions of vault notes in agent notes (KINDLE_LINK_NOTES). */
  linkNotes: boolean;
}

export type FileOutcome = "filed" | "found" | "unrouted";

export interface Filed {
  highlight_id: string;
  tag: string;
  arg: string;
  outcome: FileOutcome;
  /** Vault-relative path of the file the entry is in. */
  to: string;
  reason?: string;
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

/**
 * The note @project <name> goes to: a note named or aliased <name> (spaces, hyphens and
 * underscores alike, trailing punctuation ignored). Your own notes win over kindle-mcp's, a
 * name beats an alias; two equally good matches are ambiguous. Otherwise Projects/<name>.md.
 */
export function resolveProject(ctx: FileContext, rawName: string): ProjectTarget {
  const name = rawName.normalize("NFC").replace(/[.,;:!?)"'\]]+$/, "").trim();
  const key = (s: string): string => fold(s).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  const want = key(name);
  const kindle = `${ctx.vault.folder}/`;
  const own = (p: string): boolean =>
    p.startsWith(`${kindle}Inbox/`) && !p.startsWith(`${kindle}Inbox/Projects/`);
  const candidates = ctx.index
    .notes()
    .filter((n) => !n.excluded && !own(n.path) && n.source !== "kindle" && !n.kindleHighlight)
    .map((n) => {
      const byTitle = key(n.title) === want;
      const byAlias = !byTitle && n.aliases.some((a) => key(a) === want);
      if (!byTitle && !byAlias) return null;
      const inKindle = n.path.startsWith(kindle);
      return { path: n.path, rank: (inKindle ? 2 : 0) + (byTitle ? 0 : 1) };
    })
    .filter((x): x is { path: string; rank: number } => x !== null)
    .sort((a, b) => a.rank - b.rank);
  if (candidates.length) {
    const best = candidates.filter((c) => c.rank === candidates[0].rank);
    return best.length === 1 ? { path: best[0].path } : { ambiguous: best.map((b) => b.path) };
  }
  const safe = sanitizeName(name.replace(/[-_]+/g, " ")) ?? "Project";
  const path = ctx.vault.k(`Projects/${safe}.md`);
  return ctx.vault.exists(path) ? { path } : { path, create: true };
}

function appendList(ctx: FileContext, path: string, heading: string, entry: string): void {
  if (!ctx.vault.exists(path)) ctx.vault.create(path, `# ${heading}\n\n${entry}\n`);
  else ctx.vault.append(path, entry);
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

  const unrouted = (reason: string): Filed => {
    const path = ctx.vault.k("Inbox/Unrouted.md");
    const text = ctx.vault.read(path);
    if (!text || !hasBlockId(text, id)) {
      const what = `\`@${c.tag}${c.arg ? ` ${oneLine(c.arg)}` : ""}\``;
      const note = h.note ? ` — note: ${LQ}${oneLine(h.note)}${RQ}` : "";
      appendList(ctx, path, "Kindle: unrouted", `- ${what} ${reason}${note} — ${quote ? `${quote} — ` : ""}${link} ^${id}`);
    }
    ctx.store.recordOutput(h, c, { via: "sync", path, blockId: id });
    return { ...base, outcome: "unrouted", to: path, reason };
  };

  if (!spec) return unrouted("is not a known command");
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
    const entry = `${quoteBlock(h, link, true)}\n\n^${id}`;
    if (target.create) {
      const title = path.split("/").pop()!.replace(/\.md$/, "");
      ctx.vault.create(path, `---\ntags: [kindle/project]\n---\n# ${title}\n\n## From Kindle\n\n${entry}\n`);
    } else {
      const text = ctx.vault.read(path) ?? "";
      if (!hasBlockId(text, id)) {
        const plan = insertUnderHeading(text, "From Kindle", entry);
        if ("append" in plan) ctx.vault.append(path, plan.append);
        else ctx.vault.replace(path, text, plan.text);
      }
    }
  }
  ctx.store.recordOutput(h, c, { via: "sync", path, blockId: id });
  return { ...base, outcome: "filed", to: path };
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
