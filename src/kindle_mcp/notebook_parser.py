"""Pure HTML -> models. No network, so it is unit-testable against saved pages."""
from __future__ import annotations

import base64
import re

from bs4 import BeautifulSoup

from . import notebook_selectors as S
from .models import Book, Highlight


def _val(soup, selector: str) -> str:
    el = soup.select_one(selector)
    return (el.get("value") or "").strip() if el else ""


def _int(text: str | None) -> int | None:
    digits = re.sub(r"[^\d]", "", text or "")
    return int(digits) if digits else None


def decode_annotation_id(row_id: str) -> tuple[str | None, int | None]:
    """Row ids are base64 of '<account>:<asin>:<position>:<TYPE>:<uuid>'.
    Returns (stable id without the account part, byte position)."""
    try:
        parts = base64.b64decode(row_id + "=" * (-len(row_id) % 4)).decode("utf-8").split(":")
        if len(parts) >= 5 and parts[2].isdigit():
            return ":".join(parts[1:]), int(parts[2])
    except Exception:
        pass
    return None, None


def parse_pane_book(html: str) -> Book | None:
    """The annotation pane carries the book's own title/author, so a book can be synced by ASIN alone."""
    soup = BeautifulSoup(html, "html.parser")
    asin, title = _val(soup, S.PANE_ASIN), soup.select_one(S.PANE_TITLE)
    if not asin or not title:
        return None
    author = soup.select_one(S.PANE_AUTHOR)
    return Book(book_id=asin, asin=asin, title=title.get_text(" ", strip=True),
                author=author.get_text(" ", strip=True) if author else "")


def parse_library(html: str) -> tuple[list[Book], str]:
    """Returns (books, next_page_token). Token is '' on the last page."""
    soup = BeautifulSoup(html, "html.parser")
    books = []
    for row in soup.select(S.BOOK_ROW):
        asin = (row.get("id") or "").strip()
        title_el = row.select_one(S.BOOK_TITLE)
        if not asin or not title_el:
            continue
        author_el = row.select_one(S.BOOK_AUTHOR)
        author = author_el.get_text(" ", strip=True) if author_el else ""
        author = re.sub(r"^(By|De|Von|Par)\s*:\s*", "", author, flags=re.I)
        date_el = row.select_one(S.BOOK_ANNOTATED_DATE)
        books.append(Book(
            book_id=asin, asin=asin, title=title_el.get_text(" ", strip=True), author=author,
            last_annotated=(date_el.get("value") or "").strip() if date_el else None,
        ))
    return books, _val(soup, S.LIBRARY_NEXT_TOKEN)


def parse_annotations(html: str, book_id: str) -> tuple[list[Highlight], str, str]:
    """Returns (highlights, next_page_token, content_limit_state)."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    rows = soup.select(S.ANNOTATION_ROW) or [
        r for r in soup.select(S.ANNOTATION_ROW_FRAGMENT) if r.select_one(S.LOCATION_INPUT) is not None
    ]
    for row in rows:
        text_el, note_el = row.select_one(S.HIGHLIGHT_TEXT), row.select_one(S.NOTE_TEXT)
        text = text_el.get_text(" ", strip=True) if text_el else ""
        note = note_el.get_text("\n", strip=True) if note_el else ""
        header_el = row.select_one(S.HIGHLIGHT_HEADER) or row.select_one(S.NOTE_HEADER)
        header = header_el.get_text(" ", strip=True) if header_el else ""
        if not (text or note or header):
            continue

        amazon_id, position = decode_annotation_id(row.get("id") or "")
        location = _int(_val(row, S.LOCATION_INPUT))
        if location is None and position is not None:
            location = position // 150 + 1
        if location is None:
            m = re.search(r"Location:?\s*([\d,]+)", header, flags=re.I)
            location = _int(m.group(1)) if m else None
        page_m = re.search(r"Page:?\s*([\w,]+)", header, flags=re.I)
        color_m = re.match(r"\s*(\w+)\s+highlight", header, flags=re.I)
        color = color_m.group(1).lower() if color_m else None
        box = row.select_one(S.HIGHLIGHT_BOX)
        if box is not None:
            for cls in box.get("class", []):
                if cls.startswith("kp-notebook-highlight-") and cls != "kp-notebook-highlight-empty-text":
                    color = cls.rsplit("-", 1)[1]
        undisplayable = row.select_one(S.HIGHLIGHT_EMPTY) is not None

        out.append(Highlight(
            book_id=book_id, text=text, note=note, location_start=location,
            page=page_m.group(1) if page_m else None,
            color=color,
            # Empty highlight text: either Amazon can't render it (image/table) or the export limit was hit.
            truncated=undisplayable or bool(row.select_one(S.HIGHLIGHT_HEADER) and not text and not note),
            source="cloud", amazon_id=amazon_id, position=position,
        ))
    return out, _val(soup, S.ANNOTATIONS_NEXT_TOKEN), _val(soup, S.CONTENT_LIMIT_STATE)
