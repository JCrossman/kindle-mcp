import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { makeBook, makeHighlight } from "../src/models.js";
import { Store, type HighlightRow } from "../src/store.js";
import { findThemes, themeKeys } from "../src/themes.js";

const row = (id: string, text: string, tags: string[] = [], title = "Placeholder Title"): HighlightRow =>
  ({ id, title, text, note: "", commands: tags.map((tag) => ({ tag, arg: "" })) }) as unknown as HighlightRow;

describe("themes", () => {
  it("keeps content words, folds plurals and adds tags", () => {
    const keys = themeKeys(row("a", "The highlights about compound interest", ["post"]));
    expect([...keys].sort()).toEqual(["#post", "compound", "highlight", "interest"]);
  });

  it("groups highlights by the words they share and leaves loners unthemed", () => {
    const { themes, unthemed } = findThemes([
      row("a", "compound interest in a garden"),
      row("b", "compound interest and habits", [], "Sample Title"),
      row("c", "the territory is not the map"),
      row("d", "a territory of cloud"),
      row("e", "orange"),
    ]);
    expect(themes.map((t) => t.highlight_ids)).toEqual([["a", "b"], ["c", "d"]]);
    expect(themes[0].terms).toEqual(["compound", "interest"]);
    expect(themes[0].books).toEqual(["Placeholder Title", "Sample Title"]);
    expect(themes[1].terms).toEqual(["territory"]);
    expect(unthemed).toEqual(["e"]);
  });

  it("prefers a shared word over a shared tag, and caps the number of themes", () => {
    const { themes } = findThemes([
      row("a", "garden", ["post"]),
      row("b", "garden", ["post"]),
      row("c", "territory", ["post"]),
      row("d", "territory"),
    ], 1);
    expect(themes).toHaveLength(1);
    expect(themes[0].terms).toEqual(["garden"]);
    expect(themes[0].tags).toEqual(["post"]);
  });

  it("finds older highlights on any of a theme's words, by prefix", () => {
    const store = new Store(join(tmpdir(), `kindle-mcp-themes-${process.pid}-${Date.now()}.db`));
    try {
      const bookId = store.upsertBook(makeBook({ bookId: "B0FAKE0001", title: "Placeholder Title" }));
      store.upsertHighlight(bookId, makeHighlight({ bookId, locationStart: 1, text: "small habits compound" }));
      store.upsertHighlight(bookId, makeHighlight({ bookId, locationStart: 2, text: "orange territory" }));
      const later = new Date(Date.now() + 60_000).toISOString();
      expect(store.olderMatching(["habit"], later).map((h) => h.text)).toEqual(["small habits compound"]);
      expect(store.olderMatching(["habit", "territory"], later)).toHaveLength(2);
      expect(store.olderMatching(["habit"], "2000-01-01T00:00:00Z")).toEqual([]);
      expect(store.olderMatching([], later)).toEqual([]);
    } finally {
      store.close();
    }
  });
});
