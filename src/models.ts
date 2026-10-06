/** Data shapes shared by the parsers, the store and the sync engine. */

export interface Book {
  /** ASIN for cloud books, "clip:<slug>" for clippings-only books. */
  bookId: string;
  title: string;
  author: string;
  asin: string | null;
  /** Raw "last annotated" string from the notebook page; used to skip unchanged books. */
  lastAnnotated: string | null;
}

export interface Highlight {
  bookId: string;
  text: string;
  note: string;
  locationStart: number | null;
  locationEnd: number | null;
  page: string | null;
  color: string | null;
  /** Publisher clipping limit hit, or content Amazon cannot render: text missing or partial. */
  truncated: boolean;
  source: "cloud" | "clippings";
  /** ISO timestamp; only clippings carries this. */
  highlightedAt: string | null;
  /** Amazon's own stable annotation id (cloud only), minus the account part. */
  amazonId: string | null;
  /** Byte position in the book; location == position // 150 + 1. */
  position: number | null;
}

export function makeBook(b: Partial<Book> & Pick<Book, "bookId" | "title">): Book {
  return { author: "", asin: null, lastAnnotated: null, ...b };
}

export function makeHighlight(h: Partial<Highlight> & Pick<Highlight, "bookId">): Highlight {
  return {
    text: "",
    note: "",
    locationStart: null,
    locationEnd: null,
    page: null,
    color: null,
    truncated: false,
    source: "cloud",
    highlightedAt: null,
    amazonId: null,
    position: null,
    ...h,
  };
}
