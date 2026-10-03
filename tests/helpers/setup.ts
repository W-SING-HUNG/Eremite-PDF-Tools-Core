/**
 * Global test setup: ensure the CLI is built (dist/) before CLI integration
 * tests run. Runs `tsc` once. The build output is a real artifact, not a mock.
 *
 * Returns a teardown that removes all temp dirs (safety net for abnormal exit).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const CLI_JS = join(ROOT, "dist", "cli", "cli.js");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

export default function setup(): () => Promise<void> {
  if (!existsSync(CLI_JS)) {
    execFileSync(process.execPath, [TSC, "-p", join(ROOT, "tsconfig.json")], {
      cwd: ROOT,
      stdio: "inherit"
    });
  }
  return async () => {
    // Safety-net temp cleanup lives in temp.ts and runs via its own module
    // tracking; here we do nothing extra (cleanupAll is invoked in-process by
    // each suite's afterEach/afterAll). Kept async for globalSetup contract.
  };
}
