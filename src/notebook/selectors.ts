/**
 * Every DOM assumption about read.amazon.com/notebook lives here.
 *
 * When Amazon changes the page, this is the only file that should need editing.
 * Run `kindle-mcp doctor` to dump the live HTML and compare it against these.
 */

// Logged-in marker and library list
export const LIBRARY_ROOT = "#kp-notebook-library";
export const BOOK_ROW = ".kp-notebook-library-each-book"; // element id == ASIN
export const BOOK_TITLE = "h2";
export const BOOK_AUTHOR = "p";
export const BOOK_ANNOTATED_DATE = "input[id^='kp-notebook-annotated-date']"; // value = last annotated date
export const LIBRARY_NEXT_TOKEN = ".kp-notebook-library-next-page-start"; // input value, empty on last page

// Annotation pane for one book (verified against a live HAR capture, 2026-09-21)
export const PANE_TITLE = "h3.kp-notebook-metadata";
export const PANE_AUTHOR = "p.kp-notebook-metadata.a-color-secondary";
export const PANE_ASIN = "#kp-notebook-asin";
export const ANNOTATION_ROW = "#kp-notebook-annotations > div.a-row.a-spacing-base";
// Page 2+ responses are bare fragments: the rows sit at top level with no container.
export const ANNOTATION_ROW_FRAGMENT = "div.a-row.a-spacing-base";
export const HIGHLIGHT_BOX = ".kp-notebook-highlight"; // class kp-notebook-highlight-<color>
export const HIGHLIGHT_EMPTY = ".kp-notebook-highlight-empty-text"; // "unable to display this type of content"
export const HIGHLIGHT_TEXT = "#highlight";
export const NOTE_TEXT = "#note";
export const HIGHLIGHT_HEADER = "#annotationHighlightHeader"; // e.g. "Yellow highlight | Location: 1,234"
export const NOTE_HEADER = "#annotationNoteHeader"; // e.g. "Note | Location: 1,234"
export const LOCATION_INPUT = "#kp-annotation-location"; // input value = start location
export const ANNOTATIONS_NEXT_TOKEN = ".kp-notebook-annotations-next-page-start";
export const CONTENT_LIMIT_STATE = ".kp-notebook-content-limit-state";

export const SIGNIN_URL_MARKERS = ["/ap/signin", "/ap/mfa", "/ap/cvf"];

export function libraryUrl(base: string, token = ""): string {
  return token ? `${base}/notebook?library=list&token=${token}` : `${base}/notebook`;
}

export function annotationsUrl(base: string, asin: string, token = "", contentLimitState = ""): string {
  return `${base}/notebook?asin=${asin}&contentLimitState=${contentLimitState}&token=${token}`;
}
