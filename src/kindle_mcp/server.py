"""MCP interface over the local store. Reads are instant (SQLite); only kindle_sync touches Amazon."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Annotated

import anyio
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from .config import Config
from .store import Store

mcp = MCPServer(
    "kindle_mcp",
    instructions=(
        "Jeremy's Kindle highlights and notes, synced to a local store. Use kindle_search_highlights to bring "
        "his own reading into a conversation, kindle_get_new_since to see what he has been reading lately, and "
        "kindle_get_pending_commands to act on @tags he typed as notes on his Kindle (@post, @research, "
        "@project <name>, @todo <text>). Always cite book title and location when quoting a highlight."
    ),
)

READ = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
CHAR_LIMIT = 25_000


def _store() -> tuple[Config, Store]:
    cfg = Config.load()
    cfg.ensure_dirs()
    return cfg, Store(cfg.db_path)


def _slim(h: dict) -> dict:
    keep = ("id", "title", "author", "text", "note", "location_start", "page", "truncated", "commands", "first_seen")
    return {k: h[k] for k in keep if h.get(k) not in (None, "", [], False)}


def _reply(payload: dict) -> str:
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    if len(text) > CHAR_LIMIT and isinstance(payload.get("highlights"), list):
        items = payload["highlights"]
        while items and len(text) > CHAR_LIMIT:
            items = items[: max(1, len(items) // 2)]
            text = json.dumps({**payload, "highlights": items, "truncated_response": True,
                               "hint": "Response cut to fit. Use limit/offset or a narrower query."},
                              indent=2, ensure_ascii=False)
    return text


def _parse_since(since: str) -> str:
    """Accepts '7d', '36h', '2w', or an ISO date/datetime."""
    s = since.strip().lower()
    units = {"h": "hours", "d": "days", "w": "weeks"}
    if s[:-1].isdigit() and s[-1] in units:
        dt = datetime.now(timezone.utc) - timedelta(**{units[s[-1]]: int(s[:-1])})
    else:
        try:
            dt = datetime.fromisoformat(s.replace("z", "+00:00"))
        except ValueError:
            raise ValueError(f"Could not read '{since}'. Use a span like '7d', '36h', '2w' or an ISO date like '2026-09-01'.")
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@mcp.tool(name="kindle_list_books", annotations=READ)
def kindle_list_books(
    query: Annotated[str | None, Field(description="Optional title or author fragment, e.g. 'kahneman'")] = None,
    limit: Annotated[int, Field(ge=1, le=200)] = 50,
    offset: Annotated[int, Field(ge=0)] = 0,
) -> str:
    """List synced books, most recently highlighted first, with highlight counts per book."""
    _, store = _store()
    try:
        books = store.list_books(query, limit, offset)
        return _reply({"count": len(books), "offset": offset, "books": books})
    finally:
        store.close()


@mcp.tool(name="kindle_get_highlights", annotations=READ)
def kindle_get_highlights(
    book: Annotated[str, Field(description="Book id, ASIN, or part of the title, e.g. 'Thinking, Fast'")],
    limit: Annotated[int, Field(ge=1, le=500)] = 100,
    offset: Annotated[int, Field(ge=0)] = 0,
) -> str:
    """All highlights and notes for one book, in reading order."""
    _, store = _store()
    try:
        found = store.find_book(book)
        if not found:
            return _reply({"error": f"No book matches '{book}'. Call kindle_list_books to see titles."})
        items = store.get_highlights(found["book_id"], limit, offset)
        return _reply({"book": found["title"], "author": found["author"], "count": len(items),
                       "offset": offset, "highlights": [_slim(h) for h in items]})
    finally:
        store.close()


@mcp.tool(name="kindle_search_highlights", annotations=READ)
def kindle_search_highlights(
    query: Annotated[str, Field(description="Words to find across highlight text, notes, titles and authors", min_length=2)],
    limit: Annotated[int, Field(ge=1, le=100)] = 20,
) -> str:
    """Full-text search across every highlight and note, best matches first."""
    _, store = _store()
    try:
        items = store.search(query, limit)
        return _reply({"query": query, "count": len(items), "highlights": [_slim(h) for h in items]})
    finally:
        store.close()


@mcp.tool(name="kindle_get_new_since", annotations=READ)
def kindle_get_new_since(
    since: Annotated[str, Field(description="Span like '7d', '36h', '2w', or an ISO date like '2026-09-01'")] = "7d",
    limit: Annotated[int, Field(ge=1, le=500)] = 200,
) -> str:
    """Highlights first seen by the sync since a point in time. The basis for digests and resurfacing."""
    _, store = _store()
    try:
        cutoff = _parse_since(since)
        items = store.new_since(cutoff, limit)
        return _reply({"since": cutoff, "count": len(items), "highlights": [_slim(h) for h in items]})
    except ValueError as e:
        return _reply({"error": str(e)})
    finally:
        store.close()


@mcp.tool(name="kindle_get_pending_commands", annotations=READ)
def kindle_get_pending_commands(
    tag: Annotated[str | None, Field(description="Filter to one tag, e.g. 'post', 'research', 'project', 'todo'")] = None,
    limit: Annotated[int, Field(ge=1, le=500)] = 100,
) -> str:
    """Highlights whose Kindle note contains an @command that has not been actioned yet.
    After routing one, call kindle_mark_command_done with its id so it is not routed twice."""
    _, store = _store()
    try:
        items = store.pending_commands(tag, limit)
        return _reply({"count": len(items), "highlights": [_slim(h) for h in items]})
    finally:
        store.close()


@mcp.tool(name="kindle_mark_command_done",
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
def kindle_mark_command_done(
    highlight_id: Annotated[str, Field(description="The 'id' field of the highlight that was routed")],
) -> str:
    """Mark a highlight's @commands as actioned. Editing the note on the Kindle re-opens it."""
    _, store = _store()
    try:
        ok = store.mark_commands_done(highlight_id)
        return _reply({"ok": ok} if ok else {"error": f"No highlight with id '{highlight_id}'."})
    finally:
        store.close()


@mcp.tool(name="kindle_export_to_obsidian",
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=False))
def kindle_export_to_obsidian(
    book: Annotated[str | None, Field(description="Book id, ASIN or title fragment. Omit to export every book.")] = None,
) -> str:
    """Write highlights into the Obsidian vault, one note per book. Append-only: existing edits are never overwritten."""
    from .obsidian import export_all, export_book
    cfg, store = _store()
    try:
        if not cfg.obsidian_vault:
            return _reply({"error": "OBSIDIAN_VAULT is not set in this server's environment."})
        results = [export_book(store, book, cfg.obsidian_vault, cfg.obsidian_folder)] if book else \
            export_all(store, cfg.obsidian_vault, cfg.obsidian_folder)
        return _reply({"books": len(results), "highlights_added": sum(r["added"] for r in results),
                       "files": [r["file"] for r in results if r["added"]]})
    except ValueError as e:
        return _reply({"error": str(e)})
    finally:
        store.close()


@mcp.tool(name="kindle_sync",
          annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=True, openWorldHint=True))
async def kindle_sync(
    full: Annotated[bool, Field(description="Re-read every book instead of only books annotated since last sync")] = False,
    book: Annotated[str | None, Field(description="Limit the sync to one title fragment or ASIN")] = None,
) -> str:
    """Pull the latest highlights from Amazon's Kindle notebook. Slow (seconds per book); reads do not need it."""
    from .scraper import AuthRequired
    from .sync import sync_cloud

    def work() -> dict:                       # Playwright's sync API must run outside the event loop
        cfg, store = _store()
        try:
            return sync_cloud(cfg, store, full=full, only=book, log=lambda _m: None)
        finally:
            store.close()

    try:
        return _reply(await anyio.to_thread.run_sync(work))
    except AuthRequired as e:
        return _reply({"error": str(e), "needs_human": True})
    except Exception as e:
        return _reply({"error": f"Sync failed: {e}"})


@mcp.tool(name="kindle_status", annotations=READ)
def kindle_status() -> str:
    """Store counts, truncated-highlight count, pending @commands, and the last sync run."""
    _, store = _store()
    try:
        return _reply(store.status())
    finally:
        store.close()


def run() -> None:
    mcp.run("stdio")


if __name__ == "__main__":
    run()
