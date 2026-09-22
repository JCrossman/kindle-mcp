import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { COMMANDS } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { parseAnnotations, parseLibrary } from "../src/notebook/parser.js";
import { createServer, parseSince, routePendingPrompt, serverInstructions, weeklyBriefPrompt } from "../src/server.js";
import { Store } from "../src/store.js";

const FX = join(__dirname, "fixtures");

async function connected(): Promise<{ client: Client; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "kindle-mcp-"));
  const cfg = loadConfig({ KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: join(home, "vault") });
  const store = new Store(cfg.dbPath);
  const [books] = parseLibrary(readFileSync(join(FX, "library.html"), "utf8"));
  const bookId = store.upsertBook(books[0]);
  for (const h of parseAnnotations(readFileSync(join(FX, "annotations.html"), "utf8"), bookId)[0]) store.upsertHighlight(bookId, h);
  store.close();

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(cfg).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return { client, home };
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { ...res, data: res.structuredContent as Record<string, any> };
};

describe("MCP server", () => {
  it("lists the tools and prompts and answers over the protocol", async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(
      expect.arrayContaining([
        "kindle_list_books", "kindle_get_highlights", "kindle_search_highlights", "kindle_get_new_since",
        "kindle_get_pending_commands", "kindle_get_command_context", "kindle_mark_command_done",
        "kindle_export_to_obsidian", "kindle_sync", "kindle_status",
      ]),
    );
    expect(tools).toHaveLength(10);
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(["kindle_route_pending", "kindle_weekly_brief"]);

    expect((await call(client, "kindle_search_highlights", { query: "blindness" })).data.count).toBe(1);
    expect((await call(client, "kindle_get_new_since", { since: "1d" })).data.count).toBe(3);
    const bad = await call(client, "kindle_get_new_since", { since: "whenever" });
    expect(bad.isError).toBe(true);
    expect(bad.data.error).toMatch(/Could not read/);
    expect((await call(client, "kindle_get_highlights", { book: "no such book" })).isError).toBe(true);
    expect((await call(client, "kindle_list_books", {})).data.books[0].title).toBe("Thinking, Fast and Slow");

    const status = (await call(client, "kindle_status")).data;
    expect(status.pending_commands).toBe(1);
    expect(status.pending_by_tag).toEqual({ post: 1, project: 1 });
    expect(status.obsidian_vault).toMatch(/vault$/);
    expect(status.obsidian_folder).toBe("Kindle");
  });

  it("walks the command queue: pending -> context -> done", async () => {
    const { client } = await connected();
    const pending = (await call(client, "kindle_get_pending_commands", { tag: "@post" })).data;
    expect(pending.count).toBe(1);
    const item = pending.highlights[0];
    expect(item.commands.map((c: any) => c.tag)).toEqual(["post", "project"]);
    expect(item.commands[0].action).toContain("Draft a post angle");
    expect(item.commands[1].known).toBe(true);

    const ctx = (await call(client, "kindle_get_command_context", { highlight_id: item.id })).data;
    expect(ctx.highlight.id).toBe(item.id);
    expect(ctx.pending).toBe(true);
    expect(ctx.neighbours.map((h: any) => h.location_start)).toEqual([2001, 3050]);
    expect(ctx.same_tag_in_book).toEqual({ post: [], project: [] });
    expect((await call(client, "kindle_get_command_context", { highlight_id: "nope" })).isError).toBe(true);

    expect((await call(client, "kindle_mark_command_done", { highlight_id: item.id })).data.ok).toBe(true);
    expect((await call(client, "kindle_get_pending_commands")).data.count).toBe(0);
    expect((await call(client, "kindle_mark_command_done", { highlight_id: "nope" })).isError).toBe(true);
  });

  it("exports to the configured vault", async () => {
    const { client, home } = await connected();
    const res = (await call(client, "kindle_export_to_obsidian", {})).data;
    expect(res.books).toBe(1);
    expect(res.highlights_added).toBe(3);
    expect(res.files[0].startsWith(join(home, "vault"))).toBe(true);
  });

  it("renders the prompts with every command and the arguments", async () => {
    const { client } = await connected();
    const prompt = await client.getPrompt({ name: "kindle_route_pending", arguments: { tag: "post", dry_run: "true" } });
    const text = (prompt.messages[0].content as { text: string }).text;
    for (const c of COMMANDS) expect(text).toContain(`\`@${c.tag}\``);
    expect(text).toContain("`tag` = `post`");
    expect(text).toContain("DRY RUN");
    expect(routePendingPrompt()).not.toContain("DRY RUN");
    for (const c of COMMANDS) expect(serverInstructions()).toContain(`@${c.tag}`);

    const brief = await client.getPrompt({ name: "kindle_weekly_brief", arguments: { since: "14d" } });
    expect((brief.messages[0].content as { text: string }).text).toContain("`14d`");
    expect(weeklyBriefPrompt()).toContain("`7d`");
  });

  it("parses since spans and dates", () => {
    expect(parseSince("2026-09-01")).toBe("2026-09-01T00:00:00Z");
    expect(parseSince("2026-09-01T10:00:00+02:00")).toBe("2026-09-01T08:00:00Z");
    expect(parseSince("7d") < parseSince("1h")).toBe(true);
    expect(() => parseSince("whenever")).toThrow(/Could not read/);
  });
});
