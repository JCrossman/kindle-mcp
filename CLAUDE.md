# kindle-mcp

Kindle highlights and notes as an agent-readable store. Sync engine (Playwright, read.amazon.com/notebook)
-> SQLite + FTS -> MCP server (9 tools) -> Obsidian export + @command queue. See README.md.

## Setup
    python3.12 -m venv .venv && source .venv/bin/activate
    pip install -e ".[dev]" && playwright install chromium
    python -m pytest -q          # 14 tests; fixtures are scrubbed real page markup

## Layout
- `src/kindle_mcp/notebook_selectors.py` — every DOM assumption about Amazon's page. Change here first when a sync breaks.
- `notebook_parser.py` — pure HTML -> models; unit-tested. `scraper.py` — Playwright only.
- `store.py` — SQLite. Cloud highlights keyed by Amazon annotation id; clippings merge by (book, location).
- `commands.py` — @tag grammar (`ARG_STYLE`). `server.py` — MCP tools. `cli.py` — login/sync/doctor/serve.

## Rules
- Never commit `.har`, `.db`, or `doctor-*.html`; they hold highlight text and session state.
- Fixtures must be scrubbed: placeholder text, account id replaced, cover URLs replaced.
- When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, save a scrubbed fixture, fix selectors, add a test.
- Keep the store and the MCP interface separate; the cron job and the server share one SQLite file.

## Verified against live account (2026-09-21)
19 books, 471 highlights. Library page, annotation pane, pagination (page 2+ is a bare fragment),
notes (attached and freestanding), undisplayable highlights. Incremental sync skips unchanged books.

## Next
1. Router agent for the @command queue (post/research/project/todo) — the differentiating piece.
2. Short tag aliases (`@p`, `@r`) for Kindle typing.
3. `kindle_get_themes(window)`; weekly digest.
4. Try plain-HTTP sync with session cookies (HAR shows simple XHR GETs) to drop Playwright from the cron path.
