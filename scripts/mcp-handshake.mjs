// The stdio handshake Claude Desktop makes with a server it starts. The bundle build replays it against the packed
// bundle, and tests/mcpb-entry.test.ts against the source entry.
import { spawn } from "node:child_process";

/**
 * Speak MCP over stdio to a spawned server the way Claude Desktop does: discover probe first, then initialize.
 * `stray` holds any stdout line that isn't JSON-RPC: one is enough to break a real host, so callers fail on it.
 */
export function handshake(command, args, env) {
  return new Promise((resolve) => {
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const got = {};
    const stray = [];
    let out = "", err = "", exit = null;
    const finish = () => {
      try { p.kill(); } catch {}
      resolve({
        discover: got[1] ? (got[1].error ? `error ${got[1].error.code}` : "ok") : null,
        server: got[2]?.result?.serverInfo ?? null,
        tools: got[3]?.result?.tools?.length ?? 0,
        prompts: got[4]?.result?.prompts?.length ?? 0,
        exit,
        stray,
        stderr: err.split("\n").filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).slice(0, 3),
      });
    };
    const timer = setTimeout(finish, 20000);
    p.stdout.on("data", (d) => {
      out += d;
      const lines = out.split("\n");
      out = lines.pop();
      for (const line of lines) {
        try { const m = JSON.parse(line); if (m.id !== undefined) got[m.id] = m; } catch { stray.push(line.slice(0, 200)); }
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
