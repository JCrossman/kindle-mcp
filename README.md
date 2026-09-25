# kindle-mcp

Your Kindle highlights and notes as tools for Claude, and an Obsidian vault that keeps itself
linked. A sync pulls `read.amazon.com/notebook` into a local SQLite store. With an Obsidian vault,
it adds new highlights to one note per book, linked to the notes you already have. Type a note like
`@todo email Sam` or `@research` on the Kindle: the sync files the simple ones itself and hands the
rest to Claude, which writes them up and saves them into the vault.

```
Kindle notebook (fetch + saved cookies) ─┐
                                         ├─► SQLite + FTS ─┬─► MCP server over stdio (Claude Desktop, Claude Code)
My Clippings.txt (device, optional) ─────┘                 ├─► Obsidian: book notes linked to your notes,
                                                           │   @todo / @quote / @project filed by the sync
                                                           └─► Claude: @post and @research saved as linked notes
```

Everything runs on your machine. Nothing is sent anywhere except requests to Amazon for your own
notebook. The command line needs Node 22.13 or newer; the Claude Desktop extension uses Claude's own.

## Setup

Pick one: the Claude Desktop extension (simplest), Claude Code, or the command line alone. They all
keep their data in `~/.kindle-mcp`, so you can mix them.

### Claude Desktop

1. You need Claude Desktop, and Google Chrome or Microsoft Edge for signing in to Amazon. If you
   use Obsidian, back up your vault first: every sync adds to it.
2. Download `kindle-mcp-server-<version>.mcpb` from the
   [latest release](https://github.com/JCrossman/kindle-mcp/releases/latest), open it, and click
   **Install** (or drag it onto Settings, Extensions).
3. In Settings, Extensions, **Kindle highlights**, set **Obsidian vault** to your vault's top
   folder if you use one. The other settings can stay as they are (see [Settings](#settings)).
4. In a new chat, say "Sign me in to Kindle" and allow the tool. A Chrome window opens on Amazon's
   sign-in page. Sign in (2FA included) and tick **Keep me signed in**: it lets later syncs renew
   the sign-in without you. The window closes itself when your notebook loads. "Is my Kindle
   connection working?" confirms it.
5. Say "Sync my Kindle highlights" and allow the Kindle tools. The first sync of a big library
   takes several calls; Claude keeps going by itself.
6. If Claude asks whether to add links to highlights you exported before, answer it (see
   [What lands in Obsidian](#what-lands-in-obsidian)).
7. Try a command: on the Kindle, add the note `@todo try kindle-mcp` to any highlight. Once the
   Kindle has synced (it needs Wi-Fi), sync again. The task is in `Kindle/Inbox/Todo.md`, linked
   to the highlight.

If the extension does not start, its log is `mcp-server-Kindle highlights.log` in Claude's log
folder (`~/Library/Logs/Claude` on macOS, `%APPDATA%\Claude\logs` on Windows).

### Sync on a schedule in Claude Desktop

A local routine runs the sync for you, and with **Do @commands after a sync** on, it writes up your
@post and @research notes too. Routines run only while Claude Desktop is open and the computer is
awake.

1. Make a new, empty folder for the routine, for example `Kindle Routine` in your home folder. A
   routine is a Claude Code session, and Claude Code always works in a folder; the Kindle tools
   don't use it. Don't pick your vault (Claude's own file tools would write in it directly,
   outside kindle-mcp's append-only writes) or `~/.kindle-mcp` (it holds your Amazon session).
2. In the **Code** tab, open **Routines**, click **New routine** and choose **Local**. Give it a
   name and a description, paste the prompt below into **Instructions**, leave the permission
   mode on **Manual**, select the folder from step 1, and leave **Worktree** off.
3. Pick a schedule. Hourly costs Amazon almost nothing (an idle sync is two requests), but each
   run is a Claude session that counts toward your plan's usage; Daily, or every few hours with
   Custom, uses less.
4. Click **Create**, then **Run now**, and answer each permission prompt with **Always allow** for
   `kindle_sync`, `kindle_get_pending_commands`, `kindle_get_command_context`,
   `kindle_complete_command`, `kindle_search_vault` and `kindle_status`, plus WebSearch and
   WebFetch if you use @research. A scheduled run can't answer a prompt: it waits, and the runs
   after it are skipped until you do. Don't always-allow `kindle_login` (it opens a window) or
   `kindle_link_existing_highlights` (it changes older notes, which is your call).
5. If that run can't find the Kindle tools, turn **Kindle highlights** on in a Code session's **+**
   menu, under **Connectors**, or register the server for Claude Code (next section).
6. Optional: Settings, Desktop app, General, **Keep computer awake**. A computer that sleeps
   through a run skips it; when it wakes, Claude Desktop runs the latest missed one once.

Each run shows a notification and a session under **Scheduled** in the sidebar. If the summary
starts with "Kindle sign-in needed", say "Sign me in to Kindle" in any chat; the next run catches
up. The prompt:

```text
Sync my Kindle highlights with kindle_sync. If the result says partial, call kindle_sync again
until it's complete. Then carry out any pending @commands as the sync result instructs, saving
each one with kindle_complete_command.

This runs unattended: don't ask me anything and don't open the Amazon sign-in window. If the
sync says I need to sign in, call kindle_get_pending_commands and still do anything waiting,
then start the summary with "Kindle sign-in needed: say 'Sign me in to Kindle' when you're at
your computer." If it offers to link older highlights, just mention it.

Finish with a short summary: new highlights, what was filed where, the notes you wrote (by
title), and anything that needs me.
```

### Claude Code

1. `npm install -g kindle-mcp-server` (Node 22.13 or newer).
2. `claude mcp add --scope user kindle -e OBSIDIAN_VAULT="$HOME/path/to/vault" -- kindle-mcp serve`
   (leave out `-e ...` if you don't use a vault).
3. `kindle-mcp login`: a browser opens; sign in and tick **Keep me signed in**.
4. In Claude Code, say "Sync my Kindle highlights". Slash commands and headless runs are under
   [Example prompts](#example-prompts).

**Claude Desktop from npm** instead of the extension (`claude_desktop_config.json`):

```json
{ "mcpServers": { "kindle": {
    "command": "kindle-mcp", "args": ["serve"],
    "env": { "OBSIDIAN_VAULT": "/path/to/vault" } } } }
```

### Command line and cron

```bash
npm install -g kindle-mcp-server     # or run every command below with `npx kindle-mcp-server`
kindle-mcp login          # a browser opens; sign in once (2FA included) and tick "Keep me signed in"
kindle-mcp doctor         # check first: it should report your real book count
kindle-mcp sync           # first run reads every book; later runs only changed books
kindle-mcp status
```

`login` needs Google Chrome or Microsoft Edge. Any Chromium-based browser works through
`KINDLE_BROWSER_PATH=/path/to/browser` (Brave, Chromium on Linux), or run
`npx playwright install chromium`. The Amazon session cookies are saved to
`~/.kindle-mcp/session.json`, readable only by you. Your password is never seen or stored. Treat
that file like a credential. `sync` is plain HTTP with those cookies; if Amazon ever refuses that,
`kindle-mcp sync --browser` drives the browser instead.

For cron or launchd, hourly is cheap. The sync files what it can; `--on-pending` starts Claude only
when @post or @research is left:

```cron
30 * * * * PATH=/usr/local/bin:$PATH OBSIDIAN_VAULT="$HOME/path/to/vault" kindle-mcp sync --on-pending 'claude -p "$(kindle-mcp prompt route-pending)" --allowedTools "mcp__kindle,WebSearch,WebFetch"' >> ~/.kindle-mcp/sync.log 2>&1
```

Cron doesn't see the extension's settings, so the vault path goes in the line. Register the server
for Claude Code first (`claude mcp add` above) so the headless run can see it. The hook gets
`KINDLE_PENDING=<count>` in its environment. Windows: the same command in Task Scheduler with
`cmd /c`.

### Updating

Download the new `.mcpb` and open it; Claude Desktop replaces the old version (check its settings
afterwards). For Claude Code and cron: `npm install -g kindle-mcp-server@latest`. Keep both on the
same version, since they share `~/.kindle-mcp`.

### If it keeps asking you to sign in

The sync reuses the sign-in you saved. When Amazon stops accepting it, the sync renews it in a
hidden browser window from the browser you signed in with, then carries on (the result says
`session_refreshed: true`). That works while Amazon remembers that browser, which is what **Keep
me signed in** is for. When Amazon wants your password again, the sync says so:

- Say "Sign me in to Kindle" (or run `kindle-mcp login`) and tick **Keep me signed in**. Without
  it, Amazon forgets the browser when the sign-in window closes, and every sync needs you.
- "Is my Kindle connection working?" shows the data folder, the version, and when you last signed
  in. If a chat syncs and a routine doesn't, the two are using different data folders or versions.
- Nothing is lost while you're signed out: reads work from the store, and the next sync catches up.

## Notes as commands

Type these as a note on any highlight, on the Kindle:

| Tag | Alias | Argument | You mean | Done by | What happens |
|---|---|---|---|---|---|
| `@post` | `@p` | none | I want to write about this. The rest of the note is the angle. | Claude | Claude drafts a post angle and saves it as a note in `Posts/`, linked to the highlight. |
| `@research` | `@r` | none | Go find out more about this. The rest of the note is the question. | Claude | Claude researches it (web search when it has it) and saves a note with sources in `Research/`. |
| `@todo` | `@t` | rest of line, required | Make this a task. The argument is the task text. | the sync | A checklist item in `Inbox/Todo.md` with the quote and a link to the highlight. |
| `@project` | `@pr` | one word, required | This belongs to project `<name>`. | the sync | The quote and note under a `From Kindle` heading in your note named or aliased `<name>`, else in `Projects/<name>.md`. |
| `@quote` | `@q` | none | Keep this as a quotable line. | the sync | The quote with title, author and location in `Inbox/Quotes.md`. |

Paths are inside the Kindle folder of your vault (`Kindle` unless you change it). A line argument
stops at the next tag, so `@todo email Sam @project netcare` is two commands. Unknown tags, a
`@project` with no name, and a name that matches two notes go to `Inbox/Unrouted.md` with the
reason. Editing the note on the Kindle re-opens only what changed. Without a vault, Claude does
every command and puts the result in its reply. Add a command by adding a row to `COMMANDS` in
`src/commands.ts`; the tool descriptions, the router prompt and this table all follow it.

## How a note becomes an action

1. The Kindle syncs your note to Amazon the next time it is online. (Sideloaded books never reach
   the cloud; `kindle-mcp import-clippings` reads `My Clippings.txt` for those.)
2. A sync pulls changed books and adds new highlights to their book notes in the vault.
3. The sync files `@todo`, `@quote` and `@project` itself. No Claude needed, so this works from cron.
4. `@post` and `@research` come back in the sync result with an instruction. With **Do @commands
   after a sync** on (the default), Claude does them right away, without asking. Each one is saved
   with `kindle_complete_command`, which writes the note, links it, and marks the command done.
   With the setting off, Claude lists them and offers.
5. `kindle-mcp status`, or asking Claude "What's in my Kindle queue?", shows what is left.

In Claude Desktop, one sync call stops fetching after about 40 seconds and says so, because
Desktop gives up on a tool call at about a minute. A first sync of a big library takes a few calls,
each continuing where the last one stopped. The command line has no such limit.

## What lands in Obsidian

A book note, one block per highlight. Mentions of your notes' titles and aliases become links,
and the note shows exactly what you typed:

```markdown
> Most plans fail at the handoff, not in the planning.
>
> **Note:** @todo ask the team about [[Handoffs|handoffs]] @quote
> — Location 1234 · #kindle/todo #kindle/quote

^kh-0123456789abcdef
```

What the sync files, each linked back to that exact highlight:

```markdown
- [ ] ask the team about handoffs — “Most plans fail at the handoff, not in the planning.” — [[Example Book#^kh-0123456789abcdef|Example Book, Location 1234]] ^kh-0123456789abcdef-todo-1a2b
```

`@project netcare` appends the quote under `## From Kindle` in your own `Netcare` note (or the note
that lists `netcare` in its `aliases`), before any section that follows it. With no such note it
creates `Kindle/Projects/netcare.md`.

`@post` and `@research` become their own notes, with frontmatter (`kindle-highlight`, `book`,
`created`, `tags`), the quote with its link, your note as the angle or question, Claude's text with
links to your notes, and a `Related:` line. Links Claude invents to notes that don't exist are
turned back into plain text, and code that Obsidian plugins would run (Dataview JS, Templater) is
made inert.

**Linking rules.** Whole words, any case, like Obsidian's own "unlinked mentions". Never inside
existing links, code, URLs, tags or headings; the first mention only; at most five new links per
highlight. Titles that are common words (Home, Ideas, Notes, days, months), dates, and names shared
by two notes are never linked. Short names link only as exact acronyms (AI, UX). To keep a note from
being linked, add `kindle-link: false` to its frontmatter. Folders in Obsidian's own
**Excluded files** and its template folders are left out, and so are the folders in **Folders never
linked or searched**. Turn linking off entirely with **Link highlights to your notes**.

**Safe by design.** kindle-mcp appends; it never rewrites what you wrote. It writes only inside the
vault, never through a symbolic link, and never into a vault folder that doesn't exist (a mistyped
path fails instead of growing a new folder tree). Book notes are found by their frontmatter, so you
can move or rename them; a book note you delete stays deleted unless you ask for it back. The
scheduled job and Desktop never write to the vault at the same time.

**Highlights you exported before.** When a sync could add links to highlights already in your
vault, Claude asks you in the chat (at most once a week until you answer): add them now, and keep
doing it as new notes appear? Only blocks still exactly as kindle-mcp wrote them change (your edits
and your own links stay), their block ids move to their own line so links land on them, and old
wording is corrected. Say no and it won't ask again; ask for it any time ("Link my older Kindle
highlights to my notes"), or run `kindle-mcp link-existing` to preview and add `--apply` to write.

## Example prompts

**Getting started**
- "Sign me in to Kindle." (opens the Amazon sign-in window)
- "Sync my Kindle highlights."
- "Is my Kindle connection working?"

**Recall and search**
- "What have I highlighted this week?"
- "Find everything I've highlighted about pricing."
- "Show my highlights from <book title>, in reading order."
- "Which books have I been reading lately?"
- "Quote three of my highlights on habits, with book and location."

**Think and write**
- "Give me my weekly reading brief."
- "What do my highlights about leadership disagree on?"
- "Draft a post from my highlights on <topic>, citing each quote."
- "Connect what I highlighted in <book A> with <book B>."

**@commands**
- "What's in my Kindle queue?"
- "Do my pending Kindle commands."
- "Show me what you'd do with my Kindle commands, but don't save anything."
- "Only handle my @research notes."

**Obsidian**
- "Which of my notes relate to this highlight?"
- "Search my vault for notes about <topic>."
- "Link my older Kindle highlights to my notes." (previews first, applies on your yes)
- "Bring back the note for <book title>." (recreates a book note you deleted)

**Claude Code**
- `/mcp__kindle__kindle_route_pending`: do everything pending.
- `/mcp__kindle__kindle_route_pending research true`: dry run, @research only (arguments are positional).
- `/mcp__kindle__kindle_weekly_brief 14d`
- `claude -p "$(kindle-mcp prompt route-pending)"`: the same, headless.

## MCP tools

| Tool | What it does |
|---|---|
| `kindle_sync` | Pull new highlights from Amazon, update the vault, return what is left with an instruction. |
| `kindle_status` | Counts, the queue by tag, last sync, session, vault and settings, and a next step. |
| `kindle_login` | Open the one-time Amazon sign-in window. |
| `kindle_list_books` | Books, most recently highlighted first. |
| `kindle_get_highlights` | One book's highlights in reading order. |
| `kindle_search_highlights` | Full-text search over highlights and notes. |
| `kindle_get_new_since` | Highlights first seen since a date or span (`7d`). |
| `kindle_get_pending_commands` | Highlights with @commands still to do, each with its action. |
| `kindle_get_command_context` | One highlight with neighbours, related highlights, related vault notes and its own link. |
| `kindle_complete_command` | Save one command's result into the vault and mark it done. |
| `kindle_mark_command_done` | Mark commands done that were handled some other way. |
| `kindle_search_vault` | Full-text search over your vault's notes, with paste-ready links. |
| `kindle_link_existing_highlights` | Preview, or on your yes apply, links in highlights exported before. |
| `kindle_export_to_obsidian` | Update the vault from the store without contacting Amazon. |

Prompts: `kindle_route_pending(tag?, dry_run?)` walks the queue; `kindle_weekly_brief(since?)`
clusters recent highlights into themes with one cited angle each. `truncated: true` on a highlight
means Amazon didn't return its text, usually because it is an image or a table.

## Settings

The Claude Desktop extension shows these in its settings; everywhere else they are environment
variables.

| Variable | Desktop setting | Default |
|---|---|---|
| `KINDLE_MCP_HOME` | Data folder | `~/.kindle-mcp` |
| `OBSIDIAN_VAULT` | Obsidian vault | unset (no vault) |
| `OBSIDIAN_FOLDER` | Folder inside the vault | `Kindle` |
| `KINDLE_ACT_ON_COMMANDS` | Do @commands after a sync | `true`; `false` makes Claude offer instead |
| `KINDLE_AUTO_FILE` | File @todo, @quote and @project during sync | `true`; `false` leaves them to Claude |
| `KINDLE_LINK_NOTES` | Link highlights to your notes | `true` |
| `KINDLE_LINK_EXCLUDE` | Folders never linked or searched | unset; comma-separated folders |
| `KINDLE_BROWSER_PATH` | Browser executable | unset; Chrome or Edge is found automatically |
| `KINDLE_MCP_DB` | | `$KINDLE_MCP_HOME/kindle.db` |
| `KINDLE_ON_PENDING` | | unset; same as `sync --on-pending` |
| `KINDLE_REQUEST_DELAY` | | `1.5` seconds between Amazon pages |
| `KINDLE_SYNC_BUDGET_MS` | | `40000`; how long one MCP sync call may fetch |
| `KINDLE_NOTEBOOK_BASE` | | `https://read.amazon.com` |

## Privacy and data

- `~/.kindle-mcp/kindle.db`: your highlights, notes and the @command queue.
- `~/.kindle-mcp/session.json`: Amazon session cookies. Treat it like a password.
- `~/.kindle-mcp/vault-index-*.db`: a cache of your vault's note names, aliases and the start of each
  note's text, for linking and search. Safe to delete; it is rebuilt.
- Claude sees what the tools return: highlights, and with a vault, snippets of your notes from
  `kindle_search_vault` and related notes. Folders you exclude and notes marked `kindle-link: false`
  are never searched or returned.
- Nothing leaves your machine except requests to Amazon for your own notebook, and what your Claude
  client sends to Claude as part of the conversation.

## Known limits

- Automated access may conflict with Amazon's terms of use. This reads only your own data, at low
  volume, with a delay between pages. Your call.
- How long Amazon remembers a browser is up to Amazon. The sync renews a stale sign-in by itself
  while it does, and says when it needs you (see
  [If it keeps asking you to sign in](#if-it-keeps-asking-you-to-sign-in)). The renewal uses a
  headless browser; if Amazon ever refuses that, signing in again still works.
- "Do @commands after a sync" is an instruction to Claude, not a guarantee. Claude Desktop still asks
  your permission the first time each tool runs, and @research only searches the web when web search
  is on.
- The server can't wake Claude by itself. Commands are done when you, a routine, or cron runs
  a sync through Claude.
- `first_seen` is when the sync first saw a highlight, not when you made it; the cloud page does not
  expose per-highlight times (clippings does).
- Everything runs where the store lives. Claude on the web and on mobile can't reach a stdio server;
  an HTTP transport is a small later addition, the tool code is transport-free.

## How the notebook is read

Verified against live captures of the notebook and a full account sync (the original Python version,
2026-09-21) and, for this TypeScript version, the plain-HTTP sync from Claude Desktop (2026-09-22).
Tests run against scrubbed copies of real page markup in `tests/fixtures`.

- Location comes from a hidden input; headers may show `Page:` only. Location == byte position // 150 + 1.
- Row ids are base64 of `<account>:<asin>:<position>:<TYPE>:<uuid>`; stored without the account as `amazon_id`.
- Colour comes from the `kp-notebook-highlight-<colour>` class.
- A note attaches to its highlight in the same row; a freestanding note is a row with a note and no text.
- Pagination: page 1 sets `.kp-notebook-annotations-next-page-start`; it is passed back as `token`
  with the `contentLimitState` value. Later pages are bare fragments; the parser handles both.
- Highlights Amazon can't render (images, tables) come back as `kp-notebook-highlight-empty-text`
  and are stored as `truncated`.

`kindle-mcp doctor` saves the live HTML to `~/.kindle-mcp` and reports what the parser finds; every
selector lives in `src/notebook/selectors.ts`.

**Merge rule.** Cloud highlights are keyed by Amazon's own annotation id, so two highlights at the
same location stay separate. Clippings entries merge into the cloud copy at the same (book, start
location), else get their own row; a non-truncated copy beats a truncated one and longer text beats
shorter. Ids are computed exactly as the original Python version did, so an existing store and vault
keep working.

## Development

```bash
npm install
npm test                        # vitest; fixtures are scrubbed real page markup
npm run build                   # dist/, then `node dist/cli.js --help`
npm run build && npm run mcpb   # the Desktop bundle, checked by unpacking it and replaying a host handshake
```

When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, save a scrubbed copy of the HTML
under `tests/fixtures`, fix `src/notebook/selectors.ts`, add a test. Never commit `.har`, `.db`,
`session.json` or `doctor-*.html`: they hold highlight text and session state.

## Releasing

Bump `version` in `package.json` and merge. Then run the `publish` workflow from the Actions tab,
typing that version to confirm. It runs the tests, builds and checks the Desktop bundle, refuses a
version already on npm, publishes `kindle-mcp-server` with provenance through npm trusted publishing
(no token is stored anywhere), creates the `v<version>` tag, and attaches the `.mcpb` to the release.

## Repository settings (maintainers)

Everything security-related about the repository itself is applied by one script, run once on
your own machine with the GitHub CLI:

```bash
gh auth login                                        # device-code flow in the browser
scripts/repo-settings.sh OWNER/REPO --public         # settings, then public + secret scanning
```

It sets verified-only actions with a read-only token, Dependabot alerts and security updates,
private vulnerability reporting, and a ruleset on the default branch (pull requests required,
review threads resolved, CI green on an up-to-date branch, no force pushes or deletions). With
`--public` it also flips visibility and enables secret scanning with push protection. Re-running is
safe; it prints the resulting state.

## Next

- `kindle_get_themes(since)`: deterministic keyword clustering the weekly brief can lean on.
- Streamable HTTP transport with a token, for Claude on the web and mobile.
