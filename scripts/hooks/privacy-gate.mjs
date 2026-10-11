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
//   - the `gh` CLI run through Bash (pr/issue/release/comment/gist/api, ...): the command text is checked, and so
//     is any file it reads a body from (--body-file, --notes-file, --input, -F name=@file). This is the same
//     publication the GitHub tools guard against, just reached through a shell command instead of an MCP call.
// A crash in the hook lets ordinary tool calls through, but never a commit, a push or a `gh` publish.
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
// Any `gh` invocation may publish text to GitHub (pr/issue/release/comment/gist create or edit, `gh api`, ...);
// rather than enumerate every publishing subcommand, the whole command line is checked whenever `gh` appears.
const GH_CLI = /(^|[\s;&|])gh\b/;
const CURL_PUBLISH = /(^|[\s;&|])curl\b[^;&|\n]*(?:\s(?:-X|--request)(?:\s+|=)(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-binary|-raw|-urlencode)?|--form(?:-string)?|-F|--upload-file|-T)(?:\s|=|@|$))/i;
const UNINSPECTABLE_PUBLISH = /(?:\$\(|`|[<>]\(|<<<|<<\s*\S|\$(?:[A-Za-z_]\w*|\{[^}]+\})|\|\s*gh\b|--(?:body|notes)-file\s+-|--input\s+-|@-|(?:--upload-file|-T)\s+-)/;
const BYPASS = [
  /\bgit\b[^;&|\n]*\s--no-verify\b/,
  /\bgit\b[^;&|\n]*\bcommit\b[^;&|\n]*\s-[asnvqeipo]*n[asnvqeipo]*(?=\s|$)/,
  /core\.hooksPath/i,
  /\bHUSKY\s*=\s*0\b/,
  /\bgit\b[^;&|\n]*\bconfig\b[^;&|\n]*\bhooks/i,
  /(^|[\s;&|])(rm|mv|cp|chmod|sed|tee|truncate)\b[^;&|\n]*(\.githooks|scripts\/hooks|privacy-(lib|check)\.mjs|\.claude\/settings|VOCABULARY\.txt)/,
  />\s*\S*(\.githooks|scripts\/hooks|privacy-(lib|check)\.mjs|\.claude\/settings|VOCABULARY\.txt)/,
];

const stripQuotes = (s) => (s && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"))) ? s.slice(1, -1) : s);

/** Local files a publishing command reads a body from, so their text is checked too. */
function filesReferencedByPublisher(cmd) {
  const files = [];
  const patterns = [
    /--(?:body|notes)-file[ =]("[^"]*"|'[^']*'|\S+)/g,
    /--input[ =]("[^"]*"|'[^']*'|\S+)/g,
    /(?:-f|-F|--field|--raw-field)[ =][^\s=]+=@("[^"]*"|'[^']*'|\S+)/g,
    /(?:--data(?:-binary|-raw|-urlencode)?|--upload-file|-d|-T)(?:[ =]|(?=@))@?("[^"]*"|'[^']*'|\S+)/g,
    /(?:-F|--form(?:-string)?)(?:[ =])[^\s=]+=@?("[^"]*"|'[^']*'|\S+)/g,
  ];
  for (const re of patterns) {
    for (const m of cmd.matchAll(re)) {
      const v = stripQuotes(m[1]);
      if (v && v !== "-") files.push(v);
    }
  }
  return files;
}

async function main() {
  const terms = await loadTerms();
  const opts = { terms: terms.size ? terms : null, root };

  if (tool === "Bash") {
    const cmd = String(args.command ?? "");
    if (!process.env.PRIVACY_GUARD_EDIT && BYPASS.some((re) => re.test(cmd))) {
      stop("that command skips or edits the privacy hooks. Fix what the check reported instead; only the reader changes the guard.");
    }
    const ships = SHIPS.test(cmd);
    const publishes = GH_CLI.test(cmd) || CURL_PUBLISH.test(cmd);
    if (!ships && !publishes) return;
    if (publishes && UNINSPECTABLE_PUBLISH.test(cmd)) {
      stop("that publication uses dynamic text or stdin that cannot be checked. Pass text directly or use a readable body file.");
    }
    const findings = [...scanFile(publishes ? "the publishing command" : "the command", cmd, { terms: opts.terms, root })];
    if (publishes) {
      for (const f of filesReferencedByPublisher(cmd)) {
        const abs = resolve(root, f);
        try {
          findings.push(...scanFile(relative(root, abs) || f, readFileSync(abs, "utf8"), opts));
        } catch {
          // not a readable file; the flag's own text was already scanned above
        }
      }
    }
    if (ships) {
      findings.push(...scanTree(root, opts));
      if (/\bgit\b[^;&|\n]*\bpush\b/.test(cmd)) findings.push(...scanRange(root, ["HEAD", "--not", "--remotes"], opts));
    }
    if (findings.length) {
      stop(
        `${findings.length} finding(s); nothing was committed, pushed or sent.\n${describeSources(terms)}\n${formatFindings(findings)}\n` +
          "Replace the text with invented placeholders. Do not add words to tests/fixtures/VOCABULARY.txt or edit the guard.",
      );
    }
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
  if (tool === "Bash" && (SHIPS.test(cmd) || GH_CLI.test(cmd) || CURL_PUBLISH.test(cmd))) {
    stop(`the check itself failed (${String(e?.message ?? e).split("\n")[0]}), so this commit, push or gh call is refused.`);
  }
  process.exit(0);
}
