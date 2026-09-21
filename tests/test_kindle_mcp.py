import asyncio
import json
from pathlib import Path

import pytest

from kindle_mcp.clippings import parse_clippings
from kindle_mcp.commands import parse_commands
from kindle_mcp.notebook_parser import parse_annotations, parse_library
from kindle_mcp.obsidian import export_book
from kindle_mcp.store import Store, title_key
from kindle_mcp.sync import import_clippings

FX = Path(__file__).parent / "fixtures"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "k.db")
    yield s
    s.close()


def load_cloud(store):
    books, token = parse_library((FX / "library.html").read_text())
    assert token == ""
    book_id = store.upsert_book(books[0])
    highlights, _, _ = parse_annotations((FX / "annotations.html").read_text(), book_id)
    return book_id, [store.upsert_highlight(book_id, h) for h in highlights]


def test_commands_grammar():
    cmds, rest = parse_commands("@post focusing illusion applies to AI hype @project netcare")
    assert cmds == [{"tag": "post", "arg": ""}, {"tag": "project", "arg": "netcare"}]
    assert rest == "focusing illusion applies to AI hype"
    assert parse_commands("@todo email Sam about this") == ([{"tag": "todo", "arg": "email Sam about this"}], "")
    assert parse_commands("mail me at a@b.com") == ([], "mail me at a@b.com")     # emails are not commands
    assert parse_commands("") == ([], "")


def test_library_parse():
    books, _ = parse_library((FX / "library.html").read_text())
    assert [b.asin for b in books] == ["B0FAKE0004", "B07XYZ1234"]
    assert books[0].author == "Daniel Kahneman"
    assert books[0].last_annotated == "Sunday September 13, 2026"


def test_annotations_parse():
    hs, token, _ = parse_annotations((FX / "annotations.html").read_text(), "B0FAKE0004")
    assert len(hs) == 3 and token == ""
    assert hs[0].location_start == 1234 and hs[0].color == "yellow" and hs[0].note.startswith("@post")
    assert hs[1].page == "87" and hs[1].location_start == 2001
    assert hs[2].truncated and hs[2].text == ""


def test_title_key_joins_cloud_and_clippings():
    assert title_key("Team Topologies: Organizing Business") == title_key("Team Topologies (Skelton, Matthew)")


def test_store_is_idempotent_and_searchable(store):
    _, first = load_cloud(store)
    _, second = load_cloud(store)
    assert first == ["new"] * 3 and second == ["unchanged"] * 3
    hits = store.search("blindness")
    assert len(hits) == 1 and hits[0]["title"] == "Thinking, Fast and Slow"
    assert store.search("kahneman")            # author is searchable


def test_fullest_copy_merge_fixes_truncated_cloud_highlight(store):
    book_id, _ = load_cloud(store)
    assert store.status()["truncated_highlights"] == 1
    import_clippings(store, FX / "My Clippings.txt", log=lambda _m: None)
    merged = [h for h in store.get_highlights(book_id) if h["location_start"] == 3050][0]
    assert merged["text"].startswith("The confidence people have")      # clippings filled the gap
    assert not merged["truncated"]
    assert merged["commands"] == [{"tag": "research", "arg": ""}]        # device note attached to its highlight
    assert store.status()["books"] == 3                                  # Kahneman matched, not duplicated


def test_clippings_parse():
    books = parse_clippings(FX / "My Clippings.txt")
    side = books["clip:a-sideloaded-pdf"][1]
    assert len(side) == 1 and side[0].location_end == 12                 # bookmark skipped
    assert side[0].highlighted_at == "2026-09-14T07:00:00"
    assert books["clip:some-limited-book"][1][0].truncated


def test_pending_commands_lifecycle(store):
    load_cloud(store)
    pending = store.pending_commands()
    assert len(pending) == 1
    assert [h["id"] for h in store.pending_commands("project")] == [pending[0]["id"]]
    assert store.pending_commands("todo") == []
    assert store.mark_commands_done(pending[0]["id"])
    assert store.pending_commands() == []


def test_obsidian_export_is_append_only(store, tmp_path):
    book_id, _ = load_cloud(store)
    vault = tmp_path / "vault"
    first = export_book(store, book_id, vault)
    note = Path(first["file"])
    assert first["added"] == 3 and "#kindle/project/netcare" in note.read_text()
    note.write_text(note.read_text() + "\nMY OWN THOUGHTS\n")            # user edits in Obsidian
    import_clippings(store, FX / "My Clippings.txt", log=lambda _m: None)
    second = export_book(store, "thinking", vault)                       # title fragment lookup
    assert second["added"] == 0 and second["already_present"] == 3
    assert "MY OWN THOUGHTS" in note.read_text()


def test_mcp_tools_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setenv("KINDLE_MCP_HOME", str(tmp_path))
    from kindle_mcp import server
    s = Store(tmp_path / "kindle.db"); load_cloud(s); s.close()

    tools = asyncio.run(server.mcp.list_tools())
    assert {t.name for t in tools} >= {"kindle_list_books", "kindle_search_highlights", "kindle_get_new_since",
                                       "kindle_get_pending_commands", "kindle_sync", "kindle_status"}
    assert json.loads(server.kindle_search_highlights("blindness"))["count"] == 1
    assert json.loads(server.kindle_get_new_since("1d"))["count"] == 3
    assert "error" in json.loads(server.kindle_get_new_since("whenever"))
    assert json.loads(server.kindle_get_highlights("no such book"))["error"]
    assert json.loads(server.kindle_status())["pending_commands"] == 1


def test_live_page_structure(store):
    """Real markup captured from read.amazon.com on 2026-09-21; text and account id scrubbed."""
    from kindle_mcp.notebook_parser import parse_pane_book
    html = (FX / "annotations_live_structure.html").read_text()
    book = parse_pane_book(html)
    assert book.asin == "B0FAKE0001" and book.author == "Placeholder Author One"
    hs, token, state = parse_annotations(html, book.asin)
    assert [(h.location_start, h.page, h.color) for h in hs] == [(31, "7", "yellow"), (123, "42", "yellow"), (130, "44", "yellow")]
    assert all(h.position // 150 + 1 == h.location_start for h in hs)      # location derives from byte position
    assert hs[0].amazon_id.startswith("B0FAKE0001:4559:HIGHLIGHT:") and "ACCOUNT" not in hs[0].amazon_id
    assert token == "" and state == "REDACTED" and not any(h.truncated for h in hs)
    book_id = store.upsert_book(book)
    assert [store.upsert_highlight(book_id, h) for h in hs] == ["new"] * 3
    assert store.get_highlights(book_id)[0]["amazon_id"] == hs[0].amazon_id


def test_live_fragment_page_and_notes(store):
    """Page 2+ of a book arrives without the #kp-notebook-annotations container."""
    hs, token, state = parse_annotations((FX / "annotations_fragment_page2.html").read_text(), "B0FAKE0002")
    assert len(hs) == 3 and token == "" and state == "REDACTED"
    assert hs[0].location_start == 4583 and hs[0].color == "orange"

    notes, _, _ = parse_annotations((FX / "annotations_notes.html").read_text(), "B0FAKE0002")
    assert len(notes) == 2
    assert notes[0].text and notes[0].note == "Placeholder note 1."           # note attached to a highlight
    assert not notes[1].text and notes[1].note == "Placeholder note 2." and not notes[1].truncated   # freestanding note

    bad, _, _ = parse_annotations((FX / "annotations_undisplayable.html").read_text(), "B0FAKE0003")
    assert len(bad) == 1 and bad[0].truncated and bad[0].location_start == 1901 and bad[0].color == "orange"


def test_same_location_cloud_highlights_are_kept_apart(store):
    from kindle_mcp.models import Book, Highlight
    book_id = store.upsert_book(Book(book_id="B1", asin="B1", title="T"))
    a = Highlight(book_id="B1", text="first", location_start=10, amazon_id="B1:1500:HIGHLIGHT:a", source="cloud")
    b = Highlight(book_id="B1", text="second", location_start=10, amazon_id="B1:1500:HIGHLIGHT:b", source="cloud")
    assert [store.upsert_highlight(book_id, h) for h in (a, b)] == ["new", "new"]
    assert store.status()["highlights"] == 2
    # a clippings copy of one of them merges rather than adding a third row
    c = Highlight(book_id="B1", text="first, and longer text from the device", location_start=10, source="clippings")
    assert store.upsert_highlight(book_id, c) == "updated"
    assert store.status()["highlights"] == 2


def test_migration_rekeys_location_ids(tmp_path):
    from kindle_mcp.models import Book, Highlight
    from kindle_mcp.store import location_id
    s = Store(tmp_path / "old.db")
    book_id = s.upsert_book(Book(book_id="B1", asin="B1", title="T"))
    h = Highlight(book_id="B1", text="x", location_start=5, amazon_id="B1:600:HIGHLIGHT:z", source="cloud")
    s.db.execute("INSERT INTO highlights (id, book_id, location_start, text, source, amazon_id, first_seen, updated_at)"
                 " VALUES (?,?,?,?,?,?,'t','t')", (location_id(book_id, h), book_id, 5, "x", "cloud", h.amazon_id))
    s.db.commit(); s.close()
    s = Store(tmp_path / "old.db")
    assert s.upsert_highlight(book_id, h) == "unchanged" and s.status()["highlights"] == 1
    s.close()
