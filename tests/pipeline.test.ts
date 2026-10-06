import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { makeBook, makeHighlight } from "../src/models.js";
import { renderHighlightV1 } from "../src/obsidian.js";
import { Store } from "../src/store.js";
import { applyBackfill, planBackfill } from "../src/vault/backfill.js";
import { writeAgentNote } from "../src/vault/file.js";
import { LEASE, openVault, runVaultStep } from "../src/vault/run.js";

interface World {
  cfg: Config;
  store: Store;
  vault: string;
  ids: Record<string, string>;
  read(rel: string): string;
}

/** A store with one book and highlights carrying every kind of command, and a vault with a few user notes. */
function world(extraNotes: Record<string, string> = {}): World {
  const home = mkdtempSync(join(tmpdir(), "kindle-pipe-"));
  const vault = join(home, "vault");
  const notes: Record<string, string> = {
    "Concepts/Compound Interest.md": "Compound interest.",
    "People/Ada Exampleton.md": "---\naliases: [Exampleton]\n---\nAuthor.",
    "Work/Garden.md": "# Garden\n\n## From Kindle\n\n- older entry\n\n## Log\n\n- did things\n",
    ".obsidian/app.json": "{}",
    ...extraNotes,
  };
  for (const [rel, text] of Object.entries(notes)) {
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), text);
  }
  const cfg = loadConfig({ KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: vault });
  const store = new Store(cfg.dbPath);
  const bookId = store.upsertBook(makeBook({ bookId: "B0FAKE0004", asin: "B0FAKE0004", title: "Placeholder Title, Part One", author: "Ada Exampleton" }));
  const add = (key: string, loc: number, text: string, note: string): void => {
    store.upsertHighlight(bookId, makeHighlight({ bookId, text, note, locationStart: loc, amazonId: `B0FAKE0004:${loc * 150}:HIGHLIGHT:${key}` }));
  };
  add("post", 1234, "Small steps, repeated daily, add up to more than any single leap.", "@post the compound interest idea applies to habits @project garden");
  add("todo", 2001, "A map is useful because it leaves most of the territory out.", "@todo email Sam about Exampleton @quote");
  add("odd", 2500, "A third highlight.", "@later maybe @project");
  const ids: Record<string, string> = {};
  for (const h of store.getHighlights(bookId, 100)) ids[{ 1234: "post", 2001: "todo", 2500: "odd" }[h.location_start!]!] = h.id;
  return { cfg, store, vault, ids, read: (rel) => readFileSync(join(vault, rel), "utf8") };
}

const BOOK = "Kindle/Placeholder Title, Part One.md";

describe("vault step", () => {
  it("writes linked book notes, files what the sync owns, and leaves the agent's work pending", () => {
    const w = world();
    const r = runVaultStep(w.cfg, w.store);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ books_written: 1, highlights_written: 3 });
    expect(r.links_added).toBeGreaterThanOrEqual(2);

    const book = w.read(BOOK);
    expect(book).toContain("title: \"Placeholder Title, Part One\"");
    expect(book).toContain("> **Note:** @post the [[Compound Interest|compound interest]] idea applies to habits @project [[Garden|garden]]");
    expect(book).toContain(`> — Location 1234 · #kindle/post #kindle/project/garden\n\n^kh-${w.ids.post}`);
    expect(book).toContain("[[Ada Exampleton|Exampleton]]"); // alias, in the note of the second highlight

    const todo = w.read("Kindle/Inbox/Todo.md");
    expect(todo).toMatch(new RegExp(`^- \\[ \\] email Sam about Exampleton — .+ — \\[\\[Placeholder Title, Part One#\\^kh-${w.ids.todo}\\|Placeholder Title, Part One, Location 2001\\]\\] \\^kh-${w.ids.todo}-todo-[0-9a-f]{4}$`, "m"));
    const quotes = w.read("Kindle/Inbox/Quotes.md");
    expect(quotes).toContain("> A map is useful");
    expect(quotes).toContain(`, [[Placeholder Title, Part One#^kh-${w.ids.todo}|Placeholder Title, Part One, Location 2001]]\n\n^kh-${w.ids.todo}-quote`);

    // @project garden lands in the user's own note, at the end of its From Kindle section.
    const project = w.read("Work/Garden.md");
    expect(project.indexOf("> Small steps")).toBeGreaterThan(project.indexOf("- older entry"));
    expect(project.indexOf("> Small steps")).toBeLessThan(project.indexOf("## Log"));
    expect(r.filed).toEqual(expect.arrayContaining([{ tag: "project", to: "Work/Garden.md", count: 1 }]));

    const unrouted = w.read("Kindle/Inbox/Unrouted.md");
    expect(unrouted).toContain("`@later` is not a known command");
    expect(unrouted).toContain("`@project` needs a project name");
    expect(r.unrouted.map((u) => u.tag).sort()).toEqual(["later", "project"]);

    const pending = w.store.pendingCommands();
    expect(pending.map((h) => h.remaining!.map((c) => c.tag))).toEqual([["post"]]);
    expect(pending[0].already_done!.map((d) => d.path)).toEqual(["Work/Garden.md"]);
  });

  it("writes nothing on a second run", () => {
    const w = world();
    runVaultStep(w.cfg, w.store);
    const files = [BOOK, "Kindle/Inbox/Todo.md", "Kindle/Inbox/Quotes.md", "Kindle/Inbox/Unrouted.md", "Work/Garden.md"];
    const before = files.map((f) => w.read(f));
    const again = runVaultStep(w.cfg, w.store);
    expect(again).toMatchObject({ highlights_written: 0, filed: [], unrouted: [] });
    expect(files.map((f) => w.read(f))).toEqual(before);
  });

  it("counts entries a 1.0 router already wrote as done", () => {
    const w = world();
    mkdirSync(join(w.vault, "Kindle", "Inbox"), { recursive: true });
    writeFileSync(join(w.vault, "Kindle/Inbox/Todo.md"), `## Placeholder Title, Part One, Location 2001\n- [ ] email Sam\n^kh-${w.ids.todo}\n`);
    const r = runVaultStep(w.cfg, w.store);
    expect(r.found_earlier).toBe(1);
    expect(w.read("Kindle/Inbox/Todo.md").match(/email Sam/g)).toHaveLength(1);
  });

  it("follows a moved book note, leaves a deleted one deleted, and restores it on request", () => {
    const w = world();
    runVaultStep(w.cfg, w.store);
    mkdirSync(join(w.vault, "Books"));
    renameSync(join(w.vault, BOOK), join(w.vault, "Books/Moved.md"));
    w.store.upsertHighlight("B0FAKE0004", makeHighlight({ bookId: "B0FAKE0004", text: "A new one.", locationStart: 4000, amazonId: "B0FAKE0004:600000:HIGHLIGHT:new" }));
    let r = runVaultStep(w.cfg, w.store);
    expect(r.highlights_written).toBe(1);
    expect(existsSync(join(w.vault, BOOK))).toBe(false);
    expect(w.read("Books/Moved.md")).toContain("> A new one.");

    rmSync(join(w.vault, "Books/Moved.md"));
    r = runVaultStep(w.cfg, w.store);
    expect(r.deleted_book_notes).toEqual(["Placeholder Title, Part One"]);
    expect(existsSync(join(w.vault, BOOK))).toBe(false);
    r = runVaultStep(w.cfg, w.store, { restoreBook: "placeholder title" });
    expect(r.highlights_written).toBe(4);
    expect(existsSync(join(w.vault, BOOK))).toBe(true);
  });

  it("writes nothing on a half-read index, while another process holds the vault, or without a vault", () => {
    const w = world();
    expect(runVaultStep(w.cfg, w.store, { deadline: Date.now() - 1 })).toMatchObject({ skipped: "indexing", highlights_written: 0 });
    expect(existsSync(join(w.vault, BOOK))).toBe(false);
    expect(w.store.acquireLease(LEASE, "someone else", 60_000)).toBe(true);
    const t = Date.now();
    expect(runVaultStep(w.cfg, w.store)).toMatchObject({ skipped: "busy" });
    expect(Date.now() - t).toBeGreaterThanOrEqual(4000);
    expect(existsSync(join(w.vault, BOOK))).toBe(false);
    const missing = loadConfig({ KINDLE_MCP_HOME: w.cfg.home, OBSIDIAN_VAULT: join(w.vault, "nope") });
    expect(runVaultStep(missing, w.store).error).toMatch(/does not exist/);
  }, 15_000);

  it("sends an ambiguous project to Unrouted with the candidates", () => {
    const w = world({ "Archive2/Garden.md": "another" });
    const r = runVaultStep(w.cfg, w.store);
    expect(r.unrouted.find((u) => u.tag === "project" && u.arg === "garden")!.reason).toMatch(/matches 2 notes \(.*Garden\.md.*\)/);
  });

  it("does not file anything when auto-filing is off", () => {
    const w = world();
    const cfg = { ...w.cfg, autoFile: false };
    const r = runVaultStep(cfg, w.store);
    expect(r.filed).toEqual([]);
    expect(existsSync(join(w.vault, "Kindle/Inbox/Todo.md"))).toBe(false);
    expect(w.store.pendingCommands().length).toBe(3);
  });
});

describe("agent notes", () => {
  it("writes the draft as its own linked note, drops invented links, and is idempotent", () => {
    const w = world();
    runVaultStep(w.cfg, w.store);
    const open = openVault(w.cfg, w.store);
    try {
      const h = w.store.getHighlight(w.ids.post)!;
      const post = h.commands.find((c) => c.tag === "post")!;
      const out = writeAgentNote(open.ctx, h, post, {
        title: "Compound interest: habits?",
        content: "Exampleton's point applies. See [[Not A Real Note]] and [[Compound Interest]].\n\n```dataviewjs\nx\n```",
        related: ["Ada Exampleton", "Nope"],
      });
      expect(out.path).toBe("Kindle/Posts/Compound interest habits.md");
      expect(out.removed_links).toEqual(["Not A Real Note"]);
      const text = w.read(out.path);
      expect(text).toContain(`kindle-highlight: ${h.id}`);
      expect(text).toContain(`[[Placeholder Title, Part One#^kh-${h.id}|Placeholder Title, Part One, Location 1234]]`);
      expect(text).toContain("**Angle:** the compound interest idea applies to habits");
      expect(text).toContain("[[Ada Exampleton|Exampleton]]'s point applies. See Not A Real Note and [[Compound Interest]].");
      expect(text).toContain("```text");
      expect(text).toContain("Related: [[Ada Exampleton]]");
      expect(w.store.pendingCommands()).toEqual([]);
      expect(w.store.getHighlight(h.id)!.commands_done_at).toBeTruthy();

      const again = writeAgentNote(open.ctx, w.store.getHighlight(h.id)!, post, { title: "Other", content: "x" });
      expect(again).toMatchObject({ path: out.path, created: false });
    } finally {
      open.close();
    }
  });
});

describe("links in highlights exported before", () => {
  it("previews, then links only unedited 1.0 blocks, keeping the user's own links", () => {
    const w = world();
    const hs = w.store.getHighlights("B0FAKE0004", 100);
    const blocks = hs.map((h) => renderHighlightV1(h));
    blocks[0] = blocks[0].replace("any single leap", "any single [[leap]]"); // the user linked a word
    blocks[2] = blocks[2].replace("A third", "My edited third"); // the user rewrote this one
    mkdirSync(join(w.vault, "Kindle"), { recursive: true });
    writeFileSync(
      join(w.vault, BOOK),
      `---\ntitle: "Placeholder Title, Part One"\nauthor: "Ada Exampleton"\nasin: B0FAKE0004\nsource: kindle\ntags: [kindle]\n---\n\n# T\n\n## Highlights\n\n${blocks.join("\n\n")}\n`,
    );
    const open = openVault(w.cfg, w.store);
    try {
      const plan = planBackfill(open.ctx);
      expect(plan.blocks).toBe(2); // the first gains a link; the second only moves its id; the edited one is left alone
      expect(plan.links).toBe(1);
      expect(plan.samples[0].after).toContain("[[Compound Interest|compound interest]]");
      const applied = applyBackfill(open.ctx);
      expect(applied).toMatchObject({ blocks: 2, links: 1, conflicts: [] });
      const text = w.read(BOOK);
      expect(text).toContain(`> — Location 1234 · #kindle/post #kindle/project/garden\n\n^kh-${w.ids.post}`);
      expect(text).toContain(`> — Location 2001 · #kindle/todo #kindle/quote\n\n^kh-${w.ids.todo}`);
      expect(text).toContain(`> — Location 2500 · #kindle/later #kindle/project ^kh-${w.ids.odd}`); // untouched
      expect(text).toContain("My edited third");
      expect(text).toContain("any single [[leap]]");
      expect(planBackfill(open.ctx).blocks).toBe(0);
    } finally {
      open.close();
    }
  });

  it("asks through the sync result at most once a week, and applies silently once the answer is always", () => {
    const w = world();
    const hs = w.store.getHighlights("B0FAKE0004", 100);
    mkdirSync(join(w.vault, "Kindle"), { recursive: true });
    writeFileSync(join(w.vault, BOOK), `---\nasin: B0FAKE0004\nsource: kindle\n---\n\n${hs.map(renderHighlightV1).join("\n\n")}\n`);
    const first = runVaultStep(w.cfg, w.store, { offerLinkExisting: true });
    expect(first.link_existing).toMatchObject({ links: expect.any(Number), ask_user: expect.stringContaining("kindle_link_existing_highlights") });
    expect(runVaultStep(w.cfg, w.store, { offerLinkExisting: true }).link_existing).toBeUndefined();
    w.store.setState(`link_existing:${open(w).root}`, "always");
    const later = runVaultStep(w.cfg, w.store);
    expect(later.link_existing).toMatchObject({ applied: { blocks: expect.any(Number) } });
  });
});

function open(w: World): { root: string } {
  const o = openVault(w.cfg, w.store);
  o.close();
  return { root: o.ctx.vault.root };
}
