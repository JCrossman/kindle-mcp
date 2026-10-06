/**
 * Just enough YAML frontmatter to link and find notes: aliases, the opt-out flag, and the fields
 * kindle-mcp writes into its own notes. Dependency-free and forgiving: anything it can't read is
 * ignored, never an error, because a vault is full of hand-written frontmatter.
 */

export interface Frontmatter {
  /** From `aliases` (block list, flow list, or a single string). Obsidian 1.9 dropped `alias`. */
  aliases: string[];
  /** `kindle-link: false`: never link other text to this note. */
  linkOptOut: boolean;
  source: string | null;
  asin: string | null;
  title: string | null;
  /** Set on notes kindle-mcp writes for an @command. */
  kindleHighlight: string | null;
  kindleCommand: string | null;
}

const EMPTY: Frontmatter = {
  aliases: [],
  linkOptOut: false,
  source: null,
  asin: null,
  title: null,
  kindleHighlight: null,
  kindleCommand: null,
};

/** The YAML between the opening and closing `---`, and where the body starts. */
export function splitFrontmatter(text: string): { yaml: string | null; bodyStart: number } {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---[ \t]*\r?\n/.exec(text.slice(start));
  if (!open) return { yaml: null, bodyStart: 0 };
  const from = start + open[0].length;
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m;
  const rest = text.slice(from);
  const m = close.exec(rest);
  if (!m) return { yaml: null, bodyStart: 0 };
  return { yaml: rest.slice(0, m.index), bodyStart: from + m.index + m[0].length };
}

/** A plain, single- or double-quoted YAML scalar, with a trailing ` # comment` removed. */
export function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const end = v.lastIndexOf('"');
    const inner = end > 0 ? v.slice(0, end + 1) : `${v}"`;
    try {
      return JSON.parse(inner) as string;
    } catch {
      return inner.slice(1, -1);
    }
  }
  if (v.startsWith("'")) {
    const end = v.lastIndexOf("'");
    return (end > 0 ? v.slice(1, end) : v.slice(1)).replace(/''/g, "'");
  }
  return v.replace(/\s+#.*$/, "").trim();
}

/** `[a, "b, c", 'd']` -> ['a', 'b, c', 'd']. */
function flowList(raw: string): string[] {
  const body = raw.trim().replace(/^\[/, "").replace(/\]\s*(#.*)?$/, "");
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote && !(quote === '"' && body[i - 1] === "\\")) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(scalar).filter(Boolean);
}

const FALSE = new Set(["false", "no", "off", "0"]);

/** Aliases must be usable as link display text. */
const usableAlias = (a: string): boolean => a.trim().length > 0 && !/\[\[|\]\]|[|#^\n]/.test(a);

export function readFrontmatter(text: string): Frontmatter {
  const { yaml } = splitFrontmatter(text);
  if (yaml === null) return { ...EMPTY };
  const fm: Frontmatter = { ...EMPTY, aliases: [] };
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = (m[2] ?? "").trim();
    if (key === "aliases") {
      if (value.startsWith("[")) fm.aliases = flowList(value);
      else if (value && !value.startsWith("#")) fm.aliases = [scalar(value)];
      else {
        const items: string[] = [];
        while (i + 1 < lines.length && /^[ \t]*-[ \t]/.test(lines[i + 1])) items.push(scalar(lines[++i].replace(/^[ \t]*-[ \t]+/, "")));
        fm.aliases = items;
      }
      fm.aliases = fm.aliases.map((a) => a.trim()).filter(usableAlias);
    } else if (key === "kindle-link") fm.linkOptOut = FALSE.has(scalar(value).toLowerCase());
    else if (key === "source") fm.source = scalar(value) || null;
    else if (key === "asin") fm.asin = scalar(value) || null;
    else if (key === "title") fm.title = scalar(value) || null;
    else if (key === "kindle-highlight") fm.kindleHighlight = scalar(value) || null;
    else if (key === "kindle-command") fm.kindleCommand = scalar(value) || null;
  }
  return fm;
}

/** A YAML double-quoted string, safe for any title. */
export const yamlString = (s: string): string => JSON.stringify(s);
