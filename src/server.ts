/**
 * MCP interface over the local store. Reads are instant (SQLite); only kindle_sync touches Amazon.
 * createServer() is transport-free; serveStdio() wires it to stdio.
 *
 * Claude Desktop does not pass server instructions to the model, so everything a client must
 * know to act (the @command flow, what `truncated` means) is in tool descriptions and results.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type CallToolResult,
  type GetPromptResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { actionsTable, COMMANDS, commandSpec, resolveTag, UNKNOWN_ACTION, type CommandWithAction } from "./commands.js";
import { ensureDirs, type Config } from "./config.js";
import { loadSession } from "./notebook/session.js";
import { Store, type HighlightRow } from "./store.js";

export const CHAR_LIMIT = 25_000;
/** The package version, so the server reports what npm installed. */
export const SERVER_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** How long the vault step of a sync may run after the Amazon part's budget. */
const VAULT_GRACE_MS = 12_000;
/** Pending highlights listed in a sync result; the rest come from kindle_get_pending_commands. */
const PENDING_IN_SYNC = 10;

type Json = Record<string, unknown>;

const tagList = COMMANDS.map((c) => `@${c.tag}${c.arg === "none" ? "" : c.arg === "word" ? " <name>" : " <text>"}`).join(", ");
const TRUNCATED_HINT = "`truncated: true` means Amazon didn't return that highlight's text (usually an image or table).";

export function serverInstructions(): string {
  return (
    "The user's Kindle highlights and notes, synced to a local store, and their Obsidian vault if one is set. Use " +
    "kindle_search_highlights to bring their own reading into a conversation and kindle_get_new_since to see what " +
    `they have been reading lately. Notes on the Kindle can carry @commands (${tagList}): kindle_sync files ` +
    "@todo, @quote and @project into the vault itself and returns the @post and @research commands left for you, " +
    "with an instruction saying whether to do them now; save each result with kindle_complete_command. " +
    `${TRUNCATED_HINT} Always cite book title and location when quoting a highlight.`
  );
}

const cut = (s: string, n: number): string => (Array.from(s).length > n ? `${Array.from(s).slice(0, n - 1).join("")}...` : s);

/** Drop empty fields and, unless asked, the verbose action text, to keep responses small. */
function slim(h: HighlightRow, withActions = false): Json {
  const keep = ["id", "title", "author", "text", "note", "location_start", "page", "truncated", "commands", "first_seen"] as const;
  const out: Json = {};
  for (const k of keep) {
    const v = h[k];
    if (v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && !v.length)) continue;
    out[k] = k === "commands" && !withActions ? (v as CommandWithAction[]).map(({ tag, arg }) => ({ tag, arg })) : v;
  }
  if (h.commands.length && h.raw_note && h.raw_note.trim() !== h.note.trim()) out.note_as_typed = h.raw_note;
  return out;
}

/** A pending highlight: what is left to do (with each command's action) and what is already done. */
function pendingView(h: HighlightRow): Json {
  const out = slim({ ...h, commands: h.remaining ?? h.commands }, true);
  if (h.commands.length && h.raw_note && h.raw_note.trim() !== h.note.trim()) out.note_as_typed = h.raw_note;
  if (h.already_done?.length) out.already_done = h.already_done.map(({ tag, arg, path }) => ({ tag, arg, ...(path ? { path } : {}) }));
  return out;
}

function reply(payload: Json): CallToolResult {
  let text = JSON.stringify(payload, null, 2);
  let body = payload;
  if (text.length > CHAR_LIMIT && Array.isArray(payload.highlights)) {
    let items = payload.highlights as unknown[];
    while (items.length && text.length > CHAR_LIMIT) {
      items = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
      body = { ...payload, highlights: items, truncated_response: true, hint: "Response cut to fit. Use limit/offset or a narrower query." };
      text = JSON.stringify(body, null, 2);
    }
  }
  return { content: [{ type: "text", text }], structuredContent: body };
}

function fail(message: string, extra: Json = {}): CallToolResult {
  const payload = { error: message, ...extra };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

/** Accepts '7d', '36h', '2w', or an ISO date/datetime. Returns a UTC ISO string. */
export function parseSince(since: string): string {
  const s = since.trim().toLowerCase();
  const units: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const span = /^(\d+)([hdw])$/.exec(s);
  let dt: Date;
  if (span) dt = new Date(Date.now() - parseInt(span[1], 10) * units[span[2]]);
  else {
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
    if (Number.isNaN(t)) throw new Error(`Could not read '${since}'. Use a span like '7d', '36h', '2w' or an ISO date like '2026-09-01'.`);
    dt = new Date(t);
  }
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * What the agent should do about pending commands, in words it will follow. The user's setting
 * decides act or offer; the vault decides where results go.
 */
export function pendingInstruction(act: boolean, vault: boolean, more: boolean): string {
  const save = vault
    ? "save each result with kindle_complete_command (it writes the note into the vault and marks the command done)"
    : "no Obsidian vault is set, so put each result in your reply (or use your own notes or task tools), then call kindle_mark_command_done for the highlight";
  const rest = more ? " Start with these; kindle_get_pending_commands lists the rest." : "";
  if (!act) {
    return (
      "List these @commands for the user and offer to do them. Only act if they say yes; then follow the action for " +
      `each tag (in \`actions\`), use kindle_get_command_context for a highlight's context, and ${save}.${rest}`
    );
  }
  return (
    "These are @commands the user typed on their Kindle, and their settings say to carry them out when they sync. " +
    "Do each one now, without asking first: follow the action for its tag (in `actions`), call " +
    `kindle_get_command_context for a highlight when you need its context, and ${save}. Then tell the user what you ` +
    `did.${rest}`
  );
}

/** The pending part of a sync result: highlights with commands left, short, with the actions once per tag. */
function pendingSummary(cfg: Config, store: Store, vault: boolean): Json {
  const all = store.pendingCommands(null, Number.MAX_SAFE_INTEGER);
  if (!all.length) return { count: 0 };
  const tags = [...new Set(all.flatMap((h) => h.remaining!.map((c) => c.tag)))];
  const highlights = all.slice(0, PENDING_IN_SYNC).map((h) => {
    const v = pendingView(h);
    if (typeof v.text === "string") v.text = cut(v.text, 500);
    for (const c of (v.commands as Json[]) ?? []) {
      delete c.action;
      delete c.known;
    }
    return v;
  });
  return {
    count: all.length,
    act_now: cfg.actOnCommands,
    instruction: pendingInstruction(cfg.actOnCommands, vault, all.length > PENDING_IN_SYNC),
    actions: Object.fromEntries(tags.map((t) => [t, commandSpec(t)?.action ?? UNKNOWN_ACTION])),
    highlights,
    ...(all.length > PENDING_IN_SYNC ? { has_more: true } : {}),
  };
}

function loadPrompt(name: string, vars: Record<string, string>): string {
  let text = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}

export function routePendingPrompt(tag?: string, dryRun = false): string {
  const t = tag?.trim().replace(/^@+/, "");
  return loadPrompt("route-pending", {
    commands_table: actionsTable(),
    tag_clause: t ? ` and \`tag\` = \`${t}\`` : "",
    dry_run_clause: dryRun
      ? "\n**DRY RUN.** List what you would do for each pending highlight. Write nothing anywhere, and do not call " +
        "`kindle_complete_command`, `kindle_mark_command_done` or `kindle_export_to_obsidian`.\n"
      : "",
  });
}

export function weeklyBriefPrompt(since = "7d"): string {
  return loadPrompt("weekly-brief", { since });
}

/** The router prompts. Arguments are all optional strings, as MCP prompt arguments must be. */
interface PromptSpec {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: false }>;
  render(args: Record<string, string>): string;
}

export const PROMPTS: PromptSpec[] = [
  {
    name: "kindle_route_pending",
    title: "Route pending @commands",
    description:
      "Walk every pending @command, do what each one asks, and save it. Runner-agnostic: works interactively or from a scheduled task.",
    arguments: [
      { name: "tag", description: "Only route this tag, e.g. 'post'", required: false },
      { name: "dry_run", description: "'true' to list planned actions without writing or marking anything", required: false },
    ],
    render: (a) => routePendingPrompt(a.tag, a.dry_run === "true"),
  },
  {
    name: "kindle_weekly_brief",
    title: "Weekly reading brief",
    description: "Cluster recent highlights into themes and draft one cited angle per theme.",
    arguments: [{ name: "since", description: "Span like '7d' or an ISO date; default 7d", required: false }],
    render: (a) => weeklyBriefPrompt(a.since || "7d"),
  },
];

/**
 * Prompts are registered on the low-level server rather than through McpServer.registerPrompt:
 * SDK 1.30 validates `params.arguments` against the zod schema even when a client omits the
 * key entirely (legal per the spec, and what "run it with no options" looks like), and rejects
 * `undefined`. Here a missing object means no arguments.
 */
function registerPrompts(server: McpServer): void {
  server.server.registerCapabilities({ prompts: {} });
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })),
  }));
  server.server.setRequestHandler(GetPromptRequestSchema, async (request): Promise<GetPromptResult> => {
    const spec = PROMPTS.find((p) => p.name === request.params.name);
    if (!spec) throw new McpError(ErrorCode.InvalidParams, `Prompt ${request.params.name} not found`);
    const given = request.params.arguments ?? {};
    const args: Record<string, string> = {};
    for (const a of spec.arguments) {
      const v = given[a.name];
      if (v !== undefined && v !== null && v !== "") args[a.name] = String(v);
    }
    return { description: spec.description, messages: [{ role: "user", content: { type: "text", text: spec.render(args) } }] };
  });
}

let loginInProgress = false;

const NO_VAULT = "No Obsidian vault is set. Set it in the extension's settings (or OBSIDIAN_VAULT) to save notes there.";

/** What to do when Amazon needs the user, in a conversation or in a run nobody is watching. */
const SIGN_IN_NEXT =
  "The user has to sign in to Amazon. If they are in this conversation, offer to open the sign-in window with " +
  "kindle_login (they should tick \"Keep me signed in\"). In a scheduled or unattended run, don't call kindle_login: " +
  "do the pending commands as instructed, and tell the user to say \"Sign me in to Kindle\" when they're back.";

export function createServer(cfg: Config): McpServer {
  const server = new McpServer({ name: "kindle-mcp", version: SERVER_VERSION }, { instructions: serverInstructions() });

  const withStore = <T>(fn: (store: Store) => T): T => {
    ensureDirs(cfg);
    const store = new Store(cfg.dbPath);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  };
  const withStoreAsync = async <T>(fn: (store: Store) => Promise<T>): Promise<T> => {
    ensureDirs(cfg);
    const store = new Store(cfg.dbPath);
    try {
      return await fn(store);
    } finally {
      store.close();
    }
  };

  server.registerTool(
    "kindle_list_books",
    {
      title: "List Kindle books",
      description: "List synced books, most recently highlighted first, with highlight counts per book.",
      inputSchema: {
        query: z.string().optional().describe("Optional title or author fragment, e.g. 'kahneman'"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    async ({ query, limit, offset }) =>
      withStore((store) => {
        const books = store.listBooks(query ?? null, limit, offset);
        return reply({ count: books.length, offset, books });
      }),
  );

  server.registerTool(
    "kindle_get_highlights",
    {
      title: "Get a book's highlights",
      description: `All highlights and notes for one book, in reading order. ${TRUNCATED_HINT}`,
      inputSchema: {
        book: z.string().min(1).describe("Book id, ASIN, or part of the title, e.g. 'Thinking, Fast'"),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ,
    },
    async ({ book, limit, offset }) =>
      withStore((store) => {
        const found = store.findBook(book);
        if (!found) return fail(`No book matches '${book}'. Call kindle_list_books to see titles.`);
        const items = store.getHighlights(found.book_id as string, limit, offset);
        return reply({ book: found.title, author: found.author, count: items.length, offset, highlights: items.map((h) => slim(h)) });
      }),
  );

  server.registerTool(
    "kindle_search_highlights",
    {
      title: "Search highlights",
      description: `Full-text search across every highlight and note, best matches first. ${TRUNCATED_HINT}`,
      inputSchema: {
        query: z.string().min(2).describe("Words to find across highlight text, notes, titles and authors"),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: READ,
    },
    async ({ query, limit }) =>
      withStore((store) => {
        const items = store.search(query, limit);
        return reply({ query, count: items.length, highlights: items.map((h) => slim(h)) });
      }),
  );

  server.registerTool(
    "kindle_get_new_since",
    {
      title: "Highlights since a point in time",
      description: `Highlights first seen by the sync since a point in time. The basis for digests and resurfacing. ${TRUNCATED_HINT}`,
      inputSchema: {
        since: z.string().default("7d").describe("Span like '7d', '36h', '2w', or an ISO date like '2026-09-01'"),
        limit: z.number().int().min(1).max(500).default(200),
      },
      annotations: READ,
    },
    async ({ since, limit }) =>
      withStore((store) => {
        let cutoff: string;
        try {
          cutoff = parseSince(since);
        } catch (e) {
          return fail((e as Error).message);
        }
        const items = store.newSince(cutoff, limit);
        return reply({ since: cutoff, count: items.length, highlights: items.map((h) => slim(h)) });
      }),
  );

  server.registerTool(
    "kindle_get_pending_commands",
    {
      title: "Pending @commands",
      description:
        `Highlights whose Kindle note has @commands still to do (${tagList}). Each carries the commands left, with ` +
        "each one's `action`, and any already done. With a vault set, the sync files @todo, @quote and @project " +
        "itself, so what is left is for you: save each result with kindle_complete_command, which writes the note " +
        "and marks the command done. Without a vault, reply with the result, then call kindle_mark_command_done.",
      inputSchema: {
        tag: z.string().optional().describe("Filter to one tag, e.g. 'post', 'research', 'project', 'todo'"),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ,
    },
    async ({ tag, limit }) =>
      withStore((store) => {
        const items = store.pendingCommands(tag ?? null, limit);
        return reply({ count: items.length, highlights: items.map(pendingView) });
      }),
  );

  server.registerTool(
    "kindle_get_command_context",
    {
      title: "Context for one highlight's @commands",
      description:
        "Everything needed to act on one highlight: the highlight and its note (as typed), the commands still to do " +
        "with their actions, the neighbouring highlights in the same book, other highlights in the book with the " +
        "same tag, related highlights from other books, and (with a vault) related notes from the user's vault with " +
        "paste-ready [[links]] and the link to the highlight itself.",
      inputSchema: { highlight_id: z.string().min(1).describe("The 'id' field of a highlight") },
      annotations: READ,
    },
    async ({ highlight_id }) =>
      withStoreAsync(async (store) => {
        const h = store.getHighlight(highlight_id);
        if (!h) return fail(`No highlight with id '${highlight_id}'.`);
        const states = h.commands_done_at ? { remaining: [], done: [] } : store.commandStates(h);
        const tags = [...new Set(h.commands.map((c) => c.tag))];
        const sameTag: Record<string, Json[]> = {};
        for (const t of tags) sameTag[t] = store.sameTagInBook(h.book_id, t, h.id).map((x) => slim(x));
        const related = store.related(`${h.text} ${h.note}`, h.id, h.book_id, 5);
        const highlight: Json = {
          ...slim({ ...h, commands: states.remaining }, true),
          ...(h.commands.length && h.raw_note.trim() !== h.note.trim() ? { note_as_typed: h.raw_note } : {}),
          ...(states.done.length ? { already_done: states.done.map(({ tag, arg, path }) => ({ tag, arg, ...(path ? { path } : {}) })) } : {}),
          book_id: h.book_id,
          location_end: h.location_end,
          color: h.color,
          source: h.source,
          commands_done_at: h.commands_done_at,
        };
        const payload: Json = {
          highlight,
          pending: states.remaining.length > 0,
          neighbours: store.neighbours(h.book_id, h.location_start, h.id, 3).map((x) => slim(x)),
          same_tag_in_book: sameTag,
          related: related.map((x) => slim(x)),
        };
        if (cfg.obsidianVault) {
          const { openVault } = await import("./vault/run.js");
          const { bookNotePath } = await import("./obsidian.js");
          const { sourceLink } = await import("./vault/file.js");
          try {
            const open = openVault(cfg, store, Date.now() + 5000, false);
            try {
              const book = store.findBook(h.book_id);
              const path = book && bookNotePath(store, { vault: open.ctx.vault, index: open.index }, book);
              if (path) payload.source_link = sourceLink(open.ctx, h, path);
              payload.related_notes = open.index
                .related(`${h.text} ${h.note}`, 5)
                .map((n) => ({ title: n.title, link: `[[${open.ctx.linker.linkText(n.path)}]]`, snippet: n.snippet }));
            } finally {
              open.close();
            }
          } catch {
            // no usable vault: the store's context still helps
          }
        }
        return reply(payload);
      }),
  );

  server.registerTool(
    "kindle_complete_command",
    {
      title: "Save a finished @command",
      description:
        "Save the result of one @command into the Obsidian vault and mark it done. For @post and @research pass a " +
        "short `title` and your text as markdown `content`: it becomes its own note in Posts/ or Research/ with the " +
        "quote, a link to the highlight, links to the user's notes, and `related_notes` (titles from " +
        "kindle_get_command_context or kindle_search_vault) as a Related line. For @todo, @quote, @project and " +
        "unknown tags it files the entry the way the sync does. The highlight is done once all its commands are. " +
        "Never write vault files any other way. Without a vault this fails: reply with the result and call " +
        "kindle_mark_command_done instead.",
      inputSchema: {
        highlight_id: z.string().min(1).describe("The 'id' field of the highlight"),
        tag: z.string().min(1).describe("The command, e.g. 'post', 'research' or 'todo' (aliases like 'p' work)"),
        title: z.string().max(120).optional().describe("Note title for @post and @research, e.g. 'Why loss aversion persists'"),
        content: z.string().max(60_000).optional().describe("Markdown for @post and @research: the draft or the research write-up"),
        related_notes: z.array(z.string().max(200)).max(8).optional().describe("Titles of related vault notes to link at the end"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ highlight_id, tag, title, content, related_notes }) =>
      withStoreAsync(async (store) => {
        if (!cfg.obsidianVault) return fail(`${NO_VAULT} For now, put the result in your reply and call kindle_mark_command_done.`);
        const h = store.getHighlight(highlight_id);
        if (!h) return fail(`No highlight with id '${highlight_id}'.`);
        const want = resolveTag(tag.trim().replace(/^@+/, ""));
        if (!h.commands.some((c) => c.tag === want)) {
          return fail(`Highlight ${h.id} has no @${want}. Its commands: ${h.commands.map((c) => `@${c.tag}`).join(", ") || "none"}.`);
        }
        const states = store.commandStates(h);
        const cmd = h.commands_done_at ? undefined : states.remaining.find((c) => c.tag === want);
        if (!cmd) {
          const done = states.done.find((d) => d.tag === want);
          return reply({ ok: true, already_done: true, ...(done?.path ? { path: done.path } : {}) });
        }
        const agent = commandSpec(want)?.doneBy === "agent";
        if (agent && !content?.trim()) return fail(`@${want} needs your text in \`content\` (markdown) and a short \`title\`.`);

        const { openVault, vaultErrorMessage, withVaultLease } = await import("./vault/run.js");
        const { exportBook } = await import("./obsidian.js");
        const { fileCommand, writeAgentNote } = await import("./vault/file.js");
        let open;
        try {
          open = openVault(cfg, store, Date.now() + 30_000);
        } catch (e) {
          return fail(vaultErrorMessage(e));
        }
        try {
          if (!open.complete) return fail("The vault is still being indexed. Try again in a moment.");
          const ctx = open.ctx;
          const index = open.index;
          const out = withVaultLease(store, (): Json => {
            exportBook(store, h.book_id, { vault: ctx.vault, index, linker: cfg.linkNotes ? ctx.linker : null });
            if (agent) return { ...writeAgentNote(ctx, h, cmd, { title, content: content!, related: related_notes }) };
            const f = fileCommand(ctx, h, cmd);
            return { path: f.to, outcome: f.outcome, ...(f.reason ? { reason: f.reason } : {}) };
          });
          if (out === "busy") return fail("Another kindle-mcp process is writing to the vault. Try again in a minute.");
          const after = store.getHighlight(h.id)!;
          const left = after.commands_done_at ? [] : store.commandStates(after).remaining.map(({ tag: t, arg }) => ({ tag: t, arg }));
          return reply({ ok: true, ...out, highlight_done: Boolean(after.commands_done_at), remaining: left });
        } catch (e) {
          return fail(vaultErrorMessage(e));
        } finally {
          open.close();
        }
      }),
  );

  server.registerTool(
    "kindle_mark_command_done",
    {
      title: "Mark @commands done",
      description:
        "Mark a highlight's @commands done without saving anything to the vault: for when you handled them another " +
        "way (no vault, or the user's own task tool). With `tag`, only that command. Editing the note on the Kindle " +
        "re-opens what changed.",
      inputSchema: {
        highlight_id: z.string().min(1).describe("The 'id' field of the highlight that was routed"),
        tag: z.string().optional().describe("Only this command, e.g. 'todo'"),
      },
      annotations: WRITE,
    },
    async ({ highlight_id, tag }) =>
      withStore((store) =>
        store.markCommandsDone(highlight_id, tag ?? null) ? reply({ ok: true, id: highlight_id }) : fail(`No highlight with id '${highlight_id}'.`),
      ),
  );

  server.registerTool(
    "kindle_search_vault",
    {
      title: "Search the Obsidian vault",
      description:
        "Full-text search over the user's Obsidian vault notes (titles, aliases and text), best first, each with a " +
        "paste-ready [[link]]. Use it to find related notes to link from a draft or research note. The Kindle folder " +
        "is left out unless include_kindle is true; excluded folders and notes marked `kindle-link: false` never appear.",
      inputSchema: {
        query: z.string().min(2).describe("Words to find, e.g. 'loss aversion pricing'"),
        limit: z.number().int().min(1).max(20).default(8),
        include_kindle: z.boolean().default(false).describe("Also search the Kindle folder (book notes, drafts, research)"),
      },
      annotations: READ,
    },
    async ({ query, limit, include_kindle }) =>
      withStoreAsync(async (store) => {
        if (!cfg.obsidianVault) return fail(NO_VAULT);
        const { openVault, vaultErrorMessage } = await import("./vault/run.js");
        let open;
        try {
          open = openVault(cfg, store, Date.now() + 10_000, false);
        } catch (e) {
          return fail(vaultErrorMessage(e));
        }
        try {
          const hits = open.index.search(query, limit, include_kindle);
          const linker = open.ctx.linker;
          return reply({
            query,
            count: hits.length,
            ...(open.complete ? {} : { index_complete: false }),
            notes: hits.map((n) => ({ title: n.title, path: n.path, link: `[[${linker.linkText(n.path)}]]`, snippet: n.snippet })),
          });
        } finally {
          open.close();
        }
      }),
  );

  server.registerTool(
    "kindle_link_existing_highlights",
    {
      title: "Link highlights exported earlier",
      description:
        "Add links to the user's notes inside highlights exported to Obsidian before, move their block ids to where " +
        "Obsidian expects them, and fix old wording. Without `apply` it only previews. Call with apply: true only after " +
        "the user said yes in this conversation. remember: 'always' also does this on every sync from now on; " +
        "'never' stops kindle_sync from asking. Only blocks still exactly as kindle-mcp wrote them change; the user's " +
        "own edits and links are kept.",
      inputSchema: {
        book: z.string().optional().describe("Only this book (id, ASIN or title fragment)"),
        apply: z.boolean().default(false).describe("Write the changes (only after the user agreed)"),
        remember: z.enum(["always", "never"]).optional().describe("The user's standing answer"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ book, apply, remember }) =>
      withStoreAsync(async (store) => {
        if (!cfg.obsidianVault) return fail(NO_VAULT);
        if (book && !store.findBook(book)) return fail(`No book matches '${book}'. Call kindle_list_books to see titles.`);
        const { openVault, setLinkExistingPreference, vaultErrorMessage, withVaultLease } = await import("./vault/run.js");
        const { applyBackfill, planBackfill } = await import("./vault/backfill.js");
        let open;
        try {
          open = openVault(cfg, store, Date.now() + 30_000);
        } catch (e) {
          return fail(vaultErrorMessage(e));
        }
        try {
          if (!open.complete) return fail("The vault is still being indexed. Try again in a moment.");
          const ctx = open.ctx;
          const out = withVaultLease(store, (): Json => {
            if (remember) setLinkExistingPreference(store, ctx.vault, remember);
            if (apply) return { applied: applyBackfill(ctx, book ?? null) };
            const { blocks, links, samples } = planBackfill(ctx, book ?? null);
            return { preview: { blocks, links, samples } };
          });
          if (out === "busy") return fail("Another kindle-mcp process is writing to the vault. Try again in a minute.");
          return reply({ ...out, ...(remember ? { remember } : {}) });
        } catch (e) {
          return fail(vaultErrorMessage(e));
        } finally {
          open.close();
        }
      }),
  );

  server.registerTool(
    "kindle_export_to_obsidian",
    {
      title: "Update the Obsidian vault",
      description:
        "Update the Obsidian vault from the local store without contacting Amazon: append new highlights to their " +
        "book notes (with links to the user's notes), and file @todo, @quote and @project. kindle_sync does this too. " +
        "Append-only: text the user wrote is never overwritten. With `book`, also recreates that book's note if it was deleted.",
      inputSchema: { book: z.string().optional().describe("Book id, ASIN or title fragment: recreate this book's note if it was deleted") },
      annotations: WRITE,
    },
    async ({ book }) =>
      withStoreAsync(async (store) => {
        if (!cfg.obsidianVault) return fail(NO_VAULT);
        if (book && !store.findBook(book)) return fail(`No book matches '${book}'. Call kindle_list_books to see titles.`);
        const { runVaultStep } = await import("./vault/run.js");
        const r = runVaultStep(cfg, store, { restoreBook: book ?? null, deadline: Date.now() + cfg.syncBudgetMs, offerLinkExisting: true });
        return r.error ? fail(r.error) : reply({ obsidian: r });
      }),
  );

  server.registerTool(
    "kindle_sync",
    {
      title: "Sync from Amazon",
      description:
        "Pull the latest highlights from Amazon's Kindle notebook (seconds per book; reads don't need it). With an " +
        "Obsidian vault set, it then appends new highlights to their book notes with links to the user's notes and " +
        "files @todo, @quote and @project. The result's `pending` lists the @commands left for you with an " +
        "`instruction`: follow it (it says whether to do them now or offer). `partial: true` means call kindle_sync " +
        "again for the rest. If `link_existing` is present, ask the user its question. If Amazon needs the user to " +
        "sign in, the result says so (`needs_human`) and still carries `pending`: follow its `next`.",
      inputSchema: {
        full: z.boolean().default(false).describe("Re-read every book instead of only books annotated since last sync"),
        book: z.string().optional().describe("Limit the sync to one title fragment or ASIN"),
        browser: z.boolean().default(false).describe("Use a real browser instead of the saved cookies"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ full, book, browser }, extra) =>
      withStoreAsync(async (store) => {
        const { AuthRequired } = await import("./notebook/client.js");
        const { syncCloud } = await import("./sync.js");
        const deadline = Date.now() + cfg.syncBudgetMs;
        let stats;
        let signIn: string | null = null;
        try {
          stats = await syncCloud(cfg, store, { full, only: book ?? null, browser, log: () => {}, deadline, signal: extra.signal });
        } catch (e) {
          if (!(e instanceof AuthRequired)) return fail(`Sync failed: ${(e as Error).message}`);
          signIn = e.message; // the vault step and the queue need no Amazon, so they still run
        }
        const payload: Json = { ...stats };
        if (stats?.partial) {
          const left = stats.books_remaining ? ` the remaining ${stats.books_remaining} book(s)` : " the rest";
          payload.next = `Out of time for this call: call kindle_sync again to fetch${left}.`;
        }
        let vaultReady = false;
        if (cfg.obsidianVault) {
          const { runVaultStep } = await import("./vault/run.js");
          const { link_existing, ...obsidian } = runVaultStep(cfg, store, { deadline: deadline + VAULT_GRACE_MS, offerLinkExisting: true });
          payload.obsidian = obsidian;
          vaultReady = !obsidian.error;
          if (link_existing) payload.link_existing = link_existing;
        }
        payload.pending = pendingSummary(cfg, store, vaultReady);
        if (signIn) return fail(signIn, { needs_human: true, next: SIGN_IN_NEXT, ...payload });
        return reply(payload);
      }),
  );

  server.registerTool(
    "kindle_status",
    {
      title: "Store status",
      description:
        "Store counts, truncated-highlight count, pending @commands by tag, the last sync run, whether an Amazon " +
        "session is saved and when, the data folder and version, the Obsidian vault and settings in effect, and a " +
        "`next_step` suggestion.",
      annotations: READ,
    },
    async () =>
      withStoreAsync(async (store) => {
        const s = store.status();
        const saved = loadSession(cfg.sessionPath);
        const session = saved !== null;
        let linkExisting: string | undefined;
        if (cfg.obsidianVault) {
          try {
            const { Vault } = await import("./vault/write.js");
            const { linkExistingPreference } = await import("./vault/run.js");
            linkExisting = linkExistingPreference(store, Vault.open(cfg.obsidianVault, cfg.obsidianFolder)) ?? "not answered yet";
          } catch {
            linkExisting = "vault folder not found";
          }
        }
        const next = !session
          ? "The user isn't signed in to Amazon yet: offer kindle_login (it opens a sign-in window; not in a scheduled run), then kindle_sync."
          : !s.highlights
            ? "Call kindle_sync to pull the user's highlights."
            : s.pending_commands
              ? cfg.actOnCommands
                ? "Call kindle_get_pending_commands and do them, saving each with kindle_complete_command."
                : `Tell the user ${s.pending_commands} highlight(s) have @commands waiting, and offer to do them.`
              : "Nothing waiting. kindle_sync fetches anything new.";
        return reply({
          ...s,
          session_saved: session,
          ...(saved ? { session_saved_at: saved.savedAt, ...(saved.signedInAt ? { signed_in_at: saved.signedInAt } : {}) } : {}),
          login_in_progress: loginInProgress,
          data_folder: cfg.home,
          version: SERVER_VERSION,
          obsidian_vault: cfg.obsidianVault,
          obsidian_folder: cfg.obsidianFolder,
          ...(linkExisting ? { link_existing: linkExisting } : {}),
          settings: {
            act_on_commands: cfg.actOnCommands,
            auto_file: cfg.autoFile,
            link_notes: cfg.linkNotes,
            link_exclude: cfg.linkExclude,
          },
          next_step: next,
        });
      }),
  );

  server.registerTool(
    "kindle_login",
    {
      title: "Sign in to Amazon",
      description:
        "Open a browser window on this machine for the user to sign in to Amazon (2FA included). Returns as soon " +
        "as the window is open; the session is saved when the Kindle notebook loads, up to 10 minutes later. " +
        "kindle_status shows session_saved once it is done. Needed once, and again when kindle_sync reports needs_human.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      if (loginInProgress) return reply({ ok: true, message: "A sign-in window is already open. Finish signing in there." });
      const { startLogin } = await import("./notebook/login.js");
      try {
        ensureDirs(cfg);
        const handle = await startLogin(cfg);
        loginInProgress = true;
        void handle.done.finally(() => {
          loginInProgress = false;
        });
        return reply({
          ok: true,
          message:
            "A browser window opened on this machine. Sign in to Amazon there and tick \"Keep me signed in\" (it lets " +
            "later syncs renew the sign-in without you); the session is saved and the window closes when your Kindle " +
            "notebook loads. Then call kindle_status (session_saved: true) and kindle_sync.",
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  registerPrompts(server);

  return server;
}

export async function serveStdio(cfg: Config): Promise<void> {
  const server = createServer(cfg);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => {
    process.stdin.on("close", resolve);
    process.stdin.on("end", resolve);
  });
}
