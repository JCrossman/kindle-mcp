/** The tools the server must offer, and an MCP client connected in memory to a fresh server. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { Config } from "../../src/config.js";
import { createServer } from "../../src/server.js";

export const TOOLS = [
  "kindle_list_books", "kindle_get_highlights", "kindle_search_highlights", "kindle_get_new_since",
  "kindle_get_pending_commands", "kindle_get_command_context", "kindle_complete_command", "kindle_mark_command_done",
  "kindle_search_vault", "kindle_link_existing_highlights", "kindle_export_to_obsidian", "kindle_sync",
  "kindle_status", "kindle_set_vault", "kindle_login", "kindle_read_note", "kindle_teach_tag", "kindle_get_themes",
];

export async function connect(cfg: Config): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(cfg).connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}
