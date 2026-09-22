import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { COMMANDS } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { parseAnnotations, parseLibrary } from "../src/notebook/parser.js";
import { createServer, parseSince, routePendingPrompt, serverInstructions, weeklyBriefPrompt } from "../src/server.js";
import { saveSession } from "../src/notebook/session.js";
import { makeHighlight } from "../src/models.js";
import { Store } from "../src/store.js";
import { startFakeAmazon, type FakeAmazon } from "./helpers/fake-amazon.js";

const FX = join(__dirname, "fixtures");

export const TOOLS = [
  "kindle_list_books", "kindle_get_highlights", "kindle_search_highlights", "kindle_get_new_since",
  "kindle_get_pending_commands", "kindle_get_command_context", "kindle_complete_command", "kindle_mark_command_done",
  "kindle_search_vault", "kindle_link_existing_highlights", "kindle_export_to_obsidian", "kindle_sync",
  "kindle_status", "kindle_login",
];

let amazon: FakeAmazon;
beforeAll(async () => {
  amazon = await startFakeAmazon();
});
afterAll(() => amazon.close());

async function connected(env: Record<string, string> = {}, vault = true, reuse?: string): Promise<{ client: Client; home: string }> {
  const home = reuse ?? mkdtempSync(join(tmpdir(), "kindle-mcp-"));
  if (!reuse) mkdirSync(join(home, "vault"));
  const cfg = loadConfig({
    KINDLE_MCP_HOME: home,
    ...(vault ? { OBSIDIAN_VAULT: join(home, "vault") } : {}),
    KINDLE_NOTEBOOK_BASE: amazon.base,
    KINDLE_REQUEST_DELAY: "0",
    ...env,
  });
  const store = new Store(cfg.dbPath);
  if (reuse) {
    store.close();
    return link(cfg, home);
  }
  const [books] = parseLibrary(readFileSync(join(FX, "library.html"), "utf8"));
  const bookId = store.upsertBook(books[0]);
  for (const h of parseAnnotations(readFileSync(join(FX, "annotations.html"), "utf8"), bookId)[0]) store.upsertHighlight(bookId, h);
  store.close();
  return link(cfg, home);
}

async function link(cfg: ReturnType<typeof loadConfig>, home: string): Promise<{ client: Client; home: string }> {
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
    expect(tools.sort()).toEqual(TOOLS.slice().sort());
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
    expect(status.session_saved).toBe(false);
    expect(status.login_in_progress).toBe(false);
    expect(status.settings).toEqual({ act_on_commands: true, auto_file: true, link_notes: true, link_exclude: [] });
    expect(status.link_existing).toBe("not answered yet");
    expect(status.next_step).toMatch(/kindle_login/);
  });

  it("walks the command queue: pending -> context -> done", async () => {
    const { client } = await connected();
    const pending = (await call(client, "kindle_get_pending_commands", { tag: "@post" })).data;
    expect(pending.count).toBe(1);
    const item = pending.highlights[0];
    expect(item.commands.map((c: any) => c.tag)).toEqual(["post", "project"]);
    expect(item.commands[0].action).toContain("Draft a post angle");
    expect(item.commands[1].known).toBe(true);
    expect(item.note).toBe("focusing illusion applies to AI hype");
    expect(item.note_as_typed).toBe("@post focusing illusion applies to AI hype @project netcare");

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
    const res = (await call(client, "kindle_export_to_obsidian", {})).data.obsidian;
    expect(res).toMatchObject({ books_written: 1, highlights_written: 3 });
    expect(res.filed).toEqual([{ tag: "project", to: "Kindle/Projects/netcare.md", count: 1 }]);
    expect(readFileSync(join(home, "vault", "Kindle", "Thinking, Fast and Slow.md"), "utf8")).toContain("^kh-");
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

    // Clients may omit the arguments object entirely when every argument is optional.
    const bare = await client.getPrompt({ name: "kindle_route_pending" });
    expect((bare.messages[0].content as { text: string }).text).toBe(routePendingPrompt());
    const empty = await client.getPrompt({ name: "kindle_route_pending", arguments: {} });
    expect((empty.messages[0].content as { text: string }).text).toBe(routePendingPrompt());
    await expect(client.getPrompt({ name: "nope" })).rejects.toThrow(/not found/);
    const listed = (await client.listPrompts()).prompts.find((p) => p.name === "kindle_route_pending")!;
    expect(listed.arguments?.map((a) => a.name)).toEqual(["tag", "dry_run"]);
    expect(listed.arguments?.every((a) => a.required === false)).toBe(true);

    const brief = await client.getPrompt({ name: "kindle_weekly_brief", arguments: { since: "14d" } });
    expect((brief.messages[0].content as { text: string }).text).toContain("`14d`");
    expect(weeklyBriefPrompt()).toContain("`7d`");
  });

  it("saves a finished @post as a note through kindle_complete_command", async () => {
    const { client, home } = await connected();
    writeFileSync(join(home, "vault", "Focusing Illusion.md"), "A note about it.");
    expect((await call(client, "kindle_export_to_obsidian")).data.obsidian.filed).toEqual([{ tag: "project", to: "Kindle/Projects/netcare.md", count: 1 }]);
    const item = (await call(client, "kindle_get_pending_commands")).data.highlights[0];
    expect(item.commands.map((c: any) => c.tag)).toEqual(["post"]);
    expect(item.already_done).toEqual([{ tag: "project", arg: "netcare", path: "Kindle/Projects/netcare.md" }]);

    const ctx = (await call(client, "kindle_get_command_context", { highlight_id: item.id })).data;
    expect(ctx.source_link).toBe(`[[Thinking, Fast and Slow#^kh-${item.id}|Thinking, Fast and Slow, Location 1234]]`);
    expect(ctx.related_notes.map((n: any) => n.link)).toEqual(["[[Focusing Illusion]]"]);

    expect((await call(client, "kindle_complete_command", { highlight_id: item.id, tag: "post" })).isError).toBe(true); // needs content
    expect((await call(client, "kindle_complete_command", { highlight_id: item.id, tag: "quote" })).data.error).toMatch(/has no @quote/);
    const done = (await call(client, "kindle_complete_command", {
      highlight_id: item.id, tag: "p", title: "Focusing on AI", content: "The focusing illusion explains the hype.", related_notes: ["Focusing Illusion"],
    })).data;
    expect(done).toMatchObject({ ok: true, path: "Kindle/Posts/Focusing on AI.md", highlight_done: true, remaining: [] });
    const note = readFileSync(join(home, "vault", done.path), "utf8");
    expect(note).toContain("The [[Focusing Illusion|focusing illusion]] explains the hype.");
    expect(note).toContain("Related: [[Focusing Illusion]]");
    expect((await call(client, "kindle_complete_command", { highlight_id: item.id, tag: "post", content: "again" })).data).toMatchObject({ ok: true, already_done: true });
    expect((await call(client, "kindle_get_pending_commands")).data.count).toBe(0);
  });

  it("searches the vault and previews links for highlights exported earlier", async () => {
    const { client, home } = await connected();
    writeFileSync(join(home, "vault", "Blindness.md"), "Notes on being blind to the obvious.");
    const found = (await call(client, "kindle_search_vault", { query: "obvious" })).data;
    expect(found.notes.map((n: any) => [n.title, n.link])).toEqual([["Blindness", "[[Blindness]]"]]);
    const preview = (await call(client, "kindle_link_existing_highlights", {})).data;
    expect(preview.preview).toMatchObject({ blocks: 0, links: 0 });
    expect((await call(client, "kindle_link_existing_highlights", { remember: "never" })).data.remember).toBe("never");
    expect((await call(client, "kindle_status")).data.link_existing).toBe("never");
  });

  it("tells a client without a vault to reply and mark done instead", async () => {
    const { client } = await connected({}, false);
    const item = (await call(client, "kindle_get_pending_commands")).data.highlights[0];
    const res = await call(client, "kindle_complete_command", { highlight_id: item.id, tag: "post", content: "x" });
    expect(res.isError).toBe(true);
    expect(res.data.error).toMatch(/kindle_mark_command_done/);
    expect((await call(client, "kindle_search_vault", { query: "x y" })).isError).toBe(true);
  });

  it("syncs, updates the vault, and hands over what is left with an instruction", async () => {
    const { client, home } = await connected();
    saveSession(join(home, "session.json"), { savedAt: "t", cookies: [{ name: "session-id", value: "abc", domain: "127.0.0.1", path: "/", expires: -1 }] });
    const res = (await call(client, "kindle_sync")).data;
    expect(res.partial).toBeUndefined();
    expect(res.obsidian.filed).toEqual([{ tag: "project", to: "Kindle/Projects/netcare.md", count: 1 }]);
    expect(res.pending).toMatchObject({ count: 1, act_now: true, instruction: expect.stringContaining("Do each one now, without asking first") });
    expect(res.pending.instruction).toContain("kindle_complete_command");
    expect(res.pending.highlights[0].commands).toEqual([{ tag: "post", arg: "" }]);
    expect(Object.keys(res.pending.actions)).toEqual(["post"]);
    expect(existsSync(join(home, "vault", "Kindle", "Thinking, Fast and Slow.md"))).toBe(true);
  });

  it("offers instead of acting when the setting says so, and without a vault lists everything", async () => {
    let { client, home } = await connected({ KINDLE_ACT_ON_COMMANDS: "false" });
    saveSession(join(home, "session.json"), { savedAt: "t", cookies: [{ name: "session-id", value: "abc", domain: "127.0.0.1", path: "/", expires: -1 }] });
    let res = (await call(client, "kindle_sync")).data;
    expect(res.pending.act_now).toBe(false);
    expect(res.pending.instruction).toMatch(/^List these @commands for the user and offer/);

    ({ client, home } = await connected({}, false));
    saveSession(join(home, "session.json"), { savedAt: "t", cookies: [{ name: "session-id", value: "abc", domain: "127.0.0.1", path: "/", expires: -1 }] });
    res = (await call(client, "kindle_sync")).data;
    expect(res.obsidian).toBeUndefined();
    expect(res.pending.highlights[0].commands.map((c: any) => c.tag)).toEqual(["post", "project"]);
    expect(res.pending.instruction).toContain("kindle_mark_command_done");
  });

  it("returns a partial sync when out of time, keeps the result small, and continues on the next call", async () => {
    let { client, home } = await connected({ KINDLE_SYNC_BUDGET_MS: "1" });
    saveSession(join(home, "session.json"), { savedAt: "t", cookies: [{ name: "session-id", value: "abc", domain: "127.0.0.1", path: "/", expires: -1 }] });
    const store = new Store(join(home, "kindle.db"));
    for (let i = 0; i < 60; i++) {
      store.upsertHighlight("B0FAKE0004", makeHighlight({ bookId: "B0FAKE0004", text: "long ".repeat(400), note: "@research why", locationStart: 5000 + i, amazonId: `B0FAKE0004:${i}:HIGHLIGHT:x${i}` }));
    }
    store.close();
    const first = await call(client, "kindle_sync");
    expect(first.data.partial).toBe(true);
    expect(first.data.next).toMatch(/call kindle_sync again/);
    expect(JSON.stringify(first.data).length).toBeLessThan(25_000);
    expect(first.data.pending).toMatchObject({ count: 61, has_more: true });
    expect(first.data.pending.highlights).toHaveLength(10);

    ({ client } = await connected({}, true, home)); // same store, the normal budget
    const second = (await call(client, "kindle_sync")).data;
    expect(second.partial).toBeUndefined();
    expect(second.books_synced).toBeGreaterThan(0);
  });

  it("parses since spans and dates", () => {
    expect(parseSince("2026-09-01")).toBe("2026-09-01T00:00:00Z");
    expect(parseSince("2026-09-01T10:00:00+02:00")).toBe("2026-09-01T08:00:00Z");
    expect(parseSince("7d") < parseSince("1h")).toBe(true);
    expect(() => parseSince("whenever")).toThrow(/Could not read/);
  });
});
