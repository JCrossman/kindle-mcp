import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { COMMANDS, commandsTable } from "../src/commands.js";
import { loadConfig } from "../src/config.js";
import { createServer, routePendingPrompt } from "../src/server.js";

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
  it("README names every tool the server offers and every setting it reads", async () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createServer(loadConfig({ KINDLE_MCP_HOME: mkdtempSync(join(tmpdir(), "kindle-docs-")) })).connect(serverT);
    const client = new Client({ name: "docs", version: "0" });
    await client.connect(clientT);
    for (const t of (await client.listTools()).tools) expect(readme).toContain(`\`${t.name}\``);
    const config = readFileSync(join(root, "src", "config.ts"), "utf8");
    for (const [, key] of config.matchAll(/(?:setting|flag)\(env, "([A-Z_]+)"/g)) expect(readme).toContain(`\`${key}\``);
    await client.close();
  });
  it("README and CLAUDE.md carry no account totals", () => {
    for (const f of ["README.md", "CLAUDE.md"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text).not.toMatch(/\b\d+ books?\b|\b\d+ (?:highlights|annotations)\b/);
    }
  });
});
