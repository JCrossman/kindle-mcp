import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { actionsTable, COMMANDS, commandsTable } from "../src/commands.js";
import { makeBook, makeHighlight } from "../src/models.js";
import { commandKey, Store } from "../src/store.js";

const tmpDb = (name: string): string => join(process.env.VITEST_TMP ?? "/tmp", `kindle-mcp-life-${process.pid}-${name}-${Date.now()}.db`);

function withNote(note: string): { store: Store; bookId: string; put: (n: string) => string; id: string } {
  const store = new Store(tmpDb("note"));
  const bookId = store.upsertBook(makeBook({ bookId: "B1", asin: "B1", title: "T" }));
  const base = makeHighlight({ bookId: "B1", text: "some text", locationStart: 10, amazonId: "B1:1500:HIGHLIGHT:a", note });
  store.upsertHighlight(bookId, base);
  const id = store.getHighlights(bookId)[0].id;
  return { store, bookId, id, put: (n: string) => store.upsertHighlight(bookId, { ...base, note: n }) };
}

describe("command table", () => {
  it("says who does each command", () => {
    expect(COMMANDS.filter((c) => c.doneBy === "sync").map((c) => c.tag)).toEqual(["todo", "project", "quote"]);
    expect(COMMANDS.filter((c) => c.doneBy === "agent").map((c) => c.tag)).toEqual(["post", "research"]);
    expect(commandsTable()).toContain("| Done by | What happens |");
    expect(actionsTable()).toContain("kindle_complete_command");
  });
});

describe("command lifecycle", () => {
  it("keeps the note as typed next to the cleaned note", () => {
    const { store, id } = withNote("@todo email Sam @post the angle");
    const h = store.getHighlight(id)!;
    expect(h.note).toBe("the angle");
    expect(h.raw_note).toBe("@todo email Sam @post the angle");
    store.close();
  });

  it("tracks commands one at a time and closes the highlight when all are done", () => {
    const { store, id } = withNote("@todo email Sam @post");
    let h = store.pendingCommands()[0];
    expect(h.remaining!.map((c) => c.tag)).toEqual(["todo", "post"]);
    store.recordOutput(h, h.commands[0], { via: "sync", path: "Kindle/Inbox/Todo.md", blockId: "kh-x-todo" });
    h = store.pendingCommands()[0];
    expect(h.remaining!.map((c) => c.tag)).toEqual(["post"]);
    expect(h.already_done).toEqual([{ tag: "todo", arg: "email Sam", via: "sync", path: "Kindle/Inbox/Todo.md" }]);
    expect(store.status().pending_by_tag).toEqual({ post: 1 });
    expect(store.pendingCommands("todo")).toEqual([]); // only what is left counts
    store.recordOutput(h, h.commands[1], { via: "agent", path: "Kindle/Posts/Angle.md" });
    expect(store.pendingCommands()).toEqual([]);
    expect(store.getHighlight(id)!.commands_done_at).toBeTruthy();
    store.close();
  });

  it("re-opens only what an edit changed", () => {
    const { store, id, put } = withNote("@todo email Sam @post first angle");
    const h = store.getHighlight(id)!;
    for (const c of h.commands) store.recordOutput(h, c, { via: "sync" });
    expect(store.pendingCommands()).toEqual([]);

    expect(put("@todo  Email  Sam @post first angle")).toBe("updated"); // whitespace and case only
    expect(store.pendingCommands()).toEqual([]);

    put("@todo email Sam @post a new angle"); // the angle is the @post's input
    expect(store.pendingCommands()[0].remaining!.map((c) => c.tag)).toEqual(["post"]);

    put("@todo email Sam @post a new angle @quote"); // an added command re-opens only itself
    expect(store.pendingCommands()[0].remaining!.map((c) => c.tag)).toEqual(["post", "quote"]);
    store.close();
  });

  it("respects a highlight marked done by 1.0 code, which wrote no per-command rows", () => {
    const { store, id } = withNote("@project netcare");
    store.db.prepare("UPDATE highlights SET commands_done_at='2026-09-01T00:00:00Z' WHERE id=?").run(id);
    expect(store.pendingCommands()).toEqual([]);
    expect(store.refreshDone(id)).toBe(true); // never cleared
    expect(store.getHighlight(id)!.commands_done_at).toBe("2026-09-01T00:00:00Z");
    store.close();
  });

  it("marks one tag or everything done by hand", () => {
    const { store, id } = withNote("@todo email Sam @post");
    expect(store.markCommandsDone(id, "@t")).toBe(true);
    expect(store.pendingCommands()[0].remaining!.map((c) => c.tag)).toEqual(["post"]);
    expect(store.markCommandsDone(id)).toBe(true);
    expect(store.pendingCommands()).toEqual([]);
    expect(store.markCommandsDone("nope")).toBe(false);
    store.close();
  });

  it("keys agent commands on the note and filing commands on the argument", () => {
    expect(commandKey({ tag: "todo", arg: "Email  Sam" }, "anything")).toBe("todo:email sam");
    expect(commandKey({ tag: "post", arg: "" }, "angle one")).not.toBe(commandKey({ tag: "post", arg: "" }, "angle two"));
    expect(commandKey({ tag: "post", arg: "" }, "Angle  one")).toBe(commandKey({ tag: "post", arg: "" }, "angle one"));
  });
});

describe("a 1.0 store", () => {
  it("opens, gains the new tables, and keeps its rows and ids", () => {
    const path = tmpDb("v1");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE books (book_id TEXT PRIMARY KEY, asin TEXT, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
        title_key TEXT NOT NULL, last_annotated TEXT, last_synced TEXT);
      CREATE TABLE highlights (id TEXT PRIMARY KEY, book_id TEXT NOT NULL, location_start INTEGER, location_end INTEGER,
        page TEXT, text TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', raw_note TEXT NOT NULL DEFAULT '',
        color TEXT, truncated INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, highlighted_at TEXT,
        commands TEXT NOT NULL DEFAULT '[]', commands_done_at TEXT, amazon_id TEXT, position INTEGER,
        first_seen TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE highlights_fts USING fts5(id UNINDEXED, text, note, title, author);
      INSERT INTO books VALUES ('B1','B1','T','','t',NULL,NULL);
      INSERT INTO highlights (id, book_id, location_start, text, note, raw_note, source, commands, commands_done_at, first_seen, updated_at)
        VALUES ('0123456789abcdef','B1',10,'x','','@quote','cloud','[{"tag":"quote","arg":""}]','2026-09-01T00:00:00Z','t','t');`);
    old.close();
    const store = new Store(path);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["command_outputs", "app_state", "leases", "book_notes"]));
    expect(store.getHighlight("0123456789abcdef")!.raw_note).toBe("@quote");
    expect(store.pendingCommands()).toEqual([]);
    store.close();
  });
});

describe("shared state", () => {
  it("hands a lease to one holder at a time and frees it when it expires", () => {
    const path = tmpDb("lease");
    const a = new Store(path);
    const b = new Store(path);
    expect(a.acquireLease("vault", "a", 60_000)).toBe(true);
    expect(b.acquireLease("vault", "b", 60_000)).toBe(false);
    expect(a.acquireLease("vault", "a", 60_000)).toBe(true); // re-entrant for its holder
    a.releaseLease("vault", "a");
    expect(b.acquireLease("vault", "b", -1)).toBe(true); // already expired when taken
    expect(a.acquireLease("vault", "a", 60_000)).toBe(true); // so the next caller gets it
    a.close();
    b.close();
  });

  it("stores settings and exported book notes", () => {
    const store = new Store(tmpDb("state"));
    expect(store.getState("k")).toBeNull();
    store.setState("k", "v1");
    store.setState("k", "v2");
    expect(store.getState("k")).toBe("v2");
    store.deleteState("k");
    expect(store.getState("k")).toBeNull();
    expect(store.bookNote("/vault", "B1")).toBeNull();
    store.setBookNote("/vault", "B1", "Kindle/T.md");
    expect(store.bookNote("/vault", "B1")).toBe("Kindle/T.md");
    expect(store.bookNote("/other", "B1")).toBeNull();
    store.close();
  });
});
