"""Parser for the device's My Clippings.txt. Covers sideloaded books the cloud never sees."""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from .models import Book, Highlight

SEPARATOR = "=========="
LIMIT_MARKER = "clipping limit"          # "<You have reached the clipping limit for this item>"
_TITLE = re.compile(r"^(?P<title>.*?)(?:\s*\((?P<author>[^()]*)\))?$")
_LOC = re.compile(r"[Ll]ocation\s+(\d+)(?:-(\d+))?")
_PAGE = re.compile(r"[Pp]age\s+(\w+)")
_DATE = re.compile(r"Added on\s+(.+)$")
_DATE_FORMATS = ("%A, %B %d, %Y %I:%M:%S %p", "%A, %d %B %Y %H:%M:%S", "%A, %B %d, %Y %H:%M:%S")


def _slug(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]


def _when(meta: str) -> str | None:
    m = _DATE.search(meta)
    if not m:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(m.group(1).strip(), fmt).strftime("%Y-%m-%dT%H:%M:%S")
        except ValueError:
            continue
    return None


def parse_clippings(path: Path | str) -> dict[str, tuple[Book, list[Highlight]]]:
    """Returns {book_id: (Book, highlights)} with notes folded into the highlight they sit on."""
    raw = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    books: dict[str, tuple[Book, list[Highlight]]] = {}
    loose_notes: dict[str, list[Highlight]] = {}

    for entry in raw.split(SEPARATOR):
        lines = [ln.strip("\ufeff \r") for ln in entry.strip().splitlines()]
        if len(lines) < 2:
            continue
        m = _TITLE.match(lines[0].strip())
        title = (m.group("title") or lines[0]).strip()
        author = (m.group("author") or "").strip()
        meta = lines[1]
        body = "\n".join(lines[2:]).strip()
        kind = "note" if re.search(r"Your Note", meta, re.I) else "bookmark" if re.search(r"Bookmark", meta, re.I) else "highlight"
        if kind == "bookmark":
            continue

        book_id = f"clip:{_slug(title)}"
        if book_id not in books:
            books[book_id] = (Book(book_id=book_id, title=title, author=author), [])
        loc, page = _LOC.search(meta), _PAGE.search(meta)
        start = int(loc.group(1)) if loc else None
        end = int(loc.group(2)) if loc and loc.group(2) else start
        truncated = LIMIT_MARKER in body.lower()
        h = Highlight(
            book_id=book_id, location_start=start, location_end=end, page=page.group(1) if page else None,
            truncated=truncated, source="clippings", highlighted_at=_when(meta),
            text="" if (kind == "note" or truncated) else body, note=body if kind == "note" else "",
        )
        (loose_notes.setdefault(book_id, []) if kind == "note" else books[book_id][1]).append(h)

    # The device logs a note as its own entry, located inside the highlight it belongs to.
    for book_id, notes in loose_notes.items():
        highlights = books[book_id][1]
        for n in notes:
            host = next((h for h in highlights if h.location_start is not None and n.location_start is not None
                         and h.location_start <= n.location_start <= (h.location_end or h.location_start)), None)
            if host:
                host.note = f"{host.note}\n{n.note}".strip()
            else:
                highlights.append(n)   # standalone note
    return books
