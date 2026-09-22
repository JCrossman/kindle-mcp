/**
 * Entry point for the Claude Desktop bundle (.mcpb). It always serves MCP over stdio and never reads
 * argv or checks whether it is the main module.
 *
 * Hosts launch bundles differently. Claude Desktop's built-in Node.js runs servers inside Electron,
 * through its own wrapper, and can pass the manifest's arguments (script path included) again. The
 * CLI entry parses subcommands and only runs when it is the process entry, so under such a host it
 * either exits on "unknown command" or never starts. This file has neither dependency.
 */
import { quietExperimentalWarnings } from "./warnings.js";

quietExperimentalWarnings();

void (async () => {
  const { loadConfig } = await import("./config.js");
  const { serveStdio } = await import("./server.js"); // loads node:sqlite, after the warning filter
  await serveStdio(loadConfig());
})().catch((e: unknown) => {
  console.error(`kindle-mcp: could not start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
