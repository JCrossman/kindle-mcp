/** Regenerate skills/kindle-router/SKILL.md from the router prompt. `npm run render-skill`. */
import { writeFileSync } from "node:fs";
import { routePendingPrompt } from "../src/server.js";

const front = `---
name: kindle-router
description: Route pending Kindle @commands (@post, @research, @todo, @project, @quote) through the kindle MCP server, acting on each and marking it done. Use when asked to process, route or action Kindle notes, or from a scheduled run.
---
`;
writeFileSync(new URL("../skills/kindle-router/SKILL.md", import.meta.url), front + routePendingPrompt());
console.log("skills/kindle-router/SKILL.md updated");
