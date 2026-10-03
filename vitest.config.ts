import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/helpers/setup.ts"],
    setupFiles: ["tests/helpers/cleanup-global.ts"],
    // Tests use the unified temp helper (tests/helpers/temp.ts) which auto-cleans.
    hookTimeout: 20000,
    testTimeout: 20000
  }
});
