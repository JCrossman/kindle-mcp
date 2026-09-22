# kindle-mcp

Kindle highlights and notes as an agent-readable store. Sync engine (fetch + saved cookies, Playwright
only for login) -> SQLite + FTS -> MCP server over stdio (10 tools, 2 prompts) -> @command router
prompt -> optional Obsidian export. See README.md.

## Setup
    npm install && npm test          # vitest; fixtures are scrubbed real page markup
    npm run build && node dist/cli.js --help

## Layout (TypeScript, Node >= 22.13, ESM)
- `src/notebook/selectors.ts` — every DOM assumption about Amazon's page. Change here first when a sync breaks.
- `src/notebook/parser.ts` — pure HTML -> models (cheerio); unit-tested. `client.ts` — pagination + sign-in
  detection over a `Fetcher`. `fetchers.ts` — cookie fetcher (cron path) and browser fetcher (fallback).
  `login.ts` — headed Chrome once, saves `session.json`. `session.ts` — cookie jar.
- `src/store.ts` — node:sqlite. Cloud highlights keyed by Amazon annotation id; clippings merge by (book, location).
  Ids are sha1 prefixes identical to the original Python store (golden test); never change the hashing.
- `src/commands.ts` — `COMMANDS` table: tag, aliases, argument style, action contract. Single source of truth for
  parsing, tool descriptions, the router prompt and the README table (drift test in `tests/docs.test.ts`).
- `src/server.ts` — `createServer(cfg)` is transport-free; `serveStdio` wires stdio. Prompts in `src/prompts/*.md`.
- `src/cli.ts` — login/sync/import-clippings/export/status/doctor/prompt/serve. `sync --on-pending CMD` is the trigger.
- `skills/kindle-router/SKILL.md` — the router prompt as a Claude Code skill; generated from the same text.

## Rules
- Never commit `.har`, `.db`, `session.json`, or `doctor-*.html`; they hold highlight text and session state.
- Fixtures must be scrubbed: placeholder text, account id replaced, cover URLs replaced.
- When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, save a scrubbed fixture, fix selectors, add a test.
- Keep the store and the MCP interface separate; the cron job and the server share one SQLite file (WAL).
- The server never assumes a runner or a sink. Routing behaviour lives in `COMMANDS` and the prompt text.
- stdio servers must not write to stdout except through the transport; log to stderr.

## Verified
- Python version, live account (2026-09-21): 19 books, 471 highlights; library page, annotation pane, pagination,
  notes, undisplayable highlights, incremental sync.
- TypeScript port: same fixtures and golden ids; sync + cookie write-back + `--on-pending` hook tested end to end
  against a local fixture server. The plain-HTTP path against the real site and cookie lifetime are not yet
  verified live: run `kindle-mcp login`, `doctor`, then `sync` and expect `highlights_new: 0` on an existing store.

## Next
1. `kindle_get_themes(since)` for the weekly brief.
2. Streamable HTTP transport behind a token, for web and mobile clients.
