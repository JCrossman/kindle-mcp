import { metaOf, TRUNCATED_TEXT_V1 } from "../../src/obsidian.js";
import type { HighlightRow } from "../../src/store.js";

/** A block exactly as 1.0 wrote it (id at the end of the last quote line), to build the notes 1.0 left behind. */
export function renderHighlightV1(h: HighlightRow): string {
  const body = h.text || (h.truncated ? TRUNCATED_TEXT_V1 : "");
  const lines = body ? body.split(/\r\n|\r|\n/).map((ln) => `> ${ln}`) : [];
  if (h.note) lines.push(...(lines.length ? [">"] : []), "> **Note:** " + h.note.replace(/\n/g, " "));
  const meta = metaOf(h);
  lines.push(meta ? `> — ${meta} ^kh-${h.id}` : `> ^kh-${h.id}`);
  return lines.join("\n");
}
