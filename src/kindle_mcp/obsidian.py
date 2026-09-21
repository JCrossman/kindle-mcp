"""Edit-safe Obsidian export: one note per book.

Each highlight is written once, tagged with a block id (^kh-<id>). On re-export we only
append highlights whose block id is not already in the file, so anything you edit,
reorder, or annotate in Obsidian is never overwritten.
"""
from __future__ import annotations

import re
from pathlib import Path

from .store import Store


def _filename(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|#^\[\]]', "", title).strip()[:120] or "Untitled"


def _tag(command: dict) -> str:
    tag = f"#kindle/{command['tag']}"
    if command["tag"] == "project" and command["arg"]:
        tag += "/" + re.sub(r"[^\w-]", "-", command["arg"])
    return tag


def render_highlight(h: dict) -> str:
    where = f"Location {h['location_start']}" if h["location_start"] is not None else ""
    if h.get("page"):
        where = f"Page {h['page']}" + (f" · {where}" if where else "")
    body = h["text"] or ("*(text withheld: publisher clipping limit)*" if h["truncated"] else "")
    lines = [f"> {ln}" for ln in body.splitlines()] if body else []
    if h["note"]:
        lines += ([">"] if lines else []) + ["> **Note:** " + h["note"].replace("\n", " ")]
    tags = " ".join(_tag(c) for c in h["commands"])
    meta = " · ".join(x for x in (where, tags) if x)
    lines.append(f"> — {meta} ^kh-{h['id']}" if meta else f"> ^kh-{h['id']}")
    return "\n".join(lines)


def export_book(store: Store, book_id: str, vault: Path, folder: str = "Kindle") -> dict:
    book = store.find_book(book_id)
    if not book:
        raise ValueError(f"No book matches '{book_id}'. Use kindle_list_books to see what is synced.")
    highlights = store.get_highlights(book["book_id"], limit=100000)
    target = vault / folder / f"{_filename(book['title'])}.md"
    target.parent.mkdir(parents=True, exist_ok=True)

    if target.exists():
        existing = target.read_text(encoding="utf-8")
    else:
        existing = "\n".join([
            "---", f'title: "{book["title"]}"', f'author: "{book["author"]}"',
            f'asin: {book["asin"] or ""}', "source: kindle", "tags: [kindle]", "---", "",
            f"# {book['title']}", f"*{book['author']}*" if book["author"] else "", "", "## Highlights", "",
        ])
    present = set(re.findall(r"\^kh-([0-9a-f]{16})", existing))
    fresh = [h for h in highlights if h["id"] not in present]
    if fresh:
        existing = existing.rstrip("\n") + "\n\n" + "\n\n".join(render_highlight(h) for h in fresh) + "\n"
    if fresh or not target.exists():
        target.write_text(existing, encoding="utf-8")
    return {"file": str(target), "added": len(fresh), "already_present": len(highlights) - len(fresh)}


def export_all(store: Store, vault: Path, folder: str = "Kindle") -> list[dict]:
    return [export_book(store, b["book_id"], vault, folder) for b in store.list_books(limit=100000)
            if b["highlight_count"]]
