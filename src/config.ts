/** Paths and settings. Everything is overridable by environment variable. */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { normalizeFolder } from "./vault/write.js";

export interface Config {
  home: string;
  dbPath: string;
  browserProfile: string;
  /** Amazon session cookies captured by `kindle-mcp login`. Treat like a credential. */
  sessionPath: string;
  notebookBase: string;
  obsidianVault: string | null;
  obsidianFolder: string;
  requestDelayMs: number;
  /** Shell command run after a sync that leaves @commands pending (KINDLE_ON_PENDING). */
  onPending: string | null;
  /** Explicit browser executable for login/doctor/--browser (KINDLE_BROWSER_PATH); else Chrome, Edge, bundled Chromium. */
  browserPath: string | null;
  /** After a sync, tell the agent to do pending @post/@research now rather than offer (KINDLE_ACT_ON_COMMANDS). */
  actOnCommands: boolean;
  /** File @todo, @quote and @project into the vault during sync (KINDLE_AUTO_FILE). */
  autoFile: boolean;
  /** Link mentions of vault notes in what is written (KINDLE_LINK_NOTES). */
  linkNotes: boolean;
  /** Vault folders never linked to or searched, on top of Obsidian's own exclusions (KINDLE_LINK_EXCLUDE). */
  linkExclude: string[];
  /** How long one kindle_sync call may spend before returning a partial result (KINDLE_SYNC_BUDGET_MS). */
  syncBudgetMs: number;
  /** `<home>/config.json`: settings kept for every client; the environment overrides each one. */
  settingsPath: string;
  /** Where each file-backed setting came from. */
  sources: Record<SettingKey, SettingSource>;
  /** Started by a Claude plugin (CLAUDE_PLUGIN_ROOT is set): no settings screen, the file decides. */
  inPlugin: boolean;
}

/**
 * Settings that can live in `<data folder>/config.json`, so every client (the Desktop extension,
 * the plugin in Claude Code and Cowork, the command line, cron) shares them. Keys are the Desktop
 * extension's setting names; each has an environment variable that overrides it.
 */
export const SETTING_ENV = {
  obsidian_vault: "OBSIDIAN_VAULT",
  obsidian_folder: "OBSIDIAN_FOLDER",
  act_on_commands: "KINDLE_ACT_ON_COMMANDS",
  auto_file: "KINDLE_AUTO_FILE",
  link_notes: "KINDLE_LINK_NOTES",
  link_exclude: "KINDLE_LINK_EXCLUDE",
  browser_path: "KINDLE_BROWSER_PATH",
} as const;
export type SettingKey = keyof typeof SETTING_ENV;
export type SettingSource = "environment" | "config file" | "default";
export type SettingsFile = Partial<Record<SettingKey, string | boolean | string[]>>;

/**
 * A setting as the host passed it, or null when it is unset or still an unexpanded placeholder.
 * MCP bundle hosts substitute `${user_config.x}` and `${HOME}`; a host that leaves an optional,
 * unset one in place must not turn it into a folder literally named `${user_config.x}`. Shell
 * commands keep their own `${VAR}` references, so only `${user_config.*}` counts there.
 */
function setting(env: NodeJS.ProcessEnv, key: string, kind: "path" | "shell" = "path"): string | null {
  const v = env[key]?.trim();
  if (!v) return null;
  if (/\$\{user_config\.[^}]*\}/.test(v)) return null;
  if (kind === "path" && /\$\{[^}]*\}/.test(v)) return null;
  return v;
}

/** An absolute path, with a leading `~` meaning the home folder. */
export function expand(p: string): string {
  return resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
}

/** Whether a settings-file value has the right type for its key (text for paths, on/off for switches). */
function validSetting(key: SettingKey, v: unknown): boolean {
  switch (key) {
    case "obsidian_vault":
    case "obsidian_folder":
    case "browser_path":
      return typeof v === "string";
    case "act_on_commands":
    case "auto_file":
    case "link_notes":
      return typeof v === "boolean" || (typeof v === "string" && parseOnOff(v) !== null);
    case "link_exclude":
      return typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
  }
}

/** The file's JSON object as written, {} when there is none (or it is empty); throws if it isn't one. */
function readSettingsObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (!text.trim()) return {};
  const data = JSON.parse(text) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not a JSON object");
  return data as Record<string, unknown>;
}

/**
 * The settings file, or {} when there is none. An unreadable file, and any value of the wrong type
 * for its key, is ignored with a warning (stderr).
 */
export function readSettingsFile(path: string): SettingsFile {
  try {
    const data = readSettingsObject(path);
    const out: SettingsFile = {};
    const wrong: string[] = [];
    for (const key of Object.keys(SETTING_ENV) as SettingKey[]) {
      const v = data[key];
      if (v === undefined) continue;
      if (validSetting(key, v)) out[key] = v as string | boolean | string[];
      else wrong.push(key);
    }
    if (wrong.length) console.error(`kindle-mcp: ignoring ${wrong.join(", ")} in ${path}: wrong type`);
    return out;
  } catch (e) {
    console.error(`kindle-mcp: ignoring ${path}: ${(e as Error).message}`);
    return {};
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` holding `<path>.lock`, so two processes (a chat, a routine, the command line) can't
 * read the same old file and overwrite each other's change. A lock older than 10 s is stale.
 */
function withSettingsLock<T>(path: string, waitMs: number, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) {
          unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // released meanwhile
      }
      if (Date.now() > until) throw new Error(`The settings file is being changed by another process (${lock}); try again.`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/**
 * Sets (or, with null, removes) keys in the settings file. Everything else in it stays as written,
 * including keys this version doesn't know (a newer one may have saved them). A file that isn't a
 * JSON object is left alone: the error says so.
 */
export function writeSettingsFile(
  path: string,
  patch: Partial<Record<SettingKey, string | boolean | string[] | null>>,
  waitMs = 2000,
): void {
  withSettingsLock(path, waitMs, () => {
    let next: Record<string, unknown>;
    try {
      next = { ...readSettingsObject(path) };
    } catch (e) {
      throw new Error(`Left ${path} unchanged: it can't be read (${(e as Error).message}). Fix or delete it, then try again.`);
    }
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  });
}

/** true/false/1/0/yes/no/on/off; null for anything else. */
export function parseOnOff(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (/^(0|false|no|off)$/.test(v)) return false;
  if (/^(1|true|yes|on)$/.test(v)) return true;
  return null;
}

/** The value in effect for a setting that can live in the settings file. */
export function settingValue(cfg: Config, key: SettingKey): string | boolean | string[] | null {
  switch (key) {
    case "obsidian_vault": return cfg.obsidianVault;
    case "obsidian_folder": return cfg.obsidianFolder;
    case "act_on_commands": return cfg.actOnCommands;
    case "auto_file": return cfg.autoFile;
    case "link_notes": return cfg.linkNotes;
    case "link_exclude": return cfg.linkExclude;
    case "browser_path": return cfg.browserPath;
  }
}

/** Null when the folder is an Obsidian vault kindle-mcp may write to, else why not. */
export function vaultProblem(path: string): string | null {
  // A relative path would resolve against wherever the server happened to start.
  if (!isAbsolute(path.trim()) && !path.trim().startsWith("~")) return `Give the vault's full path (starting with / or ~), not ${path}.`;
  const full = expand(path.trim());
  if (!existsSync(full) || !statSync(full).isDirectory()) return `There is no folder at ${full}.`;
  const marker = join(full, ".obsidian");
  if (!existsSync(marker) || !statSync(marker).isDirectory()) {
    return `${full} isn't an Obsidian vault: it has no .obsidian folder. Give the vault's top folder (open it in Obsidian once if it's new).`;
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = expand(setting(env, "KINDLE_MCP_HOME") ?? join(homedir(), ".kindle-mcp"));
  const settingsPath = join(home, "config.json");
  const file = readSettingsFile(settingsPath);
  const sources = {} as Record<SettingKey, SettingSource>;
  // A plugin's bundle has no settings screen, so what it passes are its defaults: a value saved in
  // the settings file beats them. Everywhere else the environment is the user's own choice and wins.
  const inPlugin = setting(env, "CLAUDE_PLUGIN_ROOT") !== null;
  /** The environment value, else the file's (as text), else null; records which one it was. */
  const pick = (key: SettingKey, kind: "path" | "shell" = "path"): string | null => {
    const v = file[key];
    const fromFile = (Array.isArray(v) ? v.join(",") : typeof v === "boolean" ? String(v) : v?.trim()) || null;
    const fromEnv = setting(env, SETTING_ENV[key], kind);
    if (fromEnv !== null && !(inPlugin && fromFile)) {
      sources[key] = "environment";
      return fromEnv;
    }
    sources[key] = fromFile ? "config file" : "default";
    return fromFile;
  };
  /** A true/false setting; unset, placeholder or unrecognised values keep the default. */
  const onOff = (key: SettingKey, fallback: boolean): boolean => parseOnOff(pick(key, "shell") ?? "") ?? fallback;
  const vault = pick("obsidian_vault");
  const browser = pick("browser_path");
  const delay = parseFloat(setting(env, "KINDLE_REQUEST_DELAY") ?? "1.5");
  return {
    home,
    dbPath: expand(setting(env, "KINDLE_MCP_DB") ?? join(home, "kindle.db")),
    browserProfile: join(home, "browser-profile"),
    sessionPath: join(home, "session.json"),
    notebookBase: (setting(env, "KINDLE_NOTEBOOK_BASE") ?? "https://read.amazon.com").replace(/\/+$/, ""),
    obsidianVault: vault ? expand(vault) : null,
    obsidianFolder: normalizeFolder(pick("obsidian_folder") ?? "Kindle"),
    requestDelayMs: Math.round((Number.isFinite(delay) ? delay : 1.5) * 1000),
    onPending: setting(env, "KINDLE_ON_PENDING", "shell"),
    browserPath: browser ? expand(browser) : null,
    actOnCommands: onOff("act_on_commands", true),
    autoFile: onOff("auto_file", true),
    linkNotes: onOff("link_notes", true),
    linkExclude: (pick("link_exclude", "shell") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    syncBudgetMs: Math.max(1, Number(setting(env, "KINDLE_SYNC_BUDGET_MS", "shell")) || 40_000),
    settingsPath,
    sources,
    inPlugin,
  };
}

export function ensureDirs(cfg: Config): void {
  mkdirSync(cfg.home, { recursive: true });
  mkdirSync(cfg.browserProfile, { recursive: true });
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
}
