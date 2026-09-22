import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readFrontmatter, splitFrontmatter } from "../src/vault/frontmatter.js";
import { VaultIndex } from "../src/vault/index.js";
import { Linker, type LinkableNote } from "../src/vault/linkify.js";
import {
  hasBlockId, insertUnderHeading, neutralize, normalizeFolder, sanitizeName, Vault, VaultConflict, VaultError,
} from "../src/vault/write.js";

const tmp = (name: string): string => mkdtempSync(join(tmpdir(), `kindle-vault-${name}-`));

function vaultWith(files: Record<string, string>): string {
  const root = tmp("v");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const note = (path: string, aliases: string[] = [], linkable = true): LinkableNote => ({
  path,
  title: (path.split("/").pop() ?? "").replace(/\.md$/, ""),
  aliases,
  linkable,
});

describe("frontmatter", () => {
  it("reads aliases in every form Obsidian users write them", () => {
    expect(readFrontmatter("---\naliases:\n  - One\n  - 'Two, too'\n---\nbody").aliases).toEqual(["One", "Two, too"]);
    expect(readFrontmatter("---\naliases: [A, \"B, b\", 'C']\n---\n").aliases).toEqual(["A", "B, b", "C"]);
    expect(readFrontmatter("---\naliases: Solo\n---\n").aliases).toEqual(["Solo"]);
    expect(readFrontmatter("---\r\naliases:\r\n- Windows\r\n---\r\nx").aliases).toEqual(["Windows"]);
    expect(readFrontmatter("---\nalias: Old\n---\n").aliases).toEqual([]); // dropped by Obsidian 1.9
    expect(readFrontmatter("---\naliases: [ok, \"bad|pipe\", \"[[link]]\"]\n---\n").aliases).toEqual(["ok"]);
  });
  it("reads the opt-out and kindle-mcp's own fields, and tolerates junk", () => {
    const fm = readFrontmatter('---\ntitle: "A \\"quoted\\" title"\nasin: B0FAKE\nsource: kindle\nkindle-link: false\n---\n');
    expect(fm).toMatchObject({ title: 'A "quoted" title', asin: "B0FAKE", source: "kindle", linkOptOut: true });
    expect(readFrontmatter("no frontmatter").aliases).toEqual([]);
    expect(readFrontmatter("---\n: : broken\n  - [\n---\n").aliases).toEqual([]);
    expect(readFrontmatter("---\nunclosed: yes\n").source).toBeNull();
    expect(splitFrontmatter("---\na: 1\n---\nbody").bodyStart).toBe(13);
  });
});

describe("linker", () => {
  const linker = new Linker([
    note("Concepts/Trust.md"),
    note("Concepts/Deep Work.md", ["deep focus"]),
    note("People/Daniel Kahneman.md", ["Kahneman"]),
    note("AI.md"),
    note("Ideas.md"),
    note("To Do.md"),
    note("Daily/2026-09-01 Monday.md"),
    note("A/Sapiens.md"),
    note("B/Sapiens.md"),
    note("Private/Journal Entry.md", [], false),
    note("Stoicism.md"),
  ]);

  it("links mentions whole-word and in any case, with the matched text shown", () => {
    const r = linker.linkify("Trust is built in drops. Deep work needs trust.");
    expect(r.text).toBe("[[Trust]] is built in drops. [[Deep Work|Deep work]] needs trust.");
    expect(r.added).toBe(2);
    expect(r.targets).toEqual(["Concepts/Trust.md", "Concepts/Deep Work.md"]);
  });
  it("uses aliases, possessives and curly apostrophes", () => {
    expect(linker.linkify("As Kahneman’s work shows").text).toBe("As [[Daniel Kahneman|Kahneman]]’s work shows");
    expect(linker.linkify("try some deep focus").text).toBe("try some [[Deep Work|deep focus]]");
  });
  it("skips common words, lowercase short words, dates, function-word titles, ambiguous and unlinkable names", () => {
    expect(linker.linkify("Great ideas to do on Monday about sapiens and journal entry").added).toBe(0);
    expect(linker.linkify("ai is lowercase here").added).toBe(0);
    expect(linker.linkify("AI is an acronym here").text).toBe("[[AI]] is an acronym here");
  });
  it("never links inside links, code, urls, tags, headings or ids, and respects self and caps", () => {
    const text = "[[Trust]] and `Stoicism` and https://x.com/Stoicism #Stoicism\n# Stoicism\nStoicism ^kh-1";
    expect(linker.linkify(text).text).toBe(text.replace("\nStoicism ^", "\n[[Stoicism]] ^"));
    expect(linker.linkify("Stoicism and trust", { exclude: new Set(["Stoicism.md"]) }).text).toBe("Stoicism and [[Trust|trust]]");
    expect(linker.linkify("Trust, Stoicism, Kahneman", { max: 1 }).added).toBe(1);
    expect(linker.linkify("self-trust and trust-based").added).toBe(0);
    expect(linker.linkify("broken [[ markup Trust").added).toBe(0);
  });
  it("links each note once per text, counting links already there", () => {
    expect(linker.linkify("[[Stoicism]] then Stoicism again").added).toBe(0);
    const seen = new Set<string>();
    expect(linker.linkify("Trust here", { seen }).added).toBe(1);
    expect(linker.linkify("Trust there", { seen }).added).toBe(0); // same note, same output
  });
  it("qualifies a link by path when the name is not unique, and resolves targets", () => {
    const dup = new Linker([note("A/Focus Area.md"), note("B/Focus Area.md", [], false)]);
    expect(dup.linkText("A/Focus Area.md")).toBe("A/Focus Area");
    expect(dup.linkify("my focus area").text).toBe("my [[A/Focus Area|focus area]]");
    expect(linker.resolve("stoicism")).toBe("Stoicism.md");
    expect(linker.resolve("Concepts/Trust")).toBe("Concepts/Trust.md");
    expect(linker.resolve("Nope")).toBeNull();
  });
});

describe("vault writes", () => {
  it("requires the vault to exist and keeps every path inside it", () => {
    expect(() => Vault.open(join(tmp("x"), "missing"), "Kindle")).toThrow(VaultError);
    const root = tmp("safe");
    const v = Vault.open(root, "Kindle");
    expect(() => v.abs("../outside.md")).toThrow(VaultError);
    expect(() => v.abs("/etc/passwd")).toThrow(VaultError);
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "link"));
    expect(() => v.abs("link/file.md")).toThrow(/symbolic link/);
    expect(normalizeFolder("\\Reading\\Kindle\\")).toBe("Reading/Kindle");
    expect(normalizeFolder("../up")).toBe("Kindle");
  });
  it("appends with a blank line in the file's own line endings, creates exclusively, swaps only unchanged files", () => {
    const root = tmp("append");
    const v = Vault.open(root, "Kindle");
    writeFileSync(join(root, "crlf.md"), "line one\r\n");
    v.append("crlf.md", "entry\nsecond");
    expect(readFileSync(join(root, "crlf.md"), "utf8")).toBe("line one\r\n\r\nentry\r\nsecond\r\n");
    v.append("Kindle/new.md", "first");
    expect(readFileSync(join(root, "Kindle/new.md"), "utf8")).toBe("first\n");
    expect(v.create("Kindle/new.md", "x")).toBe(false);
    expect(v.create("Kindle/other.md", "x")).toBe(true);
    expect(() => v.replace("Kindle/other.md", "not x", "y")).toThrow(VaultConflict);
    v.replace("Kindle/other.md", "x", "y");
    expect(readFileSync(join(root, "Kindle/other.md"), "utf8")).toBe("y");
  });
  it("inserts under a heading: appends when the section is last, splices when it is not", () => {
    expect(insertUnderHeading("# P\n\ntext\n", "From Kindle", "- a")).toEqual({ append: "## From Kindle\n\n- a" });
    expect(insertUnderHeading("# P\n## From Kindle\n\n- old\n", "From Kindle", "- a")).toEqual({ append: "- a" });
    const r = insertUnderHeading("---\ntitle: x\n---\n## From Kindle\n\n- old\n\n```\n# not a heading\n```\n\n## Log\nmore", "From Kindle", "- a");
    expect(r).toEqual({ text: "---\ntitle: x\n---\n## From Kindle\n\n- old\n\n```\n# not a heading\n```\n\n- a\n\n## Log\nmore" });
    const crlf = insertUnderHeading("## From Kindle\r\n- old\r\n## Log\r\n", "From Kindle", "- a") as { text: string };
    expect(crlf.text).toBe("## From Kindle\r\n- old\r\n\r\n- a\r\n\r\n## Log\r\n");
  });
  it("makes names safe and model output inert", () => {
    expect(sanitizeName("  ..Why: loss [aversion]? #1  ")).toBe("Why loss aversion 1");
    expect(sanitizeName("CON")).toBe("CON (note)");
    expect(sanitizeName("../../../etc/evil")).toBe("etc evil");
    expect(sanitizeName("trailing dots...")).toBe("trailing dots");
    expect(sanitizeName("???")).toBeNull();
    expect(neutralize("```dataviewjs\ndv.x()\n```\n`$= dv.y` <% tp.z %> <script>")).toBe("```text\ndv.x()\n```\n`\\$= dv.y` <\\% tp.z %> &lt;script>");
    expect(hasBlockId("text\n\n^kh-abc\n", "kh-abc")).toBe(true);
    expect(hasBlockId("- a ^kh-abc-todo-1234", "kh-abc")).toBe(false);
    expect(hasBlockId("see [[Book#^kh-abc|Book]]", "kh-abc")).toBe(false);
  });
});

describe("vault index", () => {
  it("indexes names, aliases and text; honours exclusions, opt-outs and symlinks", () => {
    const root = vaultWith({
      ".obsidian/app.json": JSON.stringify({ userIgnoreFilters: ["Archive/"] }),
      ".obsidian/templates.json": JSON.stringify({ folder: "Templates" }),
      "Concepts/Deep Work.md": "---\naliases: [deep focus]\n---\nFocus without distraction on a demanding task.",
      "Archive/Old Idea.md": "archived distraction",
      "Templates/Book.md": "{{title}}",
      "Private.md": "---\nkindle-link: false\n---\nsecret distraction",
      "Kindle/Inbox/Todo.md": "- [ ] x",
      "Kindle/Some Book.md": "---\nsource: kindle\nasin: B0FAKE0009\n---\n> distraction quote",
      ".trash/Gone.md": "x",
      "node_modules/pkg/README.md": "x",
    });
    symlinkSync(join(root, "Concepts"), join(root, "Loop"));
    const home = tmp("home");
    const idx = VaultIndex.open(home, root, { kindleFolder: "Kindle" });
    expect(idx.refresh(Date.now() + 10_000, true)).toMatchObject({ complete: true, notes: 6 });
    const byPath = new Map(idx.notes().map((n) => [n.path, n]));
    expect([...byPath.keys()].sort()).toEqual(
      ["Archive/Old Idea.md", "Concepts/Deep Work.md", "Kindle/Inbox/Todo.md", "Kindle/Some Book.md", "Private.md", "Templates/Book.md"],
    );
    expect(byPath.get("Concepts/Deep Work.md")).toMatchObject({ aliases: ["deep focus"], linkable: true });
    expect(byPath.get("Archive/Old Idea.md")!.linkable).toBe(false);
    expect(byPath.get("Templates/Book.md")!.linkable).toBe(false);
    expect(byPath.get("Private.md")!.linkable).toBe(false);
    expect(byPath.get("Kindle/Inbox/Todo.md")!.linkable).toBe(false);
    expect(idx.findBookNote("B0FAKE0009", "Some Book")).toBe("Kindle/Some Book.md");
    expect(idx.search("distraction").map((h) => h.path)).toEqual(["Concepts/Deep Work.md"]); // excluded, opted-out and Kindle notes stay out
    expect(idx.search("distraction", 8, true).map((h) => h.path).sort()).toEqual(["Concepts/Deep Work.md", "Kindle/Some Book.md"]);
    expect(idx.related("Working without distraction on demanding tasks").map((h) => h.path)).toEqual(["Concepts/Deep Work.md"]);
    idx.close();
  });
  it("re-reads only what changed, forgets deleted notes, and reports an unfinished read", () => {
    const root = vaultWith({ "A.md": "alpha", "B.md": "beta" });
    const home = tmp("home2");
    let idx = VaultIndex.open(home, root, { kindleFolder: "Kindle" });
    expect(idx.refresh(Date.now() + 10_000, true).read).toBe(2);
    expect(idx.refresh(Date.now() + 10_000, true).read).toBe(0);
    writeFileSync(join(root, "A.md"), "---\naliases: [first]\n---\nalpha changed");
    utimesSync(join(root, "A.md"), new Date(), new Date(Date.now() + 5000));
    require("node:fs").rmSync(join(root, "B.md"));
    expect(idx.refresh(Date.now() + 10_000, true)).toMatchObject({ read: 1, notes: 1 });
    expect(idx.notes().map((n) => [n.path, n.aliases])).toEqual([["A.md", ["first"]]]);
    idx.close();

    writeFileSync(join(root, "C.md"), "gamma");
    idx = VaultIndex.open(home, root, { kindleFolder: "Kindle" });
    expect(idx.refresh(Date.now() - 1, true).complete).toBe(false); // out of time: callers must not write
    expect(idx.refresh(Date.now() + 10_000, true).complete).toBe(true);
    idx.close();
  });
});
