/**
 * RC5 external prerequisite — CLEAN TGZ-ONLY CONSUMER SELF-SMOKE.
 *
 * This harness is owned by the CONSUMER. It runs from inside an independent
 * workspace whose node_modules came solely from `npm install <tgz> --omit=dev`.
 * It borrows nothing from the Supplier tree: no src, no dist, no tests, no
 * fixtures, no vendor path, no Supplier node_modules.
 *
 * PDF test data is generated here from scratch (hand-built, xref-correct minimal
 * PDFs), so no Supplier fixture is reused.
 *
 * Coverage:
 *   1. installed-package shape / identity / hygiene
 *   2. CLI startup via the npm-generated .bin shim + negative surfaces
 *   3. the five V1 operations, through the external PATH qpdf
 *   4. Host limit probes — every resource limit must really fail (RED)
 *   5. no partial success / no residue on a limit failure
 *   6. offline completeness (no unbundled dependency that would need a registry)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, statSync, readdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const CONSUMER = resolve(import.meta.dirname);
const PKG_ROOT = join(CONSUMER, "node_modules", "pdf-tools-core");
const CLI_JS = join(PKG_ROOT, "dist", "cli", "cli.js");
const BIN_SHIM = join(CONSUMER, "node_modules", ".bin", "pdf-tools-core.cmd");
const QPDF = process.platform === "win32" ? "qpdf.exe" : "qpdf";
const SCHEMA = join(PKG_ROOT, "schema", "supplier-protocol-v1.schema.json");
const RUN = join(CONSUMER, "run");



/** Every limit generous EXCEPT the one under test. */
const BIG = 512 * 1024 * 1024;

const results = [];
let hardFail = false;

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  if (!pass) hardFail = true;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Consumer-owned minimal PDF generator (xref-correct, qpdf-clean).
 * ------------------------------------------------------------------ */
function buildPdf(pageCount, label) {
  const n = pageCount;
  const objs = [];
  const kids = [];
  for (let i = 0; i < n; i++) kids.push(`${4 + i} 0 R`);

  objs[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objs[2] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${n} >>`;
  objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  for (let i = 0; i < n; i++) {
    objs[4 + i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + n + i} 0 R >>`;
  }
  for (let i = 0; i < n; i++) {
    const stream = `BT /F1 24 Tf 72 700 Td (${label} page ${i + 1}) Tj ET\n`;
    const len = Buffer.byteLength(stream, "latin1");
    objs[4 + n + i] = `<< /Length ${len} >>\nstream\n${stream}endstream`;
  }

  const total = 3 + 2 * n;
  let body = "%PDF-1.4\n";
  const offsets = [];
  for (let num = 1; num <= total; num++) {
    offsets[num] = Buffer.byteLength(body, "latin1");
    body += `${num} 0 obj\n${objs[num]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(body, "latin1");
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let num = 1; num <= total; num++) {
    xref += `${String(offsets[num]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "latin1");
}

/* ------------------------------------------------------------------ *
 * Installed-package shape / identity / hygiene (TGZ-only).
 * ------------------------------------------------------------------ */
function checkInstalledShape() {
  const leaks = ["src", "tests", "coverage", ".git", ".workbuddy", "TEMP", "fixtures", "vendor"];
  const present = leaks.filter((d) => existsSync(join(PKG_ROOT, d)));
  record("no dev/QA leakage in installed tree", present.length === 0, `unexpected: [${present.join(", ")}]`);

  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));
  record("name/version is the RC5 artifact", pkg.name === "pdf-tools-core" && pkg.version === "1.0.0-rc5", `${pkg.name}@${pkg.version}`);
  record("bundleDependencies remains ajv only", JSON.stringify(pkg.bundleDependencies) === '["ajv"]', JSON.stringify(pkg.bundleDependencies));
  const ajvPkg = JSON.parse(readFileSync(join(PKG_ROOT, "node_modules", "ajv", "package.json"), "utf-8"));
  const uriPkg = JSON.parse(readFileSync(join(PKG_ROOT, "node_modules", "fast-uri", "package.json"), "utf-8"));
  record("AJV remains 8.20.0", ajvPkg.version === "8.20.0", ajvPkg.version);
  record("bundled fast-uri is the locked security patch", uriPkg.version === "3.1.8", uriPkg.version);
  record("canonical schema byte identity", sha256(SCHEMA) === "863662f704b1001fb309741d5b2842a258ac62deba3135534feff4ce6acd38fc", sha256(SCHEMA));
  record("bin maps to dist/cli/cli.js", pkg.bin?.["pdf-tools-core"] === "./dist/cli/cli.js", JSON.stringify(pkg.bin));
  const hooks = ["preinstall", "install", "postinstall", "prepare"].filter((h) => pkg.scripts?.[h]);
  record("no install-time lifecycle scripts", hooks.length === 0, `hooks: [${hooks.join(", ")}]`);

  record("CLI entry present", existsSync(CLI_JS), CLI_JS);
  record("npm-generated .bin shim present", existsSync(BIN_SHIM), BIN_SHIM);
  record("bundled ajv present", existsSync(join(PKG_ROOT, "node_modules", "ajv")), "node_modules/ajv");
  record("canonical schema shipped", existsSync(SCHEMA), SCHEMA);
  record("LICENSE shipped", existsSync(join(PKG_ROOT, "LICENSE")), "LICENSE");
  record("THIRD-PARTY-NOTICES shipped", existsSync(join(PKG_ROOT, "THIRD-PARTY-NOTICES")), "THIRD-PARTY-NOTICES");

  // Hygiene: no dependency dev assets may survive into the production package.
  const nmRoot = join(PKG_ROOT, "node_modules");
  const devLeftovers = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        if (/^(test|tests|spec|benchmark|benchmarks|\.github|docs|examples)$/i.test(name)) devLeftovers.push(p);
        else walk(p);
      } else if (/\.(ts|map|md|ya?ml)$/i.test(name)) {
        devLeftovers.push(p);
      }
    }
  };
  if (existsSync(nmRoot)) walk(nmRoot);
  record("no dependency dev assets (.ts/.map/.md/.yml/test/benchmark/.github)", devLeftovers.length === 0,
    devLeftovers.length === 0 ? "clean" : devLeftovers.slice(0, 5).join(", "));

  const nativeFiles = [];
  const inventory = d => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const file = join(d, entry.name);
      if (entry.isDirectory()) inventory(file);
      else if (/\.(exe|dll|so(?:\.\d+)*|dylib|lib|a)$/i.test(entry.name)) nativeFiles.push(relative(PKG_ROOT, file));
    }
  };
  inventory(PKG_ROOT);
  record("installed tgz has no native binaries", nativeFiles.length === 0, JSON.stringify(nativeFiles));
  const where = spawnSync(join(process.env.SystemRoot || process.env.SYSTEMROOT || "C:/Windows", "System32", "where.exe"), ["qpdf.exe"], { cwd: CONSUMER, encoding: "utf8", windowsHide: true });
  const resolvedQpdf = String(where.stdout || "").trim().split(/\r?\n/)[0];
  record("system PATH resolves a real external qpdf", where.status === 0 && !!resolvedQpdf && existsSync(resolvedQpdf), resolvedQpdf || String(where.error || where.stderr));
  const relQpdf = resolvedQpdf ? relative(PKG_ROOT, resolvedQpdf) : "";
  record("PATH qpdf is outside installed package", !!resolvedQpdf && (relQpdf.startsWith("..") || isAbsolute(relQpdf)), resolvedQpdf || "missing");
  const version = spawnSync(QPDF, ["--version"], { cwd: CONSUMER, encoding: "utf8", windowsHide: true });
  const firstLine = String(version.stdout || "").trim().split(/\r?\n/)[0];
  record("real system PATH qpdf is exactly 12.4.0", version.status === 0 && firstLine === "qpdf version 12.4.0", firstLine || String(version.error || version.stderr));
  if (resolvedQpdf && existsSync(resolvedQpdf)) console.log("EXTERNAL_QPDF_SHA256: " + sha256(resolvedQpdf));

  // Offline completeness: every declared dep must be bundled, so no registry is
  // needed at install or run time.
  const deps = Object.keys(pkg.dependencies ?? {});
  const missing = deps.filter((d) => !existsSync(join(nmRoot, d)));
  record("all runtime deps bundled (fully offline)", missing.length === 0,
    missing.length === 0 ? `bundled: ${deps.join(", ")}` : `missing: ${missing.join(", ")}`);
}

/* ------------------------------------------------------------------ *
 * Validator built on the TGZ's OWN bundled ajv + schema.
 * ------------------------------------------------------------------ */
async function makeValidator() {
  const req = createRequire(join(PKG_ROOT, "package.json"));
  const ajvPath = req.resolve("ajv/dist/2020.js");
  const m = await import(pathToFileURL(ajvPath).href);
  const Ajv2020 = m.Ajv2020 ?? m.default?.Ajv2020 ?? m.default;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile(JSON.parse(readFileSync(SCHEMA, "utf-8")));
}

/* ------------------------------------------------------------------ *
 * CLI helpers.
 * ------------------------------------------------------------------ */
function runCli(args) {
  return spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: "utf-8",
    cwd: CONSUMER,
    windowsHide: true
  });
}

function qpdfPages(file) {
  const r = spawnSync(QPDF, ["--show-npages", file], { encoding: "utf-8" });
  return r.status === 0 ? Number(String(r.stdout).trim()) : -1;
}

function qpdfCheckClean(file) {
  const r = spawnSync(QPDF, ["--check", file], { encoding: "utf-8" });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return r.status === 0 && /No syntax or stream encoding errors found/i.test(text);
}

function qpdfHasRotate90(file) {
  const r = spawnSync(QPDF, ["--json", file], { encoding: "utf-8" });
  return r.status === 0 && /"\/Rotate":\s*90/.test(String(r.stdout));
}

/* ------------------------------------------------------------------ *
 * Request plumbing.
 * ------------------------------------------------------------------ */
function limitsWith(overrides = {}) {
  return {
    maxInputFiles: 100,
    maxInputBytesPerFile: BIG,
    maxTotalInputBytes: BIG,
    maxOutputFiles: 1000,
    maxOutputBytesPerFile: BIG,
    maxTotalOutputBytes: BIG,
    maxPagesPerInput: 100000,
    maxTotalPages: 100000,
    maxWorkspaceBytes: BIG,
    timeoutMs: 60000,
    ...overrides
  };
}

function makeWorkspace(tag, specs) {
  const root = join(RUN, tag);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "inputs"), { recursive: true });
  const inputs = [];
  for (const [idx, spec] of specs.entries()) {
    const rel = `inputs/${spec.name}`;
    const abs = join(root, rel);
    writeFileSync(abs, buildPdf(spec.pages, spec.label));
    inputs.push({
      id: `in-${idx + 1}`,
      relativePath: rel,
      snapshot: { byteSize: statSync(abs).size, sha256: sha256(abs), displayName: spec.name }
    });
  }
  return { root, inputs };
}

function invoke(root, operation, inputs, parameters, limits) {
  const request = {
    kind: "pdf.tools.request",
    protocolVersion: 1,
    invocationId: randomUUID(),
    operation,
    workspace: { rootPath: root },
    inputs
  };
  if (parameters !== undefined) request.parameters = parameters;
  if (limits !== undefined) request.limits = limits;

  const reqPath = join(root, "request.json");
  const respPath = join(root, "response.json");
  writeFileSync(reqPath, JSON.stringify(request, null, 2));
  const r = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
  const resp = existsSync(respPath) ? JSON.parse(readFileSync(respPath, "utf-8")) : null;
  return { request, resp, status: r.status, stderr: String(r.stderr ?? "") };
}

/* ------------------------------------------------------------------ *
 * Five V1 operations.
 * ------------------------------------------------------------------ */
function runOperation(validate, op, tag, specs, parameters, expect) {
  const { root, inputs } = makeWorkspace(tag, specs);
  const { resp, status } = invoke(root, op, inputs, parameters, undefined);
  const detail = [];
  let pass = true;

  if (status !== 0) { pass = false; detail.push(`exit=${status}`); }
  if (resp === null) { record(op, false, "no response file"); return; }
  if (!validate(resp)) { pass = false; detail.push(`schema invalid: ${JSON.stringify(validate.errors?.[0] ?? {})}`); }
  if (resp.status !== "succeeded") { pass = false; detail.push(`status=${resp.status} error=${JSON.stringify(resp.error ?? null)}`); }
  if (resp.provenance?.coreVersion !== "1.0.0-rc5") { pass = false; detail.push(`coreVersion=${resp.provenance?.coreVersion}`); }
  const missingStatus = { ...resp }; delete missingStatus.status;
  if (validate(missingStatus) || validate({ ...resp, unexpected: true })) { pass = false; detail.push("invalid response accepted"); }

  const outs = resp.outputs ?? [];
  if (outs.length !== expect.outputs) { pass = false; detail.push(`outputs=${outs.length} expected=${expect.outputs}`); }

  const pageCounts = [];
  for (const o of outs) {
    const abs = join(root, o.relativePath);
    if (!existsSync(abs)) { pass = false; detail.push(`missing ${o.relativePath}`); continue; }
    if (sha256(abs) !== o.sha256) { pass = false; detail.push(`sha mismatch ${o.relativePath}`); }
    const np = qpdfPages(abs);
    pageCounts.push(np);
    if (np !== o.pageCount) { pass = false; detail.push(`pageCount ${o.pageCount} != ${np}`); }
    if (!qpdfCheckClean(abs)) { pass = false; detail.push(`qpdf --check unclean ${o.relativePath}`); }
  }
  if (JSON.stringify(pageCounts) !== JSON.stringify(expect.pages)) {
    pass = false; detail.push(`pages=${JSON.stringify(pageCounts)} expected=${JSON.stringify(expect.pages)}`);
  }
  if (expect.rotate90 && outs.length > 0) {
    const abs = join(root, outs[0].relativePath);
    if (!qpdfHasRotate90(abs)) { pass = false; detail.push("no /Rotate 90 in output"); }
  }
  detail.unshift(`outputs=${outs.length} pages=${JSON.stringify(pageCounts)}`);
  record(op, pass, detail.join("; "));
}

/* ------------------------------------------------------------------ *
 * Host limit probes — each must be RED with the exact frozen code.
 * ------------------------------------------------------------------ */
function runLimitProbe(validate, label, op, tag, specs, parameters, overrides, expectedCode) {
  const { root, inputs } = makeWorkspace(tag, specs);
  const { resp, status } = invoke(root, op, inputs, parameters, limitsWith(overrides));
  let pass = true;
  const detail = [];

  if (status !== 0) { pass = false; detail.push(`exit=${status}`); }
  if (resp === null) { record(label, false, "no response file"); return; }
  if (!validate(resp)) { pass = false; detail.push("response schema invalid"); }
  if (resp.status !== "failed") { pass = false; detail.push(`status=${resp.status} (expected failed)`); }
  if (resp.error?.code !== expectedCode) { pass = false; detail.push(`code=${resp.error?.code} expected=${expectedCode}`); }
  if (resp.error?.stage !== "resource") { pass = false; detail.push(`stage=${resp.error?.stage}`); }

  // No partial success: the published output area must be empty.
  const outDir = join(root, "output");
  const left = existsSync(outDir) ? readdirSync(outDir) : [];
  if (left.length !== 0) { pass = false; detail.push(`residue: ${left.join(", ")}`); }

  detail.unshift(`code=${resp.error?.code}`);
  record(label, pass, detail.join("; "));
}

/* ------------------------------------------------------------------ *
 * Startup + negative surfaces.
 * ------------------------------------------------------------------ */
function checkStartupAndNegatives(validate) {
  // npm-generated shim must start AND propagate the exit code.
  const shim = spawnSync(process.env.ComSpec || "cmd.exe", ["/c", BIN_SHIM], {
    encoding: "utf-8", cwd: CONSUMER, windowsHide: true
  });
  const shimText = `${shim.stdout ?? ""}${shim.stderr ?? ""}`;
  record("CLI startup via npm .bin shim (exit 2 + usage)",
    shim.status === 2 && /usage: pdf-tools-core --protocol 1/.test(shimText), `exit=${shim.status}`);

  mkdirSync(RUN, { recursive: true });
  const badReq = join(RUN, "malformed-request.json");
  const badResp = join(RUN, "malformed-response.json");
  rmSync(badResp, { force: true });
  writeFileSync(badReq, '{ "kind": "pdf.tools.request", "protocolVersion": 1, ');
  const bad = runCli(["--protocol", "1", "--request", badReq, "--response", badResp]);
  record("malformed JSON -> controlled failure (exit 2, no response)",
    bad.status === 2 && /request is not valid JSON/.test(String(bad.stderr)) && !existsSync(badResp),
    `exit=${bad.status}`);

  const invReq = join(RUN, "invalid-request.json");
  const invResp = join(RUN, "invalid-response.json");
  rmSync(invResp, { force: true });
  writeFileSync(invReq, JSON.stringify({
    kind: "pdf.tools.request", protocolVersion: 1, invocationId: randomUUID(),
    operation: "pdf.merge", workspace: { rootPath: RUN },
    inputs: [{ id: "in-1", relativePath: "nope.pdf", snapshot: { byteSize: 1, sha256: "0".repeat(64), displayName: "n" } }],
    bogusField: true
  }));
  const inv = runCli(["--protocol", "1", "--request", invReq, "--response", invResp]);
  let invPass = inv.status === 0 && existsSync(invResp);
  let invDetail = `exit=${inv.status}`;
  if (invPass) {
    const resp = JSON.parse(readFileSync(invResp, "utf-8"));
    invPass = validate(resp) && resp.status === "failed" && resp.error?.code === "request.unknown_field";
    invDetail += ` code=${resp.error?.code}`;
  }
  record("protocol rejects unknown field -> failed response", invPass, invDetail);

  const verResp = join(RUN, "version-response.json");
  rmSync(verResp, { force: true });
  const ver = runCli(["--protocol", "2", "--request", invReq, "--response", verResp]);
  record("unsupported protocol version -> exit 2",
    ver.status === 2 && /unsupported protocol version 2/.test(String(ver.stderr)) && !existsSync(verResp),
    `exit=${ver.status}`);
}

function checkContainment(validate) {
  for (const directory of ["output", "staging"]) {
    const { root, inputs } = makeWorkspace("containment-" + directory, [{ name: "input.pdf", pages: 2, label: "Containment" }]);
    const outside = join(RUN, "containment-outside-" + directory);
    mkdirSync(outside);
    symlinkSync(outside, join(root, directory), "junction");
    const { resp, status } = invoke(root, "pdf.merge", inputs, undefined, undefined);
    const unchanged = inputs.every(input => sha256(join(root, input.relativePath)) === input.snapshot.sha256);
    const emptyStage = !existsSync(join(root, "staging")) || readdirSync(join(root, "staging")).length === 0;
    const emptyOutput = !existsSync(join(root, "output")) || readdirSync(join(root, "output")).length === 0;
    const pass = status === 0 && resp && validate(resp) && resp.status === "failed" && resp.error?.code === "workspace.escape" &&
      !Object.hasOwn(resp, "outputs") && readdirSync(outside).length === 0 && unchanged && emptyStage && emptyOutput;
    record("containment rejects " + directory + " junction", !!pass, "outsideFiles=" + JSON.stringify(readdirSync(outside)) + " inputUnchanged=" + unchanged + " stagingEmpty=" + emptyStage);
  }
}

/* ------------------------------------------------------------------ *
 * Main.
 * ------------------------------------------------------------------ */
const validate = await makeValidator();
mkdirSync(RUN, { recursive: true });

checkInstalledShape();
checkStartupAndNegatives(validate);
checkContainment(validate);

const SPECS_MERGE = [{ name: "a.pdf", pages: 3, label: "A" }, { name: "b.pdf", pages: 2, label: "B" }];
const SPECS_5 = [{ name: "c.pdf", pages: 5, label: "C" }];

// --- five V1 operations (external PATH qpdf) ---
runOperation(validate, "pdf.merge", "merge", SPECS_MERGE, undefined, { outputs: 1, pages: [5] });
runOperation(validate, "pdf.split", "split", SPECS_5, { strategy: { type: "every", n: 2 } }, { outputs: 3, pages: [2, 2, 1] });
runOperation(validate, "pdf.extract", "extract", SPECS_5, { pageSelector: { mode: "pages", pages: [0, 2, 4] } }, { outputs: 1, pages: [3] });
runOperation(validate, "pdf.rotate", "rotate", SPECS_5, { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "relative" }, { outputs: 1, pages: [5], rotate90: true });
runOperation(validate, "pdf.reorder", "reorder", SPECS_5, { pageOrder: [4, 3, 2, 1, 0] }, { outputs: 1, pages: [5] });

// --- Host limit probes (all must be RED) ---
runLimitProbe(validate, "LIMIT maxInputBytesPerFile=1", "pdf.merge", "lim-in-bytes", SPECS_MERGE, undefined,
  { maxInputBytesPerFile: 1 }, "resource.max_input_bytes");
runLimitProbe(validate, "LIMIT maxTotalInputBytes=1", "pdf.merge", "lim-in-total", SPECS_MERGE, undefined,
  { maxTotalInputBytes: 1 }, "resource.max_total_input_bytes");
runLimitProbe(validate, "LIMIT maxPagesPerInput=1", "pdf.merge", "lim-pages", SPECS_MERGE, undefined,
  { maxPagesPerInput: 1 }, "resource.max_pages");
runLimitProbe(validate, "LIMIT maxTotalPages=1", "pdf.merge", "lim-total-pages", SPECS_MERGE, undefined,
  { maxTotalPages: 1 }, "resource.max_total_pages");
runLimitProbe(validate, "LIMIT maxInputFiles=1", "pdf.merge", "lim-in-files", SPECS_MERGE, undefined,
  { maxInputFiles: 1 }, "resource.max_input_files");
runLimitProbe(validate, "LIMIT maxOutputBytesPerFile=1", "pdf.merge", "lim-out-bytes", SPECS_MERGE, undefined,
  { maxOutputBytesPerFile: 1 }, "resource.max_output_bytes");
runLimitProbe(validate, "LIMIT maxTotalOutputBytes=1", "pdf.merge", "lim-out-total", SPECS_MERGE, undefined,
  { maxTotalOutputBytes: 1 }, "resource.max_total_output_bytes");
runLimitProbe(validate, "LIMIT maxWorkspaceBytes=1", "pdf.merge", "lim-workspace", SPECS_MERGE, undefined,
  { maxWorkspaceBytes: 1 }, "resource.max_workspace_bytes");

// --- split multi-output AGGREGATE limit: per-file passes, set fails ---
{
  const splitParams = { strategy: { type: "every", n: 2 } };
  const m = makeWorkspace("split-measure", SPECS_5);
  const rm = invoke(m.root, "pdf.split", m.inputs, splitParams, limitsWith());
  const sizes = rm.resp?.status === "succeeded"
    ? rm.resp.outputs.map((o) => o.byteSize) : [];
  if (sizes.length !== 3) {
    record("LIMIT split aggregate (multi-output)", false, `measurement failed: ${rm.resp?.status}`);
  } else {
    const maxSingle = Math.max(...sizes);
    const total = sizes.reduce((a, c) => a + c, 0);
    runLimitProbe(validate, "LIMIT split aggregate (per-file OK, set over)", "pdf.split", "split-agg", SPECS_5, splitParams,
      { maxOutputBytesPerFile: maxSingle, maxTotalOutputBytes: total - 1 }, "resource.max_total_output_bytes");
  }
}

console.log("\n=== RC5 CLEAN TGZ-ONLY CONSUMER SELF-SMOKE ===");
for (const r of results) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  -- ${r.detail}` : ""}`);
}
console.log(`\nOVERALL: ${hardFail ? "FAIL" : "PASS"}  (${results.filter((r) => r.pass).length}/${results.length})`);
process.exit(hardFail ? 1 : 0);
