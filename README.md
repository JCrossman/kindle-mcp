# kindle-mcp

Kindle highlights and notes as an agent-readable store, plus a router that acts on notes you type
on the Kindle itself. A sync engine pulls from `read.amazon.com/notebook` (and optionally
`My Clippings.txt`) into SQLite; an MCP server exposes that store to Claude; two prompts inside the
server turn `@post`, `@research`, `@todo` and friends into drafts, research notes and tasks.

```
Kindle notebook (fetch + saved cookies) ─┐
                                         ├─► SQLite + FTS ─┬─► MCP server over stdio (Claude Desktop / Claude Code)
My Clippings.txt (device, optional) ─────┘                 ├─► kindle_route_pending prompt: the @command router
                                                           ├─► kindle_weekly_brief prompt
                                                           └─► Obsidian notes (optional, append-only)
```

Requires Node 22.13 or newer. No native modules: SQLite comes with Node.

## Setup

```bash
npm install -g kindle-mcp-server     # or run every command below with `npx kindle-mcp-server`
kindle-mcp login          # Chrome opens; sign in to Amazon once (2FA included); cookies are saved
kindle-mcp doctor         # VERIFY FIRST: should report your real book count
kindle-mcp sync           # first run reads every book; later runs only changed books
kindle-mcp status
```

`login` needs Google Chrome or Microsoft Edge installed. Any Chromium-based browser works via
`KINDLE_BROWSER_PATH=/path/to/browser` (Brave, Chromium on Linux), or run `npx playwright install chromium`.
It saves the Amazon session cookies to `~/.kindle-mcp/session.json` with owner-only permissions.
Your password is never seen or stored by this code. Treat that file like a credential.

`sync` is plain HTTP with those cookies, so the scheduled job needs no browser. If Amazon ever
refuses that path, `kindle-mcp sync --browser` drives Chrome the way `login` does.

## Connect it to Claude

Claude Code:

```bash
claude mcp add --scope user kindle -e OBSIDIAN_VAULT="$HOME/path/to/vault" -- kindle-mcp serve
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "kindle": {
    "command": "kindle-mcp", "args": ["serve"],
    "env": { "OBSIDIAN_VAULT": "/path/to/vault" } } } }
```

`OBSIDIAN_VAULT` is optional. Without it the router writes wherever the client can (its own document
or task tools) and otherwise puts drafts in its reply.

## Notes as commands

Type these as a note on any highlight, on the Kindle:

| Tag | Alias | Argument | You mean | Router action |
|---|---|---|---|---|
| `@post` | `@p` | none | I want to write about this. The rest of the note is the angle. | Draft a post angle: one claim, 2 to 4 quotes cited by book title and location (this highlight plus related ones from kindle_get_command_context), and the tension with something else the reader has read. 150 to 300 words. |
| `@research` | `@r` | none | Go find out more about this. The rest of the note is the question. | Do the research. With web search available: find 3 to 5 sources, summarise them, say where they agree or disagree with the highlight, and include links. Always add the related highlights from the store. Without a web tool: write the three sharpest questions and state plainly that no research was performed. |
| `@todo` | `@t` | rest of line, required | Make this a task. The argument is the task text. | Create the task with the quote, book title and location attached. Use the runner's task tool if it has one, otherwise append a checklist item to the Todo list. |
| `@project` | `@pr` | one word, required | This belongs to project <name>. | Append the quote and note to that project's note. A missing project name goes to Unrouted with the reason. |
| `@quote` | `@q` | none | Keep this as a quotable line. | File it with attribution (title, author, location). No commentary. |

Unknown tags are kept and filed under Unrouted. A line argument stops at the next tag, so
`@todo email Sam @project netcare` is two commands. Editing the note on the Kindle re-opens it.
Add a command by adding a row to `COMMANDS` in `src/commands.ts`; the tool descriptions, the router
prompt and this table are all derived from it.

## How a note becomes an action

1. The Kindle syncs the note to Amazon the next time it is online (sideloaded books never reach the
   cloud; use `kindle-mcp import-clippings` for those).
2. `kindle-mcp sync` pulls changed books and stores the note's commands as pending.
3. `sync --on-pending CMD` runs `CMD` when something is pending, with `KINDLE_PENDING=<count>` in its
   environment. Quiet runs spawn nothing.
4. `CMD` starts an agent that runs the `kindle_route_pending` prompt: for each pending highlight it
   fetches context, does what every command asks, writes the output, marks the highlight done, and
   ends by re-reading the queue and listing anything still open.
5. `kindle-mcp status` shows the queue at any time.

The router is a prompt, not a scheduler. Pick whichever runner suits you:

**cron or launchd (hourly is cheap; an idle sync is two requests):**

```cron
30 * * * * PATH=/usr/local/bin:$PATH kindle-mcp sync --on-pending 'claude -p "$(kindle-mcp prompt route-pending)" --allowedTools "mcp__kindle,Read,Write,Edit,WebSearch,WebFetch"' >> ~/.kindle-mcp/sync.log 2>&1
```

Register the server for Claude Code first (`claude mcp add --scope user kindle ...` above) so the
headless session can see it. Windows: the same command in Task Scheduler with `cmd /c`.

**A Claude scheduled task bound to your computer:** in the desktop app, create a scheduled task whose
prompt is the output of `kindle-mcp prompt route-pending`, with the kindle server in your desktop
config. It runs when the app is running.

**Interactively:** in Claude Code type `/mcp__kindle__kindle_route_pending` (or `/mcp__kindle` and
pick from the list); arguments are positional, so `/mcp__kindle__kindle_route_pending todo true`
routes only `@todo` as a dry run. In Claude Desktop pick the prompt from the server's prompt menu.
Use a dry run the first time to see what it would do without writing or marking anything.

`kindle-mcp prompt weekly-brief` does the same for the reading brief: recent highlights clustered
into themes, one cited angle per theme, `@post` items first.

## MCP tools

`kindle_list_books`, `kindle_get_highlights`, `kindle_search_highlights`, `kindle_get_new_since`,
`kindle_get_pending_commands`, `kindle_get_command_context`, `kindle_mark_command_done`,
`kindle_export_to_obsidian`, `kindle_sync`, `kindle_status`.

Prompts: `kindle_route_pending(tag?, dry_run?)`, `kindle_weekly_brief(since?)`.

`kindle_get_command_context` is what makes routing work in one call: the highlight and note, the
neighbouring highlights in the same book, other highlights in the book with the same tag, and up to
five related highlights from other books.

## Status of the scraper

Verified against two live HAR captures (2026-09-21), 13 books, 434 annotations, every book matching
Amazon's own highlight and note counts, plus a full account sync of 19 books and 471 highlights (with
the original Python version; the TypeScript port passes the same scrubbed fixtures, and its
cookie-based sync path is tested against a local stand-in for Amazon, not yet against the live site):
- Location comes from a hidden input; headers may show `Page:` only. Location == byte position // 150 + 1.
- Row id is base64 of `<account>:<asin>:<position>:<TYPE>:<uuid>`; TYPE is HIGHLIGHT or NOTE. Stored minus the account as `amazon_id`.
- Colour comes from the `kp-notebook-highlight-<colour>` class (yellow, aqua, orange seen).
- Notes attach to their highlight in the same row; a freestanding note is a row with a note and no text.
- Pagination: page 1 sets `.kp-notebook-annotations-next-page-start`; pass it back verbatim as `token`
  with the `contentLimitState` value. Page 2+ responses are bare fragments with no
  `#kp-notebook-annotations` container; the parser handles both shapes.
- Highlights Amazon cannot render (images, tables) come back as `kp-notebook-highlight-empty-text`
  and are stored as `truncated`.
- Requests are plain same-origin GETs. The cookie-based sync path sends navigation-style headers;
  the browser path is the fallback if that ever changes.

`kindle-mcp doctor` saves the live HTML to `~/.kindle-mcp` and reports what the parser finds; every
selector lives in `src/notebook/selectors.ts`.

## Merge rule

Cloud highlights are keyed by Amazon's own annotation id, so two highlights at the same location
stay separate. Clippings entries have no such id: they merge into the cloud copy at the same
(book, start location) if one exists, else get their own row. When cloud and clippings both have a
highlight, a non-truncated copy beats a truncated one and longer text beats shorter.
Clippings-only books get a `clip:` id; clippings for a cloud book attach to it by normalized title.

Ids are computed exactly as the original Python version did, so a store and an Obsidian vault
created by it keep working.

## Environment

| Variable               | Default                   |
|------------------------|---------------------------|
| `KINDLE_MCP_HOME`      | `~/.kindle-mcp`           |
| `KINDLE_MCP_DB`        | `$KINDLE_MCP_HOME/kindle.db` |
| `KINDLE_NOTEBOOK_BASE` | `https://read.amazon.com` |
| `KINDLE_REQUEST_DELAY` | `1.5` seconds per page    |
| `KINDLE_ON_PENDING`    | unset; same as `sync --on-pending` |
| `KINDLE_BROWSER_PATH`  | unset; explicit browser executable for `login`, `doctor`, `--browser` |
| `OBSIDIAN_VAULT`       | unset                     |
| `OBSIDIAN_FOLDER`      | `Kindle`                  |

## Known limits

- Automated access may conflict with Amazon's terms of use. This reads only your own data, at low
  volume, with a delay between pages. Your call.
- How long the saved cookies stay valid without a browser refreshing them is not yet known. When
  they expire, `sync` exits non-zero with a message to run `kindle-mcp login` again, and reads keep
  working from the store.
- The router is an agent following a prompt. It marks a highlight done only after writing its
  output, and it re-reads the queue at the end, but it is not code. Check `kindle-mcp status` if
  the queue looks stuck.
- Location matching between cloud and clippings assumes both report the same start location.
- `first_seen` is when the sync first saw a highlight, not when you made it. The cloud page does
  not expose per-highlight timestamps; clippings does.
- Everything runs on the machine where the store lives. Claude on the web and on mobile cannot
  reach a stdio server; an HTTP transport is a small later addition, the tool code is transport-free.

## Development

```bash
npm install
npm test            # vitest; fixtures are scrubbed real page markup
npm run build       # dist/, then `node dist/cli.js --help`
```

When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, save a scrubbed copy of the HTML
under `tests/fixtures`, fix `src/notebook/selectors.ts`, add a test. Never commit `.har`, `.db`,
`session.json` or `doctor-*.html`: they hold highlight text and session state.

## Releasing

Bump `version` in `package.json` and merge. Then either run the `publish` workflow from the
Actions tab, typing that version to confirm (it publishes and creates the `v<version>` tag), or
push the tag yourself: `git tag v<version> && git push origin v<version>`. The workflow runs the
tests, builds, refuses a version that is already on npm, and publishes `kindle-mcp-server` with
provenance. It needs an `NPM_TOKEN` repository secret.

## Repository settings (maintainers)

Everything security-related about the repository itself is applied by one script, run once on
your own machine with the GitHub CLI:

```bash
gh auth login                                        # device-code flow in the browser
gh secret set NPM_TOKEN --repo OWNER/REPO            # paste the npm granular token when prompted
scripts/repo-settings.sh OWNER/REPO --public         # settings, then public + secret scanning
```

It sets verified-only actions with a read-only token, Dependabot alerts and security updates,
private vulnerability reporting, and a ruleset on the default branch (pull requests required,
review threads resolved, CI green on an up-to-date branch, no force pushes or deletions). With
`--public` it also flips visibility and enables secret scanning with push protection, which
GitHub only allows on public repositories. Re-running is safe; it prints the resulting state.

## Next layers (not built)

- `kindle_get_themes(since)`: deterministic keyword clustering the weekly brief can lean on.
- Streamable HTTP transport with a token, for Claude on the web and mobile.
- Remote read-only store, so the router can run in the cloud while the sync stays local.
