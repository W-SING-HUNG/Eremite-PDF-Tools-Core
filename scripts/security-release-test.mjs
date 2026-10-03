/** RC3 packaging gate and isolated TGZ consumer; never reads or writes Host. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const EVIDENCE = join(ROOT, "security-evidence", "rc3");
const CACHE = join(ROOT, ".tmp", "npm-cache");
const NPM = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const OLD = join(ROOT, "pdf-tools-core-1.0.0-rc2.tgz");
const NEW = join(ROOT, "pdf-tools-core-1.0.0-rc3.tgz");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
function run(exe, args, cwd) {
  const result = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${exe}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function files(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = prefix + e.name;
    return e.isDirectory() ? files(join(dir, e.name), rel + "/") : [rel];
  }).sort();
}
mkdirSync(join(ROOT, ".tmp"), { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });
const temp = mkdtempSync(join(ROOT, ".tmp", "rc3-security-consumer-"));
const summary = { consumer: temp, gates: [] };
function gate(name, fn) { fn(); summary.gates.push(name); console.log(`PASS ${name}`); }
try {
  gate("accepted RC2 remains unchanged", () => assert.equal(sha(OLD), "b075d8412c1d86f2e686277289ae6b2972a4ad947c28ddd1a3aa2efc8cb3bc5a"));
  const oldExtract = join(temp, "rc2");
  const newExtract = join(temp, "rc3");
  mkdirSync(oldExtract); mkdirSync(newExtract);
  run("tar.exe", ["-xzf", OLD, "-C", oldExtract], ROOT);
  run("tar.exe", ["-xzf", NEW, "-C", newExtract], ROOT);
  const oldPkg = join(oldExtract, "package");
  const newPkg = join(newExtract, "package");
  const entries = files(newPkg);
  writeFileSync(join(EVIDENCE, "artifact-files.txt"), entries.join("\n") + "\n");
  summary.artifact = { path: NEW, sha256: sha(NEW), fileCount: entries.length };
  gate("artifact identity, CLI, exports and bundled roots", () => {
    const p = json(join(newPkg, "package.json")), old = json(join(oldPkg, "package.json"));
    assert.equal(p.name, "pdf-tools-core"); assert.equal(p.version, "1.0.0-rc3");
    for (const field of ["bin", "exports", "engines", "dependencies", "bundleDependencies", "files"]) assert.deepEqual(p[field], old[field]);
    assert.ok(existsSync(join(newPkg, p.bin["pdf-tools-core"])));
  });
  gate("Protocol v1, LICENSE, runtime manifest and all qpdf files byte-identical to RC2", () => {
    for (const f of files(oldPkg).filter((f) => f.startsWith("vendor/") || f.startsWith("schema/") || f === "LICENSE")) assert.equal(sha(join(newPkg, f)), sha(join(oldPkg, f)), f);
    assert.equal(sha(join(newPkg, "vendor/qpdf/12.4.0/win-x64/bin/qpdf.exe")), "9b3cb39a097df278b34cc1074955960e52916e7a5720b5614041b45dac132ea3");
  });
  gate("compiled Supplier behavior unchanged except synchronized coreVersion", () => {
    for (const f of files(oldPkg).filter((f) => f.startsWith("dist/"))) {
      const before = readFileSync(join(oldPkg, f), "utf8");
      const after = readFileSync(join(newPkg, f), "utf8");
      assert.equal(after, ["dist/protocol/response.js", "dist/protocol/response.d.ts"].includes(f) ? before.replace('"0.1.0"', '"1.0.0-rc3"') : before, f);
    }
  });
  gate("pruning rules hold: no source, tests, specs, benchmarks, QA or dev assets", () => {
    const prohibited = entries.filter((f) => /(^|\/)(src|tests?|specs?|__tests__|__mocks__|benchmarks?|docs?|examples?|fixtures|coverage|scripts|\.github|\.circleci|\.vscode|security-evidence|\.tmp)(\/|$)/i.test(f)
      || /\.map$/.test(f)
      || (f.startsWith("node_modules/") && (/\.(ts|md|ya?ml)$/i.test(f) && !/\/(license|copying|notice|authors|patents)(\..*)?$/i.test(f)))
      || /^vendor\/qpdf\/[^/]+\/win-x64\/(include|lib|share)\//.test(f));
    assert.deepEqual(prohibited, []);
  });
  gate("actual bundled closure matches lock versions; licenses and notices retained", () => {
    const lock = json(join(ROOT, "package-lock.json"));
    const names = readdirSync(join(newPkg, "node_modules")).sort();
    assert.deepEqual(names, ["ajv", "fast-deep-equal", "fast-uri", "json-schema-traverse", "require-from-string"]);
    summary.closure = {};
    const notices = readFileSync(join(newPkg, "THIRD-PARTY-NOTICES"), "utf8");
    assert.ok(notices.includes("Version: 1.0.0-rc3"));
    for (const name of names) {
      const pkg = json(join(newPkg, "node_modules", name, "package.json"));
      assert.equal(pkg.version, lock.packages[`node_modules/${name}`].version);
      summary.closure[name] = pkg.version;
      assert.match(notices, new RegExp(`${name}\\s+\\|\\s+${pkg.version.replaceAll(".", "\\.")}`));
      const licenses = files(join(ROOT, "node_modules", name)).filter((f) => /^(license|copying|notice)(\..*)?$/i.test(f));
      assert.ok(licenses.length > 0, name);
      for (const f of licenses) assert.equal(sha(join(newPkg, "node_modules", name, f)), sha(join(ROOT, "node_modules", name, f)));
    }
    assert.equal(summary.closure.ajv, "8.20.0"); assert.equal(summary.closure["fast-uri"], "3.1.8");
  });
  const consumer = join(temp, "consumer"); mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "rc3-security-consumer", version: "1.0.0", private: true }));
  gate("fresh consumer installs tgz offline with npm-generated CLI shim", () => {
    const out = run(process.execPath, [NPM, "install", NEW, "--omit=dev", "--ignore-scripts", "--offline", "--no-audit", "--cache", CACHE], consumer);
    writeFileSync(join(EVIDENCE, "consumer-install.out"), out);
    assert.ok(existsSync(join(consumer, "node_modules", ".bin", "pdf-tools-core.cmd")));
  });
  gate("clean consumer npm audit --json reports zero vulnerabilities", () => {
    const out = run(process.execPath, [NPM, "audit", "--json", "--cache", CACHE], consumer);
    writeFileSync(join(EVIDENCE, "consumer-audit.after.json"), out);
    const audit = JSON.parse(out);
    assert.equal(audit.metadata.vulnerabilities.total, 0);
    assert.ok(!audit.vulnerabilities["fast-uri"]);
    summary.consumerAudit = audit.metadata;
  });
  gate("existing TGZ-only smoke: CLI, all five real operations, strict schema, limits and failures", () => {
    cpSync(join(ROOT, "scripts", "consumer-smoke.mjs"), join(consumer, "consumer-smoke.mjs"));
    const out = run(process.execPath, [join(consumer, "consumer-smoke.mjs")], consumer);
    writeFileSync(join(EVIDENCE, "consumer-smoke.out"), out);
    console.log(out);
  });
} finally {
  // Delete only the unique directory created above, after verifying its boundary.
  assert.equal(dirname(temp), join(ROOT, ".tmp"));
  assert.ok(temp.startsWith(join(ROOT, ".tmp", "rc3-security-consumer-")));
  rmSync(temp, { recursive: true, force: true });
  summary.cleaned = !existsSync(temp);
  writeFileSync(join(EVIDENCE, "release-gate.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(`consumer cleaned: ${summary.cleaned}`);
}
