Sync my Kindle highlights with kindle_sync. If the result says partial, call kindle_sync again
until it's complete. Then carry out any pending @commands as the sync result instructs, saving
each one with kindle_complete_command.

This runs unattended: don't ask me anything and don't open the Amazon sign-in window. If the
sync says I need to sign in, call kindle_get_pending_commands and still do anything waiting,
then start the summary with "Kindle sign-in needed: say 'Sign me in to Kindle' when you're at
your computer." If it offers to link older highlights, just mention it.

Finish with a short summary: new highlights, what was filed where, the notes you wrote (by
title), and anything that needs me.
