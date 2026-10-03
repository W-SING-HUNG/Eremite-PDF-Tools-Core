#!/usr/bin/env node
/**
 * Production-only Consumer Test (BLOCKER B1 regression).
 *
 * Verifies the production CLI starts and performs protocol validation with
 * ONLY production dependencies installed — no dev node_modules borrowed.
 *
 * Steps:
 *   1. Create an isolated temp consumer directory.
 *   2. Copy dist/ + schema/ + package.json + package-lock.json (no src, no
 *      tests, no node_modules).
 *   3. `npm ci --omit=dev` in that directory.
 *   4. Assert only production deps exist (ajv present, vitest/typescript absent).
 *   5. Run the CLI against a valid request; assert exit 0 + canonical
 *      internal.not_implemented (P1 engine boundary).
 *   6. Run the CLI against a malformed request; assert non-zero (protocol
 *      validation actually executes).
 *   7. Clean up the temp directory.
 *
 * Usage: node scripts/production-consumer-test.mjs
 * Requires a prior `npm run build` (dist/ must exist).
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const NODE = process.execPath;
const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(NODE), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(ROOT, "node_modules", "npm", "bin", "npm-cli.js")
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

function fail(msg) {
  process.stderr.write(`production-consumer-test: FAIL — ${msg}\n`);
  process.exit(1);
}

function ok(msg) {
  process.stdout.write(`  ✓ ${msg}\n`);
}

const dist = path.join(ROOT, "dist");
if (!existsSync(path.join(dist, "cli", "cli.js"))) {
  fail("dist/cli/cli.js missing — run `npm run build` first");
}

const consumer = mkdtempSync(path.join(tmpdir(), "ptc-prod-consumer-"));
process.stdout.write(`consumer dir: ${consumer}\n`);

try {
  // 1. Copy production artifacts only.
  cpSync(dist, path.join(consumer, "dist"), { recursive: true });
  cpSync(path.join(ROOT, "schema"), path.join(consumer, "schema"), { recursive: true });
  cpSync(path.join(ROOT, "package.json"), path.join(consumer, "package.json"));
  cpSync(path.join(ROOT, "package-lock.json"), path.join(consumer, "package-lock.json"));
  ok("copied dist + schema + package.json + package-lock.json (no src/tests/node_modules)");

  // 2. Production-only install.
  const npmCli = findNpmCli();
  if (!npmCli) fail("could not locate npm-cli.js");
  execFileSync(NODE, [npmCli, "ci", "--omit=dev"], {
    cwd: consumer,
    stdio: "pipe"
  });
  ok("npm ci --omit=dev completed");

  // 3. Assert dependency classification.
  const nm = path.join(consumer, "node_modules");
  if (!existsSync(path.join(nm, "ajv"))) fail("ajv missing from production node_modules (BLOCKER B1 regression)");
  if (existsSync(path.join(nm, "vitest"))) fail("vitest leaked into production node_modules");
  if (existsSync(path.join(nm, "typescript"))) fail("typescript leaked into production node_modules");
  ok("production node_modules contains ajv only (no dev deps)");

  // 4. Valid request → exit 0 + internal.not_implemented.
  const inputContent = "%PDF-1.4 test";
  writeFileSync(path.join(consumer, "input.pdf"), inputContent);
  const request = {
    kind: "pdf.tools.request",
    protocolVersion: 1,
    invocationId: UUID_V7,
    operation: "pdf.merge",
    workspace: { rootPath: consumer },
    inputs: [
      { id: "in-0", relativePath: "input.pdf", snapshot: { byteSize: inputContent.length, sha256: sha(inputContent), displayName: "input.pdf" } }
    ]
  };
  const reqPath = path.join(consumer, "request.json");
  const respPath = path.join(consumer, "response.json");
  writeFileSync(reqPath, JSON.stringify(request));

  execFileSync(NODE, [path.join(consumer, "dist", "cli", "cli.js"), "--protocol", "1", "--request", reqPath, "--response", respPath], { cwd: consumer, stdio: "pipe" });
  const resp = JSON.parse(readFileSync(respPath, "utf-8"));
  if (resp.status !== "failed" || resp.error.code !== "internal.not_implemented") {
    fail(`unexpected response: ${JSON.stringify(resp)}`);
  }
  ok("CLI started and reached P1 engine boundary (internal.not_implemented)");

  // 5. Malformed request → protocol validation executes (non-zero, no crash).
  writeFileSync(path.join(consumer, "bad.json"), "{ not json");
  let malformedExit = 0;
  try {
    execFileSync(NODE, [path.join(consumer, "dist", "cli", "cli.js"), "--protocol", "1", "--request", path.join(consumer, "bad.json"), "--response", path.join(consumer, "bad-resp.json")], { cwd: consumer, stdio: "pipe" });
  } catch (e) {
    malformedExit = e.status ?? 1;
  }
  if (malformedExit === 0) fail("malformed JSON should exit non-zero");
  ok("protocol validation executes (malformed JSON rejected non-zero)");

  process.stdout.write("production-consumer-test: PASS\n");
} finally {
  rmSync(consumer, { recursive: true, force: true });
  process.stdout.write(`cleaned consumer dir: ${consumer}\n`);
}
