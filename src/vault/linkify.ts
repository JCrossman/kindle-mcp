/**
 * Turns mentions of vault notes into [[links]], the way Obsidian's "unlinked mentions" finds
 * them (whole words, any case), with guards so a vault full of short or generic titles doesn't
 * link every other word. Pure: the caller supplies the notes.
 */
import { COMMON_WORDS, FUNCTION_WORDS } from "./words.js";

export interface LinkableNote {
  /** Vault-relative, `/` separators, with `.md`. */
  path: string;
  /** File name without `.md`. */
  title: string;
  aliases: string[];
  /** False for excluded folders, templates, `kindle-link: false` and kindle-mcp's own lists. */
  linkable: boolean;
}

export interface LinkOptions {
  /** Notes never to link to, e.g. the note being written. */
  exclude?: Set<string>;
  /** Most new links to add. Default 5. */
  max?: number;
  /** Notes already linked earlier in the same note; filled in as links are added. */
  seen?: Set<string>;
}

export interface LinkResult {
  text: string;
  added: number;
  /** Paths of the notes linked. */
  targets: string[];
}

interface Form {
  folded: string;
  original: string;
  path: string;
  /** Short all-caps acronyms (AI, UX) only match with the same case. */
  exact: boolean;
}

const FOLD: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u02bc": "'", "\u201c": '"', "\u201d": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00a0": " ",
};

/** Lowercase, curly quotes and dashes made plain. Keeps the length, so offsets still line up. */
export function fold(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const f = FOLD[c] ?? c.toLowerCase();
    out += f.length === 1 ? f : c;
  }
  return out;
}

const WORD = /[\p{L}\p{N}_]+/gu;
/** Characters that must not sit right before a match ("self-trust", "#tag", "@name", "a/b", "don't"). */
const BAD_BEFORE = /[\p{L}\p{N}_\-'[#@/]/u;
/** Characters that must not sit right after one. An apostrophe may: possessives ("Stoicism's") match. */
const BAD_AFTER = /[\p{L}\p{N}_\-\]]/u;
/** Obsidian can't link to names containing these. */
const UNLINKABLE = /[#|^:[\]]|%%/;
const DATE = /\d{4}-\d{2}-\d{2}|\b\d{8}\b/;

const WIKILINK = /!?\[\[([^\]\n]*)\]\]/g;

/** Spans where a link must never be added. */
const PROTECT: RegExp[] = [
  /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, // fenced code
  /`[^`\n]+`/g, // inline code
  /!?\[\[[^\]\n]*\]\]/g, // wikilinks and embeds
  /!?\[[^\]\n]*\]\([^)\n]*\)/g, // markdown links and images
  /<[a-zA-Z/!][^>\n]*>/g, // html
  /%%[\s\S]*?%%/g, // comments
  /\$\$[\s\S]*?\$\$/g, // display math
  /\$[^$\n]+\$/g, // inline math
  /\b(?:https?|ftp|file|obsidian|mailto):[^\s<>()\]]+/gi, // urls
  /\bwww\.[^\s<>()\]]+/gi,
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // emails
  /(?:^|\s)#[^\s#.,;:!?()[\]{}"']+/g, // tags
  /(?:^|\s)\^[A-Za-z0-9-]+[ \t]*$/gm, // block ids
  /^#{1,6}[ \t].*$/gm, // headings
];

function protectedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const re of PROTECT) for (const m of text.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

/** The part of a wikilink that names the note: `Note#Heading|alias` -> `Note`. */
export const linkTarget = (inner: string): string => inner.split("|")[0].split("#")[0].trim();

function formOk(form: string): { ok: boolean; exact: boolean } {
  const f = form.trim();
  if (!f || !/\p{L}/u.test(f) || UNLINKABLE.test(f) || DATE.test(f) || /^untitled\b/i.test(f)) return { ok: false, exact: false };
  const words = f.split(/\s+/);
  if (words.length === 1) {
    if (f.length < 4) return /^[A-Z][A-Z0-9]{1,4}$/.test(f) ? { ok: true, exact: true } : { ok: false, exact: false };
    return { ok: !COMMON_WORDS.has(fold(f)), exact: false };
  }
  const allFunction = words.every((w) => FUNCTION_WORDS.has(fold(w).replace(/[^\p{L}\p{N}']/gu, "")));
  return { ok: !allFunction, exact: false };
}

export class Linker {
  private readonly byKey = new Map<string, Form[]>();
  private readonly titleCount = new Map<string, number>();
  private readonly byTitle = new Map<string, string>();
  private readonly byPath = new Map<string, string>();
  readonly size: number;

  constructor(notes: LinkableNote[]) {
    for (const n of notes) {
      const t = fold(n.title.normalize("NFC"));
      this.titleCount.set(t, (this.titleCount.get(t) ?? 0) + 1);
      if (!this.byTitle.has(t)) this.byTitle.set(t, n.path);
      this.byPath.set(fold(n.path.replace(/\.md$/i, "")), n.path);
    }
    // A title beats an alias; a form that still names two notes is dropped.
    const titles = new Map<string, Set<string>>();
    const aliases = new Map<string, Set<string>>();
    const original = new Map<string, { text: string; exact: boolean }>();
    const add = (bag: Map<string, Set<string>>, text: string, path: string): void => {
      const f = text.normalize("NFC").trim();
      const { ok, exact } = formOk(f);
      if (!ok) return;
      const key = exact ? `=${f}` : fold(f);
      if (!bag.has(key)) bag.set(key, new Set());
      bag.get(key)!.add(path);
      if (!original.has(key)) original.set(key, { text: f, exact });
    };
    for (const n of notes) {
      if (!n.linkable) continue;
      add(titles, n.title, n.path);
      for (const a of n.aliases) add(aliases, a, n.path);
    }
    const chosen = new Map<string, string>();
    for (const [key, paths] of titles) if (paths.size === 1) chosen.set(key, [...paths][0]);
    for (const [key, paths] of aliases) if (!titles.has(key) && paths.size === 1) chosen.set(key, [...paths][0]);
    for (const [key, path] of chosen) {
      const { text, exact } = original.get(key)!;
      const folded = fold(text);
      const first = /^[\p{L}\p{N}_]+/u.exec(folded);
      if (!first) continue;
      const list = this.byKey.get(first[0]) ?? [];
      list.push({ folded, original: text, path, exact });
      this.byKey.set(first[0], list);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => b.folded.length - a.folded.length);
    this.size = chosen.size;
  }

  /** What goes inside [[ ]]: the title when no other note shares it, else the path. */
  linkText(path: string): string {
    const title = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
    return (this.titleCount.get(fold(title.normalize("NFC"))) ?? 0) > 1 ? path.replace(/\.md$/i, "") : title;
  }

  /** The note a wikilink target resolves to, or null. Targets with another file extension aren't notes. */
  resolve(target: string): string | null {
    const t = target.trim().replace(/\.md$/i, "");
    if (!t) return null;
    const f = fold(t.normalize("NFC"));
    if (f.includes("/")) {
      const exact = this.byPath.get(f.replace(/^\/+/, ""));
      if (exact) return exact;
      for (const [p, path] of this.byPath) if (p.endsWith(`/${f}`)) return path;
      return null;
    }
    return this.byTitle.get(f) ?? null;
  }

  linkify(text: string, opts: LinkOptions = {}): LinkResult {
    const none = { text, added: 0, targets: [] as string[] };
    if (!text || !this.size) return none;
    // A stray [[ or ]] means the text is mid-edit or unusual markup: leave it alone.
    const bare = text.replace(WIKILINK, "");
    if (bare.includes("[[") || bare.includes("]]")) return none;

    const max = opts.max ?? 5;
    const exclude = opts.exclude ?? new Set<string>();
    const seen = opts.seen ?? new Set<string>();
    for (const m of text.matchAll(WIKILINK)) {
      const p = this.resolve(linkTarget(m[1]));
      if (p) seen.add(p);
    }
    const spans = protectedSpans(text);
    const inSpan = (a: number, b: number): boolean => spans.some(([s, e]) => a < e && b > s);
    const folded = fold(text);
    const edits: Array<[number, number, string]> = [];
    const targets: string[] = [];

    WORD.lastIndex = 0;
    let next = 0;
    for (let m = WORD.exec(folded); m && edits.length < max; m = WORD.exec(folded)) {
      const i = m.index;
      if (i < next || (i > 0 && BAD_BEFORE.test(text[i - 1]))) continue;
      const candidates = this.byKey.get(m[0]);
      if (!candidates) continue;
      for (const f of candidates) {
        const end = i + f.folded.length;
        if (end > text.length) continue;
        if (f.exact ? text.slice(i, end) !== f.original : folded.slice(i, end) !== f.folded) continue;
        if (end < text.length && BAD_AFTER.test(text[end])) continue;
        if (inSpan(i, end)) continue;
        next = end; // the longest form here wins, linked or not
        if (seen.has(f.path) || exclude.has(f.path)) break;
        const shown = text.slice(i, end);
        const link = this.linkText(f.path);
        edits.push([i, end, shown === link ? `[[${link}]]` : `[[${link}|${shown}]]`]);
        seen.add(f.path);
        targets.push(f.path);
        break;
      }
      if (next > i) WORD.lastIndex = Math.max(WORD.lastIndex, next);
    }
    if (!edits.length) return none;
    let out = "";
    let at = 0;
    for (const [s, e, rep] of edits) {
      out += text.slice(at, s) + rep;
      at = e;
    }
    return { text: out + text.slice(at), added: edits.length, targets };
  }
}
