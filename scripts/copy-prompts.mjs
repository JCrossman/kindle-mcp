// Copy the prompt bodies next to the compiled server so `new URL("./prompts/...", import.meta.url)` resolves.
import { cpSync, mkdirSync, rmSync } from "node:fs";
rmSync("dist/prompts", { recursive: true, force: true });
mkdirSync("dist/prompts", { recursive: true });
cpSync("src/prompts", "dist/prompts", { recursive: true });
