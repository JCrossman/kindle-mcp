/** A kindle-mcp home for the vault tests: a vault of placeholder notes and a store holding one placeholder book. */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { loadConfig, type Config } from "../../src/config.js";
import { makeBook, makeHighlight } from "../../src/models.js";
import { Store } from "../../src/store.js";

/** Writes notes (vault-relative path -> text) under `root`, making folders as needed. */
export function writeNotes(root: string, notes: Record<string, string>): void {
  for (const [rel, text] of Object.entries(notes)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

export interface World {
  cfg: Config;
  store: Store;
  vault: string;
  /** Adds a highlight at a location, with Amazon's id for it (`key` tells two apart); returns its id. */
  add(loc: number, note: string, h?: { text?: string; key?: string }): string;
  read(rel: string): string;
  /** Every file in the vault outside dot-folders, sorted. */
  files(): string[];
}

export function world(
  notes: Record<string, string> = {},
  opts: { env?: Record<string, string>; book?: { asin: string; title: string; author: string } } = {},
): World {
  const home = mkdtempSync(join(tmpdir(), "kindle-world-"));
  const vault = join(home, "vault");
  writeNotes(vault, { ".obsidian/app.json": "{}", ...notes });
  const cfg = loadConfig({ KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: vault, ...opts.env });
  const store = new Store(cfg.dbPath);
  const book = opts.book ?? { asin: "B0FAKE0007", title: "Placeholder Book", author: "A. Writer" };
  const bookId = store.upsertBook(makeBook({ bookId: book.asin, ...book }));
  const add: World["add"] = (loc, note, { text = `Highlight text at ${loc}.`, key = `x${loc}` } = {}) => {
    store.upsertHighlight(bookId, makeHighlight({ bookId, text, note, locationStart: loc, amazonId: `${book.asin}:${loc * 150}:HIGHLIGHT:${key}` }));
    return store.getHighlights(bookId, 1000).find((h) => h.location_start === loc)!.id;
  };
  const files = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) walk(join(dir, e.name));
        else out.push(relative(vault, join(dir, e.name)).replace(/\\/g, "/"));
      }
    };
    walk(vault);
    return out.sort();
  };
  return { cfg, store, vault, add, read: (rel) => readFileSync(join(vault, rel), "utf8"), files };
}
