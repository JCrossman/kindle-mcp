/**
 * Every write kindle-mcp makes to an Obsidian vault goes through here. Paths are vault-relative
 * and must stay inside the vault; nothing is written through a symbolic link. Existing files are
 * only appended to, except for a compare-and-swap replace that refuses when the file changed.
 */
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { splitFrontmatter } from "./frontmatter.js";

export class VaultError extends Error {}
/** The file changed between reading and writing it (usually Obsidian saving an edit). */
export class VaultConflict extends Error {}

/** `Kindle`, `Reading/Kindle`; never absolute, never `..`. */
export function normalizeFolder(folder: string): string {
  const parts = folder.replace(/\\/g, "/").split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return "Kindle";
  return parts.join("/");
}

export const eolOf = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n");
export const withEol = (text: string, eol: string): string => text.replace(/\r?\n/g, eol);

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** File sync clients and virus scanners hold files open for a moment; renames then fail briefly. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
        try {
          unlinkSync(from);
        } catch {
          // best effort
        }
        throw e;
      }
      sleep(100);
    }
  }
}

export class Vault {
  private constructor(
    /** Real path of the vault root. */
    readonly root: string,
    /** The Kindle folder inside it, e.g. `Kindle`. */
    readonly folder: string,
  ) {}

  /** The vault must already exist: a mistyped path should fail, not grow a new folder tree. */
  static open(root: string, folder: string): Vault {
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      throw new VaultError(`The Obsidian vault folder does not exist: ${root}. Check the vault path in the settings.`);
    }
    if (!statSync(real).isDirectory()) throw new VaultError(`The Obsidian vault path is not a folder: ${root}.`);
    return new Vault(real, normalizeFolder(folder));
  }

  /** A path inside the Kindle folder. */
  k(rel: string): string {
    return `${this.folder}/${rel}`;
  }

  /** Absolute path for a vault-relative one; refuses anything outside the vault or through a symlink. */
  abs(rel: string): string {
    const clean = rel.replace(/\\/g, "/");
    if (!clean || isAbsolute(clean) || /^[A-Za-z]:/.test(clean) || clean.split("/").some((p) => p === "..")) {
      throw new VaultError(`Refusing a path outside the vault: ${rel}`);
    }
    const full = resolve(this.root, clean);
    const back = relative(this.root, full);
    if (!back || back.startsWith("..") || isAbsolute(back)) throw new VaultError(`Refusing a path outside the vault: ${rel}`);
    let cur = this.root;
    for (const part of back.split(sep)) {
      cur = join(cur, part);
      let link = false;
      try {
        link = lstatSync(cur).isSymbolicLink();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
        throw e;
      }
      if (link) throw new VaultError(`Refusing to write through a symbolic link: ${rel}`);
    }
    return full;
  }

  exists(rel: string): boolean {
    return existsSync(this.abs(rel));
  }

  read(rel: string): string | null {
    try {
      return readFileSync(this.abs(rel), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  private parents(abs: string): void {
    mkdirSync(dirname(abs), { recursive: true });
  }

  /** Creates a new file; false if one is already there. */
  create(rel: string, content: string): boolean {
    const abs = this.abs(rel);
    this.parents(abs);
    try {
      writeFileSync(abs, content, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  /** Appends a block after a blank line, in the file's own line endings. Creates the file if needed. */
  append(rel: string, block: string): void {
    const abs = this.abs(rel);
    this.parents(abs);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : "";
    const eol = eolOf(current);
    let gap = "";
    if (current.length && !/\n\s*\n$/.test(current) && !/^\s*$/.test(current)) gap = current.endsWith("\n") ? eol : eol + eol;
    appendFileSync(abs, gap + withEol(block.replace(/\s+$/, ""), eol) + eol);
  }

  /** Replaces a file's content if it is still exactly `expected`; otherwise VaultConflict. */
  replace(rel: string, expected: string, next: string): void {
    const abs = this.abs(rel);
    if (readFileSync(abs, "utf8") !== expected) throw new VaultConflict(rel);
    const tmp = join(dirname(abs), `.${basename(abs)}.kindle-mcp-${process.pid}.tmp`);
    writeFileSync(tmp, next);
    if (readFileSync(abs, "utf8") !== expected) {
      unlinkSync(tmp);
      throw new VaultConflict(rel);
    }
    renameWithRetry(tmp, abs);
  }
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A safe file name for a new note: no characters Obsidian links or Windows reject, no leading
 * dots, no trailing dots or spaces, at most 100 characters. Null when nothing usable is left.
 * (Book notes keep the 1.0 `filename()`; their paths are their identity.)
 */
export function sanitizeName(raw: string, max = 100): string | null {
  let s = raw
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]%]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  s = Array.from(s).slice(0, max).join("");
  while (Buffer.byteLength(s) > 200) s = Array.from(s).slice(0, -1).join("");
  s = s.replace(/[. ]+$/, "");
  if (!s) return null;
  return RESERVED.test(s) ? `${s} (note)` : s;
}

/**
 * Makes model-written markdown inert in Obsidian plugins that run code: Dataview JS, JS Engine
 * and Templater. @research reads web pages, so a prompt-injected note must not execute on open.
 */
export function neutralize(md: string): string {
  return md
    .replace(/^([ \t]*)(`{3,}|~{3,})[ \t]*(dataviewjs|dataview|js-engine|javascript-engine|templater)\b[^\n]*$/gim, "$1$2text")
    .replace(/`\$=/g, "`\\$=")
    .replace(/<%/g, "<\\%")
    .replace(/<(\/?)(script|iframe|object|embed)\b/gi, "&lt;$1$2");
}

const HEADING = /^#{1,6}[ \t]+/;

/**
 * Where to put an entry under a heading (e.g. "From Kindle"): at the end of that section.
 * Returns text to append when the section is last (or missing), else the whole new text.
 */
export function insertUnderHeading(
  text: string,
  heading: string,
  entry: string,
): { append: string } | { text: string } {
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const bodyLine = text.slice(0, splitFrontmatter(text).bodyStart).split(/\r?\n/).length - 1;
  const want = new RegExp(`^#{1,6}[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t#]*$`, "i");
  let fence: string | null = null;
  let at = -1;
  let nextHeading = -1;
  for (let i = bodyLine; i < lines.length; i++) {
    const f = /^[ \t]*(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    if (at < 0 && want.test(lines[i])) at = i;
    else if (at >= 0 && HEADING.test(lines[i])) {
      nextHeading = i;
      break;
    }
  }
  const body = withEol(entry.replace(/\s+$/, ""), eol);
  if (at < 0) return { append: `## ${heading}${eol}${eol}${body}` };
  if (nextHeading < 0) return { append: body };
  let end = nextHeading;
  while (end > at + 1 && lines[end - 1].trim() === "") end--;
  const out = [...lines.slice(0, end), "", ...body.split(eol), "", ...lines.slice(nextHeading)];
  return { text: out.join(eol) };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when a line ends with this block id (`^id`), in either the inline or own-line form. */
export function hasBlockId(text: string, id: string): boolean {
  return new RegExp(`(^|\\s)\\^${escapeRe(id)}[ \\t]*$`, "m").test(text);
}
