/**
 * Regenerate the plugin (plugin/), its marketplace entry (.claude-plugin/) and skills/kindle-router
 * from package.json and the prompts. `npm run render-plugin`.
 * With --dev it also writes build/plugin-dev: the same plugin, but running this checkout's server
 * (`npm run build` first), for `claude --plugin-dir build/plugin-dev`.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { pluginFiles } from "../src/plugin.js";

const root = fileURLToPath(new URL("..", import.meta.url));
for (const [rel, content] of Object.entries(pluginFiles())) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
  console.log(`wrote ${rel}`);
}

if (process.argv.includes("--dev")) {
  const dev = join(root, "build", "plugin-dev");
  rmSync(dev, { recursive: true, force: true });
  cpSync(join(root, "plugin"), dev, { recursive: true });
  const manifestPath = join(dev, ".claude-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.mcpServers;
  manifest.version = `${manifest.version}-dev`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const server = { command: process.execPath, args: [join(root, "dist", "mcpb-entry.js")] };
  writeFileSync(join(dev, ".mcp.json"), `${JSON.stringify({ mcpServers: { "kindle-mcp-server": server } }, null, 2)}\n`);
  console.log(`dev plugin: ${dev}`);
}
