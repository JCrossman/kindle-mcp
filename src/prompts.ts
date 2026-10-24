/**
 * The prompt texts in `prompts/`: the router and the weekly brief (served as MCP prompts and printed by
 * `kindle-mcp prompt`) and the skills' bodies. Kept apart from the server, so the CLI and the plugin
 * renderer read them without loading the MCP SDK or the store.
 */
import { readFileSync } from "node:fs";

import { actionsTable, resolveTag } from "./commands.js";

/** One of the markdown files in prompts/, as written. */
export const promptText = (name: string): string => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");

function fill(name: string, vars: Record<string, string>): string {
  let text = promptText(name);
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return text;
}

export function routePendingPrompt(tag?: string, dryRun = false): string {
  const t = tag?.trim() ? resolveTag(tag) : "";
  return fill("route-pending", {
    commands_table: actionsTable(),
    tag_clause: t ? ` and \`tag\` = \`${t}\`` : "",
    dry_run_clause: dryRun
      ? "\n**DRY RUN.** List what you would do for each pending highlight. Write nothing anywhere, and do not call " +
        "`kindle_complete_command`, `kindle_mark_command_done` or `kindle_export_to_obsidian`.\n"
      : "",
  });
}

export function weeklyBriefPrompt(since = "7d"): string {
  return fill("weekly-brief", { since });
}
