/** Parser for the device's My Clippings.txt. Covers sideloaded books the cloud never sees. */
import { readFileSync } from "node:fs";

import { makeBook, makeHighlight, type Book, type Highlight } from "./models.js";

const SEPARATOR = "==========";
const LIMIT_MARKER = "clipping limit"; // "<You have reached the clipping limit for this item>"
const TITLE = /^(.*?)(?:\s*\(([^()]*)\))?$/;
const LOC = /[Ll]ocation\s+(\d+)(?:-(\d+))?/;
const PAGE = /[Pp]age\s+(\w+)/;
const DATE = /Added on\s+(.+)$/;
// "Sunday, September 13, 2026 9:14:05 PM" | "Sunday, 13 September 2026 21:14:05" | "Sunday, September 13, 2026 21:14:05"
const WHEN = /^\w+,\s+(?:([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})|(\d{1,2})\s+([A-Za-z]+)\s+(\d{4}))\s+(\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?$/i;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface ClippingsBook {
  book: Book;
  highlights: Highlight[];
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** "Added on ..." -> "YYYY-MM-DDTHH:MM:SS" (device local time, no zone), or null. */
export function parseWhen(meta: string): string | null {
  const d = DATE.exec(meta);
  if (!d) return null;
  const m = WHEN.exec(d[1].trim());
  if (!m) return null;
  const monthName = (m[1] ?? m[5]).toLowerCase();
  const month = MONTHS.indexOf(monthName);
  if (month < 0) return null;
  const day = parseInt(m[2] ?? m[4], 10);
  const year = parseInt(m[3] ?? m[6], 10);
  let hour = parseInt(m[7], 10);
  const ampm = m[10]?.toUpperCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = ampm === "AM" ? hour % 12 : (hour % 12) + 12;
  } else if (hour > 23) return null;
  if (day < 1 || day > 31) return null;
  return `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${m[8]}:${m[9]}`;
}

/** Returns {book_id: {book, highlights}} in file order, with notes folded into the highlight they sit on. */
export function parseClippings(path: string): Map<string, ClippingsBook> {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  const books = new Map<string, ClippingsBook>();
  const looseNotes = new Map<string, Highlight[]>();

  for (const entry of raw.split(SEPARATOR)) {
    const lines = entry
      .trim()
      .split(/\r\n|\r|\n/)
      .map((ln) => ln.replace(/^[﻿ \r]+|[﻿ \r]+$/g, ""));
    if (lines.length < 2) continue;
    const m = TITLE.exec(lines[0].trim());
    const title = ((m && m[1]) || lines[0]).trim();
    const author = ((m && m[2]) || "").trim();
    const meta = lines[1];
    const body = lines.slice(2).join("\n").trim();
    const kind = /Your Note/i.test(meta) ? "note" : /Bookmark/i.test(meta) ? "bookmark" : "highlight";
    if (kind === "bookmark") continue;

    const bookId = `clip:${slug(title)}`;
    if (!books.has(bookId)) books.set(bookId, { book: makeBook({ bookId, title, author }), highlights: [] });
    const loc = LOC.exec(meta);
    const page = PAGE.exec(meta);
    const start = loc ? parseInt(loc[1], 10) : null;
    const end = loc && loc[2] ? parseInt(loc[2], 10) : start;
    const truncated = body.toLowerCase().includes(LIMIT_MARKER);
    const h = makeHighlight({
      bookId,
      locationStart: start,
      locationEnd: end,
      page: page ? page[1] : null,
      truncated,
      source: "clippings",
      highlightedAt: parseWhen(meta),
      text: kind === "note" || truncated ? "" : body,
      note: kind === "note" ? body : "",
    });
    if (kind === "note") {
      if (!looseNotes.has(bookId)) looseNotes.set(bookId, []);
      looseNotes.get(bookId)!.push(h);
    } else {
      books.get(bookId)!.highlights.push(h);
    }
  }

  // The device logs a note as its own entry, located inside the highlight it belongs to.
  for (const [bookId, notes] of looseNotes) {
    const highlights = books.get(bookId)!.highlights;
    for (const n of notes) {
      const host = highlights.find(
        (h) =>
          h.locationStart !== null &&
          n.locationStart !== null &&
          h.locationStart <= n.locationStart &&
          n.locationStart <= (h.locationEnd ?? h.locationStart),
      );
      if (host) host.note = `${host.note}\n${n.note}`.trim();
      else highlights.push(n); // standalone note
    }
  }
  return books;
}
