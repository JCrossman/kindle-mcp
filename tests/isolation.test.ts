import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { pendingInstruction } from "../src/server.js";

describe("the test run is isolated from the developer's machine", () => {
  it("drops Kindle, vault and privacy settings from the shell, and uses a temporary home", () => {
    const leaked = Object.keys(process.env).filter((k) => /^(KINDLE_|OBSIDIAN_|PRIVATE_TERMS|PRIVACY_)/.test(k) && k !== "KINDLE_BROWSER_PATH");
    expect(leaked).toEqual([]);
    expect(homedir().startsWith(tmpdir())).toBe(true);
    const cfg = loadConfig();
    expect(cfg.dbPath.startsWith(tmpdir())).toBe(true); // never ~/.kindle-mcp/kindle.db on the real machine
    expect(cfg.obsidianVault).toBeNull();
  });
});

describe("pending @commands when the vault can't be written", () => {
  it("says so, and doesn't send results to the reply or mark them done", () => {
    const text = pendingInstruction(true, "broken", false);
    expect(text).toContain("couldn't be written");
    expect(text).toContain("don't mark them done");
    expect(text).not.toContain("no Obsidian vault is set");
    expect(pendingInstruction(true, "none", false)).toContain("no Obsidian vault is set");
    expect(pendingInstruction(true, "ready", false)).toContain("kindle_complete_command");
  });
});
