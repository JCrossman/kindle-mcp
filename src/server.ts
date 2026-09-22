/**
 * MCP interface over the local store. Reads are instant (SQLite); only kindle_sync touches Amazon.
 * createServer() is transport-free; serveStdio() wires it to stdio.
 */
import { existsSync, readFileSync } from "node:fs";
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

import { COMMANDS, commandsTable, type CommandWithAction } from "./commands.js";
import { ensureDirs, type Config } from "./config.js";
import { Store, type HighlightRow } from "./store.js";

export const CHAR_LIMIT = 25_000;
/** The package version, so the server reports what npm installed. */
export const SERVER_VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

type Json = Record<string, unknown>;

const tagList = COMMANDS.map((c) => `@${c.tag}${c.arg === "none" ? "" : c.arg === "word" ? " <name>" : " <text>"}`).join(", ");

export function serverInstructions(): string {
  return (
    "The user's Kindle highlights and notes, synced to a local store. Use kindle_search_highlights to bring " +
    "their own reading into a conversation, kindle_get_new_since to see what they have been reading lately, " +
    `and kindle_get_pending_commands to act on @commands they typed as notes on the Kindle (${tagList}). ` +
    "Each pending command carries an `action` field saying what to do with it; the kindle_route_pending prompt " +
    "walks the whole queue. Always cite book title and location when quoting a highlight."
  );
}

/** Drop empty fields and, unless asked, the verbose action text, to keep responses small. */
function slim(h: HighlightRow, withActions = false): Json {
  const keep = ["id", "title", "author", "text", "note", "location_start", "page", "truncated", "commands", "first_seen"] as const;
  const out: Json = {};
  for (const k of keep) {
    const v = h[k];
    if (v === null || v === undefined || v === "" || v === false || (Array.isArray(v) && !v.length)) continue;
    out[k] = k === "commands" && !withActions ? (v as CommandWithAction[]).map(({ tag, arg }) => ({ tag, arg })) : v;
  }
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

function loadPrompt(name: string, vars: Record<string, string>): string {
  let text = readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}

export function routePendingPrompt(tag?: string, dryRun = false): string {
  const t = tag?.trim().replace(/^@+/, "");
  return loadPrompt("route-pending", {
    commands_table: commandsTable(),
    tag_clause: t ? ` and \`tag\` = \`${t}\`` : "",
    dry_run_clause: dryRun
      ? "\n**DRY RUN.** List what you would do for each pending highlight. Write nothing anywhere and do not call `kindle_mark_command_done`.\n"
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
      "Walk every pending @command, do what each one asks, and mark it done. Runner-agnostic: works interactively or from a scheduled task.",
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
      description: "All highlights and notes for one book, in reading order.",
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
      description: "Full-text search across every highlight and note, best matches first.",
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
      description: "Highlights first seen by the sync since a point in time. The basis for digests and resurfacing.",
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
        "Highlights whose Kindle note contains an @command that has not been actioned yet. Each command carries " +
        `its 'action' contract. Supported tags: ${tagList}. Unknown tags are kept and routed to Unrouted. ` +
        "After routing one highlight, call kindle_mark_command_done with its id so it is not routed twice.",
      inputSchema: {
        tag: z.string().optional().describe("Filter to one tag, e.g. 'post', 'research', 'project', 'todo'"),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: READ,
    },
    async ({ tag, limit }) =>
      withStore((store) => {
        const items = store.pendingCommands(tag ?? null, limit);
        return reply({ count: items.length, highlights: items.map((h) => slim(h, true)) });
      }),
  );

  server.registerTool(
    "kindle_get_command_context",
    {
      title: "Context for routing one highlight",
      description:
        "Everything a router needs to act on one highlight: the highlight and its note, its pending commands with " +
        "their action contracts, the neighbouring highlights in the same book, other highlights in the book with the " +
        "same tag, and related highlights from other books.",
      inputSchema: { highlight_id: z.string().min(1).describe("The 'id' field of a highlight") },
      annotations: READ,
    },
    async ({ highlight_id }) =>
      withStore((store) => {
        const h = store.getHighlight(highlight_id);
        if (!h) return fail(`No highlight with id '${highlight_id}'.`);
        const tags = [...new Set(h.commands.map((c) => c.tag))];
        const sameTag: Record<string, Json[]> = {};
        for (const t of tags) sameTag[t] = store.sameTagInBook(h.book_id, t, h.id).map((x) => slim(x));
        const related = store.related(`${h.text} ${h.note}`, h.id, h.book_id, 5);
        return reply({
          highlight: { ...slim(h, true), book_id: h.book_id, location_end: h.location_end, color: h.color, source: h.source, commands_done_at: h.commands_done_at },
          pending: h.commands.length > 0 && !h.commands_done_at,
          neighbours: store.neighbours(h.book_id, h.location_start, h.id, 3).map((x) => slim(x)),
          same_tag_in_book: sameTag,
          related: related.map((x) => slim(x)),
        });
      }),
  );

  server.registerTool(
    "kindle_mark_command_done",
    {
      title: "Mark @commands done",
      description: "Mark a highlight's @commands as actioned. Editing the note on the Kindle re-opens it.",
      inputSchema: { highlight_id: z.string().min(1).describe("The 'id' field of the highlight that was routed") },
      annotations: WRITE,
    },
    async ({ highlight_id }) =>
      withStore((store) => (store.markCommandsDone(highlight_id) ? reply({ ok: true, id: highlight_id }) : fail(`No highlight with id '${highlight_id}'.`))),
  );

  server.registerTool(
    "kindle_export_to_obsidian",
    {
      title: "Export to Obsidian",
      description: "Write highlights into the Obsidian vault, one note per book. Append-only: existing edits are never overwritten.",
      inputSchema: { book: z.string().optional().describe("Book id, ASIN or title fragment. Omit to export every book.") },
      annotations: WRITE,
    },
    async ({ book }) =>
      withStoreAsync(async (store) => {
        const { exportAll, exportBook } = await import("./obsidian.js");
        if (!cfg.obsidianVault) return fail("OBSIDIAN_VAULT is not set in this server's environment.");
        try {
          const results = book ? [exportBook(store, book, cfg.obsidianVault, cfg.obsidianFolder)] : exportAll(store, cfg.obsidianVault, cfg.obsidianFolder);
          return reply({ books: results.length, highlights_added: results.reduce((n, r) => n + r.added, 0), files: results.filter((r) => r.added).map((r) => r.file) });
        } catch (e) {
          return fail((e as Error).message);
        }
      }),
  );

  server.registerTool(
    "kindle_sync",
    {
      title: "Sync from Amazon",
      description: "Pull the latest highlights from Amazon's Kindle notebook. Slow (seconds per book); reads do not need it.",
      inputSchema: {
        full: z.boolean().default(false).describe("Re-read every book instead of only books annotated since last sync"),
        book: z.string().optional().describe("Limit the sync to one title fragment or ASIN"),
        browser: z.boolean().default(false).describe("Use a real browser instead of the saved cookies"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ full, book, browser }) =>
      withStoreAsync(async (store) => {
        const { AuthRequired } = await import("./notebook/client.js");
        const { syncCloud } = await import("./sync.js");
        try {
          return reply({ ...(await syncCloud(cfg, store, { full, only: book ?? null, browser, log: () => {} })) });
        } catch (e) {
          if (e instanceof AuthRequired) return fail(e.message, { needs_human: true });
          return fail(`Sync failed: ${(e as Error).message}`);
        }
      }),
  );

  server.registerTool(
    "kindle_status",
    {
      title: "Store status",
      description:
        "Store counts, truncated-highlight count, pending @commands by tag, the last sync run, whether an Amazon " +
        "session is saved, and where the Obsidian vault is (if configured).",
      annotations: READ,
    },
    async () =>
      withStore((store) =>
        reply({
          ...store.status(),
          session_saved: existsSync(cfg.sessionPath),
          login_in_progress: loginInProgress,
          obsidian_vault: cfg.obsidianVault,
          obsidian_folder: cfg.obsidianFolder,
        }),
      ),
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
            "A browser window opened on this machine. Sign in to Amazon there; the session is saved automatically when " +
            "your Kindle notebook loads. Then call kindle_status (session_saved: true) and kindle_sync.",
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
