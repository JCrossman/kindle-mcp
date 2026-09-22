// Build the Claude Desktop bundle (.mcpb): a manifest generated from the live server, the compiled
// code, the router skill, and production node_modules, packed with @anthropic-ai/mcpb.
//   npm run build && node scripts/build-mcpb.mjs        -> kindle-mcp-server-<version>.mcpb
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "dist/cli.js"))) throw new Error("run `npm run build` first");
const { createServer } = await import(join(root, "dist/server.js"));
const { loadConfig } = await import(join(root, "dist/config.js"));

// Ask the server itself what it offers, so the manifest cannot drift from the code.
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await createServer(loadConfig({ KINDLE_MCP_HOME: join(root, "build", "mcpb-probe") })).connect(serverT);
const client = new Client({ name: "mcpb-build", version: "0" });
await client.connect(clientT);
const tools = (await client.listTools()).tools.map(({ name, description }) => ({ name, description }));
const prompts = [];
for (const p of (await client.listPrompts()).prompts) {
  const got = await client.getPrompt({ name: p.name });
  prompts.push({ name: p.name, description: p.description, arguments: (p.arguments ?? []).map((a) => a.name), text: got.messages[0].content.text });
}
await client.close();
rmSync(join(root, "build", "mcpb-probe"), { recursive: true, force: true });

const manifest = {
  manifest_version: "0.3",
  name: pkg.name,
  display_name: "Kindle highlights",
  version: pkg.version,
  description: "Your Kindle highlights and notes as tools for Claude, plus a router for @commands you type on the Kindle.",
  long_description:
    "Syncs read.amazon.com/notebook into a local SQLite store with full-text search, exposes it as MCP tools, " +
    "and turns notes like `@post`, `@research` and `@todo` into drafts, research and tasks through the " +
    "kindle_route_pending prompt. Sign in once with the kindle_login tool; your Amazon password is never seen " +
    "or stored. Everything runs on this machine; nothing is sent anywhere but Amazon.",
  author: { name: "Jeremy Crossman", url: "https://github.com/JCrossman" },
  repository: { type: "git", url: "https://github.com/JCrossman/kindle-mcp" },
  homepage: "https://github.com/JCrossman/kindle-mcp",
  documentation: "https://github.com/JCrossman/kindle-mcp#readme",
  support: "https://github.com/JCrossman/kindle-mcp/issues",
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: "node",
    entry_point: "dist/cli.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/cli.js", "serve"],
      env: {
        KINDLE_MCP_HOME: "${user_config.kindle_home}",
        OBSIDIAN_VAULT: "${user_config.obsidian_vault}",
        OBSIDIAN_FOLDER: "${user_config.obsidian_folder}",
        KINDLE_BROWSER_PATH: "${user_config.browser_path}",
      },
    },
  },
  tools,
  tools_generated: false,
  prompts,
  prompts_generated: false,
  user_config: {
    kindle_home: {
      type: "directory",
      title: "Data folder",
      description: "Where the highlight database and the saved Amazon session live. Treat it as private.",
      default: "${HOME}/.kindle-mcp",
      required: false,
    },
    obsidian_vault: {
      type: "directory",
      title: "Obsidian vault (optional)",
      description: "If set, kindle_export_to_obsidian writes one note per book here and the router files its output under Inbox.",
      required: false,
    },
    obsidian_folder: {
      type: "string",
      title: "Folder inside the vault",
      description: "Subfolder for the Kindle notes.",
      default: "Kindle",
      required: false,
    },
    browser_path: {
      type: "file",
      title: "Browser executable (optional)",
      description: "Only if neither Chrome nor Edge is installed: any Chromium-based browser, used for the one-time sign-in.",
      required: false,
    },
  },
  compatibility: { claude_desktop: ">=0.10.0", platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=22.13.0" } },
};

const stage = join(root, "build", "mcpb");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
for (const f of ["dist", "skills", "README.md", "LICENSE", "package.json", "package-lock.json"]) cpSync(join(root, f), join(stage, f), { recursive: true });
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: stage, stdio: "inherit" });
rmSync(join(stage, "package-lock.json"));

const mcpb = join(root, "node_modules", ".bin", "mcpb");
execFileSync(mcpb, ["validate", join(stage, "manifest.json")], { stdio: "inherit" });
const out = join(root, `${pkg.name}-${pkg.version}.mcpb`);
rmSync(out, { force: true });
execFileSync(mcpb, ["pack", stage, out], { stdio: "inherit" });
console.log(`\nbundle: ${out}`);
