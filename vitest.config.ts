import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Isolate every test file from the developer's own settings, home folder and temp folder.
    setupFiles: ["tests/helpers/isolate.ts"],
  },
});
