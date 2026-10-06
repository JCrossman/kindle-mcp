#!/usr/bin/env node
// Claude Code PreToolUse hook (wired in .claude/settings.json). Exit 2 stops the tool call and tells Claude why.
//
// Stops anything from a reader's library entering this repository or a GitHub post:
//   - git commit / push / tag / commit-tree / fast-import: the whole working tree and, on push, every unpushed
//     commit are checked first; --no-verify and core.hooksPath tricks are refused.
//   - Write / Edit / NotebookEdit inside the repository: the new text is checked, and the guard itself (this
//     file, the check, the git hooks, the settings, the fixture vocabulary) cannot be edited by Claude at all.
//     To change the guard the reader sets PRIVACY_GUARD_EDIT=1 in their own shell.
//   - GitHub tools (comments, pull requests, issues, files): the call's text is checked.
// A crash in the hook lets ordinary tool calls through, but never a commit or a push.
process.removeAllListeners("warning");
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_FILES, describeSources, formatFindings, insideRoot, loadTerms, scanFile, scanRange, scanTree } from "../privacy-lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stop = (message) => {
  console.error(`Privacy guard: ${message}`);
  process.exit(2);
};

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const tool = String(input.tool_name ?? "");
const args = input.tool_input ?? {};

const SHIPS = /\bgit\b[^;&|\n]*?\b(commit|push|tag|commit-tree|fast-import)\b/;
const BYPASS = [
  /\bgit\b[^;&|\n]*\s--no-verify\b/,
  /\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*\s-[asnvqeipo]*n[asnvqeipo]*(?=\s|$)/,
  /core\.hooksPath/i,
  /\bHUSKY\s*=\s*0\b/,
  /\bgit\b[^;&|\n]*\bconfig\b[^;&|\n]*\bhooks/i,
  /(^|[\s;&|])(rm|mv|cp|chmod|sed|tee|truncate)\b[^;&|\n]*(\.githooks|scripts\/hooks|privacy-(lib|check)\.mjs|\.claude\/settings|VOCABULARY\.txt)/,
  />\s*\S*(\.githooks|scripts\/hooks|privacy-(lib|check)\.mjs|\.claude\/settings|VOCABULARY\.txt)/,
];

async function main() {
  const terms = await loadTerms();
  const opts = { terms: terms.size ? terms : null, root };

  if (tool === "Bash") {
    const cmd = String(args.command ?? "");
    if (!process.env.PRIVACY_GUARD_EDIT && BYPASS.some((re) => re.test(cmd))) {
      stop("that command skips or edits the privacy hooks. Fix what the check reported instead; only the reader changes the guard.");
    }
    if (!SHIPS.test(cmd)) return;
    const findings = [...scanFile("the command", cmd, { terms: opts.terms, root }), ...scanTree(root, opts)];
    if (/\bgit\b[^;&|\n]*\bpush\b/.test(cmd)) findings.push(...scanRange(root, ["HEAD", "--not", "--remotes"], opts));
    if (findings.length) stop(`${findings.length} finding(s); nothing was committed or pushed.\n${describeSources(terms)}\n${formatFindings(findings)}\nReplace the text with invented placeholders. Do not add words to tests/fixtures/VOCABULARY.txt or edit the guard.`);
    return;
  }

  if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit" || tool === "MultiEdit") {
    const file = String(args.file_path ?? args.notebook_path ?? "");
    if (!file || !insideRoot(root, file)) return;
    const rel = relative(root, resolve(root, file)).split("\\").join("/");
    if (!process.env.PRIVACY_GUARD_EDIT && GUARD_FILES.some((re) => re.test(rel))) {
      stop(`${rel} is part of the privacy guard. Claude does not edit it; the reader does (or sets PRIVACY_GUARD_EDIT=1 for one session).`);
    }
    const text = [args.content, args.new_string, args.new_source, ...(Array.isArray(args.edits) ? args.edits.map((e) => e.new_string) : [])].filter((t) => typeof t === "string").join("\n");
    const findings = scanFile(rel, text, opts);
    if (findings.length) stop(`not written, ${findings.length} finding(s) in the new text of ${rel}.\n${formatFindings(findings)}\nUse invented placeholder text; nothing from a reader's library goes in a file.`);
    return;
  }

  if (tool.startsWith("mcp__github__")) {
    const findings = scanFile("the GitHub call", JSON.stringify(args), opts);
    if (findings.length) stop(`not sent, ${findings.length} finding(s) in the text going to GitHub.\n${formatFindings(findings)}\nNo reader library data and no Claude session links in commits, pull requests, issues or comments.`);
  }
}

try {
  await main();
} catch (e) {
  const cmd = String(args.command ?? "");
  if (tool === "Bash" && SHIPS.test(cmd)) stop(`the check itself failed (${String(e?.message ?? e).split("\n")[0]}), so this commit or push is refused.`);
  process.exit(0);
}
