# kindle-mcp

Kindle highlights and notes as an agent-readable store, and an Obsidian vault that keeps itself linked.
Sync engine (fetch + saved cookies, Playwright only for login) -> SQLite + FTS -> MCP server over stdio
(14 tools, 2 prompts). With a vault, each sync appends new highlights to book notes linked to the user's notes,
files @todo/@quote/@project itself, and hands @post/@research to the agent, which saves them with
`kindle_complete_command`. See README.md.

## Setup
    npm install && npm test          # vitest; fixtures are scrubbed real page markup
    npm run build && node dist/cli.js --help

## Layout (TypeScript, Node >= 22.13, ESM)
- `src/notebook/selectors.ts` — every DOM assumption about Amazon's page. Change here first when a sync breaks.
- `src/notebook/parser.ts` — pure HTML -> models (cheerio); unit-tested. `client.ts` — pagination, sign-in
  detection and the per-call deadline over a `Fetcher`. `fetchers.ts` — cookie fetcher (cron path) and browser
  fetcher (fallback). `login.ts` — headed Chrome once, saves `session.json`. `session.ts` — cookie jar.
- `src/store.ts` — node:sqlite. Cloud highlights keyed by Amazon annotation id; clippings merge by (book, location).
  Ids are sha1 prefixes identical to the original Python store (golden test); never change the hashing.
  `commands_done_at` is the highlight-level truth (1.0 code writes only that); `command_outputs` records finished
  commands, `leases` keeps one vault writer at a time, `book_notes` remembers exported notes. Schema changes are
  additive only: users' stores carry their reading history.
- `src/commands.ts` — `COMMANDS` table: tag, aliases, argument style, `doneBy` (sync | agent), result, action. Single
  source of truth for parsing, tool descriptions, the router prompt and the README table (drift tests in
  `tests/docs.test.ts`).
- `src/obsidian.ts` — book notes: blocks with the id on its own line, the 1.0 renderer (to recognise unedited
  blocks), `filename()` (never change it: existing notes are found by it), find-by-frontmatter.
- `src/vault/` — `write.ts` (every vault write: inside the vault, no symlinks, appends, compare-and-swap,
  neutralized model output), `index.ts` (per-vault cache of names, aliases and full text; budgeted reads),
  `linkify.ts` (mention linking), `frontmatter.ts`, `file.ts` (filing and agent notes), `backfill.ts` (links in
  blocks exported before, only on the user's yes), `run.ts` (the vault step: lease, no writes on a partial index).
- `src/server.ts` — `createServer(cfg)` is transport-free; `serveStdio` wires stdio. Prompts in `src/prompts/*.md`.
  Claude Desktop ignores server instructions: what the model must know goes in tool descriptions and results.
- `src/cli.ts` — login/sync/import-clippings/export/link-existing/status/doctor/prompt/serve. `sync --on-pending CMD`
  is the trigger.
- `src/mcpb-entry.ts` — the Claude Desktop bundle's entry. Serves unconditionally and never reads argv: Desktop's
  built-in Node runs it through its own wrapper and can repeat the script path. Keep it that way.
- `scripts/build-mcpb.mjs` — builds the `.mcpb` (manifest and settings generated from the live server), then unpacks
  the packed file and replays a host handshake against it (plain and repeated-path argv). Runs in CI and in the
  publish workflow before anything is published.
- `skills/kindle-router/SKILL.md` — the router prompt as a Claude Code skill; generated (`npm run render-skill`).

## Rules
- Never commit `.har`, `.db`, `session.json`, or `doctor-*.html`; they hold highlight text and session state.
- Fixtures must be scrubbed: placeholder text, account id replaced, cover URLs replaced. No real titles, ASINs or
  counts from anyone's library in files, commits or PR text (a docs test checks README and this file for counts).
- When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, save a scrubbed fixture, fix selectors, add a test.
- Keep the store and the MCP interface separate; the cron job and the server share one SQLite file (WAL).
- The server never assumes a runner or a sink. Routing behaviour lives in `COMMANDS` and the prompt text.
- Vault writes go through `src/vault/write.ts`, under the vault lease. Append; never rewrite the user's text.
- MCP tool calls must finish well under 60 s (Claude Desktop cancels them); long work takes a deadline.
- stdio servers must not write to stdout except through the transport; log to stderr.

## Verified
- Python version, live account (2026-09-21): library page, annotation pane, pagination, notes, undisplayable
  highlights, incremental sync.
- TypeScript port (2026-09-22): same fixtures and golden ids; sync + cookie write-back + `--on-pending` hook, and
  headless `login` + `sync --browser`, tested end to end against a local fixture server (browser tests need
  `KINDLE_BROWSER_PATH` or Chrome/Edge, else they skip); a 72-check stdio protocol pass, the MCP Inspector CLI, and
  Claude Code as a client. Live from Claude Desktop with the 1.0.3 bundle: `kindle_login` and the plain-HTTP
  incremental sync.
- 1.1.0 (2026-09-22), against the local fixture server and temp vaults: CLI sync, a 1.0-format book note linked on
  `link-existing --apply`, a second sync writing nothing, every generated block link resolving to a block id in
  the documented form; a 19-check stdio pass including a CLI sync and a server sync racing (nothing filed twice);
  the packed bundle's handshake (14 tools); headless Claude Code told only "Sync my Kindle highlights" saving the
  @post through `kindle_complete_command` unasked, and only offering with `KINDLE_ACT_ON_COMMANDS=false`. Not yet
  checked inside Obsidian itself (hover previews, Tasks plugin) or live against Amazon with 1.1.0.

## Next
1. `kindle_get_themes(since)` for the weekly brief.
2. Streamable HTTP transport behind a token, for web and mobile clients.
