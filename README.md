# kindle-mcp

Read on your Kindle, and let Claude do the rest.

- **Your highlights land in Obsidian.** If you use Obsidian, the highlights and notes from your
  Kindle Store books are added to your vault, one note per book, linked to the notes you already have.
- **Your notes become requests.** Type a short note on a highlight, like `@research is this still
  true?`, `@post`, `@todo email Sam` or `@roadmap`. Claude researches the question, drafts the
  post, files the task, or adds the highlight to your Roadmap note, then saves the result in
  Obsidian, linked back to the highlight.
- **It runs in the background.** A daily sync does all of this while you read. It only asks you
  something when it can't tell what you meant.
- **Your reading stays yours.** Your highlights are kept on your computer. Nothing is sent anywhere
  except requests to Amazon for your own notebook, and what you share with Claude in a conversation.

It works in the Claude desktop app, on a Mac or a Windows PC.

## Set it up

You need the Claude desktop app, and Google Chrome or Microsoft Edge (to sign in to Amazon once).
If you use Obsidian, back up your vault first: every sync adds to it.

1. **Install.** Download `kindle-mcp-server-<version>.mcpb` from the
   [latest release](https://github.com/JCrossman/kindle-mcp/releases/latest), open it, and click
   **Install**.
2. **Set it up in a chat.** In a new chat, say "Set up my Kindle", and allow the Kindle tools when
   Claude asks. Claude:
   - opens Amazon's sign-in page in Chrome. Sign in, and leave **Keep me signed in** ticked (it's
     ticked for you) so later syncs can renew the sign-in by themselves. The window says "Signed in"
     and closes when your notebook loads; if Amazon already knows that browser, that happens at once.
   - asks where your Obsidian vault is (its top folder) and remembers it.
   - runs the first sync. A big library takes a few rounds; Claude keeps going by itself.
   - may ask whether to add links to highlights you exported before. Answer it.
3. **Turn on the daily sync** (below).
4. **Try it.** On the Kindle, add the note `@todo try kindle-mcp` to any highlight. Once the Kindle
   has synced (it needs Wi-Fi) and the daily sync has run, the task is in `Kindle/Inbox/Todo.md`,
   linked to the highlight. Or say "Sync my Kindle highlights" to see it now.

### The daily sync

A routine runs the sync on a schedule, and Claude carries out your notes as they arrive. Routines
run while the Claude app is open and your computer is awake.

1. Make an empty folder for it, for example `Kindle Routine` in your home folder. The app needs a
   folder for every routine, but nothing is written to it. Don't use your vault.
2. In the Claude app, open the **Code** tab, then **Routines**, **New routine**, **Local**. Name it
   "Kindle sync". Paste the prompt below into **Instructions**. Leave the permission mode on
   **Manual**, choose the folder from step 1, and leave **Worktree** off.
3. Pick a schedule. Daily is plenty. Hourly also works, but each run counts toward your Claude usage.
4. Click **Create**, then **Run now**. If that run can't find the Kindle tools, click the **+**
   next to the message box, then **Connectors**, turn on **Kindle highlights**, and run it again.
5. Answer each permission prompt with **Always allow** for `kindle_sync`,
   `kindle_get_pending_commands`, `kindle_get_command_context`, `kindle_complete_command`,
   `kindle_search_vault`, `kindle_read_note` and `kindle_status`, plus WebSearch and WebFetch for
   @research. A scheduled run can't answer a prompt: it waits until you do, and later runs are
   skipped meanwhile. Don't always-allow `kindle_login`, `kindle_link_existing_highlights`,
   `kindle_teach_tag` or `kindle_set_vault`: those are your call.
6. Optional: in Settings, **Desktop app**, **General**, turn on **Keep computer awake**. A computer
   that sleeps through a run skips it, and catches up once when it wakes.

Each run leaves a notification and a summary under **Scheduled** in the sidebar. If the summary
starts with "Kindle sign-in needed", say "Sign me in to Kindle" in any chat; the next run catches up.

The prompt:

```text
Sync my Kindle highlights with kindle_sync. If the result says partial, call kindle_sync again
until it's complete. Then carry out any pending @commands as the sync result instructs, saving
each one with kindle_complete_command.

This runs unattended: don't ask me anything and don't open the Amazon sign-in window. If the
sync says I need to sign in, call kindle_get_pending_commands and still do anything waiting,
then start the summary with "Kindle sign-in needed: say 'Sign me in to Kindle' when you're at
your computer." If it offers to link older highlights, just mention it. If it lists tags it
couldn't place, put its question in the summary and don't answer it yourself.

Finish with a short summary: new highlights, what was filed where, the notes you wrote (by
title), and anything that needs me.
```

## Notes as commands

Type these as a note on any highlight, on the Kindle:

| Tag | Alias | Argument | You mean | Done by | What happens |
|---|---|---|---|---|---|
| `@post` | `@p` | none | I want to write about this. The rest of the note is the angle. | Claude | Claude drafts a post angle and saves it as a note in `Posts/`, linked to the highlight. |
| `@research` | `@r` | none | Go find out more about this. The rest of the note is the question. | Claude | Claude researches it (web search when it has it) and saves a note with sources in `Research/`. |
| `@todo` | `@t` | rest of line, required | Make this a task. The argument is the task text. | the sync | A checklist item in `Inbox/Todo.md` with the quote and a link to the highlight. |
| `@project` | `@pr` | one word, required | This belongs to project `<name>`. | the sync | The quote and note under a `From Kindle` heading in your note named or aliased `<name>`, else in `Projects/<name>.md`. |
| `@quote` | `@q` | none | Keep this as a quotable line. | the sync | The quote with title, author and location in `Inbox/Quotes.md`. |
| any other `@word` | | none | This belongs with my note `word`. | the sync | The quote and note under `From Kindle` in your note named or aliased `word`, or the note you named for it once. No such note, or two: `Inbox/Unrouted.md`, and Claude asks you where it goes. |

Paths are inside the Kindle folder of your vault (`Kindle` unless you change it). A command with
text, like `@todo`, stops at the next tag, so `@todo email Sam @project garden` is two commands.
Editing the note on the Kindle re-opens only what changed.

**Any other tag needs no setup.** `@roadmap` files into your note named or aliased `Roadmap`, the
way `@project` does. If no note has that name, or two do, it waits in `Inbox/Unrouted.md`, and
Claude asks you once where it belongs, with its best guess ("does @road mean your note
'Roadmap'?"). Say yes and it's remembered: what was waiting moves there, and later ones file there
too. Nothing is ever filed on a guess, and a tag never creates a note. A command typo (`@tood`) is
pointed out, not guessed; fix the note on the Kindle and the next sync files it.

Your note reaches Amazon the next time the Kindle is online; the next sync picks it up. Books you
sideloaded (not from the Kindle Store) never reach Amazon's notebook, so their highlights aren't synced.

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

`@project garden` appends the quote under `## From Kindle` in your own `Garden` note (or the note
that lists `garden` in its `aliases`), before any section that follows it. With no such note it
creates `Kindle/Projects/garden.md`. Any other tag, like `@roadmap`, works the same way with your
`Roadmap` note, but never creates one.

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
wording is corrected. Say no and it won't ask again; ask for it any time: "Link my older Kindle
highlights to my notes".

## Things to ask Claude

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

**Your notes and the vault**
- "What's waiting from my Kindle notes?"
- "Do my pending Kindle commands."
- "Which of my notes relate to this highlight?"
- "Use ~/Documents/Notes as my Kindle vault."
- "Link my older Kindle highlights to my notes." (previews first, applies on your yes)
- "Bring back the note for <book title>." (recreates a book note you deleted)

**Keeping it running**
- "Sync my Kindle highlights."
- "Is my Kindle connection working?"
- "Sign me in to Kindle."

## Settings

Most people never change these. They're under Settings, **Extensions**, **Kindle highlights**:

- **Obsidian vault:** leave it empty if you told Claude where your vault is. Fill it in only to
  use a different vault in this app.
- **Folder inside the vault:** where the Kindle notes go; `Kindle` unless you change it.
- **Do @commands after a sync:** on by default. Off, Claude lists your notes' requests and offers.
- **File @todo, @quote and @project during sync:** on by default.
- **Link highlights to your notes:** on by default.
- **Folders never linked or searched:** folders Claude never links to or reads.
- **Browser executable:** only if you have neither Chrome nor Edge.

## Updating

Download the new `.mcpb` from the [latest release](https://github.com/JCrossman/kindle-mcp/releases/latest)
and open it. The app replaces the old version; your settings, highlights and sign-in stay.

## If it keeps asking you to sign in

The sync reuses the sign-in you saved. Amazon lets part of it expire within a day or so, and the sync
renews it by itself in a hidden browser while Amazon remembers your browser, which is what **Keep me
signed in** is for. When that doesn't work, the sync says what Amazon asked the hidden browser for:

- Say "Sign me in to Kindle" and leave **Keep me signed in** ticked. Without it, Amazon forgets the browser
  when the sign-in window closes, and every sync needs you.
- "Is my Kindle connection working?" shows when you last signed in, how the last renewal went and
  which version is running.
- If the daily sync asks every day although the sign-in window opens already signed in, update to
  the latest version, and if it still asks, report what its summary says on the project's
  [issues page](https://github.com/JCrossman/kindle-mcp/issues).
- Nothing is lost while you're signed out: Claude still has your highlights, and the next sync
  catches up.

If the extension doesn't start at all, its log is `mcp-server-Kindle highlights.log` in Claude's
log folder (`~/Library/Logs/Claude` on a Mac, `%APPDATA%\Claude\logs` on Windows).

## Privacy

- Your highlights, notes and Amazon sign-in are stored in the `.kindle-mcp` folder in your home
  folder. Treat it as private: it holds your Amazon session.
- Claude sees what you ask about, and what the Kindle tools return: highlights, and with a vault,
  excerpts of your notes and the notes it reads to do your requests. Folders you exclude and notes
  marked `kindle-link: false` are never searched, read or returned.
- Your Amazon password is never seen or stored.

## Known limits

- Reading your notebook this way may conflict with Amazon's terms of use. It reads only your own
  data, slowly, with a pause between pages. Your call.
- How long Amazon remembers your browser is up to Amazon. The sync renews the sign-in while it does,
  and tells you when it needs you.
- It works in the Claude desktop app only, not on claude.ai in a browser or on your phone: those
  can't reach your computer.
- "Do @commands after a sync" is an instruction to Claude, not a guarantee. @research searches the
  web only when Claude has web search.

## For developers

The same server also runs as a plugin for Claude Code and Cowork, from the command line, and on a
schedule with cron. [docs/DEVELOPERS.md](docs/DEVELOPERS.md) covers those, the full list of tools and
settings, how the notebook is read, and how to build and release.
