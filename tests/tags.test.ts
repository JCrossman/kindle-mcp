import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig, type Config } from "../src/config.js";
import { makeBook, makeHighlight } from "../src/models.js";
import { Store } from "../src/store.js";
import { learnedTags, readNote, teachTag } from "../src/vault/file.js";
import { openVault, runVaultStep } from "../src/vault/run.js";

const UNROUTED = "Kindle/Inbox/Unrouted.md";

interface World {
  cfg: Config;
  store: Store;
  vault: string;
  /** Adds a highlight with a note; returns its id. */
  add(loc: number, note: string): string;
  read(rel: string): string;
  files(): string[];
}

function world(notes: Record<string, string>, env: Record<string, string> = {}): World {
  const home = mkdtempSync(join(tmpdir(), "kindle-tags-"));
  const vault = join(home, "vault");
  for (const [rel, text] of Object.entries({ ".obsidian/app.json": "{}", ...notes })) {
    mkdirSync(join(vault, rel, ".."), { recursive: true });
    writeFileSync(join(vault, rel), text);
  }
  const cfg = loadConfig({ KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: vault, ...env });
  const store = new Store(cfg.dbPath);
  const bookId = store.upsertBook(makeBook({ bookId: "B0FAKE0007", asin: "B0FAKE0007", title: "Placeholder Book", author: "A. Writer" }));
  const add = (loc: number, note: string): string => {
    store.upsertHighlight(bookId, makeHighlight({ bookId, text: `Highlight text at ${loc}.`, note, locationStart: loc, amazonId: `B0FAKE0007:${loc}:HIGHLIGHT:x${loc}` }));
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

describe("tags no command owns", () => {
  it("file into the one note named or aliased like the tag, under From Kindle", () => {
    const w = world({
      "Work/Roadmap.md": "# Roadmap\n\nPlans.\n",
      "People/Sam Lee.md": "---\naliases: [Sam]\n---\nA colleague.\n",
    });
    const a = w.add(100, "@roadmap fits the plan");
    const b = w.add(200, "@sam would like this");
    const r = runVaultStep(w.cfg, w.store);
    expect(r.error).toBeUndefined();
    const roadmap = w.read("Work/Roadmap.md");
    expect(roadmap).toContain("## From Kindle");
    expect(roadmap).toContain("> **Note:** fits the plan");
    expect(roadmap).toContain(`^kh-${a}-roadmap`);
    expect(w.read("People/Sam Lee.md")).toContain(`^kh-${b}-sam`);
    expect(r.filed).toEqual(expect.arrayContaining([{ tag: "roadmap", to: "Work/Roadmap.md", count: 1 }, { tag: "sam", to: "People/Sam Lee.md", count: 1 }]));
    expect(r.unrouted).toEqual([]);
    expect(r.unknown_tags).toBeUndefined();
    expect(w.store.pendingCommands(null, 100)).toEqual([]);
  });

  it("never guess: two matches, no match or an opted-out note go to Unrouted, and no note is created", () => {
    const w = world({
      "People, Work/Plan.md": "one",
      "B/Plan.md": "two",
      "Private/Secret.md": "---\nkindle-link: false\n---\nkeep out",
    });
    w.add(100, "@plan two notes have this name");
    w.add(200, "@nothingnamedthis");
    w.add(300, "@secret");
    const before = w.files();
    const r = runVaultStep(w.cfg, w.store);
    expect(r.unrouted.map((u) => u.tag).sort()).toEqual(["nothingnamedthis", "plan", "secret"]);
    const plan = r.unrouted.find((u) => u.tag === "plan")!;
    expect(plan.reason).toBe("matches 2 notes (B/Plan.md, People, Work/Plan.md); tell Claude which one @plan means");
    expect(plan.ambiguous).toEqual(["B/Plan.md", "People, Work/Plan.md"]);
    expect(r.unrouted.every((u) => u.to === UNROUTED)).toBe(true);
    expect(w.read("People, Work/Plan.md")).toBe("one");
    expect(w.read("B/Plan.md")).toBe("two");
    expect(w.read("Private/Secret.md")).not.toContain("From Kindle");
    const added = w.files().filter((f) => !before.includes(f));
    expect(added.sort()).toEqual(["Kindle/Inbox/Unrouted.md", "Kindle/Placeholder Book.md"]);
    expect(r.unknown_tags!.ask_user).toContain('which of "B/Plan.md" or "People, Work/Plan.md" does @plan mean?');
  });

  it("suggest what a tag may have meant, and ask once without acting", () => {
    const w = world({
      "Ideas/Slow Craft.md": "x",
      "Tech/Core 2.0.md": "x",
      "Work/Roadmap.md": "x",
    });
    w.add(100, "@sc");
    w.add(200, "@core2 maybe");
    w.add(300, "@road");
    w.add(400, "@tood call the office");
    w.add(500, "@zzz");
    const r = runVaultStep(w.cfg, w.store);
    const by = Object.fromEntries(r.unrouted.map((u) => [u.tag, u]));
    expect(by.sc.candidates).toEqual(["Slow Craft"]);
    expect(by.core2.candidates).toEqual(["Core 2.0"]);
    expect(by.road.candidates).toEqual(["Roadmap"]);
    expect(by.tood.did_you_mean).toBe("todo");
    expect(by.zzz.candidates).toBeUndefined();
    const ask = r.unknown_tags!;
    expect(ask.in).toBe(UNROUTED);
    expect(ask.tags.sort()).toEqual(["@core2", "@road", "@sc", "@tood", "@zzz"]);
    expect(ask.ask_user).toContain('does @core2 mean your note "Core 2.0"?');
    expect(ask.ask_user).toContain("@tood looks like @todo: fix the note on the Kindle");
    expect(ask.ask_user).toContain("which note should @zzz go to?");
    expect(ask.ask_user).toContain("Never call kindle_teach_tag without their answer.");
    // Nothing was filed into a suggested note.
    expect(w.read("Tech/Core 2.0.md")).toBe("x");
  });

  it("learn a tag on the user's word: waiting entries move, edited lines stay, future ones file there", () => {
    const w = world({ "Tech/Core 2.0.md": "# Core 2.0\n\nMy notes.\n" });
    const a = w.add(100, "@core2 first");
    const b = w.add(200, "@core2 second");
    runVaultStep(w.cfg, w.store);
    // The user edits one Unrouted line by hand.
    const listed = w.read(UNROUTED);
    const edited = listed.split("\n").map((l) => (l.endsWith(`^kh-${b}-core2`) ? l.replace("is not a known command", "is not a known command (ask Sam)") : l)).join("\n");
    writeFileSync(join(w.vault, UNROUTED), edited);

    const open = openVault(w.cfg, w.store);
    const t = teachTag(open.ctx, "@CORE2", "Core 2.0");
    open.close();
    expect(t).toMatchObject({ tag: "core2", note: "Tech/Core 2.0.md", moved: 2, left_in_unrouted: 1 });
    const note = w.read("Tech/Core 2.0.md");
    expect(note).toContain(`^kh-${a}-core2`);
    expect(note).toContain(`^kh-${b}-core2`);
    const after = w.read(UNROUTED);
    expect(after).not.toContain(`^kh-${a}-core2`);
    expect(after).toContain("(ask Sam)");
    expect(after).toMatch(/^# Kindle: unrouted\n\n- `@core2` is not a known command \(ask Sam\)/);

    // A new one goes straight to the note.
    const c = w.add(300, "@core2 third");
    const r = runVaultStep(w.cfg, w.store);
    expect(r.filed).toEqual(expect.arrayContaining([{ tag: "core2", to: "Tech/Core 2.0.md", count: 1 }]));
    expect(w.read("Tech/Core 2.0.md")).toContain(`^kh-${c}-core2`);
    expect(r.unknown_tags).toBeUndefined();

    // Forgotten: the next one waits in Unrouted again.
    const again = openVault(w.cfg, w.store);
    expect(teachTag(again.ctx, "core2", null)).toMatchObject({ note: null });
    again.close();
    w.add(400, "@core2 fourth");
    expect(runVaultStep(w.cfg, w.store).unrouted.map((u) => u.tag)).toEqual(["core2"]);
  });

  it("keep an Unrouted line edited anywhere, even inside the notes its reason lists", () => {
    const w = world({ "A/Plan.md": "one", "B/Plan.md": "two" });
    const x = w.add(100, "@plan first");
    const y = w.add(200, "@plan second");
    runVaultStep(w.cfg, w.store);
    const listed = w.read(UNROUTED);
    expect(listed).toContain("matches 2 notes (A/Plan.md, B/Plan.md)");
    const edited = listed.split("\n").map((l) => (l.endsWith(`^kh-${y}-plan`) ? l.replace("B/Plan.md)", "B/Plan.md, the old one)") : l)).join("\n");
    writeFileSync(join(w.vault, UNROUTED), edited);
    const open = openVault(w.cfg, w.store);
    expect(teachTag(open.ctx, "plan", "A/Plan.md")).toMatchObject({ moved: 2, left_in_unrouted: 1 });
    open.close();
    const after = w.read(UNROUTED);
    expect(after).not.toContain(`^kh-${x}-plan`);
    expect(after).toContain("B/Plan.md, the old one)");
  });

  it("refuse what can't be learned, create a topic note when none exists, and notice a note that's gone", () => {
    const w = world({ "A/Plan.md": "one", "B/Plan.md": "two", "Tech/Core 2.0.md": "x" });
    const open = openVault(w.cfg, w.store);
    expect(() => teachTag(open.ctx, "todo", "Plan")).toThrow(/built-in command/);
    expect(() => teachTag(open.ctx, "t", "Plan")).toThrow(/built-in command/);
    expect(() => teachTag(open.ctx, "two words", "Plan")).toThrow(/isn't a tag/);
    expect(() => teachTag(open.ctx, "plan", "Plan")).toThrow(/More than one note/);
    expect(() => teachTag(open.ctx, "plan", "Nowhere/Missing.md")).toThrow(/There is no note kindle-mcp may file into at Nowhere/);
    const made = teachTag(open.ctx, "idea", "Ideas");
    expect(made).toMatchObject({ note: "Kindle/Topics/Ideas.md", created: true, moved: 0 });
    expect(w.read("Kindle/Topics/Ideas.md")).toContain("## From Kindle");
    teachTag(open.ctx, "core2", "Tech/Core 2.0.md");
    expect(learnedTags(w.store, open.ctx.vault).map((x) => [x.tag, x.path])).toEqual([
      ["core2", "Tech/Core 2.0.md"],
      ["idea", "Kindle/Topics/Ideas.md"],
    ]);
    open.close();

    const i = w.add(100, "@idea a thought");
    rmSync(join(w.vault, "Tech/Core 2.0.md"));
    w.add(200, "@core2 again");
    const r = runVaultStep(w.cfg, w.store);
    expect(w.read("Kindle/Topics/Ideas.md")).toContain(`^kh-${i}-idea`);
    expect(r.unrouted.map((u) => u.reason)).toEqual(["was going to Core 2.0, which is gone; tell Claude where @core2 goes now"]);
    expect(r.unknown_tags!.ask_user).toContain("@core2's note is gone");

    // Per vault: another vault knows nothing of these.
    const other = world({});
    const o = openVault(other.cfg, other.store);
    expect(learnedTags(other.store, o.ctx.vault)).toEqual([]);
    o.close();
  });
});

describe("reading a note", () => {
  it("returns the whole note by name or path, cut at the limit, and refuses notes kindle-mcp leaves alone", () => {
    const w = world(
      {
        "Work/Roadmap.md": "---\naliases: [Plans]\n---\n# Roadmap\n\nEverything about the plan.\n",
        "Private/Diary.md": "secret",
        "Private/Roadmap.md": "the excluded one",
        "Work/Hidden.md": "---\nkindle-link: false\n---\nhidden",
      },
      { KINDLE_LINK_EXCLUDE: "Private" },
    );
    const open = openVault(w.cfg, w.store);
    const byName = readNote(open.ctx, "Roadmap", 20_000);
    // Obsidian sees both notes named Roadmap, so the link names the folder.
    expect(byName).toMatchObject({ path: "Work/Roadmap.md", title: "Roadmap", link: "[[Work/Roadmap]]", truncated: false });
    expect(byName.text).toContain("Everything about the plan.");
    expect(readNote(open.ctx, "plans", 20_000).path).toBe("Work/Roadmap.md");
    expect(readNote(open.ctx, "Work/Roadmap", 20_000).path).toBe("Work/Roadmap.md");
    const cut = readNote(open.ctx, "Work/Roadmap.md", 10);
    expect(cut).toMatchObject({ truncated: true, text: "---\naliase" });
    expect(cut.chars).toBeGreaterThan(10);
    // A name never reaches a note kindle-mcp leaves alone, so the excluded "Roadmap" neither blocks nor leaks.
    expect(() => readNote(open.ctx, "Diary", 20_000)).toThrow(/No note named/);
    expect(() => readNote(open.ctx, "Hidden", 20_000)).toThrow(/No note named/);
    expect(() => readNote(open.ctx, "Private/Diary.md", 20_000)).toThrow(/leave alone/);
    expect(() => readNote(open.ctx, "Work/Hidden.md", 20_000)).toThrow(/kindle-link: false/);
    expect(() => readNote(open.ctx, "Private/Roadmap.md", 20_000)).toThrow(/leave alone/);
    expect(() => readNote(open.ctx, "../outside.md", 20_000)).toThrow(/No note/);
    expect(() => readNote(open.ctx, "No Such Note", 20_000)).toThrow(/No note/);
    open.close();
    expect(existsSync(join(w.vault, "Kindle"))).toBe(false); // reading writes nothing
  });
});
