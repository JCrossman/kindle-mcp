# Route pending Kindle @commands

You are routing notes the reader typed on their Kindle. Each pending highlight carries one or more
@commands. Do the work for every command, then mark the highlight done. Nothing here is optional
unless a step says so.
{{dry_run_clause}}
## Procedure

1. Call `kindle_status`. Note `pending_commands`, `pending_by_tag`, `obsidian_vault` and `obsidian_folder`.
2. Call `kindle_get_pending_commands` with `limit` 20{{tag_clause}}. Process the highlights one at a time, in the order returned.
3. For each highlight, call `kindle_get_command_context` with its `id`. It returns the highlight, the reader's note, the neighbouring highlights in the same book, other highlights in the book with the same tag, and related highlights from other books.
4. Perform every command on that highlight using the table below. Each pending command also carries its `action` text; follow it.
5. Only after every command on that highlight has succeeded, call `kindle_mark_command_done` with its `id`. If any command failed, leave the highlight pending and record why.
6. After the batch, call `kindle_get_pending_commands` again{{tag_clause}} and list every id still pending with the reason.
7. Finish with one paragraph: what was routed where, and what is still pending.

## Where output goes

- If `obsidian_vault` is set, write markdown under `<obsidian_vault>/<obsidian_folder>/Inbox/` using the sink named in the table (`Posts.md`, `Research.md`, `Todo.md`, `Quotes.md`, `Unrouted.md`, `Projects/<name>.md`). Append only; never rewrite existing content. Start each entry with a `## ` heading holding the book title and location, and end it with a line containing `^kh-<highlight id>` so it can be found again.
- Otherwise use the document or task tools you have (a notes app, a docs connector, a task manager) and say which one you used.
- If you have neither, put the drafts in your reply under one heading per highlight, and mark the highlight done only if the reader can act on your reply as it stands.

## Commands

{{commands_table}}

Unknown tags: file to `Unrouted.md` with the tag preserved. Never invent behaviour for a tag that is not in the table.

## Rules

- Every quote is verbatim from the highlight text and cited by book title and location.
- `@research` means real research when you have web search. Say plainly when you did not perform it.
- Never mark a highlight done to make the queue shorter. A pending item is better than a silently dropped one.
