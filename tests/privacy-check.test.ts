import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COMMANDS } from "../src/commands.js";
// @ts-expect-error plain JS modules without types
import { PUBLIC_TAGS, Terms, htmlText, loadTerms, scanFile, scanTree, tokens } from "../scripts/privacy-lib.mjs";
// @ts-expect-error plain JS module without types
import { scrub, scrubNote } from "../scripts/scrub-capture.mjs";

const root = join(__dirname, "..");
// Invented on purpose: nothing in this file comes from anyone's library. The ASIN-shaped and session-link strings
// are built at run time because the guard refuses them written out in a file.
const TITLE = "Zebra Quartz Handbook";
const SESSION = "https://claude.ai/code/" + "session_0123456789";
const LIVE_ASIN = "B0" + "LIVEASIN";
const STRANGE_ASIN = "B0" + "ABCDEFGH";

const tmp = (): string => mkdtempSync(join(tmpdir(), "kindle-privacy-"));
const terms = (...list: string[]) => {
  const t = new Terms();
  list.forEach((s, i) => t.add(`term ${i + 1}`, s));
  return t;
};

describe("private terms", () => {
  it("match whatever the punctuation, case or accents, on word boundaries", () => {
    const t = terms(TITLE);
    expect(t.scan("See the zebra-quartz HANDBOOK!").map((h: { id: string }) => h.id)).toEqual(["term 1"]);
    expect(t.scan("Zébra Quartz Handbook").length).toBe(1);
    expect(t.scan("zebraquartz handbook").length).toBe(0);
    expect(t.scan("a quartz handbook for zebra").length).toBe(0);
  });
  it("find a quote by any run of six words, across wrapped lines", () => {
    const t = terms("one two three four five six seven eight nine ten");
    expect(t.scan("x\nthree four five six\nseven eight y").map((h: { line: number }) => h.line)).toEqual([2]);
    expect(t.scan("three four five six seven").length).toBe(0);
  });
  it("are reported by source and number, never by their text", () => {
    const findings = scanFile("docs/x.md", `a note about the ${TITLE}`, { terms: terms(TITLE), root });
    expect(findings).toEqual([expect.objectContaining({ file: "docs/x.md", line: 1, rule: "private-term", detail: "matches term 1" })]);
    expect(JSON.stringify(findings)).not.toMatch(/zebra/i);
  });
  it("ignore terms too short to mean anything", () => {
    expect(terms("ab", "the").size).toBe(0);
  });
  it("load from the environment, a file and the reader's own store", async () => {
    const home = tmp();
    writeFileSync(join(home, "private-terms.txt"), "# comment\nQuillfeather Brontosaurus\n");
    const db = new DatabaseSync(join(home, "kindle.db"));
    db.exec("CREATE TABLE books (title TEXT, author TEXT); CREATE TABLE highlights (text TEXT, note TEXT, raw_note TEXT)");
    db.prepare("INSERT INTO books VALUES (?, ?)").run(`${TITLE}: Part Seven`, "Mortimer Fenwickson");
    db.prepare("INSERT INTO highlights VALUES (?, ?, ?)").run("alpha beta gamma delta epsilon zeta eta theta", "@post look @project wombatgarden @shelf2 hello", "");
    db.close();
    const loaded = await loadTerms({ PRIVATE_TERMS: "Plumbago Telescope", KINDLE_MCP_HOME: home }, home);
    expect(loaded.sources.map((s: { name: string }) => s.name)).toEqual(["PRIVATE_TERMS", "private-terms file", "kindle.db"]);
    const hit = (text: string) => loaded.scan(text).map((h: { id: string }) => h.id);
    expect(hit("plumbago telescope")).toEqual(["PRIVATE_TERMS #1"]);
    expect(hit("quillfeather brontosaurus")).toEqual(["private-terms file #1"]);
    expect(hit(`the ${TITLE}`).length).toBe(1); // the main title, without its subtitle
    expect(hit("by fenwickson")).toHaveLength(1); // the surname alone
    expect(hit("gamma delta epsilon zeta eta theta")).toHaveLength(1); // a quote
    expect(hit("our wombatgarden plan")).toHaveLength(1); // a project name from a note
    expect(hit("tag shelf2 here")).toHaveLength(1); // a reader's own tag
    expect(hit("@post and @project and @todo")).toEqual([]); // the built-in commands are public
  });
  it("never make loading fail", async () => {
    const home = tmp();
    writeFileSync(join(home, "kindle.db"), "not a database");
    const loaded = await loadTerms({ KINDLE_MCP_HOME: home }, home);
    expect(loaded.size).toBe(0);
  });
  it("know the same command tags as the router", () => {
    const tags = COMMANDS.flatMap((c) => [c.tag, ...c.aliases]).sort();
    expect([...PUBLIC_TAGS].sort()).toEqual(tags);
  });
});

describe("structural rules", () => {
  const scan = (path: string, text: string) => scanFile(path, text, { root }).map((f: { rule: string }) => f.rule);
  it("accept only the fake ASINs", () => {
    expect(scan("tests/a.ts", "B0FAKE0007 and B07XYZ1234")).toEqual([]);
    expect(scan("tests/a.ts", STRANGE_ASIN)).toEqual(["asin"]);
  });
  it("refuse Claude session links and capture files", () => {
    expect(scan("docs/a.md", `see ${SESSION}`)).toEqual(["session-link"]);
    for (const name of ["x.har", "kindle.db", "a/session.json", "doctor-1.html", "private-terms.txt", ".env"]) expect(scan(name, "")).toEqual(["forbidden-file"]);
  });
  it("hold fixtures to the vocabulary, the placeholder URLs and the placeholder ids", () => {
    expect(scan("tests/fixtures/x.html", "<p>Placeholder note about habits</p>")).toEqual([]);
    expect(scan("tests/fixtures/x.html", "<p>Zebra quartz</p>")).toEqual(["fixture-vocabulary"]);
    expect(scan("tests/fixtures/x.html", '<img src="https://cdn.example.net/c.jpg">')).toEqual(["fixture-url"]);
    const real = Buffer.from("ACCOUNT1234:B0FAKE0001:5:HIGHLIGHT:abc-def-ghi").toString("base64").replace(/=+$/, "");
    expect(scan("tests/fixtures/x.html", `<div id="${real}"></div>`)).toEqual(["fixture-id"]);
    const fake = Buffer.from("ACCOUNTREDACTED:B0FAKE0001:5:HIGHLIGHT:00000000-0000-0000-0000-000000000001").toString("base64").replace(/=+$/, "");
    expect(scan("tests/fixtures/x.html", `<div id="${fake}"></div>`)).toEqual([]);
  });
  it("never print a rejected fixture word in full", () => {
    const [f] = scanFile("tests/fixtures/x.txt", "Zebra", { root });
    expect(f.detail).not.toMatch(/zebra/i);
    expect(f.detail).toContain("z****(5)");
  });
  it("read pages as a person would: text and a few attributes, not markup", () => {
    const words = tokens(htmlText('<div class="kp-note"><script>var secret = 1</script><span id="x" value="Visible text">Hello &amp; welcome</span><!-- hidden comment --></div>')).map((t: { w: string }) => t.w);
    expect(words).toEqual(["visible", "text", "hello", "welcome"]);
  });
  it("find nothing in this repository", () => {
    expect(scanTree(root, { terms: null, root })).toEqual([]);
  });
});

describe("the hooks", () => {
  const env = (extra: Record<string, string> = {}) => ({ ...process.env, KINDLE_MCP_HOME: tmp(), PRIVATE_TERMS: TITLE, ...extra });
  const gate = (call: unknown, extra: Record<string, string> = {}) => {
    const r = spawnSync("node", [join(root, "scripts", "hooks", "privacy-gate.mjs")], { input: JSON.stringify(call), encoding: "utf8", env: env(extra) });
    return { code: r.status, err: r.stderr };
  };
  const bash = (command: string) => gate({ tool_name: "Bash", tool_input: { command } });

  it("Claude's hook lets ordinary work through", () => {
    expect(bash("ls -la").code).toBe(0);
    expect(bash("git status && echo -nothing").code).toBe(0);
    expect(gate({ tool_name: "Write", tool_input: { file_path: join(root, "docs", "x.md"), content: "plain words" } }).code).toBe(0);
    expect(gate({ tool_name: "Write", tool_input: { file_path: "/tmp/elsewhere.md", content: TITLE } }).code).toBe(0); // outside the repository
    expect(gate({ tool_name: "mcp__github__add_issue_comment", tool_input: { body: "looks good" } }).code).toBe(0);
    expect(gate("garbage").code).toBe(0);
  });
  it("stops a commit that names a private term, and any way around the hooks", () => {
    expect(bash(`git commit -m "notes on ${TITLE}"`).code).toBe(2);
    for (const c of ["git commit --no-verify -m x", "git commit -an -m x", "git -c core.hooksPath=/dev/null commit -m x", "git config core.hooksPath /dev/null", "rm scripts/privacy-lib.mjs", "echo x > .githooks/pre-commit"]) {
      expect(bash(c).code, c).toBe(2);
    }
  });
  it("stops private text on its way into a file or onto GitHub, and edits to the guard", () => {
    const write = (file: string, content: string, extra: Record<string, string> = {}) => gate({ tool_name: "Write", tool_input: { file_path: join(root, file), content } }, extra);
    expect(write("docs/x.md", `a book called ${TITLE}`).code).toBe(2);
    expect(write("tests/fixtures/new.txt", "Zebra quartz").code).toBe(2);
    expect(write("scripts/privacy-lib.mjs", "x").code).toBe(2);
    expect(write("tests/fixtures/VOCABULARY.txt", "x").code).toBe(2);
    expect(write("scripts/privacy-lib.mjs", "x", { PRIVACY_GUARD_EDIT: "1" }).code).toBe(0); // the reader's own switch
    expect(gate({ tool_name: "mcp__github__create_pull_request", tool_input: { body: `reading ${TITLE}` } }).code).toBe(2);
    expect(gate({ tool_name: "mcp__github__add_issue_comment", tool_input: { body: `see ${SESSION}` } }).code).toBe(2);
  });

  it("git's own hooks refuse the commit, whoever makes it", () => {
    const repo = tmp();
    const run = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
    run("init", "-q", "-b", "main");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "T");
    mkdirSync(join(repo, "scripts"));
    for (const f of ["privacy-lib.mjs", "privacy-check.mjs"]) cpSync(join(root, "scripts", f), join(repo, "scripts", f));
    cpSync(join(root, ".githooks"), join(repo, ".githooks"), { recursive: true });
    mkdirSync(join(repo, "tests", "fixtures"), { recursive: true });
    cpSync(join(root, "tests", "fixtures", "VOCABULARY.txt"), join(repo, "tests", "fixtures", "VOCABULARY.txt"));
    run("config", "core.hooksPath", ".githooks");

    writeFileSync(join(repo, "a.md"), "placeholder text\n");
    run("add", "-A");
    expect(run("commit", "-qm", "clean").status).toBe(0);

    writeFileSync(join(repo, "b.md"), `about the ${TITLE}\n`);
    run("add", "-A");
    const blocked = run("commit", "-qm", "leak");
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("private-term");
    expect(blocked.stderr).not.toMatch(/zebra/i);

    writeFileSync(join(repo, "b.md"), "placeholder\n");
    run("add", "-A");
    expect(run("commit", "-qm", `see ${SESSION}`).status).not.toBe(0); // the message is checked too
    expect(run("commit", "-qm", "fine").status).toBe(0);
  });
});

describe("the capture scrubber", () => {
  const live = `<html><body>
<div id="kp-notebook-library">
 <div id="${LIVE_ASIN}" class="a-row kp-notebook-library-each-book">
  <h2>${TITLE}</h2><p>By: Mortimer Fenwickson</p>
  <input type="hidden" id="kp-notebook-annotated-date-${LIVE_ASIN}" value="Tuesday March 3, 2026">
 </div>
</div>
<div class="kp-notebook-annotation-container">
 <h3 class="kp-notebook-metadata">${TITLE}</h3><p>Mortimer Fenwickson</p>
 <img src="https://m.media-amazon.com/images/cover123.jpg">
 <a href="https://amazon.com/dp/${LIVE_ASIN}?tag=abc">x</a>
 <span id="kp-notebook-annotation-count">41 Highlights | 9 Notes</span>
 <input type="hidden" id="kp-notebook-asin" value="${LIVE_ASIN}">
 <input type="hidden" name="anti-csrftoken-a2z" value="abcdefghijklmnopqrstuvwxyz0123456789">
 <div id="${Buffer.from(`123456789012:${LIVE_ASIN}:77:HIGHLIGHT:aaaa-bbbb`).toString("base64").replace(/=+$/, "")}">
  <span id="highlight">Wombats dig burrows beneath quartz hills every single night.</span>
  <span id="note">@post try wombat burrows @shelf2 @project wombatgarden</span>
 </div>
</div></body></html>`;
  it("leaves no title, author, quote, tag, ASIN, id, URL or total behind, and passes the check", () => {
    const out: string = scrub(live, "page.html");
    for (const gone of ["Zebra", "Quartz Handbook", "Fenwickson", "Wombats", "wombat", "shelf2", LIVE_ASIN, "123456789012", "media-amazon", "2026", "41 Highlights", "abcdefghij"]) expect(out, gone).not.toContain(gone);
    expect(out).toContain("Placeholder Title 1");
    expect(out).toContain("@post placeholder placeholder placeholder @tag1 @project placeholder");
    expect(out).toContain("B0FAKE0001");
    expect(out).toContain("1 Highlights | 1 Notes");
    expect(scanFile("tests/fixtures/page.html", out, { terms: terms(TITLE, "Mortimer Fenwickson"), root })).toEqual([]);
  });
  it("keeps only the command tags of a note", () => {
    expect(scrubNote("@t buy @q a quote @brandnew")).toBe("@t placeholder @q placeholder placeholder @tag1");
  });
  it("scrubs a clippings file the same way", () => {
    const clip = `${TITLE} (Fenwickson, Mortimer)\n- Your Highlight on page 3 | Location 10-12 | Added on Friday, May 1, 2026 8:00:00 AM\n\nWombats dig burrows.\n==========\n`;
    const out: string = scrub(clip, "My Clippings.txt");
    expect(out).not.toMatch(/zebra|fenwickson|wombat|2026 8/i);
    expect(out).toContain("Location 10-12");
    expect(scanFile("tests/fixtures/My Clippings.txt", out, { root })).toEqual([]);
  });
});

describe("the repository's own setup", () => {
  it("runs the check in CI and on release, and keeps the term list and captures out of git", () => {
    for (const wf of ["ci.yml", "release.yml"]) expect(readFileSync(join(root, ".github", "workflows", wf), "utf8")).toContain("node scripts/privacy-check.mjs");
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    for (const pattern of ["private-terms.txt", "*.har", "*.db", "session.json", "doctor-*.html"]) expect(ignore).toContain(pattern);
  });
  it("wires the Claude hook and the git hooks", () => {
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    const entry = settings.hooks.PreToolUse[0];
    expect(entry.matcher).toMatch(/Bash/);
    expect(entry.matcher).toMatch(/Write/);
    expect(entry.matcher).toMatch(/mcp__github__/);
    expect(entry.hooks[0].command).toContain("scripts/hooks/privacy-gate.mjs");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.prepare).toContain("core.hooksPath .githooks");
  });
});
