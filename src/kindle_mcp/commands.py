"""Notes-as-commands: a tiny grammar for routing highlights from the Kindle itself.

Type a note on a highlight like:
    @post                      -> queue for a writing draft
    @research                  -> file under research
    @project netcare           -> attach to a project (one-word argument)
    @todo email Sam about this -> task (argument runs to end of line)
Anything that isn't a command stays as the human-readable note.

Edit ARG_STYLE to add your own tags. Unknown @tags still parse, with no argument.
"""
from __future__ import annotations

import re

# "word": next token only. "line": rest of the line. "none": no argument.
ARG_STYLE: dict[str, str] = {
    "project": "word",
    "todo": "line",
    "post": "none",
    "research": "none",
    "quote": "none",
}

_TAG = re.compile(r"(?<![\w@])@([a-zA-Z][\w-]*)")


def parse_commands(note: str) -> tuple[list[dict], str]:
    """Return (commands, remaining_note). Commands look like {"tag": "project", "arg": "netcare"}."""
    if not note or "@" not in note:
        return [], (note or "").strip()

    commands: list[dict] = []
    kept_lines: list[str] = []
    for line in note.splitlines():
        rest = line
        while True:
            m = _TAG.search(rest)
            if not m:
                break
            tag = m.group(1).lower()
            style = ARG_STYLE.get(tag, "none")
            before, after = rest[: m.start()], rest[m.end():]
            arg = ""
            if style == "line":
                arg, after = after.strip(), ""
            elif style == "word":
                parts = after.strip().split(None, 1)
                if parts and not parts[0].startswith("@"):
                    arg = parts[0]
                    after = parts[1] if len(parts) > 1 else ""
            commands.append({"tag": tag, "arg": arg})
            rest = f"{before} {after}"
        if rest.strip():
            kept_lines.append(" ".join(rest.split()))
    return commands, "\n".join(kept_lines).strip()
