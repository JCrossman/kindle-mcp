#!/usr/bin/env node
// Fails (exit 1) if anything from a reader's library is in the repository. See scripts/privacy-lib.mjs.
//
//   node scripts/privacy-check.mjs                    the working tree: tracked files and new, unignored ones
//   node scripts/privacy-check.mjs --staged           what is staged for the next commit
//   node scripts/privacy-check.mjs --message FILE     a commit message
//   node scripts/privacy-check.mjs --range <rev-list args>   messages and added lines of those commits
//   --show-words   print the words the fixture vocabulary rule rejects (default: first letter and length only)
//
// Private terms come from PRIVATE_TERMS, ~/.kindle-mcp/private-terms.txt and the reader's kindle.db.
// PRIVACY_REQUIRE_TERMS=1 makes "no term source available" a failure (CI on push, and the publish workflow).
process.removeAllListeners("warning"); // node:sqlite prints an experimental notice
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeSources, formatFindings, loadTerms, scanFile, scanRange, scanStaged, scanTree } from "./privacy-lib.mjs";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolve(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" }).trim();
const argv = process.argv.slice(2);
const showWords = argv.includes("--show-words");
const rest = argv.filter((a) => a !== "--show-words");

const terms = await loadTerms();
const opts = { terms: terms.size ? terms : null, root, showWords };
let findings;
if (rest[0] === "--staged") findings = scanStaged(root, opts);
else if (rest[0] === "--message") findings = scanFile("commit message", readFileSync(rest[1], "utf8"), { terms: opts.terms, root });
else if (rest[0] === "--range") findings = scanRange(root, rest.slice(1), opts);
else findings = scanTree(root, opts);

console.error(describeSources(terms));
if (process.env.PRIVACY_REQUIRE_TERMS && !terms.size) {
  console.error("privacy: no source of private terms here, and one is required (PRIVACY_REQUIRE_TERMS is set). Is the PRIVATE_TERMS secret missing?");
  process.exit(1);
}
if (findings.length) {
  console.error(formatFindings(findings));
  console.error(
    `\nprivacy: ${findings.length} finding(s). Nothing from a reader's library may be in this repository. Replace it with invented\n` +
      "placeholder text; do not add words to tests/fixtures/VOCABULARY.txt, edit the guard or skip the hook to get past this.\n" +
      "Ask the reader if a finding looks wrong.",
  );
  process.exit(1);
}
console.error("privacy: clean");
