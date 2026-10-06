/** Pure HTML -> models. No network, so it is unit-testable against saved pages. */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

import { makeBook, makeHighlight, type Book, type Highlight } from "../models.js";
import * as S from "./selectors.js";

type Root = cheerio.CheerioAPI;
type Sel = cheerio.Cheerio<AnyNode>;

/** BeautifulSoup's get_text(sep, strip=True): stripped text nodes joined by sep, empties dropped. */
function text(el: Sel, sep: string): string {
  const parts: string[] = [];
  const walk = (node: AnyNode): void => {
    if (node.type === "text") {
      const t = (node as { data: string }).data.trim();
      if (t) parts.push(t);
    } else if ("children" in node) {
      for (const child of (node as Element).children) walk(child);
    }
  };
  el.each((_, node) => walk(node));
  return parts.join(sep);
}

function val(scope: Sel | Root, selector: string): string {
  const el = "find" in scope ? scope.find(selector).first() : scope(selector).first();
  return (el.attr("value") ?? "").trim();
}

function int(s: string | null | undefined): number | null {
  const digits = (s ?? "").replace(/[^\d]/g, "");
  return digits ? parseInt(digits, 10) : null;
}

/**
 * Row ids are base64 of '<account>:<asin>:<position>:<TYPE>:<uuid>'.
 * Returns [stable id without the account part, byte position].
 */
export function decodeAnnotationId(rowId: string): [string | null, number | null] {
  try {
    const padded = rowId + "=".repeat((4 - (rowId.length % 4)) % 4);
    const parts = Buffer.from(padded, "base64").toString("utf8").split(":");
    if (parts.length >= 5 && /^\d+$/.test(parts[2])) return [parts.slice(1).join(":"), parseInt(parts[2], 10)];
  } catch {
    /* not a row id we understand */
  }
  return [null, null];
}

/** The annotation pane carries the book's own title/author, so a book can be synced by ASIN alone. */
export function parsePaneBook(html: string): Book | null {
  const $ = cheerio.load(html);
  const asin = val($, S.PANE_ASIN);
  const title = $(S.PANE_TITLE).first();
  if (!asin || !title.length) return null;
  const author = $(S.PANE_AUTHOR).first();
  return makeBook({ bookId: asin, asin, title: text(title, " "), author: author.length ? text(author, " ") : "" });
}

/** Returns [books, nextPageToken]. Token is '' on the last page. */
export function parseLibrary(html: string): [Book[], string] {
  const $ = cheerio.load(html);
  const books: Book[] = [];
  $(S.BOOK_ROW).each((_, el) => {
    const row = $(el);
    const asin = (row.attr("id") ?? "").trim();
    const titleEl = row.find(S.BOOK_TITLE).first();
    if (!asin || !titleEl.length) return;
    const authorEl = row.find(S.BOOK_AUTHOR).first();
    const author = (authorEl.length ? text(authorEl, " ") : "").replace(/^(By|De|Von|Par)\s*:\s*/i, "");
    const dateEl = row.find(S.BOOK_ANNOTATED_DATE).first();
    books.push(
      makeBook({
        bookId: asin,
        asin,
        title: text(titleEl, " "),
        author,
        lastAnnotated: dateEl.length ? (dateEl.attr("value") ?? "").trim() : null,
      }),
    );
  });
  return [books, val($, S.LIBRARY_NEXT_TOKEN)];
}

/** Returns [highlights, nextPageToken, contentLimitState]. */
export function parseAnnotations(html: string, bookId: string): [Highlight[], string, string] {
  const $ = cheerio.load(html);
  const out: Highlight[] = [];
  let rows = $(S.ANNOTATION_ROW);
  if (!rows.length) rows = $(S.ANNOTATION_ROW_FRAGMENT).filter((_, el) => $(el).find(S.LOCATION_INPUT).length > 0);

  rows.each((_, el) => {
    const row = $(el);
    const textEl = row.find(S.HIGHLIGHT_TEXT).first();
    const noteEl = row.find(S.NOTE_TEXT).first();
    const body = textEl.length ? text(textEl, " ") : "";
    const note = noteEl.length ? text(noteEl, "\n") : "";
    const headerEl = row.find(S.HIGHLIGHT_HEADER).first().length
      ? row.find(S.HIGHLIGHT_HEADER).first()
      : row.find(S.NOTE_HEADER).first();
    const header = headerEl.length ? text(headerEl, " ") : "";
    if (!(body || note || header)) return;

    const [amazonId, position] = decodeAnnotationId(row.attr("id") ?? "");
    let location = int(val(row, S.LOCATION_INPUT));
    if (location === null && position !== null) location = Math.floor(position / 150) + 1;
    if (location === null) {
      const m = /Location:?\s*([\d,]+)/i.exec(header);
      location = m ? int(m[1]) : null;
    }
    const pageM = /Page:?\s*([\w,]+)/i.exec(header);
    const colorM = /^\s*(\w+)\s+highlight/i.exec(header);
    let color: string | null = colorM ? colorM[1].toLowerCase() : null;
    const box = row.find(S.HIGHLIGHT_BOX).first();
    if (box.length) {
      for (const cls of (box.attr("class") ?? "").split(/\s+/)) {
        if (cls.startsWith("kp-notebook-highlight-") && cls !== "kp-notebook-highlight-empty-text") {
          color = cls.slice(cls.lastIndexOf("-") + 1);
        }
      }
    }
    const undisplayable = row.find(S.HIGHLIGHT_EMPTY).length > 0;
    const hasHighlightHeader = row.find(S.HIGHLIGHT_HEADER).length > 0;

    out.push(
      makeHighlight({
        bookId,
        text: body,
        note,
        locationStart: location,
        page: pageM ? pageM[1] : null,
        color,
        // Empty highlight text: either Amazon can't render it (image/table) or the export limit was hit.
        truncated: undisplayable || (hasHighlightHeader && !body && !note),
        source: "cloud",
        amazonId,
        position,
      }),
    );
  });
  return [out, val($, S.ANNOTATIONS_NEXT_TOKEN), val($, S.CONTENT_LIMIT_STATE)];
}
