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
});
