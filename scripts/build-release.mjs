#!/usr/bin/env node
/**
 * Build the production Supplier release tarball with a PRUNED bundled
 * dependency tree.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bundleDependencies` ships each dependency's published files verbatim. For
 * ajv that includes its TypeScript SOURCE tree (lib/**\/*.ts, 106 files),
 * sourcemaps (106), type declarations, tests, benchmarks and CI config — none
 * of which the runtime needs. The Host Gate flagged ~170 such dev assets in the
 * RC1 tarball (607 files).
 *
 * npm's `files` whitelist cannot filter INSIDE a bundled dependency, so the fix
 * is a staging tree: copy the Supplier files + the bundled runtime dependency
 * closure, prune dev assets there, then let `npm pack` build the tarball from
 * the staged tree. The tarball is therefore still produced by npm itself — not
 * by a hand-rolled tar — so it remains a standard, npm-installable artifact.
 *
 * The Supplier's own dev tree (src/, tests/, node_modules with devDeps) is
 * never touched, so typecheck/tests keep working against full type information.
 */

import {
  cpSync,
  mkdirSync,
  rmSync,
  readdirSync,
  lstatSync,
  existsSync,
  readFileSync
} from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { assertNoBundledNative } from "./package-gate.mjs";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------------------------------------------ *
 * Pruning rules (applied ONLY under node_modules/)
 * ------------------------------------------------------------------ */

/** Whole subtrees that are never runtime-required. */
const PRUNE_DIR = [
  /(^|\/)(test|tests|spec|specs|__tests__|__mocks__|benchmark|benchmarks)(\/|$)/,
  /(^|\/)(docs?|examples?|fixtures|coverage)(\/|$)/,
  /(^|\/)(\.github|\.circleci|\.vscode|scripts)(\/|$)/
];

/**
 * ajv ships its TypeScript SOURCE in lib/ (106 *.ts + duplicate refs/*.json and
 * NO *.js). The runtime lives entirely in ajv/dist. Dropping lib/ removes
 * 125 files with zero runtime impact.
 */
const PRUNE_DIR_TARGETED = [/(^|\/)ajv\/lib(\/|$)/];

/** Individual dev files. */
const PRUNE_FILE = [
  /\.map$/, // sourcemaps
  /\.ts$/, // dependency TypeScript source AND declarations (.d.ts)
  /\.md$/i, // README / CHANGELOG / docs
  /\.ya?ml$/i, // CI + lint config
  /^tsconfig(\..+)?\.json$/,
  /^\.eslintrc/i,
  /^eslint/i,
  /^\.gitattributes$/,
  /^\.gitignore$/,
  /^\.npmignore$/,
  /^\.editorconfig$/,
  /^runkit/i,
  /^Makefile$/,
  /^Dockerfile$/
];

/** Never prune license/notice text — redistribution requires it. */
const KEEP_FILE = /^(licen[cs]e|copying|notice|authors|patents)(\..*)?$/i;

function shouldPruneDir(relPath) {
  return PRUNE_DIR.some((re) => re.test(relPath)) || PRUNE_DIR_TARGETED.some((re) => re.test(relPath));
}

function shouldPruneFile(name) {
  if (KEEP_FILE.test(name)) return false;
  return PRUNE_FILE.some((re) => re.test(name));
}

/* ------------------------------------------------------------------ *
 * Tree helpers
 * ------------------------------------------------------------------ */

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}

/** Prune dev assets under `dir`, then drop directories left empty. */
function pruneDevAssets(dir) {
  let removed = 0;
  const walk = (d) => {
    let entries;
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(d, name);
      const rel = relative(dir, abs).split(sep).join("/");

      if (lstatSync(abs).isDirectory()) {
        if (shouldPruneDir(rel)) {
          rmSync(abs, { recursive: true, force: true });
          removed++;
          continue;
        }
        walk(abs);
        // Drop the directory if pruning emptied it.
        try {
          if (readdirSync(abs).length === 0) {
            rmSync(abs, { recursive: true, force: true });
          }
        } catch {
          /* best effort */
        }
        continue;
      }

      if (shouldPruneFile(name)) {
        rmSync(abs, { force: true });
        removed++;
      }
    }
  };
  walk(dir);
  return removed;
}

/**
 * Resolve the hoisted runtime dependency closure for the bundled roots by
 * walking the real installed tree (bundled deps are always installed).
 */
function bundledClosure(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    const pkgPath = join(ROOT, "node_modules", name, "package.json");
    if (!existsSync(pkgPath)) continue;
    seen.add(name);
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      continue;
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (existsSync(join(ROOT, "node_modules", dep))) queue.push(dep);
    }
  }
  return [...seen].sort();
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
  const version = pkg.version;
  const bundled = Array.isArray(pkg.bundleDependencies) ? pkg.bundleDependencies : [];

  if (version.startsWith("1.0.0-rc1")) {
    // Guard: RC1 is frozen and must never be overwritten or impersonated.
    console.error("REFUSING to build: package.json still at an rc1 version.");
    console.error("Bump the version (e.g. 1.0.0-rc2) before building a new RC.");
    process.exit(1);
  }

  const staging = join(tmpdir(), `pdf-tools-core-release-${version}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // 1. Supplier's own release files, driven by the package.json `files`
  //    whitelist (single source of truth).
  for (const entry of pkg.files) {
    if (entry.startsWith("!")) continue; // negation handled by npm
    const src = join(ROOT, entry);
    if (!existsSync(src)) continue;
    const dest = join(staging, entry);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest, { recursive: true });
  }
  cpSync(join(ROOT, "package.json"), join(staging, "package.json"));

  // 2. Bundled runtime dependency closure.
  const closure = bundledClosure(bundled);
  const nmDest = join(staging, "node_modules");
  mkdirSync(nmDest, { recursive: true });
  for (const dep of closure) {
    cpSync(join(ROOT, "node_modules", dep), join(nmDest, dep), { recursive: true });
  }

  const before = countFiles(join(staging, "node_modules"));
  const removed = pruneDevAssets(join(staging, "node_modules"));
  const after = countFiles(join(staging, "node_modules"));

  // 3. Let npm build the tarball from the pruned staging tree.
  //    npm lives next to the running Node, not in this project's node_modules.
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const argv = ["pack", "--json", "--pack-destination", ROOT];
  let packed;
  if (existsSync(npmCli)) {
    packed = execFileSync(process.execPath, [npmCli, ...argv], { cwd: staging, encoding: "utf8" });
  } else {
    packed = execFileSync("npm.cmd", argv, { cwd: staging, encoding: "utf8", shell: true });
  }
  const packedResult = JSON.parse(packed)[0];
  assertNoBundledNative(packedResult.files.map(file => file.path));

  const tgz = join(ROOT, `pdf-tools-core-${version}.tgz`);
  console.log("\n=== build-release summary ===");
  console.log(`version              : ${version}`);
  console.log(`bundled deps         : ${closure.join(", ")}`);
  console.log(`dep files before     : ${before}`);
  console.log(`dev assets pruned    : ${removed}`);
  console.log(`dep files after      : ${after}`);
  console.log(`tarball              : ${tgz}`);
  console.log(`exists               : ${existsSync(tgz)}`);
  console.log(`package gate         : PASS (no native binaries or vendor files)`);
  console.log(`package file count   : ${packedResult.entryCount}`);

  rmSync(staging, { recursive: true, force: true });
}

main();
