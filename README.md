# kindle-mcp

Kindle highlights and notes as an agent-readable store. A sync engine pulls from
`read.amazon.com/notebook` (and optionally `My Clippings.txt`) into SQLite; an MCP
server exposes that store to Claude; an exporter writes edit-safe Obsidian notes.

```
Kindle notebook (Playwright) ─┐
                              ├─► SQLite + FTS ─┬─► MCP server (Claude Desktop / Claude Code)
My Clippings.txt (fallback) ──┘                 ├─► Obsidian notes (append-only)
                                                └─► @command queue for agents
```

## Setup

```bash
pip install -e ".[dev]"
playwright install chromium
kindle-mcp login          # browser opens; sign in to Amazon once (2FA included)
kindle-mcp doctor         # VERIFY FIRST: should report your real book count
kindle-mcp sync           # first run reads every book; later runs only changed books
kindle-mcp status
```

`login` stores session cookies in `~/.kindle-mcp/browser-profile`. Your Amazon password
is never seen or stored by this code. Treat that folder like a credential.

## Status of the scraper

Verified against two live HAR captures (2026-09-21), 13 books, 434 annotations, every
book matching Amazon's own highlight and note counts:
- Location comes from a hidden input; headers may show `Page:` only. Location == byte position // 150 + 1.
- Row id is base64 of `<account>:<asin>:<position>:<TYPE>:<uuid>`; TYPE is HIGHLIGHT or NOTE. Stored minus the account as `amazon_id`.
- Colour comes from the `kp-notebook-highlight-<colour>` class (yellow, aqua, orange seen).
- Notes attach to their highlight in the same row; a freestanding note is a row with a note and no text.
- Pagination: page 1 sets `.kp-notebook-annotations-next-page-start`; pass it back verbatim as `token`
  with the `contentLimitState` value. **Page 2+ responses are bare fragments with no
  `#kp-notebook-annotations` container**; the parser handles both shapes.
- Highlights Amazon cannot render (images, tables) come back as `kp-notebook-highlight-empty-text`
  and are stored as `truncated`. No publisher-limit truncation was seen yet.
- Requests are plain same-origin XHR GETs.

Still unverified: the library list page (recording started after it loaded). `kindle-mcp doctor`
saves live HTML and reports what the parser finds; all selectors live in `notebook_selectors.py`.

## Notes as commands

Type these as a note on any highlight, on the Kindle itself:

| Note                     | Meaning                                  |
|--------------------------|------------------------------------------|
| `@post`                  | queue for a writing draft                |
| `@research`              | file under research                      |
| `@project netcare`       | attach to a project                      |
| `@todo email Sam`        | task; argument runs to end of line       |

Agents call `kindle_get_pending_commands`, route each highlight, then
`kindle_mark_command_done`. Editing the note on the Kindle re-opens it. Add your own tags
in `commands.py` (`ARG_STYLE`).

## MCP tools

`kindle_list_books`, `kindle_get_highlights`, `kindle_search_highlights`,
`kindle_get_new_since`, `kindle_get_pending_commands`, `kindle_mark_command_done`,
`kindle_export_to_obsidian`, `kindle_sync`, `kindle_status`.

Claude Code:

```bash
claude mcp add kindle -e OBSIDIAN_VAULT="$HOME/path/to/vault" -- kindle-mcp serve
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "kindle": {
    "command": "kindle-mcp", "args": ["serve"],
    "env": { "OBSIDIAN_VAULT": "/path/to/vault" } } } }
```

## Autonomy

The MCP server is pull-based. The scheduled job is what makes it autonomous:

```cron
# every morning at 6:30: sync, then append new highlights to Obsidian
30 6 * * * OBSIDIAN_VAULT=/path/to/vault /usr/local/bin/kindle-mcp sync --export >> ~/.kindle-mcp/sync.log 2>&1
```

Non-zero exit on failure. When the Amazon session expires the log says to run
`kindle-mcp login` again; nothing else breaks, reads keep working from the store.

## Merge rule

Cloud highlights are keyed by Amazon's own annotation id, so two highlights at the same
location stay separate. Clippings entries have no such id: they merge into the cloud copy
at the same (book, start location) if one exists, else get their own row. When cloud and clippings both have a
highlight, a non-truncated copy beats a truncated one and longer text beats shorter.
Clippings-only books get a `clip:` id; clippings for a cloud book attach to it by
normalized title.

## Environment

| Variable               | Default                   |
|------------------------|---------------------------|
| `KINDLE_MCP_HOME`      | `~/.kindle-mcp`           |
| `KINDLE_NOTEBOOK_BASE` | `https://read.amazon.com` |
| `OBSIDIAN_VAULT`       | unset                     |
| `OBSIDIAN_FOLDER`      | `Kindle`                  |
| `KINDLE_REQUEST_DELAY` | `1.5` seconds per page    |

## Known limits

- Automated access may conflict with Amazon's terms of use. This reads only your own
  data, at low volume, with a delay between pages. Your call.
- Location matching between cloud and clippings assumes both report the same start
  location. Verify on one book you have in both before trusting the merge.
- `first_seen` is when the sync first saw a highlight, not when you made it. The cloud
  page does not expose per-highlight timestamps; clippings does.

## Next layers (not built)

- `kindle_get_themes(window)`: cluster recent highlights into interest signals.
- Weekly digest agent: `kindle_get_new_since` + older highlights relevant to active projects.
- Router agent for the @command queue.
- Remote read-only MCP over the store, for mobile.
