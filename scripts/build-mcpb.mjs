// Build the Claude Desktop bundle (.mcpb): a manifest generated from the live server, the compiled
// code, the router skill, and production node_modules, packed with @anthropic-ai/mcpb. Then verify
// the packed file itself: unpack it and replay a host handshake against its entry point, with and
// without the host repeating the script path. Any failure fails the build.
//   npm run build && node scripts/build-mcpb.mjs        -> kindle-mcp-server-<version>.mcpb
import { execFileSync, spawn } from "node:child_process";
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
    // Not dist/cli.js: the bundle entry serves unconditionally and ignores argv (see src/mcpb-entry.ts).
    entry_point: "dist/mcpb-entry.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/mcpb-entry.js"],
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

/** Speak MCP over stdio to a spawned server the way Claude Desktop does: discover probe first, then initialize. */
function handshake(command, args, env) {
  return new Promise((resolve) => {
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const got = {};
    let out = "", err = "", exit = null;
    const finish = () => {
      try { p.kill(); } catch {}
      resolve({
        discover: got[1] ? (got[1].error ? `error ${got[1].error.code}` : "ok") : null,
        server: got[2]?.result?.serverInfo ?? null,
        tools: got[3]?.result?.tools?.length ?? 0,
        prompts: got[4]?.result?.prompts?.length ?? 0,
        exit,
        stderr: err.split("\n").filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).slice(0, 3),
      });
    };
    const timer = setTimeout(finish, 20000);
    p.stdout.on("data", (d) => {
      out += d;
      const lines = out.split("\n");
      out = lines.pop();
      for (const line of lines) {
        try { const m = JSON.parse(line); if (m.id !== undefined) got[m.id] = m; } catch { err += `non-JSON on stdout: ${line.slice(0, 80)}\n`; }
      }
      if (got[3] && got[4]) { clearTimeout(timer); finish(); }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => { exit = code; clearTimeout(timer); setTimeout(finish, 50); });
    const send = (o) => { try { p.stdin.write(JSON.stringify(o) + "\n"); } catch {} };
    send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-verify", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    send({ jsonrpc: "2.0", id: 4, method: "prompts/list", params: {} });
  });
}

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
