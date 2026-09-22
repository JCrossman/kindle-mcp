import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseClippings, parseWhen } from "../src/clippings.js";
import { COMMANDS, commandsTable, parseCommands } from "../src/commands.js";
import { makeBook, makeHighlight } from "../src/models.js";
import { decodeAnnotationId, parseAnnotations, parseLibrary, parsePaneBook } from "../src/notebook/parser.js";
import { exportBook } from "../src/obsidian.js";
import { highlightId, locationId, Store, titleKey } from "../src/store.js";
import { importClippings } from "../src/sync.js";

const FX = join(__dirname, "fixtures");
const fx = (name: string): string => readFileSync(join(FX, name), "utf8");
const quiet = (): void => {};

function loadCloud(store: Store): [string, string[]] {
  const [books, token] = parseLibrary(fx("library.html"));
  expect(token).toBe("");
  const bookId = store.upsertBook(books[0]);
  const [highlights] = parseAnnotations(fx("annotations.html"), bookId);
  return [bookId, highlights.map((h) => store.upsertHighlight(bookId, h))];
}

const tmpDb = (name: string): string => join(process.env.VITEST_TMP ?? "/tmp", `kindle-mcp-test-${process.pid}-${name}-${Date.now()}.db`);

describe("commands grammar", () => {
  it("parses tags, arguments and leaves the note", () => {
    const { commands, note } = parseCommands("@post focusing illusion applies to AI hype @project netcare");
    expect(commands).toEqual([{ tag: "post", arg: "" }, { tag: "project", arg: "netcare" }]);
    expect(note).toBe("focusing illusion applies to AI hype");
    expect(parseCommands("@todo email Sam about this")).toEqual({ commands: [{ tag: "todo", arg: "email Sam about this" }], note: "" });
    expect(parseCommands("mail me at a@b.com")).toEqual({ commands: [], note: "mail me at a@b.com" }); // emails are not commands
    expect(parseCommands("")).toEqual({ commands: [], note: "" });
  });
  it("resolves aliases", () => {
    expect(parseCommands("@p").commands).toEqual([{ tag: "post", arg: "" }]);
    expect(parseCommands("@pr netcare").commands).toEqual([{ tag: "project", arg: "netcare" }]);
    expect(parseCommands("@R").commands).toEqual([{ tag: "research", arg: "" }]);
  });
  it("stops a line argument at the next tag", () => {
    const { commands, note } = parseCommands("@todo email Sam @project netcare");
    expect(commands).toEqual([{ tag: "todo", arg: "email Sam" }, { tag: "project", arg: "netcare" }]);
    expect(note).toBe("");
  });
  it("keeps unknown tags with no argument", () => {
    expect(parseCommands("@later maybe").commands).toEqual([{ tag: "later", arg: "" }]);
  });
  it("renders a table with every command", () => {
    const table = commandsTable();
    for (const c of COMMANDS) expect(table).toContain(`\`@${c.tag}\``);
  });
});

describe("notebook parser", () => {
  it("parses the library page", () => {
    const [books] = parseLibrary(fx("library.html"));
    expect(books.map((b) => b.asin)).toEqual(["B0FAKE0004", "B07XYZ1234"]);
    expect(books[0].author).toBe("Daniel Kahneman");
    expect(books[0].lastAnnotated).toBe("Sunday September 13, 2026");
  });
  it("parses the annotation pane", () => {
    const [hs, token] = parseAnnotations(fx("annotations.html"), "B0FAKE0004");
    expect(hs).toHaveLength(3);
    expect(token).toBe("");
    expect(hs[0].locationStart).toBe(1234);
    expect(hs[0].color).toBe("yellow");
    expect(hs[0].note.startsWith("@post")).toBe(true);
    expect(hs[1].page).toBe("87");
    expect(hs[1].locationStart).toBe(2001);
    expect(hs[2].truncated).toBe(true);
    expect(hs[2].text).toBe("");
  });
  it("reads real markup captured from read.amazon.com (scrubbed)", () => {
    const html = fx("annotations_live_structure.html");
    const book = parsePaneBook(html)!;
    expect(book.asin).toBe("B0FAKE0001");
    expect(book.author).toBe("Placeholder Author One");
    const [hs, token, state] = parseAnnotations(html, book.asin!);
    expect(hs.map((h) => [h.locationStart, h.page, h.color])).toEqual([[31, "7", "yellow"], [123, "42", "yellow"], [130, "44", "yellow"]]);
    for (const h of hs) expect(Math.floor(h.position! / 150) + 1).toBe(h.locationStart); // location derives from byte position
    expect(hs[0].amazonId!.startsWith("B0FAKE0001:4559:HIGHLIGHT:")).toBe(true);
    expect(hs[0].amazonId).not.toContain("ACCOUNT");
    expect(token).toBe("");
    expect(state).toBe("REDACTED");
    expect(hs.some((h) => h.truncated)).toBe(false);
  });
  it("handles page 2 fragments, notes and undisplayable highlights", () => {
    const [hs, token, state] = parseAnnotations(fx("annotations_fragment_page2.html"), "B0FAKE0002");
    expect(hs).toHaveLength(3);
    expect(token).toBe("");
    expect(state).toBe("REDACTED");
    expect(hs[0].locationStart).toBe(4583);
    expect(hs[0].color).toBe("orange");

    const [notes] = parseAnnotations(fx("annotations_notes.html"), "B0FAKE0002");
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toBeTruthy();
    expect(notes[0].note).toBe("Placeholder note 1."); // note attached to a highlight
    expect(notes[1].text).toBe("");
    expect(notes[1].note).toBe("Placeholder note 2."); // freestanding note
    expect(notes[1].truncated).toBe(false);

    const [bad] = parseAnnotations(fx("annotations_undisplayable.html"), "B0FAKE0003");
    expect(bad).toHaveLength(1);
    expect(bad[0].truncated).toBe(true);
    expect(bad[0].locationStart).toBe(1901);
    expect(bad[0].color).toBe("orange");
  });
  it("decodes row ids", () => {
    const id = Buffer.from("ACCOUNT:B0FAKE0001:4559:HIGHLIGHT:uuid-1").toString("base64").replace(/=+$/, "");
    expect(decodeAnnotationId(id)).toEqual(["B0FAKE0001:4559:HIGHLIGHT:uuid-1", 4559]);
    expect(decodeAnnotationId("not-base64!!")).toEqual([null, null]);
  });
});

describe("clippings", () => {
  it("parses My Clippings.txt", () => {
    const books = parseClippings(join(FX, "My Clippings.txt"));
    const side = books.get("clip:a-sideloaded-pdf")!.highlights;
    expect(side).toHaveLength(1); // bookmark skipped
    expect(side[0].locationEnd).toBe(12);
    expect(side[0].highlightedAt).toBe("2026-09-14T07:00:00");
    expect(books.get("clip:some-limited-book")!.highlights[0].truncated).toBe(true);
  });
  it("parses the date formats the device writes", () => {
    expect(parseWhen("Added on Sunday, September 13, 2026 9:14:05 PM")).toBe("2026-09-13T21:14:05");
    expect(parseWhen("Added on Sunday, 13 September 2026 21:14:05")).toBe("2026-09-13T21:14:05");
    expect(parseWhen("Added on Sunday, September 13, 2026 12:00:01 AM")).toBe("2026-09-13T00:00:01");
    expect(parseWhen("nothing here")).toBeNull();
  });
});

describe("store", () => {
  it("computes the same ids as the original Python store", () => {
    const amz = makeHighlight({ bookId: "B0FAKE0001", amazonId: "B0FAKE0001:4559:HIGHLIGHT:9f0e2c2a-1b2c-4d3e-8f4a-5b6c7d8e9f00", locationStart: 31, text: "x" });
    expect(highlightId("B0FAKE0001", amz)).toBe("b346b7e276f01dd1");
    const clip = makeHighlight({ bookId: "clip:some-limited-book", locationStart: 3050, text: "y", source: "clippings" });
    expect(locationId("clip:some-limited-book", clip)).toBe("0400d5679160202e");
    expect(highlightId("clip:some-limited-book", clip)).toBe("0400d5679160202e");
    const paged = makeHighlight({ bookId: "clip:x", page: "12", text: "no location here", source: "clippings" });
    expect(locationId("clip:x", paged)).toBe("cec4ee8534c52b63");
    expect(titleKey("Thinking, Fast and Slow: A Book")).toBe("thinking fast and slow");
    expect(titleKey("Team Topologies (Skelton, Matthew)")).toBe("team topologies");
  });
  it("joins cloud and clippings titles", () => {
    expect(titleKey("Team Topologies: Organizing Business")).toBe(titleKey("Team Topologies (Skelton, Matthew)"));
  });
  it("is idempotent and searchable", () => {
    const store = new Store(tmpDb("idem"));
    const [, first] = loadCloud(store);
    const [, second] = loadCloud(store);
    expect(first).toEqual(["new", "new", "new"]);
    expect(second).toEqual(["unchanged", "unchanged", "unchanged"]);
    const hits = store.search("blindness");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Thinking, Fast and Slow");
    expect(store.search("kahneman").length).toBeGreaterThan(0); // author is searchable
    store.close();
  });
  it("fills a truncated cloud highlight from clippings (fullest-copy merge)", () => {
    const store = new Store(tmpDb("merge"));
    const [bookId] = loadCloud(store);
    expect(store.status().truncated_highlights).toBe(1);
    importClippings(store, join(FX, "My Clippings.txt"), quiet);
    const merged = store.getHighlights(bookId).find((h) => h.location_start === 3050)!;
    expect(merged.text.startsWith("The confidence people have")).toBe(true); // clippings filled the gap
    expect(merged.truncated).toBe(false);
    expect(merged.commands.map((c) => [c.tag, c.arg])).toEqual([["research", ""]]); // device note attached to its highlight
    expect(merged.commands[0].action).toContain("research");
    expect(store.status().books).toBe(3); // Kahneman matched, not duplicated
    store.close();
  });
  it("tracks the pending-commands lifecycle", () => {
    const store = new Store(tmpDb("pending"));
    loadCloud(store);
    const pending = store.pendingCommands();
    expect(pending).toHaveLength(1);
    expect(store.pendingCommands("project").map((h) => h.id)).toEqual([pending[0].id]);
    expect(store.pendingCommands("@post").map((h) => h.id)).toEqual([pending[0].id]);
    expect(store.pendingCommands("p").map((h) => h.id)).toEqual([pending[0].id]); // aliases resolve
    expect(store.pendingCommands("@pr").map((h) => h.id)).toEqual([pending[0].id]);
    expect(store.pendingCommands("todo")).toEqual([]);
    expect(store.status().pending_by_tag).toEqual({ post: 1, project: 1 });
    expect(store.markCommandsDone(pending[0].id)).toBe(true);
    expect(store.pendingCommands()).toEqual([]);
    expect(store.markCommandsDone("nope")).toBe(false);
    store.close();
  });
  it("re-opens a highlight whose note was rewritten", () => {
    const store = new Store(tmpDb("reopen"));
    const bookId = store.upsertBook(makeBook({ bookId: "B1", asin: "B1", title: "T" }));
    const h = makeHighlight({ bookId: "B1", text: "t", locationStart: 10, amazonId: "B1:1500:HIGHLIGHT:a", note: "@project a" });
    store.upsertHighlight(bookId, h);
    store.markCommandsDone(store.pendingCommands()[0].id);
    expect(store.pendingCommands()).toHaveLength(0);
    expect(store.upsertHighlight(bookId, { ...h, note: "@project b" })).toBe("updated");
    expect(store.pendingCommands()[0].commands[0].arg).toBe("b");
    store.close();
  });
  it("keeps same-location cloud highlights apart but merges a clippings copy", () => {
    const store = new Store(tmpDb("apart"));
    const bookId = store.upsertBook(makeBook({ bookId: "B1", asin: "B1", title: "T" }));
    const a = makeHighlight({ bookId: "B1", text: "first", locationStart: 10, amazonId: "B1:1500:HIGHLIGHT:a" });
    const b = makeHighlight({ bookId: "B1", text: "second", locationStart: 10, amazonId: "B1:1500:HIGHLIGHT:b" });
    expect([a, b].map((h) => store.upsertHighlight(bookId, h))).toEqual(["new", "new"]);
    expect(store.status().highlights).toBe(2);
    const c = makeHighlight({ bookId: "B1", text: "first, and longer text from the device", locationStart: 10, source: "clippings" });
    expect(store.upsertHighlight(bookId, c)).toBe("updated");
    expect(store.status().highlights).toBe(2);
    store.close();
  });
  it("re-keys rows written before amazon_id became the key", () => {
    const path = tmpDb("migrate");
    let s = new Store(path);
    const bookId = s.upsertBook(makeBook({ bookId: "B1", asin: "B1", title: "T" }));
    const h = makeHighlight({ bookId: "B1", text: "x", locationStart: 5, amazonId: "B1:600:HIGHLIGHT:z" });
    s.db
      .prepare("INSERT INTO highlights (id, book_id, location_start, text, source, amazon_id, first_seen, updated_at) VALUES (?,?,?,?,?,?,'t','t')")
      .run(locationId(bookId, h), bookId, 5, "x", "cloud", h.amazonId);
    s.close();
    s = new Store(path);
    expect(s.upsertHighlight(bookId, h)).toBe("unchanged");
    expect(s.status().highlights).toBe(1);
    s.close();
  });
  it("returns context: neighbours, same-tag siblings and related highlights", () => {
    const store = new Store(tmpDb("context"));
    const [bookId] = loadCloud(store);
    importClippings(store, join(FX, "My Clippings.txt"), quiet);
    const target = store.getHighlights(bookId).find((h) => h.location_start === 2001)!;
    const near = store.neighbours(bookId, target.location_start, target.id, 3);
    expect(near.map((h) => h.location_start)).toEqual([1234, 3050]);
    expect(near.some((h) => h.id === target.id)).toBe(false);
    const research = store.getHighlights(bookId).find((h) => h.location_start === 3050)!;
    expect(store.sameTagInBook(bookId, "research", research.id)).toEqual([]);
    expect(store.sameTagInBook(bookId, "post", research.id).map((h) => h.location_start)).toEqual([1234]);
    const related = store.related("Sideloaded content never reaches the cloud notebook", target.id, bookId, 5);
    expect(related.map((h) => h.title)).toEqual(["A Sideloaded PDF"]);
    store.close();
  });
});

describe("obsidian export", () => {
  it("is append-only", () => {
    const store = new Store(tmpDb("obsidian"));
    const [bookId] = loadCloud(store);
    const vault = join(process.env.VITEST_TMP ?? "/tmp", `kindle-mcp-vault-${process.pid}-${Date.now()}`);
    const first = exportBook(store, bookId, vault);
    expect(first.added).toBe(3);
    const note = readFileSync(first.file, "utf8");
    expect(note).toContain("#kindle/project/netcare");
    require("node:fs").writeFileSync(first.file, note + "\nMY OWN THOUGHTS\n"); // user edits in Obsidian
    importClippings(store, join(FX, "My Clippings.txt"), quiet);
    const second = exportBook(store, "thinking", vault); // title fragment lookup
    expect(second.added).toBe(0);
    expect(second.already_present).toBe(3);
    expect(readFileSync(first.file, "utf8")).toContain("MY OWN THOUGHTS");
    store.close();
  });
});
