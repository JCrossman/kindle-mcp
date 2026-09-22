/** Paths and settings. Everything is overridable by environment variable. */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
}

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

/** A true/false setting; unset, placeholder or unrecognised values keep the default. */
function flag(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const v = setting(env, key, "shell")?.toLowerCase();
  if (v && /^(0|false|no|off)$/.test(v)) return false;
  if (v && /^(1|true|yes|on)$/.test(v)) return true;
  return fallback;
}

function expand(p: string): string {
  return resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = expand(setting(env, "KINDLE_MCP_HOME") ?? join(homedir(), ".kindle-mcp"));
  const vault = setting(env, "OBSIDIAN_VAULT");
  const browser = setting(env, "KINDLE_BROWSER_PATH");
  const delay = parseFloat(setting(env, "KINDLE_REQUEST_DELAY") ?? "1.5");
  return {
    home,
    dbPath: expand(setting(env, "KINDLE_MCP_DB") ?? join(home, "kindle.db")),
    browserProfile: join(home, "browser-profile"),
    sessionPath: join(home, "session.json"),
    notebookBase: (setting(env, "KINDLE_NOTEBOOK_BASE") ?? "https://read.amazon.com").replace(/\/+$/, ""),
    obsidianVault: vault ? expand(vault) : null,
    obsidianFolder: normalizeFolder(setting(env, "OBSIDIAN_FOLDER") ?? "Kindle"),
    requestDelayMs: Math.round((Number.isFinite(delay) ? delay : 1.5) * 1000),
    onPending: setting(env, "KINDLE_ON_PENDING", "shell"),
    browserPath: browser ? expand(browser) : null,
    actOnCommands: flag(env, "KINDLE_ACT_ON_COMMANDS", true),
    autoFile: flag(env, "KINDLE_AUTO_FILE", true),
    linkNotes: flag(env, "KINDLE_LINK_NOTES", true),
    linkExclude: (setting(env, "KINDLE_LINK_EXCLUDE", "shell") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    syncBudgetMs: Math.max(1, Number(setting(env, "KINDLE_SYNC_BUDGET_MS", "shell")) || 40_000),
  };
}

export function ensureDirs(cfg: Config): void {
  mkdirSync(cfg.home, { recursive: true });
  mkdirSync(cfg.browserProfile, { recursive: true });
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
}
