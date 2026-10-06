# Set up kindle-mcp

Walk the user through getting their Kindle highlights into Claude, one step at a time. Where a
step needs them, stop and wait.

1. Call `kindle_status`. If the Kindle tools aren't available at all, the kindle plugin's server
   didn't start: in Claude Code, `/mcp` shows why. Say so and stop.
2. **Amazon sign-in.** If `session_saved` is false: say that a Chrome window will open on Amazon's
   sign-in page, that they should sign in there (2FA included) and leave **Keep me signed in**
   ticked (it's ticked for them), so later syncs can renew the sign-in without them. If Amazon
   already remembers that browser, the window just says "Signed in" and closes. Then call `kindle_login`. When they say they're
   done, call `kindle_status` again and check `session_saved`.
3. **Obsidian vault.** If `obsidian_vault` is empty, ask whether they use Obsidian, and if so for
   the vault's top folder. Call `kindle_set_vault` with it. If it says the folder isn't a vault,
   show them why and ask again. Without Obsidian, skip this: Claude puts results in the chat.
4. **First sync.** Call `kindle_sync`; while the result says `partial`, call it again. Then do
   what its `pending` instruction says, and ask its `link_existing` and `unknown_tags` questions
   if there are any.
5. **Scheduled sync.** Offer it. If they want it, give these steps for Claude Desktop:
   - Make a new, empty folder for the routine. Not the vault (Claude's own file tools would work
     in it directly) and not the data folder (it holds the Amazon session).
   - In the Code tab: Routines, New routine, Local. Instructions: `/kindle:routine`. Leave the
     permission mode on Manual, select the folder, leave Worktree off, pick a schedule.
   - Create, then Run now, and answer each permission prompt with Always allow for
     kindle_sync, kindle_get_pending_commands, kindle_get_command_context,
     kindle_complete_command, kindle_search_vault, kindle_read_note and kindle_status, plus
     WebSearch and WebFetch for @research. Never always-allow kindle_login (it opens a window),
     kindle_link_existing_highlights (it changes older notes), kindle_teach_tag or
     kindle_set_vault (both are the user's call).
6. If every Kindle tool shows up twice, the Claude Desktop extension is also on in this session.
   Suggest turning it off here (the + menu, Connectors): the plugin brings the same tools.
7. Finish with what's set up, and what they can say next: "Sync my Kindle highlights",
   `/kindle:brief` for a weekly reading brief, `/kindle:route` to work through @commands.
