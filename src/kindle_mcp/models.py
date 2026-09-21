from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Book:
    book_id: str                  # ASIN for cloud books, "clip:<slug>" for clippings-only books
    title: str
    author: str = ""
    asin: str | None = None
    last_annotated: str | None = None   # raw string from the notebook page; used to skip unchanged books


@dataclass
class Highlight:
    book_id: str
    text: str = ""
    note: str = ""
    location_start: int | None = None
    location_end: int | None = None
    page: str | None = None
    color: str | None = None
    truncated: bool = False       # publisher clipping limit hit; text missing or partial
    source: str = "cloud"         # "cloud" | "clippings"
    highlighted_at: str | None = None   # ISO timestamp; only clippings carries this
    commands: list[dict] = field(default_factory=list)
    amazon_id: str | None = None        # Amazon's own stable annotation id (cloud only)
    position: int | None = None         # byte position in the book; location == position // 150 + 1
