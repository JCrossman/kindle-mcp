/**
 * The Desktop bundle entry must serve no matter what argv a host passes. Claude Desktop's built-in
 * Node can repeat the manifest's script path; the CLI entry would read that as an unknown command.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

function handshake(extraArgs: string[]): Promise<{ server?: { name: string }; tools: number; discover?: number }> {
  return new Promise((resolve, reject) => {
    const entry = join(root, "src", "mcpb-entry.ts");
    const p = spawn(process.execPath, ["--import", "tsx", entry, ...extraArgs], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, KINDLE_MCP_HOME: mkdtempSync(join(tmpdir(), "kindle-entry-")), OBSIDIAN_VAULT: "${user_config.obsidian_vault}" },
    });
    const got: Record<number, any> = {};
    let buf = "";
    const timer = setTimeout(() => { p.kill(); reject(new Error("no response within 20s")); }, 20_000);
    p.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) { const m = JSON.parse(line); if (m.id !== undefined) got[m.id] = m; }
      if (got[3]) {
        clearTimeout(timer);
        p.kill();
        resolve({ server: got[2]?.result?.serverInfo, tools: got[3].result?.tools?.length ?? 0, discover: got[1]?.error?.code });
      }
    });
    const send = (o: object) => p.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
  });
}

describe("Desktop bundle entry", () => {
  it("serves with no arguments", async () => {
    const r = await handshake([]);
    expect(r.server?.name).toBe("kindle-mcp");
    expect(r.tools).toBe(11);
    expect(r.discover).toBe(-32601); // unknown probe methods get a JSON-RPC error, not a closed pipe
  }, 30_000);
  it("serves when the host repeats the script path and a subcommand", async () => {
    const r = await handshake([join(root, "dist", "mcpb-entry.js"), "serve"]);
    expect(r.tools).toBe(11);
  }, 30_000);
});
