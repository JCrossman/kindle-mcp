import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("treats unexpanded bundle placeholders as unset", () => {
    const cfg = loadConfig({
      KINDLE_MCP_HOME: "${user_config.kindle_home}",
      OBSIDIAN_VAULT: "${user_config.obsidian_vault}",
      OBSIDIAN_FOLDER: "${user_config.obsidian_folder}",
      KINDLE_BROWSER_PATH: "${user_config.browser_path}",
    });
    expect(cfg.home).toBe(join(homedir(), ".kindle-mcp"));
    expect(cfg.obsidianVault).toBeNull();
    expect(cfg.obsidianFolder).toBe("Kindle");
    expect(cfg.browserPath).toBeNull();
  });
  it("treats an unexpanded ${HOME} default as unset rather than a literal folder", () => {
    expect(loadConfig({ KINDLE_MCP_HOME: "${HOME}/.kindle-mcp" }).home).toBe(join(homedir(), ".kindle-mcp"));
  });
  it("keeps real values, including shell references inside the on-pending command", () => {
    const cfg = loadConfig({ KINDLE_MCP_HOME: "/data/kindle", OBSIDIAN_VAULT: "/vault", KINDLE_ON_PENDING: 'claude -p "${PROMPT}"', KINDLE_REQUEST_DELAY: "2" });
    expect(cfg.home).toBe("/data/kindle");
    expect(cfg.obsidianVault).toBe("/vault");
    expect(cfg.onPending).toBe('claude -p "${PROMPT}"');
    expect(cfg.requestDelayMs).toBe(2000);
    expect(loadConfig({ KINDLE_ON_PENDING: "${user_config.hook}" }).onPending).toBeNull();
    expect(loadConfig({ KINDLE_REQUEST_DELAY: "soon" }).requestDelayMs).toBe(1500);
  });
  it("reads the 1.1 settings: on by default, off by word, placeholders ignored", () => {
    const d = loadConfig({});
    expect([d.actOnCommands, d.autoFile, d.linkNotes, d.linkExclude, d.syncBudgetMs]).toEqual([true, true, true, [], 40_000]);
    const off = loadConfig({ KINDLE_ACT_ON_COMMANDS: "false", KINDLE_AUTO_FILE: "0", KINDLE_LINK_NOTES: "No", KINDLE_LINK_EXCLUDE: " Journal , Private/Health ,", KINDLE_SYNC_BUDGET_MS: "5000" });
    expect([off.actOnCommands, off.autoFile, off.linkNotes, off.linkExclude, off.syncBudgetMs]).toEqual([false, false, false, ["Journal", "Private/Health"], 5000]);
    const unset = loadConfig({ KINDLE_ACT_ON_COMMANDS: "${user_config.act_on_commands}", KINDLE_LINK_EXCLUDE: "${user_config.link_exclude}" });
    expect([unset.actOnCommands, unset.linkExclude]).toEqual([true, []]);
    expect(loadConfig({ OBSIDIAN_FOLDER: "\\Reading\\Kindle\\" }).obsidianFolder).toBe("Reading/Kindle");
    expect(loadConfig({ OBSIDIAN_FOLDER: "../outside" }).obsidianFolder).toBe("Kindle");
  });
});
