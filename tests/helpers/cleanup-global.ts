/**
 * Global cleanup safety net (runs in the TEST process via setupFiles).
 *
 * Registers a process 'exit' handler and a global afterAll that remove every
 * temp dir created by the temp helper. This guarantees no `pdf-tools-core-test-*`
 * residue survives even when a test throws, a hook is skipped, or a child
 * process (CLI test) is spawned.
 */

import { afterAll } from "vitest";
import { cleanupAll } from "./temp.js";

// afterAll at module scope in a setupFile runs after all test files complete.
afterAll(() => {
  cleanupAll();
});

// Last-resort: also hook process exit so even an abnormal termination cleans up.
process.on("exit", () => {
  cleanupAll();
});
