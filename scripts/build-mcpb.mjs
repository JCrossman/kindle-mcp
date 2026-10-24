// Build the Claude Desktop bundle (.mcpb): a manifest generated from the live server, the compiled
// code, the router skill, and production node_modules, packed with @anthropic-ai/mcpb. Then verify
// the packed file itself: unpack it and replay a host handshake against its entry point, with and
// without the host repeating the script path. Any failure fails the build.
//   npm run build && node scripts/build-mcpb.mjs        -> kindle-mcp-server-<version>.mcpb
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { handshake } from "./mcp-handshake.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (!existsSync(join(root, "dist/cli.js"))) throw new Error("run `npm run build` first");
const { createServer } = await import(join(root, "dist/server.js"));
const { loadConfig, SETTING_ENV } = await import(join(root, "dist/config.js"));

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
  description: "Your Kindle highlights and notes in Claude and in your Obsidian vault. Claude acts on the notes you type on the Kindle.",
  long_description:
    "With Obsidian, the highlights and notes from your Kindle Store books land in your vault, linked to the notes " +
    "you already have. Type a short note on a highlight, like @research, @post or @todo, and Claude carries it out " +
    "and saves the result in Obsidian, linked back to the highlight (or in the chat, without Obsidian). To start, " +
    "say \"Set up my Kindle\" in a chat. Your Amazon password is never seen or stored, and your highlights stay on " +
    "this computer: nothing is sent anywhere but Amazon, apart from what you share with Claude in a conversation.",
  author: { name: "Jeremy Crossman", url: "https://github.com/JCrossman" },
  repository: { type: "git", url: "https://github.com/JCrossman/kindle-mcp" },
  homepage: "https://github.com/JCrossman/kindle-mcp",
  documentation: "https://github.com/JCrossman/kindle-mcp#readme",
  support: "https://github.com/JCrossman/kindle-mcp/issues",
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: "node",
    // Not dist/cli.js: the bundle entry serves unconditionally and ignores argv (see src/mcpb-entry.ts).
    entry_point: "dist/mcpb-entry.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/mcpb-entry.js"],
      // The data folder, then every setting the server reads, each from its own option below.
      env: {
        KINDLE_MCP_HOME: "${user_config.kindle_home}",
        ...Object.fromEntries(Object.entries(SETTING_ENV).map(([key, name]) => [name, `\${user_config.${key}}`])),
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
      description:
        "Your vault's top folder, shared with the plugin, routines and the command line on this computer. Leave it " +
        "empty if you've told Claude where your vault is. Each sync adds new highlights to one note per book (linked " +
        "to your notes) and files @todo, @quote, @project and tags named after your notes; Claude saves @post and " +
        "@research as notes. Outside the Kindle folder, only notes you name with a tag (and book notes you moved " +
        "there) are written to.",
      // Every option has a default: Cowork loads a plugin's bundle only then (it never asks for values).
      default: "",
      required: false,
    },
    obsidian_folder: {
      type: "string",
      title: "Folder inside the vault (optional)",
      description: "Subfolder for the Kindle notes. Empty: Kindle, or the folder saved in the settings file.",
      default: "",
      required: false,
    },
    act_on_commands: {
      type: "boolean",
      title: "Do @commands after a sync",
      description: "On: Claude carries out @post and @research as soon as a sync finds them. Off: it lists them and offers.",
      default: true,
      required: false,
    },
    auto_file: {
      type: "boolean",
      title: "File @todo, @quote and @project during sync",
      description: "Off: leave them for Claude instead (for example to use your own task app).",
      default: true,
      required: false,
    },
    link_notes: {
      type: "boolean",
      title: "Link highlights to your notes",
      description: "Mentions of your vault's note titles and aliases in new highlights and Claude's notes become [[links]].",
      default: true,
      required: false,
    },
    link_exclude: {
      type: "string",
      title: "Folders never linked or searched (optional)",
      description: "Comma-separated vault folders, e.g. Journal, Private. Obsidian's own Excluded files are always honoured.",
      default: "",
      required: false,
    },
    browser_path: {
      type: "file",
      title: "Browser executable (optional)",
      description: "Only if neither Chrome nor Edge is installed: any Chromium-based browser, used to sign in to Amazon and to renew the sign-in.",
      default: "",
      required: false,
    },
  },
  compatibility: { claude_desktop: ">=0.10.0", platforms: ["darwin", "win32", "linux"], runtimes: { node: ">=22.13.0" } },
};

// Cowork (which runs a plugin's bundle without asking for values) skips a server whose options lack a default.
const noDefault = Object.entries(manifest.user_config).filter(([, o]) => o.default === undefined).map(([k]) => k);
if (noDefault.length) throw new Error(`user_config options without a default: ${noDefault.join(", ")}`);
// A setting with no option here could not be set from the extension at all.
const noOption = Object.keys(SETTING_ENV).filter((k) => !manifest.user_config[k]);
if (noOption.length) throw new Error(`settings without a user_config option: ${noOption.join(", ")}`);

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

const verify = join(root, "build", "mcpb-verify");
rmSync(verify, { recursive: true, force: true });
execFileSync(mcpb, ["unpack", out, verify], { stdio: "ignore" });
const packedManifest = JSON.parse(readFileSync(join(verify, "manifest.json"), "utf8"));
const entry = join(verify, packedManifest.server.entry_point);
const env = { ...process.env, KINDLE_MCP_HOME: join(root, "build", "mcpb-verify-home"), OBSIDIAN_VAULT: "${user_config.obsidian_vault}" };
for (const [label, extra] of [["as the manifest says", []], ["host repeats the script path", [entry, "serve"]]]) {
  const r = await handshake(process.execPath, [entry, ...extra], env);
  const ok = r.discover && r.server?.version === pkg.version && r.tools === tools.length && r.prompts === prompts.length;
  console.log(`self-test, ${label}: ${ok ? "ok" : "FAILED"} (${r.tools} tools, ${r.prompts} prompts, discover ${r.discover})`);
  if (!ok) throw new Error(`bundle self-test failed (${label}): ${JSON.stringify(r)}`);
}
rmSync(verify, { recursive: true, force: true });
rmSync(join(root, "build", "mcpb-verify-home"), { recursive: true, force: true });
console.log(`\nbundle: ${out}`);
