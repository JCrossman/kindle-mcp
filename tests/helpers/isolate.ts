// Runs before every test file (vitest.config.ts). Each file runs as if on a clean machine: no Kindle, vault or privacy
// settings from the developer's shell, a temporary home, and a temporary folder that is removed afterwards. A test can
// never reach a reader's real store, sign-in or vault, whatever is exported in the shell that runs it.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const KEEP = new Set(["KINDLE_BROWSER_PATH"]); // only says where Chrome is; the browser tests need it
for (const key of Object.keys(process.env)) {
  if ((/^(KINDLE_|OBSIDIAN_|PRIVATE_TERMS|PRIVACY_)/.test(key) && !KEEP.has(key)) || key === "CLAUDE_PLUGIN_ROOT") delete process.env[key];
}

const root = mkdtempSync(join(tmpdir(), "kindle-test-"));
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = process.env.USERPROFILE = home; // os.homedir() and ~/.kindle-mcp now point here
process.env.TMPDIR = process.env.TMP = process.env.TEMP = root; // os.tmpdir() too, so temp folders go with it

afterAll(() => rmSync(root, { recursive: true, force: true }));
