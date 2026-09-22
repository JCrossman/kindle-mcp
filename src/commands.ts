/**
 * Notes-as-commands: a tiny grammar for routing highlights from the Kindle itself.
 *
 * Type a note on a highlight like:
 *     @post                      -> queue for a writing draft
 *     @research                  -> go find out more about this
 *     @project netcare           -> attach to a project (one-word argument)
 *     @todo email Sam about this -> task (argument runs to the end of the line or the next @tag)
 * Anything that isn't a command stays as the human-readable note.
 *
 * COMMANDS is the single source of truth: parsing, the MCP tool descriptions, the router prompt
 * and the README table are all derived from or tested against it. Add a row to add a command.
 */

/** "word": next token only. "line": rest of the line up to the next @tag. "none": no argument. */
export type ArgStyle = "none" | "word" | "line";

/**
 * Who finishes a command. "sync": filing, done by the sync itself when a vault is set (no model
 * needed, works from cron). "agent": needs a model (Claude or any MCP client) to write it.
 */
export type DoneBy = "sync" | "agent";

export interface CommandSpec {
  tag: string;
  aliases: string[];
  arg: ArgStyle;
  argRequired: boolean;
  /** What the reader meant when they typed it. */
  meaning: string;
  doneBy: DoneBy;
  /** What lands where, for people (README table). */
  result: string;
  /** What an agent does with it while it is pending. Shipped verbatim on every pending command. */
  action: string;
}

export const COMMANDS: CommandSpec[] = [
  {
    tag: "post",
    aliases: ["p"],
    arg: "none",
    argRequired: false,
    meaning: "I want to write about this. The rest of the note is the angle.",
    doneBy: "agent",
    result: "Claude drafts a post angle and saves it as a note in `Posts/`, linked to the highlight.",
    action:
      "Draft a post angle: one claim, 2 to 4 quotes cited by book title and location (this highlight plus " +
      "related ones from kindle_get_command_context), and the tension with something else the reader has read. " +
      "150 to 300 words. Save it with kindle_complete_command (a short title, the draft as markdown).",
  },
  {
    tag: "research",
    aliases: ["r"],
    arg: "none",
    argRequired: false,
    meaning: "Go find out more about this. The rest of the note is the question.",
    doneBy: "agent",
    result: "Claude researches it (web search when it has it) and saves a note with sources in `Research/`.",
    action:
      "Do the research. With web search available: find 3 to 5 sources, summarise them, say where they agree " +
      "or disagree with the highlight, and include links. Always add the related highlights from the store and " +
      "link the related notes from kindle_get_command_context where they fit. Without a web tool: write the three " +
      "sharpest questions and state plainly that no research was performed. Save it with kindle_complete_command.",
  },
  {
    tag: "todo",
    aliases: ["t"],
    arg: "line",
    argRequired: true,
    meaning: "Make this a task. The argument is the task text.",
    doneBy: "sync",
    result: "A checklist item in `Inbox/Todo.md` with the quote and a link to the highlight.",
    action:
      "Create the task with the quote, book title and location attached: kindle_complete_command files it in the " +
      "vault's task list. Without a vault, use your own task tool or list it in your reply, then call " +
      "kindle_mark_command_done.",
  },
  {
    tag: "project",
    aliases: ["pr"],
    arg: "word",
    argRequired: true,
    meaning: "This belongs to project `<name>`.",
    doneBy: "sync",
    result:
      "The quote and note under a `From Kindle` heading in your note named or aliased `<name>`, else in `Projects/<name>.md`.",
    action:
      "Attach the quote and note to that project: kindle_complete_command appends it to the vault note named or " +
      "aliased `<name>`, or creates one. A missing project name goes to Unrouted with the reason. Without a vault, " +
      "put it in your reply, then call kindle_mark_command_done.",
  },
  {
    tag: "quote",
    aliases: ["q"],
    arg: "none",
    argRequired: false,
    meaning: "Keep this as a quotable line.",
    doneBy: "sync",
    result: "The quote with title, author and location in `Inbox/Quotes.md`.",
    action:
      "File it with attribution (title, author, location), no commentary: kindle_complete_command adds it to the " +
      "vault's quote list. Without a vault, put it in your reply, then call kindle_mark_command_done.",
  },
];

export const UNKNOWN_ACTION =
  "Unknown tag: kindle_complete_command files it to Unrouted with the tag preserved (without a vault, mention it in " +
  "your reply and call kindle_mark_command_done). Never invent behaviour for a tag that is not in the table.";

export interface Command {
  tag: string;
  arg: string;
}

export interface CommandWithAction extends Command {
  action: string;
  known: boolean;
}

const BY_TAG = new Map<string, CommandSpec>(COMMANDS.map((c) => [c.tag, c]));
const BY_ALIAS = new Map<string, string>(COMMANDS.flatMap((c) => c.aliases.map((a) => [a, c.tag] as [string, string])));

export function commandSpec(tag: string): CommandSpec | undefined {
  return BY_TAG.get(tag);
}

/** `@p` -> `post`; unknown tags come back unchanged (lowercased). */
export function resolveTag(raw: string): string {
  const t = raw.toLowerCase();
  return BY_ALIAS.get(t) ?? t;
}

export function withActions(commands: Command[]): CommandWithAction[] {
  return commands.map((c) => {
    const spec = BY_TAG.get(c.tag);
    return { ...c, action: spec ? spec.action : UNKNOWN_ACTION, known: Boolean(spec) };
  });
}

/** A tag is `@word` not glued to a preceding word or `@` (so emails are not commands). */
const TAG = /(?<![\p{L}\p{N}_@])@([a-zA-Z][\w-]*)/u;

/** Returns the commands found in a note and the note with the command text removed. */
export function parseCommands(note: string | null | undefined): { commands: Command[]; note: string } {
  if (!note || !note.includes("@")) return { commands: [], note: (note ?? "").trim() };

  const commands: Command[] = [];
  const kept: string[] = [];
  for (const line of note.split(/\r\n|\r|\n/)) {
    let rest = line;
    for (;;) {
      const m = TAG.exec(rest);
      if (!m || m.index === undefined) break;
      const tag = resolveTag(m[1]);
      const style = BY_TAG.get(tag)?.arg ?? "none";
      const before = rest.slice(0, m.index);
      let after = rest.slice(m.index + m[0].length);
      let arg = "";
      if (style === "line") {
        const next = TAG.exec(after);
        if (next && next.index !== undefined) {
          arg = after.slice(0, next.index).trim();
          after = after.slice(next.index);
        } else {
          arg = after.trim();
          after = "";
        }
      } else if (style === "word") {
        const trimmed = after.trim();
        const parts = trimmed.split(/\s+/);
        if (parts[0] && !parts[0].startsWith("@")) {
          arg = parts[0];
          after = trimmed.slice(parts[0].length).trim();
        }
      }
      commands.push({ tag, arg });
      rest = `${before} ${after}`;
    }
    if (rest.trim()) kept.push(rest.split(/\s+/).filter(Boolean).join(" "));
  }
  return { commands, note: kept.join("\n").trim() };
}

const argLabel = (c: CommandSpec): string =>
  (c.arg === "none" ? "none" : c.arg === "word" ? "one word" : "rest of line") + (c.argRequired ? ", required" : "");
const doneByLabel = (c: CommandSpec): string => (c.doneBy === "sync" ? "the sync" : "Claude");

/** Markdown table of the supported commands for people: the README carries it verbatim. */
export function commandsTable(): string {
  const rows = COMMANDS.map(
    (c) =>
      `| \`@${c.tag}\` | ${c.aliases.map((a) => `\`@${a}\``).join(", ")} | ${argLabel(c)} | ${c.meaning} | ${doneByLabel(c)} | ${c.result} |`,
  );
  return ["| Tag | Alias | Argument | You mean | Done by | What happens |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

/** The same commands with the agent's contract, for the router prompt. */
export function actionsTable(): string {
  const rows = COMMANDS.map(
    (c) =>
      `| \`@${c.tag}\` | ${c.aliases.map((a) => `\`@${a}\``).join(", ")} | ${argLabel(c)} | ${c.doneBy === "sync" ? "the sync, when a vault is set" : "you"} | ${c.action} |`,
  );
  return ["| Tag | Alias | Argument | Done by | Action while pending |", "|---|---|---|---|---|", ...rows].join("\n");
}
