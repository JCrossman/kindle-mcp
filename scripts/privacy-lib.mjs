// The privacy guard: nothing from a reader's library may end up in this repository.
// Shared by scripts/privacy-check.mjs (CLI, CI), the git hooks, the Claude Code hook and the tests.
// Plain Node with no dependencies, so it runs before `npm install` and inside a hook.
//
// Two kinds of rule:
//   - Structural rules, always on: fixtures may only use words from tests/fixtures/VOCABULARY.txt, ASINs must be
//     the fake ones, fixture URLs and annotation ids must be placeholders, no session or capture files, no
//     session links.
//   - Private terms, when a source is available: PRIVATE_TERMS (a CI secret), ~/.kindle-mcp/private-terms.txt,
//     and the titles, authors, highlights and notes in the reader's own kindle.db. A finding names the file, the
//     line and which term, never the term itself.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export const QUOTE_WORDS = 6; // this many consecutive words in common with a highlight is a quote
const MIN_TERM = 4; // normalised characters; shorter terms would match everywhere
const SESSION_LINK = new RegExp("claude\\.ai/code/" + "session_");
const ASIN = /\bB0[0-9A-Z]{8}\b/g;
const FAKE_ASIN = /^B0FAKE\d{4}$/;
export const ASIN_ALLOWED = new Set(["B07XYZ1234"]);
const URL_HOSTS = new Set(["amazon.com", "www.amazon.com", "read.amazon.com", "example.invalid", "example.com", "localhost", "127.0.0.1"]);
// Attributes whose value is text a person reads; everything else in a page is markup.
const TEXT_ATTRS = new Set(["value", "alt", "title", "placeholder", "aria-label"]);
// The built-in command tags and aliases; tests/privacy.test.ts checks this against COMMANDS.
export const PUBLIC_TAGS = new Set(["post", "p", "research", "r", "todo", "t", "project", "pr", "quote", "q"]);
const FORBIDDEN_FILES = [/\.har$/i, /\.db$/i, /\.db-(wal|shm)$/i, /\.sqlite3?$/i, /(^|\/)session\.json$/, /(^|\/)doctor-[^/]*\.html$/, /(^|\/)private-terms\.txt$/, /(^|\/)\.env(\..*)?$/];
export const GUARD_FILES = [/^scripts\/privacy-[^/]*\.mjs$/, /^scripts\/hooks\//, /^scripts\/scrub-fixture\.mjs$/, /^\.githooks\//, /^\.claude\/settings(\.local)?\.json$/, /^tests\/fixtures\/VOCABULARY\.txt$/, /^tests\/privacy\.test\.ts$/];

/** Lower-case, no accents, only letters and digits, single spaces. */
export function normalize(s) {
  return String(s).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/gi, " "); // a double-encoded space: &amp;nbsp;
}

/** Words with the line each came from. Entities are decoded; the text is normalised like normalize(). */
export function tokens(text) {
  const clean = decodeEntities(text).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const out = [];
  let line = 1;
  let last = 0;
  for (const m of clean.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (let i = last; i < m.index; i++) if (clean.charCodeAt(i) === 10) line++;
    last = m.index;
    out.push({ w: m[0], line });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Private terms

/** A matcher over word phrases; ids say where a term came from, never what it was. */
export class Terms {
  constructor() {
    this.byLength = new Map(); // n words -> Map(phrase -> id)
    this.sources = []; // [{name, count}]
  }
  get size() {
    let n = 0;
    for (const m of this.byLength.values()) n += m.size;
    return n;
  }
  /** Add one term. Long ones count as quotes: any QUOTE_WORDS consecutive words of them match. */
  add(id, text) {
    const w = normalize(text).split(" ").filter(Boolean);
    if (w.join(" ").length < MIN_TERM) return;
    if (w.length <= QUOTE_WORDS) return this.#put(w.length, w.join(" "), id);
    for (let i = 0; i + QUOTE_WORDS <= w.length; i++) this.#put(QUOTE_WORDS, w.slice(i, i + QUOTE_WORDS).join(" "), id);
  }
  #put(n, phrase, id) {
    let m = this.byLength.get(n);
    if (!m) this.byLength.set(n, (m = new Map()));
    if (!m.has(phrase)) m.set(phrase, id);
  }
  /** Every match in a text as {line, id}, one per id and line. */
  scan(text) {
    const toks = tokens(text);
    const seen = new Set();
    const hits = [];
    for (const [n, phrases] of this.byLength) {
      for (let i = 0; i + n <= toks.length; i++) {
        const id = phrases.get(toks.slice(i, i + n).map((t) => t.w).join(" "));
        if (!id) continue;
        const key = `${id}@${toks[i].line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({ line: toks[i].line, id });
      }
    }
    return hits.sort((a, b) => a.line - b.line);
  }
}

function dataHome(env, home) {
  return env.KINDLE_MCP_HOME || join(home, ".kindle-mcp");
}

function authorParts(author) {
  const out = [];
  for (const part of String(author).split(/\s+and\s+|;|&/)) {
    const p = part.trim();
    if (!p) continue;
    out.push(p);
    const comma = p.split(",").map((s) => s.trim()).filter(Boolean);
    if (comma.length === 2) out.push(`${comma[1]} ${comma[0]}`);
    const surname = comma.length === 2 ? comma[0] : p.split(/\s+/).pop();
    if (surname && normalize(surname).length >= 5) out.push(surname);
  }
  return out;
}

function addFromLibrary(terms, id, rows) {
  const { books, highlights } = rows;
  books.forEach((b, i) => {
    const t = String(b.title ?? "");
    terms.add(`${id} book ${i + 1}`, t);
    terms.add(`${id} book ${i + 1}`, t.split(/[:(]| - /)[0]);
    authorParts(b.author ?? "").forEach((a) => terms.add(`${id} author of book ${i + 1}`, a));
  });
  highlights.forEach((h, i) => {
    terms.add(`${id} highlight ${i + 1}`, h.text ?? "");
    for (const field of [h.note, h.raw_note]) {
      const note = String(field ?? "");
      if (!note) continue;
      terms.add(`${id} note ${i + 1}`, note);
      for (const m of note.matchAll(/@project\s+(\S+)/gi)) terms.add(`${id} project name in note ${i + 1}`, m[1]);
      for (const m of note.matchAll(/@([\p{L}\p{N}_-]+)/gu)) if (!PUBLIC_TAGS.has(m[1].toLowerCase())) terms.add(`${id} tag in note ${i + 1}`, m[1]);
    }
  });
}

/** Load every source of private terms that exists here. Never throws: an unreadable source is just reported. */
export async function loadTerms(env = process.env, home = homedir()) {
  const terms = new Terms();
  const note = (name, count) => terms.sources.push({ name, count });
  const before = () => terms.size;

  if (env.PRIVATE_TERMS) {
    const lines = env.PRIVATE_TERMS.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    lines.forEach((l, i) => terms.add(`PRIVATE_TERMS #${i + 1}`, l));
    note("PRIVATE_TERMS", lines.length);
  }
  const file = env.PRIVATE_TERMS_FILE || join(dataHome(env, home), "private-terms.txt");
  if (existsSync(file)) {
    try {
      const lines = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
      lines.forEach((l, i) => terms.add(`private-terms file #${i + 1}`, l));
      note("private-terms file", lines.length);
    } catch {
      note("private-terms file (unreadable)", 0);
    }
  }
  const dbFile = env.KINDLE_MCP_DB || join(dataHome(env, home), "kindle.db");
  if (existsSync(dbFile)) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const books = db.prepare("SELECT title, author FROM books").all();
        const highlights = db.prepare("SELECT text, note, raw_note FROM highlights").all();
        addFromLibrary(terms, "kindle.db", { books, highlights });
        note("kindle.db", books.length + highlights.length);
      } finally {
        db.close();
      }
    } catch {
      note("kindle.db (unreadable)", 0);
    }
  }
  terms.loaded = before() > 0;
  return terms;
}

// ---------------------------------------------------------------------------------------------------------
// Fixture vocabulary

let vocabularyCache;
export function loadVocabulary(root) {
  const file = join(root, "tests", "fixtures", "VOCABULARY.txt");
  if (vocabularyCache?.file === file) return vocabularyCache.words;
  const words = new Set();
  if (existsSync(file)) for (const l of readFileSync(file, "utf8").split(/\r?\n/)) if (l.trim() && !l.startsWith("#")) words.add(l.trim().toLowerCase());
  vocabularyCache = { file, words };
  return words;
}

/** The text a person would read in a page: text nodes and a few attributes, comments/scripts/styles left out. */
export function htmlText(html) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  const s = html
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<script\b[\s\S]*?<\/script>/gi, blank)
    .replace(/<style\b[\s\S]*?<\/style>/gi, blank);
  const parts = [];
  for (const m of s.matchAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+/g)) {
    const piece = m[0];
    if (piece[0] !== "<") {
      parts.push(piece);
      continue;
    }
    for (const a of piece.matchAll(/([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      if (TEXT_ATTRS.has(a[1].toLowerCase())) parts.push(`\n${a[2] ?? a[3] ?? ""}\n`);
    }
    parts.push(piece.replace(/[^\n]/g, "")); // keep line numbers
  }
  return parts.join(" ");
}

const mask = (w) => `${w[0]}${"*".repeat(w.length - 1)}(${w.length})`;

// ---------------------------------------------------------------------------------------------------------
// Scanning

/**
 * Check one file's text. `path` is repository-relative with forward slashes. Returns findings
 * [{file, line, rule, detail}]; `terms` may be null (structural rules only).
 */
export function scanFile(path, text, { terms = null, root = process.cwd(), showWords = false } = {}) {
  const findings = [];
  const add = (line, rule, detail) => findings.push({ file: path, line, rule, detail });
  const lineOf = (index) => text.slice(0, index).split("\n").length;

  if (FORBIDDEN_FILES.some((re) => re.test(path))) add(0, "forbidden-file", "capture, store, session or secret files are never committed");
  if (SESSION_LINK.test(text)) add(lineOf(text.search(SESSION_LINK)), "session-link", "no Claude session links in anything that is committed or posted");
  for (const m of text.matchAll(ASIN)) {
    if (!FAKE_ASIN.test(m[0]) && !ASIN_ALLOWED.has(m[0])) add(lineOf(m.index), "asin", "an ASIN that is not one of the fake ones (B0FAKE0001 ...)");
  }
  if (terms) for (const h of terms.scan(text)) add(h.line, "private-term", `matches ${h.id}`);

  if (/^tests\/fixtures\//.test(path) && !/VOCABULARY\.txt$/.test(path)) {
    const isHtml = /\.html?$/i.test(path);
    for (const m of text.matchAll(/https?:\/\/([^/\s"'<>)\\]+)/gi)) {
      if (!URL_HOSTS.has(m[1].toLowerCase())) add(lineOf(m.index), "fixture-url", "fixture URLs may only point at amazon.com, example.invalid or localhost");
    }
    for (const m of text.matchAll(/[A-Za-z0-9_-]{40,}/g)) {
      let decoded = "";
      try {
        decoded = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      } catch {
        /* not base64 */
      }
      if (/^[\x20-\x7e]+$/.test(decoded) && decoded.includes(":") && !decoded.startsWith("ACCOUNTREDACTED:B0FAKE")) {
        add(lineOf(m.index), "fixture-id", "an encoded id that is not the placeholder form (ACCOUNTREDACTED:B0FAKE...)");
      }
    }
    const vocab = loadVocabulary(root);
    const byLine = new Map();
    for (const t of tokens(isHtml ? htmlText(text) : text)) {
      if (t.w.length <= 2 || /\d/.test(t.w) || vocab.has(t.w)) continue; // ASINs and ids have their own rules
      (byLine.get(t.line) ?? byLine.set(t.line, []).get(t.line)).push(t.w);
    }
    for (const [line, words] of byLine) {
      const shown = showWords ? words.join(", ") : words.map(mask).join(", ");
      add(line, "fixture-vocabulary", `not in tests/fixtures/VOCABULARY.txt: ${shown}`);
    }
  }
  return findings;
}

function git(root, args, input) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}

const BINARY = /\.(png|jpe?g|gif|ico|woff2?|mcpb|zip|gz|tgz|pdf)$/i;

export function trackedAndNew(root) {
  return git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);
}

export function scanTree(root, opts) {
  const findings = [];
  for (const path of trackedAndNew(root)) {
    if (BINARY.test(path)) {
      findings.push(...scanFile(path, "", { ...opts, root }));
      continue;
    }
    const abs = join(root, path);
    if (!existsSync(abs)) continue;
    findings.push(...scanFile(path, readFileSync(abs, "utf8"), { ...opts, root }));
  }
  return findings;
}

export function scanStaged(root, opts) {
  const findings = [];
  const names = git(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
  for (const path of names) {
    if (BINARY.test(path)) {
      findings.push(...scanFile(path, "", { ...opts, root }));
      continue;
    }
    findings.push(...scanFile(path, git(root, ["show", `:${path}`]), { ...opts, root }));
  }
  return findings;
}

/** Messages and added lines of every commit in a rev-list range, so an intermediate commit cannot hide a leak. */
export function scanRange(root, revArgs, opts) {
  const findings = [];
  const shas = git(root, ["rev-list", ...revArgs]).split("\n").filter(Boolean);
  for (const sha of shas) {
    const body = git(root, ["show", "--no-color", "-U0", "--format=%B", sha]);
    const names = git(root, ["show", "--name-only", "--format=", "-z", sha]).split("\0").filter(Boolean);
    const label = `commit ${sha.slice(0, 8)}`;
    findings.push(...scanFile(label, body, { terms: opts.terms, root, showWords: false }).filter((f) => f.rule !== "fixture-vocabulary"));
    for (const n of names) if (FORBIDDEN_FILES.some((re) => re.test(n))) findings.push({ file: label, line: 0, rule: "forbidden-file", detail: `adds ${n}` });
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}  [${f.rule}]  ${f.detail}`).join("\n");
}

export function describeSources(terms) {
  if (!terms.sources.length) return "private terms: none available here (set PRIVATE_TERMS, or keep ~/.kindle-mcp/private-terms.txt or the reader's kindle.db); only the structural rules ran";
  return "private terms: " + terms.sources.map((s) => `${s.name} (${s.count})`).join(", ");
}

/** True if a path (absolute or relative) is inside the repository at `root`. */
export function insideRoot(root, p) {
  const abs = resolve(root, p);
  const r = resolve(root);
  return abs === r || abs.startsWith(r + sep);
}
