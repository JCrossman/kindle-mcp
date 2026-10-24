/**
 * The Desktop bundle entry must serve no matter what argv a host passes. Claude Desktop's built-in
 * Node can repeat the manifest's script path; the CLI entry would read that as an unknown command.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// @ts-expect-error plain JS module without types
import { handshake } from "../scripts/mcp-handshake.mjs";
import { TOOLS } from "./helpers/mcp.js";

const root = join(__dirname, "..");
const entry = join(root, "src", "mcpb-entry.ts");

const run = (extraArgs: string[]) =>
  handshake(process.execPath, ["--import", "tsx", entry, ...extraArgs], {
    ...process.env,
    KINDLE_MCP_HOME: mkdtempSync(join(tmpdir(), "kindle-entry-")),
    OBSIDIAN_VAULT: "${user_config.obsidian_vault}",
  });

describe("Desktop bundle entry", () => {
  it("serves with no arguments", async () => {
    const r = await run([]);
    expect(r.server?.name).toBe("kindle-mcp");
    expect(r.tools).toBe(TOOLS.length);
    expect(r.prompts).toBe(2);
    expect(r.discover).toBe("error -32601"); // unknown probe methods get a JSON-RPC error, not a closed pipe
  }, 30_000);
  it("serves when the host repeats the script path and a subcommand", async () => {
    const r = await run([join(root, "dist", "mcpb-entry.js"), "serve"]);
    expect(r.tools).toBe(TOOLS.length);
  }, 30_000);
});
