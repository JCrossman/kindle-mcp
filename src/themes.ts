import type { HighlightRow } from "./store.js";
import { COMMON_WORDS, FUNCTION_WORDS, STOPWORDS } from "./words.js";

export interface Theme {
  /** The words the highlights in this theme share, most shared first. */
  terms: string[];
  /** @tags the highlights in this theme share. */
  tags: string[];
  highlight_ids: string[];
  books: string[];
}

/** A plural and its singular count as one term; other words are kept as written (lowercased). */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

/** The content words and tags of one highlight, as a set of keys ('word' or '#tag'). */
export function themeKeys(h: Pick<HighlightRow, "text" | "note" | "commands">): Set<string> {
  const keys = new Set<string>();
  for (const raw of `${h.text} ${h.note}`.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]*/gu) ?? []) {
    const w = raw.replace(/['’-]+$/u, "").replace(/['’]s$/u, "");
    if (w.length < 4 || STOPWORDS.has(w) || COMMON_WORDS.has(w) || FUNCTION_WORDS.has(w)) continue;
    const s = stem(w);
    if (COMMON_WORDS.has(s)) continue;
    keys.add(s);
  }
  for (const c of h.commands) keys.add(`#${c.tag}`);
  return keys;
}

/**
 * Groups highlights into up to `max` themes by the content words and tags they share. Greedy and
 * deterministic: the key shared by the most unthemed highlights (from at least two of them) seeds a
 * theme; the theme takes every unthemed highlight with that key, then is labelled with the other
 * keys most of its members share. Highlights that share nothing with another stay unthemed.
 */
export function findThemes(highlights: HighlightRow[], max = 5): { themes: Theme[]; unthemed: string[] } {
  const keysOf = new Map(highlights.map((h) => [h.id, themeKeys(h)]));
  const left = new Set(highlights.map((h) => h.id));
  const byId = new Map(highlights.map((h) => [h.id, h]));
  const themes: Theme[] = [];

  while (themes.length < max && left.size > 1) {
    const df = new Map<string, number>();
    for (const id of left) for (const k of keysOf.get(id)!) df.set(k, (df.get(k) ?? 0) + 1);
    // Words beat tags on a tie: a tag like @todo says what to do, not what the highlight is about.
    const ranked = [...df.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1] || Number(a[0].startsWith("#")) - Number(b[0].startsWith("#")) || a[0].localeCompare(b[0]));
    if (!ranked.length) break;
    const seed = ranked[0][0];
    const members = [...left].filter((id) => keysOf.get(id)!.has(seed));

    const inTheme = new Map<string, number>();
    for (const id of members) for (const k of keysOf.get(id)!) inTheme.set(k, (inTheme.get(k) ?? 0) + 1);
    const shared = [...inTheme.entries()]
      .filter(([k, n]) => k === seed || n >= Math.max(2, Math.ceil(members.length / 2)))
      .sort((a, b) => Number(b[0] === seed) - Number(a[0] === seed) || b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k]) => k);

    themes.push({
      terms: shared.filter((k) => !k.startsWith("#")).slice(0, 4),
      tags: shared.filter((k) => k.startsWith("#")).map((k) => k.slice(1)),
      highlight_ids: members,
      books: [...new Set(members.map((id) => byId.get(id)!.title))],
    });
    for (const id of members) left.delete(id);
  }
  return { themes, unthemed: highlights.filter((h) => left.has(h.id)).map((h) => h.id) };
}
