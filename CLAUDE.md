# kindle-mcp

## Hard rule: a reader's library never leaves their machine
Nothing from a reader's library goes into a file, commit, commit message, PR, issue, comment, release or tool
description of this repository: no book titles, authors, highlights, notes, tags, project names, vault or folder
names, ASINs, account ids, counts, dates of reading, and no Claude session links. Not as a fixture, not as an
example, not copied from a live capture "just to get the shape", not once. Invent placeholders; fixtures may only
use the words in `tests/fixtures/VOCABULARY.txt`. This repository has been rebuilt more than once because of it.

It is enforced, not asked: `scripts/privacy-check.mjs` runs in the Claude Code hook (`.claude/settings.json`), in the
git hooks (`.githooks`), in CI on every push and in the release workflow. When it blocks you, that is the answer:
change the text. Do not add a word to `VOCABULARY.txt`, edit the guard (`scripts/privacy-*.mjs`, `scripts/hooks`,
`.githooks`, `.claude/settings.json`), use `--no-verify`, or look for another route. If a finding looks wrong, ask the
reader. After creating or editing a PR, read its body back: the GitHub tool can append a session link; strip it.
A live capture (`doctor-*.html`, a saved page) stays out of git; make fixtures with `scripts/scrub-capture.mjs`.

A reader's own words never go in a file you write, a test you run against their store, or a summary posted anywhere
except in reply to them. Work from the invented fixtures; never read `~/.kindle-mcp/kindle.db` into a prompt or a file.

A reading assistant. Readers highlight and type short notes on the Kindle; the highlights land in their Obsidian vault,
linked to their own notes, and Claude carries out the notes (research, drafts, tasks, a note for a topic) in the
background. Readers use the Claude desktop app's chat with the extension, plus a daily routine; everything else is
plumbing or for developers. Keep reader-facing text free of it.

Under the hood: Kindle highlights and notes as an agent-readable store, and an Obsidian vault that keeps itself linked. Sync engine
(fetch + saved cookies, Playwright only to sign in and to renew a stale sign-in) -> SQLite + FTS -> MCP server over
stdio (17 tools, 2 prompts), shipped as a Claude Desktop extension (.mcpb) on the GitHub release (not on npm: the
package is private), and as a plugin for Claude Code and Cowork (the same .mcpb plus four skills). With a vault, each sync appends new highlights to book notes linked to
the user's notes, files @todo/@quote/@project and any other tag named after a note itself, and hands @post/@research
to the agent, which saves them with `kindle_complete_command`. README.md is for readers; docs/DEVELOPERS.md has
everything else (other installs, tools, settings, how the notebook is read, building and releasing).

## Setup
    npm install && npm test          # vitest; fixtures hold placeholder text only
    npm run build && node dist/cli.js --help

## Layout (TypeScript, Node >= 22.13, ESM)
- `src/notebook/selectors.ts` — every DOM assumption about Amazon's page. Change here first when a sync breaks.
- `src/notebook/parser.ts` — pure HTML -> models (cheerio); unit-tested. `client.ts` — pagination, sign-in
  detection and the per-call deadline over a `Fetcher`. `fetchers.ts` — cookie fetcher (cron path) and browser
  fetcher (fallback). `login.ts` — headed Chrome once (ticks "Keep me signed in", says "Signed in" for 3 s before
  closing), saves `session.json` with the browser's user agent (the cookie fetcher sends it); `refreshSession`
  renews a stale sign-in headless from the same profile (sync retries once with it) and says what stopped it
  (`Renewal`, kept as `last_renewal`). Headless launches go out under the windowed user agent (`launchContext`):
  Amazon refuses `HeadlessChrome`. `session.ts` — cookie jar.
- `src/store.ts` — node:sqlite. Cloud highlights keyed by Amazon annotation id; clippings merge by (book, location).
  Ids are sha1 prefixes identical to the original Python store (golden test); never change the hashing.
  `commands_done_at` is the highlight-level truth (1.0 code writes only that); `command_outputs` records finished
  commands, `leases` keeps one vault writer at a time, `book_notes` remembers exported notes. Schema changes are
  additive only: users' stores carry their reading history.
- `src/config.ts` — settings: environment (the app's own settings) > `<data folder>/config.json` (every client reads
  it; `kindle_set_vault`, `kindle-mcp config set`) > defaults. Inside a plugin (`CLAUDE_PLUGIN_ROOT` set) the file
  beats the bundle's built-in defaults, since a plugin has no settings screen.
- `src/commands.ts` — `COMMANDS` table: tag, aliases, argument style, `doneBy` (sync | agent), result, action. Single
  source of truth for parsing, tool descriptions, the router prompt and the README table (drift tests in
  `tests/docs.test.ts`).
- `src/obsidian.ts` — book notes: blocks with the id on its own line, the 1.0 renderer (to recognise unedited
  blocks), `filename()` (never change it: existing notes are found by it), find-by-frontmatter.
- `src/vault/` — `write.ts` (every vault write: inside the vault, no symlinks, appends, compare-and-swap,
  neutralized model output), `index.ts` (per-vault cache of names, aliases and full text; budgeted reads),
  `linkify.ts` (mention linking), `frontmatter.ts`, `file.ts` (filing, other tags, taught tags, agent notes, reading a
  note), `backfill.ts` (links in
  blocks exported before, only on the user's yes), `run.ts` (the vault step: lease, no writes on a partial index).
- `src/server.ts` — `createServer(cfg)` is transport-free; `serveStdio` wires stdio. Prompts in `src/prompts/*.md`.
  Claude Desktop ignores server instructions: what the model must know goes in tool descriptions and results.
- `src/cli.ts` — login/sync/import-clippings/export/link-existing/status/doctor/prompt/serve. `sync --on-pending CMD`
  is the trigger.
- `src/mcpb-entry.ts` — the Claude Desktop bundle's entry. Serves unconditionally and never reads argv: Desktop's
  built-in Node runs it through its own wrapper and can repeat the script path. Keep it that way.
- `scripts/build-mcpb.mjs` — builds the `.mcpb` (manifest and settings generated from the live server), then unpacks
  the packed file and replays a host handshake against it (plain and repeated-path argv). Runs in CI and in the
  release workflow before anything is tagged or released.
- `scripts/privacy-lib.mjs`, `privacy-check.mjs`, `hooks/privacy-gate.mjs`, `.githooks/`, `.claude/settings.json`,
  `tests/fixtures/VOCABULARY.txt` — the privacy guard (see the hard rule). Private terms come from `PRIVATE_TERMS`
  (a CI secret), `~/.kindle-mcp/private-terms.txt` and the reader's own `kindle.db`; findings name file, line and
  term number, never the term. `scripts/scrub-capture.mjs` turns a live capture into a fixture. `tests/privacy-check.test.ts`.
- `src/plugin.ts` — generates the plugin (`plugin/`: manifest pointing at this version's release `.mcpb`, skills
  setup/routine/route/brief from `src/prompts/*.md`), the marketplace entry (`.claude-plugin/marketplace.json`, this
  repo is the marketplace) and `skills/kindle-router/SKILL.md`. `npm run render-plugin` writes them; `-- --dev` also
  writes `build/plugin-dev` (runs this checkout's `dist/`) for `claude --plugin-dir build/plugin-dev`.

## Rules
- Never commit `.har`, `.db`, `session.json`, or `doctor-*.html`; they hold highlight text and session state.
- The README speaks to readers in the Claude desktop app: no Claude Code, npm, cron, MCP or plugin talk before its
  last section (a docs test checks). Developer material goes in docs/DEVELOPERS.md, which names every tool and setting.
- `plugin/`, `.claude-plugin/` and `skills/` are generated: edit `src/plugin.ts` or `src/prompts/*.md`, then
  `npm run render-plugin` (a drift test fails otherwise). No `bin/` in the plugin: chat and Cowork refuse it.
- Every `.mcpb` setting needs a default (the build checks): Cowork skips a bundle whose settings lack one.
- Fixtures hold placeholder text only: invented titles, authors, highlights and notes, fake ASINs (`B0FAKE0001`),
  placeholder ids, `example.invalid` cover URLs, and only the words in `VOCABULARY.txt`. No real titles, ASINs or
  counts from anyone's library in files, commits or PR text (docs and privacy tests check).
- When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, run the capture through
  `node scripts/scrub-capture.mjs IN OUT`, fix selectors, add a test. Never write a fixture by hand from a real page.
- Keep the store and the MCP interface separate; the cron job and the server share one SQLite file (WAL).
- The server never assumes a runner or a sink. Routing behaviour lives in `COMMANDS` and the prompt text.
- A tag no command owns files only into a note named exactly like it, or the note the user chose for it with
  `kindle_teach_tag`; anything else waits in Unrouted with a question. Never file on a guess, never create a note for
  an unknown tag, and never teach a tag without the user's answer.
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
- 1.1.1 (2026-09-25), against local stand-ins: live use showed every routine run asking to sign in again. A stale
  saved sign-in is now renewed from the saved browser profile by headless Chromium, and reported as expired once
  the stand-in forgets the browser; a signed-out `kindle_sync` still files and returns the queue; headless Claude
  Code with the README's routine prompt and a stale sign-in wrote the waiting @post and never called
  `kindle_login`. Not yet checked live: that Amazon renews a remembered browser's sign-in headless.
- 1.2.0 (2026-09-28): Claude Code 2.1.283 loads the plugin with its `.mcpb` from a local path and from a release URL
  (14 tools then, all connected; `CLAUDE_PLUGIN_ROOT` reaches the bundled server, so the settings file beats the
  bundle's defaults); `claude plugin validate` passes for `plugin/` and the marketplace; headless `/kindle:routine`
  and `/kindle:setup` through `build/plugin-dev` against the local stand-in (vault from `kindle_set_vault`, @post
  saved). Not yet checked: Cowork, the app's Customize > Plugins install, the Desktop Code tab running the bundle.
- 1.3.0 (2026-10-01), against the local stand-in and temp vaults with placeholder notes: a tag named after a note filed
  into it on sync; tags matching no note waited in Unrouted, and headless `/kindle:routine` through `build/plugin-dev`
  put the one question (with the suggested note) in its summary without teaching anything; a second run answering
  yes called `kindle_teach_tag`, which moved the waiting entry and removed its Unrouted line; the @research note
  drew on the related note read in full with `kindle_read_note`; the bundle entry saved the extension's vault to
  `config.json` once, left it alone on a later start with another vault, and reported the mismatch. Not yet checked
  live: 1.3.0 in the Desktop Code tab, routines and Cowork.
- 1.3.1 (2026-10-01): headless Claude Code with the server set up like the extension (no plugin), against the local
  stand-in: told only "Set up my Kindle." with a saved sign-in and no vault, it called `kindle_status` and asked
  whether the reader keeps notes in Obsidian; told the vault in a second run, it saved it with `kindle_set_vault`,
  ran the first sync, filed the @project and wrote the @post. The 1.3.0 plugin installed from the marketplace (17
  tools, connected). Not yet checked live: the reader setup in the Desktop chat tab.
- 1.3.2 (2026-10-04): live use showed every routine run asking to sign in again, while the sign-in window opened
  already signed in: the renewal's headless Chrome names itself `HeadlessChrome`, the window doesn't. Headless
  launches now go out under the windowed name (the `--user-agent` switch keeps Chrome's own client hints; a CDP
  override drops them). Against a stand-in that refuses `HeadlessChrome`, the renewal passes and the plain-HTTP sync
  sends the saved user agent; a password form and a puzzle are reported as such. Not yet checked live: that Amazon
  renews the sign-in for the hidden browser now.
- 1.3.3 (2026-10-04): a reader's report showed the sign-in window flashing shut with no sign-in page, so no visible
  "Keep me signed in". The window now ticks the box itself and says "Signed in" for 3 s. Against a stand-in that
  remembers only browsers whose form arrives ticked, the renewal passes only with the tick; headed under Xvfb the
  window stayed 3.1-3.5 s, with the password form and with a remembered browser. Not yet checked live: that
  Amazon's box is still `input[name='rememberMe']`.

## Next
1. `kindle_get_themes(since)` for the weekly brief.
2. Streamable HTTP transport behind a token, for web and mobile clients.
