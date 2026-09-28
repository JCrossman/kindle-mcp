import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

import { COMMANDS, commandsTable } from "../src/commands.js";
import { loadConfig, SETTING_ENV } from "../src/config.js";
import { bundleUrl, pluginFiles, promptText } from "../src/plugin.js";
import { createServer, routePendingPrompt, SERVER_VERSION } from "../src/server.js";

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
  it("README names every tool the server offers, no tool it lacks, and every setting it reads", async () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createServer(loadConfig({ KINDLE_MCP_HOME: mkdtempSync(join(tmpdir(), "kindle-docs-")) })).connect(serverT);
    const client = new Client({ name: "docs", version: "0" });
    await client.connect(clientT);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const t of tools) expect(readme).toContain(`\`${t}\``);
    // And the other way round: a renamed tool must not leave the routine prompt or a table behind.
    const known = [...tools, ...(await client.listPrompts()).prompts.map((p) => p.name)];
    const shipped = readme.split("\n## Next\n")[0]; // Next names tools that don't exist yet
    for (const [name] of shipped.matchAll(/\bkindle_[a-z_]+\b/g)) expect(known).toContain(name);
    const config = readFileSync(join(root, "src", "config.ts"), "utf8");
    for (const [, key] of config.matchAll(/setting\(env, "([A-Z_]+)"/g)) expect(readme).toContain(`\`${key}\``);
    for (const [name, key] of Object.entries(SETTING_ENV)) {
      expect(readme).toContain(`\`${key}\``);
      expect(readme).toContain(`\`${name}\``); // the config file key
    }
    await client.close();
  });
  it("README and CLAUDE.md carry no account totals", () => {
    for (const f of ["README.md", "CLAUDE.md"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text).not.toMatch(/\b\d+ books?\b|\b\d+ (?:highlights|annotations)\b/);
    }
  });

});

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

describe("the plugin stays in sync with the server", () => {
  it("every generated file is committed as generated (npm run render-plugin), and nothing else is in plugin/", () => {
    const files = pluginFiles();
    for (const [rel, content] of Object.entries(files)) expect(readFileSync(join(root, rel), "utf8"), rel).toBe(content);
    const committed = walk(join(root, "plugin")).map((f) => relative(root, f).split("\\").join("/"));
    expect(committed.sort()).toEqual(Object.keys(files).filter((k) => k.startsWith("plugin/")).sort());
    // A bin/ folder makes chat and Cowork refuse the whole plugin.
    expect(existsSync(join(root, "plugin", "bin"))).toBe(false);
  });
  it("runs this version's bundle, and the marketplace lists this version", () => {
    const manifest = JSON.parse(readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest.version).toBe(SERVER_VERSION);
    expect(manifest.mcpServers).toBe(bundleUrl(SERVER_VERSION));
    expect(manifest.mcpServers).toBe(`https://github.com/JCrossman/kindle-mcp/releases/download/v${SERVER_VERSION}/kindle-mcp-server-${SERVER_VERSION}.mcpb`);
    const market = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(market.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: "./plugin", version: SERVER_VERSION })]);
  });
  it("skills name only tools and prompts the server has", async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createServer(loadConfig({ KINDLE_MCP_HOME: mkdtempSync(join(tmpdir(), "kindle-docs-")) })).connect(serverT);
    const client = new Client({ name: "docs", version: "0" });
    await client.connect(clientT);
    const known = [...(await client.listTools()).tools.map((t) => t.name), ...(await client.listPrompts()).prompts.map((p) => p.name)];
    for (const [rel, content] of Object.entries(pluginFiles())) {
      if (!rel.endsWith("SKILL.md")) continue;
      for (const [name] of content.matchAll(/\bkindle_[a-z_]+\b/g)) expect(known, `${rel} names ${name}`).toContain(name);
    }
    await client.close();
  });
  it("the README carries the routine prompt word for word", () => {
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain(promptText("routine"));
  });
});
