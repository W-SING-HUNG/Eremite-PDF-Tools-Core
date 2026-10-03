/**
 * Package metadata tests: the declared production CLI entry (package.json
 * "bin") must match the real production CLI that the P1/P2 CLI tests execute.
 *
 * Regression: bin previously pointed at a non-existent ./dist/cli.js while the
 * real entry is ./dist/cli/cli.js.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CORE_VERSION } from "../src/protocol/response.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

interface PackageJson {
  name: string;
  version: string;
  type: string;
  engines: { node: string };
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function loadPackage(): PackageJson {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as PackageJson;
}

/** The path the CLI integration tests actually execute. */
const REAL_CLI = join(ROOT, "dist", "cli", "cli.js");

describe("package metadata — production CLI entry", () => {
  it("keeps lockfile identity, CLI and provenance synchronized with package.json", () => {
    const pkg = loadPackage();
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf-8"));
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].name).toBe(pkg.name);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(lock.packages[""].bin["pdf-tools-core"]).toBe(pkg.bin["pdf-tools-core"]!.replace(/^\.\//, ""));
    expect(CORE_VERSION).toBe(pkg.version);
    expect(lock.packages["node_modules/ajv"].version).toBe("8.20.0");
    expect(lock.packages["node_modules/fast-uri"].version).toBe("3.1.8");
  });

  it("declares bin pdf-tools-core pointing at the real production CLI", () => {
    const pkg = loadPackage();
    expect(pkg.bin["pdf-tools-core"]).toBe("./dist/cli/cli.js");
  });

  it("bin entry exists after build (matches the CLI under test)", () => {
    const pkg = loadPackage();
    const declared = join(ROOT, pkg.bin["pdf-tools-core"]!);
    // Normalized comparison (declared uses forward slashes).
    expect(declared.split(/[\\/]/).join("/")).toBe(REAL_CLI.split(/[\\/]/).join("/"));
    expect(existsSync(REAL_CLI), `production CLI missing: ${REAL_CLI} (run build first)`).toBe(true);
  });

  it("declares the production runtime dependency (ajv) and Node range", () => {
    const pkg = loadPackage();
    expect(pkg.dependencies["ajv"]).toBeDefined();
    expect(pkg.devDependencies["ajv"]).toBeUndefined();
    expect(pkg.engines.node).toBe(">=24 <25");
    expect(pkg.type).toBe("module");
  });
});
