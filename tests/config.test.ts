import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

  it("ignores a value of the wrong type for its key, with a warning", () => {
    const home = mkdtempSync(join(tmpdir(), "kindle-cfg-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({
      browser_path: false, obsidian_vault: 3, act_on_commands: "maybe", link_exclude: [1], auto_file: "no", obsidian_folder: "K",
    }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadConfig({ KINDLE_MCP_HOME: home });
    expect([cfg.browserPath, cfg.obsidianVault, cfg.actOnCommands, cfg.linkExclude, cfg.autoFile, cfg.obsidianFolder]).toEqual([null, null, true, [], false, "K"]);
    expect(warn.mock.calls[0][0]).toMatch(/ignoring obsidian_vault, act_on_commands, link_exclude, browser_path in .*: wrong type/);
  });

  it("changes the settings file one process at a time", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kindle-cfg-")), "config.json");
    writeSettingsFile(path, { obsidian_folder: "K" });
    expect(existsSync(`${path}.lock`)).toBe(false); // released after each write
    writeFileSync(`${path}.lock`, ""); // another process is writing
    expect(() => writeSettingsFile(path, { obsidian_folder: "X" }, 50)).toThrow(/being changed by another process/);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old); // ...or crashed long ago
    writeSettingsFile(path, { obsidian_folder: "Y" }, 50);
    expect([readSettingsFile(path).obsidian_folder, existsSync(`${path}.lock`)]).toEqual(["Y", false]);
  });

  it("writes settings without losing the others, and removes one with null", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kindle-cfg-")), "sub", "config.json");
    writeSettingsFile(path, { obsidian_vault: "/v", act_on_commands: false });
    writeSettingsFile(path, { obsidian_folder: "K" });
    expect(readSettingsFile(path)).toEqual({ obsidian_vault: "/v", act_on_commands: false, obsidian_folder: "K" });
    writeSettingsFile(path, { act_on_commands: null });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ obsidian_vault: "/v", obsidian_folder: "K" });
  });

  it("keeps what it doesn't know in the settings file, and never overwrites one it can't read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "kindle-cfg-")), "config.json");
    // A key from a newer version, and a value this version reads as the wrong type: both survive a write.
    writeFileSync(path, JSON.stringify({ future_key: { a: 1 }, link_exclude: { b: 2 } }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    writeSettingsFile(path, { obsidian_folder: "K" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ future_key: { a: 1 }, link_exclude: { b: 2 }, obsidian_folder: "K" });
    writeFileSync(path, "{ half-edited");
    expect(() => writeSettingsFile(path, { obsidian_folder: "X" })).toThrow(/Left .*config\.json unchanged/);
    expect(readFileSync(path, "utf8")).toBe("{ half-edited");
    writeFileSync(path, "\n"); // empty: nothing to keep
    writeSettingsFile(path, { obsidian_folder: "Y" });
    expect(readSettingsFile(path)).toEqual({ obsidian_folder: "Y" });
  });

  it("accepts only an Obsidian vault as the vault", () => {
    const dir = mkdtempSync(join(tmpdir(), "kindle-vault-"));
    expect(vaultProblem(join(dir, "missing"))).toMatch(/There is no folder/);
    expect(vaultProblem("Documents/Notes")).toMatch(/full path/);
    expect(vaultProblem(dir)).toMatch(/isn't an Obsidian vault/);
    writeFileSync(join(dir, ".obsidian"), "not a folder");
    expect(vaultProblem(dir)).toMatch(/isn't an Obsidian vault/);
    const other = mkdtempSync(join(tmpdir(), "kindle-vault-"));
    mkdirSync(join(other, ".obsidian"));
    expect(vaultProblem(`${other} `)).toBeNull();
    mkdirSync(join(dir, "sub", ".obsidian"), { recursive: true });
    expect(vaultProblem(join(dir, "sub"))).toBeNull();
    const plain = mkdtempSync(join(tmpdir(), "kindle-vault-"));
    mkdirSync(join(plain, ".obsidian"));
    expect(vaultProblem(plain)).toBeNull();
  });
});
