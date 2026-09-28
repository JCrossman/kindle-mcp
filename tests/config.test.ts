import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig, readSettingsFile, vaultProblem, writeSettingsFile } from "../src/config.js";

// A developer's own ~/.kindle-mcp/config.json must not leak into these tests.
beforeEach(() => {
  vi.stubEnv("HOME", mkdtempSync(join(tmpdir(), "kindle-home-")));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

  it("reads the settings file, and the environment overrides it key by key", () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-cfg-"));
    const vault = mkdtempSync(join(tmpdir(), "kindle-vault-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      obsidian_vault: vault, obsidian_folder: "Reading/Kindle", act_on_commands: false, link_exclude: ["Journal", "Private"], unknown: 1,
    }));
    const cfg = loadConfig({ KINDLE_MCP_HOME: home });
    expect([cfg.obsidianVault, cfg.obsidianFolder, cfg.actOnCommands, cfg.linkExclude]).toEqual([vault, "Reading/Kindle", false, ["Journal", "Private"]]);
    expect(cfg.sources).toMatchObject({ obsidian_vault: "config file", act_on_commands: "config file", auto_file: "default" });
    expect(cfg.settingsPath).toBe(join(home, "config.json"));

    const env = loadConfig({ KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: "/elsewhere", KINDLE_ACT_ON_COMMANDS: "true" });
    expect([env.obsidianVault, env.actOnCommands, env.obsidianFolder]).toEqual(["/elsewhere", true, "Reading/Kindle"]);
    expect(env.sources).toMatchObject({ obsidian_vault: "environment", obsidian_folder: "config file" });

    // What an extension or plugin passes for a setting left empty: the file still applies.
    const empty = loadConfig({ KINDLE_MCP_HOME: home, OBSIDIAN_VAULT: "", OBSIDIAN_FOLDER: "${user_config.obsidian_folder}" });
    expect([empty.obsidianVault, empty.obsidianFolder]).toEqual([vault, "Reading/Kindle"]);
  });

  it("inside a plugin, the settings file beats the bundle's built-in defaults", () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-cfg-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ act_on_commands: false, obsidian_folder: "Reading" }));
    // What a plugin's bundle passes: its defaults, since it has no settings screen.
    const bundle = { KINDLE_MCP_HOME: home, KINDLE_ACT_ON_COMMANDS: "true", KINDLE_AUTO_FILE: "true", OBSIDIAN_FOLDER: "" };
    const plugin = loadConfig({ ...bundle, CLAUDE_PLUGIN_ROOT: "/plugins/kindle" });
    expect([plugin.inPlugin, plugin.actOnCommands, plugin.autoFile, plugin.obsidianFolder]).toEqual([true, false, true, "Reading"]);
    expect(plugin.sources).toMatchObject({ act_on_commands: "config file", auto_file: "environment" });
    // The Desktop extension passes what the user set in its settings: that wins.
    const extension = loadConfig(bundle);
    expect([extension.inPlugin, extension.actOnCommands]).toEqual([false, true]);
  });

  it("ignores an unreadable settings file, with a warning", () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-cfg-"));
    writeFileSync(join(home, "config.json"), "{ not json");
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(loadConfig({ KINDLE_MCP_HOME: home }).obsidianVault).toBeNull();
    expect(warn.mock.calls[0][0]).toMatch(/ignoring .*config\.json/);
  });

  it("writes settings without losing the others, and removes one with null", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kindle-cfg-")), "sub", "config.json");
    writeSettingsFile(path, { obsidian_vault: "/v", act_on_commands: false });
    writeSettingsFile(path, { obsidian_folder: "K" });
    expect(readSettingsFile(path)).toEqual({ obsidian_vault: "/v", act_on_commands: false, obsidian_folder: "K" });
    writeSettingsFile(path, { act_on_commands: null });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ obsidian_vault: "/v", obsidian_folder: "K" });
  });

  it("accepts only an Obsidian vault as the vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindle-vault-"));
    expect(vaultProblem(join(dir, "missing"))).toMatch(/There is no folder/);
    expect(vaultProblem("Documents/Notes")).toMatch(/full path/);
    expect(vaultProblem(dir)).toMatch(/isn't an Obsidian vault/);
    mkdirSync(join(dir, ".obsidian"));
    expect(vaultProblem(dir)).toBeNull();
  });
});
