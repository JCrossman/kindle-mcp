# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Please do not open a public issue for anything that could expose a
reader's Amazon session or highlights. You will get an acknowledgement within a week.

## Supported versions

The latest release on GitHub receives fixes. Versions that were published to npm (up to 1.3.3) are no longer
updated; use the release's Claude Desktop bundle or the plugin instead.

## What this tool handles

- `kindle-mcp login` saves Amazon session cookies to `~/.kindle-mcp/session.json` (owner-only
  permissions). Your password is never seen or stored. Treat that file, the browser profile next
  to it, and `kindle.db` (your highlights) as private data.
- The MCP server runs over stdio on the machine that holds the store and exposes no network port.
- Sync talks only to Amazon: plain GET requests to `read.amazon.com` with those cookies, and, when
  the saved sign-in needs renewing, Amazon's sign-in page loaded in a hidden browser from the saved
  browser profile. There is no telemetry.

## Claude and untrusted text

Claude reads text nobody here wrote: book text and metadata from Amazon, notes in the vault (some clipped
from the web), and web pages during @research. Any of it can carry instructions. The design assumes some
will, and limits what following them could do:

- **Only the reader starts work.** @commands are parsed from the note the reader typed on the Kindle, never
  from a book's text, so a book can't create one.
- **The server's reach is small.** It talks to nothing but Amazon and writes only inside the vault
  (symlinks and outside paths are refused). It appends to the reader's notes, changes only text it wrote
  itself and only while unedited (with a conflict check), and never deletes a file.
- **Nothing written runs or phones home.** Text from a model or a book is made inert before it reaches
  Obsidian: Dataview JS, JS Engine and Templater code becomes plain text, every image becomes a link
  (an `![[embed]]` of a vault file stays), and every HTML tag is shown as text, so nothing loads from the
  network or runs when a note is opened. Frontmatter values copied from a book are cleaned the same way.
- **Claude's own notes stay labelled.** Notes Claude writes carry `ai-generated: true` and say so in the
  note. They are never offered to Claude as related notes, are left out of vault search unless asked,
  and are marked `written_by: claude` when read, so an instruction slipped into one draft can't steer the
  next.
- **Untrusted text is labelled.** Tool descriptions and results that carry it say it is data, not
  instructions. That helps, but it is a request to the model, not a guarantee; the points above don't
  depend on it.
- **Unattended runs get fewer tools.** The scheduled routine is set up with only the Kindle tools and web
  search: no page fetching, no email, files or other connected apps, so nothing it reads can make it
  send data out. Tools that change settings or the vault's structure (`kindle_teach_tag`,
  `kindle_set_vault`, `kindle_link_existing_highlights`, `kindle_login`) stay behind the app's permission
  prompt.

Known limits: Claude still sees your highlights and the notes it reads, as with anything shared in a
conversation; in Claude Code or Cowork, where Claude can read files, it can read the data folder,
including the saved Amazon session. Report a way around any of the above as a vulnerability.

Fixtures under `tests/fixtures` hold placeholder text only: the page markup Amazon uses, with invented titles,
authors, highlights and notes, fake ASINs and no account ids or tokens. A check (`scripts/privacy-check.mjs`)
refuses anything else, in CI and in the git hooks. Please keep new fixtures the same way.
