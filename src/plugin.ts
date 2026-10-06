/**
 * The plugin for Claude Code and Cowork, its marketplace entry, and the standalone router skill,
 * generated from package.json and the prompts so they can't drift from the server (a test compares
 * the committed files with this). `npm run render-plugin` writes them.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import { routePendingPrompt, weeklyBriefPrompt } from "./server.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string; license: string; keywords: string[] };

export const PLUGIN_NAME = "kindle";
export const MARKETPLACE_NAME = "kindle-mcp";
const REPO = "https://github.com/JCrossman/kindle-mcp";
const AUTHOR = { name: "Jeremy Crossman", url: "https://github.com/JCrossman" };
const DESCRIPTION =
  "Your Kindle highlights and notes as tools for Claude, and an Obsidian vault that keeps itself linked: the " +
  "kindle-mcp server, plus skills to set it up, sync on a schedule, carry out @commands and write a weekly brief.";

/** What a plugin version runs: the Desktop bundle attached to that version's GitHub release. */
export function bundleUrl(version = pkg.version): string {
  return `${REPO}/releases/download/v${version}/kindle-mcp-server-${version}.mcpb`;
}

export const promptText = (name: string): string => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");

/** A SKILL.md: frontmatter values are JSON-quoted, which YAML reads as plain strings. */
function skill(front: Record<string, string | boolean>, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Every generated file, by path from the repository root. */
export function pluginFiles(): Record<string, string> {
  const manifest = {
    name: PLUGIN_NAME,
    version: pkg.version,
    description: DESCRIPTION,
    author: AUTHOR,
    homepage: REPO,
    repository: REPO,
    license: pkg.license,
    keywords: pkg.keywords,
    mcpServers: bundleUrl(),
  };
  const marketplace = {
    name: MARKETPLACE_NAME,
    description: "kindle-mcp for Claude Code and Cowork",
    owner: AUTHOR,
    plugins: [{ name: PLUGIN_NAME, source: "./plugin", description: DESCRIPTION, version: pkg.version }],
  };
  return {
    ".claude-plugin/marketplace.json": json(marketplace),
    "plugin/.claude-plugin/plugin.json": json(manifest),
    "plugin/skills/setup/SKILL.md": skill(
      {
        name: "setup",
        description:
          "Set up kindle-mcp step by step: check the connection, sign in to Amazon, choose the Obsidian vault, run " +
          "a first sync and schedule a routine. Use when the user has just installed the Kindle plugin or asks to " +
          "set up Kindle syncing.",
      },
      promptText("setup"),
    ),
    "plugin/skills/routine/SKILL.md": skill(
      {
        name: "routine",
        description:
          "The unattended Kindle sync for a scheduled routine: sync, carry out waiting @commands, summarize. Put " +
          "/kindle:routine in a routine's instructions.",
        "disable-model-invocation": true,
      },
      `# Unattended Kindle sync\n\n${promptText("routine")}`,
    ),
    "plugin/skills/route/SKILL.md": skill(
      {
        name: "route",
        description:
          "Carry out pending Kindle @commands (@post, @research, @todo, @project, @quote), saving each result " +
          "with kindle_complete_command. Use when asked to process, route or action Kindle notes.",
        "argument-hint": "[tag] [dry run]",
      },
      "If the user named a tag (such as research) or asked for a dry run (here: $ARGUMENTS), handle only that " +
        "tag, or list what you would do and write nothing.\n\n" +
        routePendingPrompt(),
    ),
    "plugin/skills/brief/SKILL.md": skill(
      {
        name: "brief",
        description:
          "Write the reader's weekly reading brief from their recent Kindle highlights: themes, cited angles, " +
          "tasks. Use when asked for a reading brief or what they have been reading lately.",
        "argument-hint": "[span, e.g. 14d]",
      },
      `If the user gave a span or a date (here: $ARGUMENTS), use it instead of 7d.\n\n${weeklyBriefPrompt("7d")}`,
    ),
    // The router as a standalone skill, for Claude Code without the plugin (a copy for people who load only the skill).
    "skills/kindle-router/SKILL.md":
      "---\nname: kindle-router\ndescription: Carry out pending Kindle @commands (@post, @research, @todo, @project, " +
      "@quote) through the kindle MCP server, saving each result with kindle_complete_command. Use when asked to " +
      "process, route or action Kindle notes, or from a scheduled run.\n---\n" +
      routePendingPrompt(),
  };
}
