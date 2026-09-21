"""Every DOM assumption about read.amazon.com/notebook lives here.

When Amazon changes the page, this is the only file that should need editing.
Run `kindle-mcp doctor` to dump the live HTML and compare it against these.
"""

# Logged-in marker and library list
LIBRARY_ROOT = "#kp-notebook-library"
BOOK_ROW = ".kp-notebook-library-each-book"          # element id == ASIN
BOOK_TITLE = "h2"
BOOK_AUTHOR = "p"
BOOK_ANNOTATED_DATE = "input[id^='kp-notebook-annotated-date']"   # value = last annotated date
LIBRARY_NEXT_TOKEN = ".kp-notebook-library-next-page-start"       # input value, empty on last page

# Annotation pane for one book (verified against a live HAR capture, 2026-09-21)
PANE_TITLE = "h3.kp-notebook-metadata"
PANE_AUTHOR = "p.kp-notebook-metadata.a-color-secondary"
PANE_ASIN = "#kp-notebook-asin"
ANNOTATION_ROW = "#kp-notebook-annotations > div.a-row.a-spacing-base"
# Page 2+ responses are bare fragments: the rows sit at top level with no container.
ANNOTATION_ROW_FRAGMENT = "div.a-row.a-spacing-base"
HIGHLIGHT_BOX = ".kp-notebook-highlight"                # class kp-notebook-highlight-<color>
HIGHLIGHT_EMPTY = ".kp-notebook-highlight-empty-text"   # "unable to display this type of content"
HIGHLIGHT_TEXT = "#highlight"
NOTE_TEXT = "#note"
HIGHLIGHT_HEADER = "#annotationHighlightHeader"      # e.g. "Yellow highlight | Location: 1,234"
NOTE_HEADER = "#annotationNoteHeader"                # e.g. "Note | Location: 1,234"
LOCATION_INPUT = "#kp-annotation-location"           # input value = start location
ANNOTATIONS_NEXT_TOKEN = ".kp-notebook-annotations-next-page-start"
CONTENT_LIMIT_STATE = ".kp-notebook-content-limit-state"

SIGNIN_URL_MARKERS = ("/ap/signin", "/ap/mfa", "/ap/cvf")


def library_url(base: str, token: str = "") -> str:
    return f"{base}/notebook?library=list&token={token}" if token else f"{base}/notebook"


def annotations_url(base: str, asin: str, token: str = "", content_limit_state: str = "") -> str:
    return f"{base}/notebook?asin={asin}&contentLimitState={content_limit_state}&token={token}"
