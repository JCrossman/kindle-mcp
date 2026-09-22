/** Paths and settings. Everything is overridable by environment variable. */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
}

function expand(p: string): string {
  return resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = expand(env.KINDLE_MCP_HOME || join(homedir(), ".kindle-mcp"));
  const vault = env.OBSIDIAN_VAULT;
  return {
    home,
    dbPath: expand(env.KINDLE_MCP_DB || join(home, "kindle.db")),
    browserProfile: join(home, "browser-profile"),
    sessionPath: join(home, "session.json"),
    notebookBase: (env.KINDLE_NOTEBOOK_BASE || "https://read.amazon.com").replace(/\/+$/, ""),
    obsidianVault: vault ? expand(vault) : null,
    obsidianFolder: env.OBSIDIAN_FOLDER || "Kindle",
    requestDelayMs: Math.round(parseFloat(env.KINDLE_REQUEST_DELAY || "1.5") * 1000),
    onPending: env.KINDLE_ON_PENDING || null,
  };
}

export function ensureDirs(cfg: Config): void {
  mkdirSync(cfg.home, { recursive: true });
  mkdirSync(cfg.browserProfile, { recursive: true });
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
}
