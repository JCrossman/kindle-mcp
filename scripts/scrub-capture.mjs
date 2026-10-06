#!/usr/bin/env node
// Turn a live capture (a `kindle-mcp doctor` page, a saved notebook page, a My Clippings.txt) into a fixture that
// holds no reader data, then refuse to write it unless scripts/privacy-check.mjs accepts the result.
//
//   node scripts/scrub-capture.mjs IN OUT          (the capture is never read by anything else, never committed)
//
// What goes: titles, authors, highlights, notes (command tags stay; other tags and every other word become
// placeholders), ASINs, the encoded annotation ids (and the account inside them), cover and link URLs, tokens,
// dates of reading activity, and the counts. What stays: the markup, locations, pages and colours, which is what
// the selectors and the parser need. The output may only use words from tests/fixtures/VOCABULARY.txt; if the page
// has chrome the vocabulary lacks, the reader decides about adding it, not the scrubber.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_TAGS, describeSources, formatFindings, loadTerms, scanFile } from "./privacy-lib.mjs";

process.removeAllListeners("warning");
const here = dirname(fileURLToPath(import.meta.url));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
const cheerio = createRequire(resolve(root, "package.json"))("cheerio");

const pad = (n, w = 4) => String(n).padStart(w, "0");
const fakeAsin = (n) => `B0FAKE${pad(n)}`;
// Mondays in the months the fixture vocabulary already has; the dates only need to look like dates.
const DATES = ["September 7", "September 14", "September 21", "September 28", "August 31", "August 24", "August 17", "August 10", "August 3"];
const fakeDate = (i) => `Monday ${DATES[i % DATES.length]}, 2026`;

/** Command tags stay (they are the product's own words); every other tag and every other word is replaced. */
export function scrubNote(text) {
  let tag = 0;
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      const m = w.match(/^@([\p{L}\p{N}_-]+)/u);
      if (!m) return "placeholder";
      return PUBLIC_TAGS.has(m[1].toLowerCase()) ? w : `@tag${++tag}`;
    })
    .join(" ");
}

export function scrubClippings(text) {
  const titles = new Map();
  let n = 0;
  const blocks = text.split("==========").map((block) => {
    const lines = block.replace(/^\r?\n/, "").split(/\r?\n/);
    if (lines.length < 3 || !lines[0].trim()) return block;
    const key = lines[0].replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!titles.has(key)) titles.set(key, titles.size + 1);
    const k = titles.get(key);
    const isNote = /^- Your Note/.test(lines[1]);
    const header = lines[1].replace(/Added on .*$/, "Added on Monday, September 7, 2026 9:00:00 AM");
    const body = lines.slice(2).join("\n").trim();
    const clean = !body ? "" : /^<You have reached the clipping limit/.test(body) ? body : isNote ? scrubNote(body) : `Placeholder clipping text ${++n}.`;
    return `\nPlaceholder Title ${k} (Author, Placeholder ${k})\n${header}\n\n${clean}\n`;
  });
  return blocks.join("==========").replace(/^\n/, "");
}

export function scrubPage(html) {
  const $ = cheerio.load(html);
  const asins = new Map(); // real -> fake
  const asinFor = (real) => (asins.has(real) ? asins.get(real) : (asins.set(real, fakeAsin(asins.size + 1)), asins.get(real)));
  // ASINs first: library rows are keyed by them, annotation pages carry them in hidden inputs.
  $(".kp-notebook-library-each-book").each((_, e) => void asinFor($(e).attr("id") ?? ""));
  $("#kp-notebook-asin, #kp-notebook-annotations-asin").each((_, e) => void asinFor($(e).attr("value") ?? ""));

  let book = 0;
  $(".kp-notebook-library-each-book").each((_, e) => {
    book++;
    $(e).find("h2").text(`Placeholder Title ${book}`);
    $(e).find("p").text(`By: Placeholder Author ${book}`);
    $(e).find("input[type=hidden]").each((__, i) => {
      if (/annotated-date/.test($(i).attr("id") ?? "")) $(i).attr("value", fakeDate(book - 1));
    });
  });
  $("h3.kp-notebook-metadata").text("Placeholder Title 1");
  $("h3.kp-notebook-metadata").next("p").text("Placeholder Author 1");
  let h = 0;
  $("[id=highlight]").each((_, e) => {
    if ($(e).text().trim()) $(e).text(`Placeholder highlight ${++h}.`);
  });
  $("[id=note]").each((_, e) => {
    const t = $(e).text().trim();
    if (t) $(e).text(scrubNote(t));
  });
  const notes = $("[id=note]").filter((_, e) => $(e).text().trim() !== "").length;
  if ($("#kp-notebook-annotation-count").length) {
    $("#kp-notebook-annotation-count").text(`${h} Highlights | ${notes} Notes`);
    $("#kp-notebook-annotation-count-formatted").attr("value", `${h}&nbsp;Highlights | ${notes}&nbsp;Notes`);
  }
  $("img[src^=http]").attr("src", "https://example.invalid/cover.jpg");
  $("a[href^=http]").each((_, e) => {
    const href = $(e).attr("href") ?? "";
    const asin = href.match(/\/dp\/([A-Z0-9]{10})/);
    $(e).attr("href", asin ? `https://amazon.com/dp/${asinFor(asin[1])}` : /^https?:\/\/(www\.)?amazon\.com\//.test(href) ? href.split("?")[0] : "https://example.invalid/");
  });
  $("input[type=hidden]").each((_, e) => {
    const v = $(e).attr("value") ?? "";
    if (/anti-csrf|token/i.test($(e).attr("name") ?? "") || (v.length > 20 && !/^B0/.test(v) && !/Highlights/.test(v))) $(e).attr("value", "REDACTED");
  });
  $("script").each((_, e) => void $(e).text("{}"));

  let out = $.html();
  for (const [real, fake] of asins) if (real) out = out.split(real).join(fake);
  // Encoded annotation ids: "<account>:<asin>:<position>:HIGHLIGHT:<uuid>" in base64.
  const ids = new Map();
  out = out.replace(/(?<![A-Za-z0-9_])[A-Za-z0-9_]{40,}/g, (token) => {
    if (!ids.has(token)) {
      const n = ids.size + 1;
      const decoded = Buffer.from(token.replace(/_/g, "/"), "base64").toString("utf8");
      const kind = /:NOTE:/.test(decoded) ? "NOTE" : "HIGHLIGHT";
      ids.set(token, Buffer.from(`ACCOUNTREDACTED:${fakeAsin(1)}:${n}:${kind}:00000000-0000-0000-0000-${pad(n, 12)}`).toString("base64").replace(/=+$/, ""));
    }
    return ids.get(token);
  });
  return out;
}

export function scrub(raw, name) {
  return /\.txt$/i.test(name) || /^=+$/m.test(raw) ? scrubClippings(raw) : scrubPage(raw);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error("usage: node scripts/scrub-capture.mjs IN OUT");
    process.exit(2);
  }
  const scrubbed = scrub(readFileSync(input, "utf8"), input);
  const terms = await loadTerms();
  const findings = scanFile("tests/fixtures/" + output.split("/").pop(), scrubbed, { terms: terms.size ? terms : null, root });
  if (findings.length) {
    console.error(describeSources(terms));
    console.error(formatFindings(findings));
    console.error(`\nscrub-capture: ${findings.length} finding(s) left after scrubbing; nothing was written. The reader decides whether the page chrome above is allowed (VOCABULARY.txt).`);
    process.exit(1);
  }
  writeFileSync(output, scrubbed);
  console.error(`scrub-capture: wrote ${output} (${describeSources(terms)})`);
}
