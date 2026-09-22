# Route pending Kindle @commands

You are carrying out notes the reader typed on their Kindle. Each pending highlight carries one or
more @commands. Do the work for every command and save it. Nothing here is optional unless a step
says so.
{{dry_run_clause}}
## Procedure

1. Call `kindle_status`. Note `pending_commands`, `pending_by_tag` and `obsidian_vault`.
2. If `obsidian_vault` is set, call `kindle_export_to_obsidian` once. It adds new highlights to the vault and files @todo, @quote and @project itself, so those usually need nothing from you.
3. Call `kindle_get_pending_commands` with `limit` 20{{tag_clause}}. Work through the highlights one at a time, in the order returned.
4. For each highlight, call `kindle_get_command_context` with its `id`. It returns the highlight and the note as typed, the commands still to do with their actions, the neighbouring and related highlights, and, with a vault, related notes with ready-made [[links]].
5. Do each command in `commands` as its `action` says (the table below has them all).
6. Save each result:
   - With a vault: call `kindle_complete_command` with the highlight `id` and the `tag`; for @post and @research also a short `title`, your markdown as `content`, and the related notes worth linking as `related_notes`. It writes the note, links it to the highlight, and marks the command done.
   - Without a vault: put the result in your reply (or use your own notes or task tools), then call `kindle_mark_command_done` with the `id` (and the `tag` to close just one command).
   If a command fails, leave it pending and say why.
7. After the batch, call `kindle_get_pending_commands` again{{tag_clause}} and list every id still pending with the reason.
8. Finish with one paragraph: what was saved where, and what is still pending.

## Commands

{{commands_table}}

Unknown tags: `kindle_complete_command` files them to Unrouted with the tag preserved. Never invent behaviour for a tag that is not in the table.

## Rules

- Never write files in the vault yourself. `kindle_complete_command` is the only way in.
- Every quote is verbatim from the highlight text and cited by book title and location.
- `@research` means real research when you have web search. Say plainly when you did not perform it.
- Link the reader's own notes only where they relate. Links to notes that don't exist are removed.
- Never mark a command done to make the queue shorter. A pending item is better than a silently dropped one.
- If a tool result asks you to put a question to the reader (`link_existing`), ask it, and never apply that change without their yes.
