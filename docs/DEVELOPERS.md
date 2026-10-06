# kindle-mcp for developers

The [README](../README.md) is for readers: the Claude desktop app, the extension and a chat. This
page has everything else: the other ways to run the server, the tools and settings, how the
notebook is read, and how to build and release.

```
Kindle notebook (fetch + saved cookies) ─┐
                                         ├─► SQLite + FTS ─┬─► MCP server over stdio (Claude Desktop, Claude Code)
My Clippings.txt (device, optional) ─────┘                 ├─► Obsidian: book notes linked to your notes,
                                                           │   @todo / @quote / @project filed by the sync
                                                           └─► Claude: @post and @research saved as linked notes
```

Everything runs on your machine. Nothing is sent anywhere except requests to Amazon for your own
notebook, and what your Claude client sends to Claude as part of a conversation (tool results
included). The command line needs Node 22.13 or newer; the Claude Desktop extension uses Claude's own.

## Other ways to run it

One server, several installs. The extension (the README) and everything here share `~/.kindle-mcp`:
the same highlights, the same Amazon sign-in, the same vault setting.

### The plugin: Claude Code and Cowork

One install gives Claude Code (including the Desktop app's Code tab, where routines run) and Cowork
the Kindle tools and four skills. The plugin doesn't load in chat (claude.ai, the Desktop app's
chat, mobile); use the extension there.

1. You need Google Chrome or Microsoft Edge for signing in to Amazon. Claude Code in a terminal
   runs the server with the Node.js on your PATH (22.13 or newer). If you use Obsidian, back up
   your vault first: every sync adds to it.
2. Install it:
   - In the Claude app: **Customize**, **Plugins**, add the marketplace `JCrossman/kindle-mcp`, and
     install **kindle**. It then appears in Claude Code on this computer too.
   - Or in Claude Code: `/plugin marketplace add JCrossman/kindle-mcp`, then
     `/plugin install kindle@kindle-mcp`.
3. Run `/kindle:setup`. It checks the connection, opens the Amazon sign-in (tick **Keep me signed
   in**), asks where your Obsidian vault is and saves it with `kindle_set_vault`, runs the first
   sync, and offers to schedule the routine.

| Skill | What it does |
|---|---|
| `/kindle:setup` | The first run, step by step. |
| `/kindle:routine` | The unattended sync for a scheduled routine. Runs only when called. |
| `/kindle:route [tag] [dry run]` | Work through pending @commands. |
| `/kindle:brief [14d]` | A weekly reading brief from recent highlights. |

In Cowork, the plugin's server runs when the Cowork session runs on your computer. If you also use
the extension and each Kindle tool shows up twice in a Code session, turn the extension off there
(the **+** menu, **Connectors**).

With the plugin, a routine's Instructions can be just `/kindle:routine`: it runs the
[routine prompt](../README.md#the-daily-sync) from the README.

### Claude Code without the plugin

1. Build it from a clone (Node 22.13 or newer): `git clone https://github.com/JCrossman/kindle-mcp`, then in the
   folder `npm ci && npm run build && npm link`. That puts `kindle-mcp` on your PATH. It is not published to npm.
2. `claude mcp add --scope user kindle -- kindle-mcp serve`, and if you use Obsidian,
   `kindle-mcp config set vault ~/path/to/vault`.
3. `kindle-mcp login`: a browser opens; sign in and leave **Keep me signed in** ticked (it's ticked for you).
4. In Claude Code, say "Sync my Kindle highlights". Slash commands and headless runs are under
   [Claude Code prompts](#claude-code-prompts).

**Claude Desktop from a clone** instead of the extension (`claude_desktop_config.json`):

```json
{ "mcpServers": { "kindle": {
    "command": "node", "args": ["/path/to/kindle-mcp/dist/cli.js", "serve"],
    "env": { "OBSIDIAN_VAULT": "/path/to/vault" } } } }
```

### Command line and cron

```bash
# in a clone: npm ci && npm run build && npm link      (puts `kindle-mcp` on your PATH)
kindle-mcp login          # a browser opens; sign in once (2FA included), "Keep me signed in" stays ticked
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
30 * * * * PATH=/usr/local/bin:$PATH kindle-mcp sync --on-pending 'claude -p "$(kindle-mcp prompt route-pending)" --allowedTools "mcp__kindle,WebSearch,WebFetch"' >> ~/.kindle-mcp/sync.log 2>&1
```

Cron doesn't see the extension's settings, but it reads the settings file: set the vault there once
with `kindle-mcp config set vault ~/path/to/vault` (or put `OBSIDIAN_VAULT=...` in the line).
Register the server for Claude Code first (`claude mcp add` above) so the headless run can see it.
The hook gets
`KINDLE_PENDING=<count>` in its environment. Windows: the same command in Task Scheduler with
`cmd /c`.

### Updating

- **The plugin:** update it from **Customize**, **Plugins** in the app, or in a terminal with
  `claude plugin marketplace update kindle-mcp` and then `claude plugin update kindle@kindle-mcp`.
- **The command line:** in your clone, `git pull && npm ci && npm run build`.

Keep them on the same version as the extension: they share `~/.kindle-mcp`.

### Claude Code prompts

- `/mcp__kindle__kindle_route_pending`: do everything pending.
- `/mcp__kindle__kindle_route_pending research true`: dry run, @research only (arguments are positional).
- `/mcp__kindle__kindle_weekly_brief 14d`
- `claude -p "$(kindle-mcp prompt route-pending)"`: the same, headless.

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

Add a command by adding a row to `COMMANDS` in `src/commands.ts`; the tool descriptions, the router
prompt and the README's table all follow it. `kindle-mcp link-existing` previews links for
highlights exported before; `--apply` writes them. `kindle-mcp import-clippings` reads
`My Clippings.txt` from the Kindle, for sideloaded books that never reach Amazon's notebook.

## MCP tools

| Tool | What it does |
|---|---|
| `kindle_sync` | Pull new highlights from Amazon, update the vault, return what is left with an instruction. |
| `kindle_status` | Counts, the queue by tag, last sync, session, how the last sign-in renewal went (`last_renewal`), vault and settings (and where each comes from), tags you pointed at notes, tags waiting in Unrouted, and a next step. |
| `kindle_set_vault` | Save which Obsidian vault to use, for every client; only a folder with `.obsidian` in it. |
| `kindle_login` | Open the one-time Amazon sign-in window. |
| `kindle_list_books` | Books, most recently highlighted first. |
| `kindle_get_highlights` | One book's highlights in reading order. |
| `kindle_search_highlights` | Full-text search over highlights and notes. |
| `kindle_get_new_since` | Highlights first seen since a date or span (`7d`). |
| `kindle_get_pending_commands` | Highlights with @commands still to do, each with its action. |
| `kindle_get_command_context` | One highlight with neighbours, related highlights, related vault notes and its own link. |
| `kindle_complete_command` | Save one command's result into the vault and mark it done. |
| `kindle_mark_command_done` | Mark commands done that were handled some other way. |
| `kindle_search_vault` | Full-text search over your vault's notes, with paste-ready links and short excerpts. |
| `kindle_read_note` | Read one of your notes in full, by name or path. Read-only; excluded and opted-out notes stay off-limits. |
| `kindle_teach_tag` | On your word, point a tag at a note: what's waiting in Unrouted moves there, and later ones file there. |
| `kindle_link_existing_highlights` | Preview, or on your yes apply, links in highlights exported before. |
| `kindle_export_to_obsidian` | Update the vault from the store without contacting Amazon. |

Prompts: `kindle_route_pending(tag?, dry_run?)` walks the queue; `kindle_weekly_brief(since?)`
clusters recent highlights into themes with one cited angle each. `truncated: true` on a highlight
means Amazon didn't return its text, usually because it is an image or a table.

## Settings

Settings come from three places, and the first one set wins:

1. The app: the extension's settings in Claude Desktop, or environment variables (a cron line,
   `claude mcp add -e`).
2. The settings file, `~/.kindle-mcp/config.json`, which every client reads. Set it with
   `kindle_set_vault` ("Use ~/Documents/Notes as my Kindle vault") or `kindle-mcp config set KEY
   VALUE`; `kindle-mcp config` shows each setting and where it comes from, and so does
   `kindle_status`. The plugin has no settings screen, so inside the plugin (Claude Code and
   Cowork start it with `CLAUDE_PLUGIN_ROOT` set) the file also beats the bundle's built-in
   defaults.
3. The defaults below.

The vault is one setting for every app. The first time the extension starts with its own vault set
and no vault is saved yet, it saves its vault to the settings file, so the plugin, routines and the
command line follow it. If the two ever differ, `kindle_status` and the sync say so (`vault_mismatch`);
clear the extension's vault field to use the saved one everywhere.

| Variable | Desktop setting | Settings file key | Default |
|---|---|---|---|
| `KINDLE_MCP_HOME` | Data folder | | `~/.kindle-mcp` |
| `OBSIDIAN_VAULT` | Obsidian vault | `obsidian_vault` (or `vault`) | unset (no vault) |
| `OBSIDIAN_FOLDER` | Folder inside the vault | `obsidian_folder` (or `folder`) | `Kindle` |
| `KINDLE_ACT_ON_COMMANDS` | Do @commands after a sync | `act_on_commands` | `true`; `false` makes Claude offer instead |
| `KINDLE_AUTO_FILE` | File @todo, @quote and @project during sync | `auto_file` | `true`; `false` leaves them to Claude |
| `KINDLE_LINK_NOTES` | Link highlights to your notes | `link_notes` | `true` |
| `KINDLE_LINK_EXCLUDE` | Folders never linked or searched | `link_exclude` | unset; comma-separated folders |
| `KINDLE_BROWSER_PATH` | Browser executable | `browser_path` | unset; Chrome or Edge is found automatically |
| `KINDLE_MCP_DB` | | | `$KINDLE_MCP_HOME/kindle.db` |
| `KINDLE_ON_PENDING` | | | unset; same as `sync --on-pending` |
| `KINDLE_REQUEST_DELAY` | | | `1.5` seconds between Amazon pages |
| `KINDLE_SYNC_BUDGET_MS` | | | `40000`; how long one MCP sync call may fetch |
| `KINDLE_NOTEBOOK_BASE` | | | `https://read.amazon.com` |

## Privacy and data

- `~/.kindle-mcp/kindle.db`: your highlights, notes and the @command queue.
- `~/.kindle-mcp/session.json`: Amazon session cookies. Treat it like a password.
- `~/.kindle-mcp/config.json`: your settings (the vault path and the like), if you saved any.
- `~/.kindle-mcp/vault-index-*.db`: a cache of your vault's note names, aliases and the start of each
  note's text, for linking and search. Safe to delete; it is rebuilt.
- Claude sees what the tools return: highlights, and with a vault, excerpts of your notes from
  `kindle_search_vault` and related notes, and the whole notes it reads with `kindle_read_note`.
  Folders you exclude and notes marked `kindle-link: false` are never searched, read or returned.
- Nothing leaves your machine except requests to Amazon for your own notebook, and what your Claude
  client sends to Claude as part of the conversation.

## How the notebook is read

Amazon has no public API for Kindle highlights. The sync calls the same addresses the notebook
site's own page calls to load your library and each book's highlights, sends your saved sign-in, and
reads the HTML those addresses answer with. No browser and no screenshots: a browser is used only to
sign in, and to renew the sign-in when Amazon refuses the saved one. If Amazon changes that HTML,
`kindle-mcp doctor` shows what changed, and `src/notebook/selectors.ts` is the one file to fix.

**Sign-in renewal.** Part of Amazon's sign-in expires within about a day. When the saved cookies are
refused, the sync opens the sign-in browser's profile without a window, loads the notebook, and a
browser Amazon remembers (**Keep me signed in**) gets new cookies without a password. Chrome without
a window names itself `HeadlessChrome` in its user agent, and Amazon treats that browser as a
stranger, so the hidden browser is started under its windowed name (Chrome's `--user-agent` switch,
which keeps the browser's own client hints). The plain-HTTP sync sends the user agent of the browser
that saved the sign-in. When a renewal fails, the sync's message says what Amazon asked for (a
password, a code, a puzzle) or where the page stopped, and `kindle_status` keeps it as `last_renewal`.

The sign-in window ticks **Keep me signed in** on Amazon's form for the reader (an init script that
sets the box once per page without moving the focus; they can untick it), since renewal works only
for a browser Amazon remembers. When the notebook loads, the window says "Signed in" for three
seconds before it closes, and says so when Amazon didn't ask for the password: a window that only
flashed looked like a failure.

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
npm test                        # vitest; fixtures hold placeholder text only
npm run build                   # dist/, then `node dist/cli.js --help`
npm run build && npm run mcpb   # the Desktop bundle, checked by unpacking it and replaying a host handshake
npm run render-plugin           # plugin/, .claude-plugin/ and skills/ from package.json and src/prompts
npm run build && npm run render-plugin -- --dev   # build/plugin-dev: the plugin running this checkout
claude --plugin-dir build/plugin-dev              # try it; `claude plugin validate plugin` checks it
```

The plugin's files are generated; edit `src/plugin.ts` or `src/prompts/*.md` instead, and a test fails
until they're rendered again.

When Amazon's page shape changes: `kindle-mcp doctor [--book X]`, run the capture through
`node scripts/scrub-capture.mjs doctor-….html tests/fixtures/<name>.html` (it writes nothing unless the result
passes the privacy check), fix `src/notebook/selectors.ts`, add a test. Never commit `.har`, `.db`,
`session.json` or `doctor-*.html`: they hold highlight text and session state.

### The privacy guard

Nothing from a reader's library may be in this repository: no title, author, highlight, note, tag, project or
vault name, no ASIN, account id or total, and no Claude session link. `scripts/privacy-check.mjs` enforces it:

- **Fixtures** may only use the words in `tests/fixtures/VOCABULARY.txt` (Amazon's page chrome and invented
  placeholders), fake ASINs (`B0FAKE0001`), placeholder ids and `example.invalid` URLs.
- **Private terms** are matched everywhere, as names and as six-word quotes. They come from the `PRIVATE_TERMS`
  environment variable (the CI secret of the same name), a `private-terms.txt` next to `kindle.db`, and the titles,
  authors, highlights and notes in your own `kindle.db`. A finding names the file, the line and the term's number,
  never the term.
- **Where it runs:** the git hooks in `.githooks` (turned on by `npm install`), the Claude Code hook in
  `.claude/settings.json` (commits, pushes, file writes and GitHub posts), CI on every push and pull request, and
  the release workflow.
- **Claude cannot edit the guard** (`scripts/privacy-*.mjs`, `scripts/hooks`, `.githooks`, `.claude/settings.json`,
  `VOCABULARY.txt`): the hook refuses, and so does skipping the git hooks. You change it, or set
  `PRIVACY_GUARD_EDIT=1` in your own shell for a session.

## Releasing

Bump `version` in `package.json`, run `npm run render-plugin` and merge. Then run the `release` workflow from the
Actions tab, typing that version to confirm. It runs the privacy check and the tests, builds and checks the
Desktop bundle, refuses a version that already has a release, creates the `v<version>` tag and attaches the
`.mcpb` to a GitHub release. The plugin installs that bundle from the release. Nothing is published to npm: the
package is private, and the versions published earlier (up to 1.3.3) are no longer updated.

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

Optionally add a `PRIVATE_TERMS` repository secret (Settings, Secrets and variables, Actions): one title, author
or project name per line. CI and the release workflow refuse those words when it is set. Without it they still
check fixtures and the structural rules, which is what stops new leaks.

## Next

- `kindle_get_themes(since)`: deterministic keyword clustering the weekly brief can lean on.
- Streamable HTTP transport with a token, for Claude on the web and mobile.
