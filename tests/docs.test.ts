import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { COMMANDS, commandsTable } from "../src/commands.js";
import { routePendingPrompt } from "../src/server.js";

const root = join(__dirname, "..");

describe("docs stay in sync with COMMANDS", () => {
  it("README carries the generated command table", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain(commandsTable());
    for (const c of COMMANDS) {
      expect(readme).toContain(`\`@${c.tag}\``);
      for (const a of c.aliases) expect(readme).toContain(`\`@${a}\``);
    }
  });
  it("the Claude Code skill is the router prompt verbatim", () => {
    const skill = readFileSync(join(root, "skills", "kindle-router", "SKILL.md"), "utf8");
    const body = skill.replace(/^---[\s\S]*?---\n/, "");
    expect(body).toBe(routePendingPrompt());
    expect(skill.startsWith("---\nname: kindle-router\n")).toBe(true);
  });
});
