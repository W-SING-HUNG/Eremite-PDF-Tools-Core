/**
 * V1 operation execution (single- and multi-output operations).
 *
 * merge / extract / rotate / reorder / split. Every operation:
 *   1. validates protocol page indices against the real page count,
 *   2. builds argv through the planner (never from caller input),
 *   3. runs qpdf with timeout + output caps,
 *   4. re-verifies the produced output (structure + page count + rotation),
 *   5. only then publishes staging -> output (no clobber).
 *
 * Page indices are 0-based on the protocol side; the 1-based conversion happens
 * inside argv.ts (engine boundary).
 */

import { renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { runProcess, DEFAULT_STDERR_MAX_BYTES, DEFAULT_STDOUT_MAX_BYTES } from "./spawn.js";
import { planMerge, planExtract, planRotate, planReorder, planSplit } from "./argv.js";
import { expandPageSelector } from "./pages.js";
import { verifyOutput, readPageRotations, normalizeRotation, type OutputFacts } from "./verify.js";
import type { PageSelector } from "../protocol/types.js";
import type { ErrorCode, Stage, WarningCode } from "../taxonomy/index.js";
import { resolveContainedTarget } from "../workspace/index.js";

export interface EngineContext {
  /** Canonical root fixed by executeRequest for this invocation. */
  workspaceRoot: string;
  /** Absolute path to the pinned qpdf executable. */
  exe: string;
  timeoutMs: number;
  /** Absolute staging directory (Core-managed, inside the workspace). */
  stagingDir: string;
  /** Absolute published output directory (Core-managed, inside the workspace). */
  outputDir: string;
  /** Upper bound on the number of output files (preflight guard). */
  maxOutputFiles: number;
}

export interface ResolvedInput {
  id: string;
  absolutePath: string;
  relativePath: string;
  pageCount: number;
}

export interface ProducedOutput {
  id: string;
  displayName: string;
  /** Workspace-relative path (never absolute on the public wire). */
  relativePath: string;
  byteSize: number;
  sha256: string;
  pageCount: number;
}

export type EngineOutcome =
  | { ok: true; outputs: ProducedOutput[]; warnings: WarningCode[] }
  | { ok: false; code: ErrorCode; stage: Stage; detail?: string };

function fail(code: ErrorCode, stage: Stage, detail?: string): EngineOutcome {
  return { ok: false, code, stage, ...(detail === undefined ? {} : { detail }) };
}

function resolveTarget(ctx: EngineContext, area: "staging" | "output", absolutePath: string) {
  return resolveContainedTarget(ctx.workspaceRoot, relative(ctx.workspaceRoot, absolutePath), area);
}

/** True when every 0-based index is within [0, pageCount). */
function indicesInRange(pages: number[], pageCount: number): boolean {
  return pages.every((p) => Number.isSafeInteger(p) && p >= 0 && p < pageCount);
}

function hasDuplicate(pages: number[]): boolean {
  return new Set(pages).size !== pages.length;
}

/**
 * Run a plan and validate the produced SINGLE output.
 * `stagingPath` is the exact staging file; it is never derived from `plan`.
 */
async function runAndVerify(
  ctx: EngineContext,
  argv: string[],
  stagingPath: string,
  expectedPageCount: number
): Promise<{ ok: true; facts: OutputFacts } | { ok: false; code: ErrorCode; stage: Stage; detail?: string }> {
  const outputPath = join(ctx.outputDir, relative(ctx.stagingDir, stagingPath));
  if (!resolveTarget(ctx, "staging", stagingPath).ok || !resolveTarget(ctx, "output", outputPath).ok) {
    return { ok: false, code: "workspace.escape", stage: "workspace" };
  }
  const res = await runProcess(ctx.exe, argv, {
    timeoutMs: ctx.timeoutMs,
    stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
  });

  if (res.timedOut) return { ok: false, code: "timeout.engine", stage: "timeout" as Stage };
  if (res.exitCode !== 0) {
    // Never surface stderr / command / paths publicly.
    return { ok: false, code: "engine.nonzero_exit", stage: "engine" as Stage };
  }

  if (!resolveTarget(ctx, "staging", stagingPath).ok) {
    return { ok: false, code: "workspace.escape", stage: "workspace" };
  }
  const verified = await verifyOutput(ctx.exe, stagingPath, expectedPageCount, ctx.timeoutMs);
  if (!verified.ok) {
    return { ok: false, code: "output.wrong_type", stage: "output" as Stage, detail: verified.reason };
  }
  return { ok: true, facts: verified.facts };
}

/**
 * Publish a staging file into the output area. No silent overwrite: an existing
 * destination is a controlled failure (frozen no-clobber rule).
 */
function publishOne(
  ctx: EngineContext,
  stagingPath: string,
  outputName: string
): { ok: true; relativePath: string } | { ok: false; code: ErrorCode; stage: Stage } {
  const source = resolveTarget(ctx, "staging", stagingPath);
  const dest = resolveTarget(ctx, "output", join(ctx.outputDir, outputName));
  if (!source.ok || !dest.ok) return { ok: false, code: "workspace.escape", stage: "workspace" };
  if (existsSync(dest.value)) {
    return { ok: false, code: "output.exists", stage: "output" as Stage };
  }
  try {
    renameSync(source.value, dest.value);
  } catch {
    return { ok: false, code: "publish.failed", stage: "publish" as Stage };
  }
  return { ok: true, relativePath: relative(ctx.workspaceRoot, dest.value).replace(/\\/g, "/") };
}

/* ------------------------------------------------------------------ *
 * merge
 * ------------------------------------------------------------------ */

export async function executeMerge(
  ctx: EngineContext,
  inputs: ResolvedInput[],
  outputName = "merge.pdf"
): Promise<EngineOutcome> {
  const inputPaths = inputs.map((i) => i.absolutePath);
  const expectedPages = inputs.reduce((sum, i) => {
    const next = sum + i.pageCount;
    return Number.isSafeInteger(next) ? next : -1;
  }, 0);
  if (expectedPages < 0) return fail("resource.max_total_pages", "resource" as Stage);

  const stagingPath = join(ctx.stagingDir, outputName);
  const plan = planMerge(inputPaths, stagingPath);
  const run = await runAndVerify(ctx, plan.argv, stagingPath, expectedPages);
  if (!run.ok) return fail(run.code, run.stage, run.detail);

  const pub = publishOne(ctx, stagingPath, outputName);
  if (!pub.ok) return fail(pub.code, pub.stage);

  return {
    ok: true,
    outputs: [{
      id: "out-0",
      displayName: outputName,
      relativePath: pub.relativePath,
      byteSize: run.facts.byteSize,
      sha256: run.facts.sha256,
      pageCount: run.facts.pageCount
    }],
    warnings: []
  };
}

/* ------------------------------------------------------------------ *
 * extract
 * ------------------------------------------------------------------ */

export async function executeExtract(
  ctx: EngineContext,
  input: ResolvedInput,
  selector: PageSelector,
  outputName = "extract.pdf"
): Promise<EngineOutcome> {
  const selected = expandPageSelector(selector);
  if (!indicesInRange(selected, input.pageCount)) {
    return fail("parameter.out_of_range", "parameter" as Stage);
  }

  const stagingPath = join(ctx.stagingDir, outputName);
  const plan = planExtract(input.absolutePath, selector, stagingPath);
  const run = await runAndVerify(ctx, plan.argv, stagingPath, selected.length);
  if (!run.ok) return fail(run.code, run.stage, run.detail);

  const pub = publishOne(ctx, stagingPath, outputName);
  if (!pub.ok) return fail(pub.code, pub.stage);

  const warnings: WarningCode[] = hasDuplicate(selected) ? ["w.duplicate_page_emitted"] : [];
  return {
    ok: true,
    outputs: [{
      id: "out-0",
      displayName: outputName,
      relativePath: pub.relativePath,
      byteSize: run.facts.byteSize,
      sha256: run.facts.sha256,
      pageCount: run.facts.pageCount
    }],
    warnings
  };
}

/* ------------------------------------------------------------------ *
 * rotate
 * ------------------------------------------------------------------ */

export async function executeRotate(
  ctx: EngineContext,
  input: ResolvedInput,
  selector: PageSelector,
  angle: 90 | 180 | 270,
  mode: "relative" | "absolute",
  outputName = "rotate.pdf"
): Promise<EngineOutcome> {
  const selected = expandPageSelector(selector);
  if (!indicesInRange(selected, input.pageCount)) {
    return fail("parameter.out_of_range", "parameter" as Stage);
  }

  // Baseline rotation of the SOURCE pages (to prove "others untouched").
  const before = await readPageRotations(ctx.exe, input.absolutePath, ctx.timeoutMs);
  if (before === null) return fail("pdf_validation.malformed", "pdf_validation" as Stage);

  const stagingPath = join(ctx.stagingDir, outputName);
  const plan = planRotate(input.absolutePath, selector, angle, mode, stagingPath);
  // rotate never changes the page count.
  const run = await runAndVerify(ctx, plan.argv, stagingPath, input.pageCount);
  if (!run.ok) return fail(run.code, run.stage, run.detail);

  // Prove the ACTUAL rotation result (not just exit code).
  const after = await readPageRotations(ctx.exe, stagingPath, ctx.timeoutMs);
  if (after === null) return fail("output.wrong_type", "output" as Stage, "rotation unreadable");
  if (after.length !== before.length) {
    return fail("output.page_count_mismatch", "output" as Stage);
  }

  const selectedSet = new Set(selected);
  for (let i = 0; i < after.length; i++) {
    const orig = before[i] ?? 0;
    const actual = after[i] ?? 0;
    const expected = selectedSet.has(i)
      ? (mode === "relative" ? normalizeRotation(orig + angle) : normalizeRotation(angle))
      : orig;
    if (actual !== expected) {
      return fail("output.page_count_mismatch", "output" as Stage, `page ${i} rotation ${actual} != ${expected}`);
    }
  }

  const pub = publishOne(ctx, stagingPath, outputName);
  if (!pub.ok) return fail(pub.code, pub.stage);

  return {
    ok: true,
    outputs: [{
      id: "out-0",
      displayName: outputName,
      relativePath: pub.relativePath,
      byteSize: run.facts.byteSize,
      sha256: run.facts.sha256,
      pageCount: run.facts.pageCount
    }],
    warnings: []
  };
}

/* ------------------------------------------------------------------ *
 * reorder
 * ------------------------------------------------------------------ */

export async function executeReorder(
  ctx: EngineContext,
  input: ResolvedInput,
  pageOrder: number[],
  outputName = "reorder.pdf"
): Promise<EngineOutcome> {
  if (!indicesInRange(pageOrder, input.pageCount)) {
    return fail("parameter.out_of_range", "parameter" as Stage);
  }
  // Frozen: reorder is a full arrangement of ALL source pages. Omission is not
  // allowed (deleting pages belongs to extract, not reorder).
  const covered = new Set(pageOrder);
  if (covered.size !== input.pageCount) {
    return fail("parameter.invalid_page_selector", "parameter" as Stage, "pageOrder must cover every source page at least once");
  }

  const stagingPath = join(ctx.stagingDir, outputName);
  const plan = planReorder(input.absolutePath, pageOrder, stagingPath);
  const run = await runAndVerify(ctx, plan.argv, stagingPath, pageOrder.length);
  if (!run.ok) return fail(run.code, run.stage, run.detail);

  const pub = publishOne(ctx, stagingPath, outputName);
  if (!pub.ok) return fail(pub.code, pub.stage);

  const warnings: WarningCode[] = hasDuplicate(pageOrder) ? ["w.duplicate_page_emitted"] : [];
  return {
    ok: true,
    outputs: [{
      id: "out-0",
      displayName: outputName,
      relativePath: pub.relativePath,
      byteSize: run.facts.byteSize,
      sha256: run.facts.sha256,
      pageCount: run.facts.pageCount
    }],
    warnings
  };
}

/* ------------------------------------------------------------------ *
 * split (multi-output, all-or-none observable semantics)
 * ------------------------------------------------------------------ */

/** 1-based chunk index -> expected page count for that chunk. */
function chunkPageCount(chunkIndex1Based: number, totalPages: number, n: number): number {
  const fullChunks = Math.floor(totalPages / n);
  const remainder = totalPages % n;
  if (chunkIndex1Based <= fullChunks) return n;
  if (chunkIndex1Based === fullChunks + 1 && remainder !== 0) return remainder;
  // Should not happen for a well-formed preflight; treat as 0 (caught downstream).
  return 0;
}

export async function executeSplit(
  ctx: EngineContext,
  input: ResolvedInput,
  n: number,
  outputNamePrefix = "part"
): Promise<EngineOutcome> {
  const totalPages = input.pageCount;
  if (!Number.isSafeInteger(n) || n <= 0) {
    return fail("parameter.invalid_page_selector", "parameter" as Stage, "split n must be a positive integer");
  }
  if (totalPages <= 0) {
    return fail("parameter.out_of_range", "parameter" as Stage, "input has no pages to split");
  }
  // Preflight: the EXPECTED output count is computed from the page-count, never
  // from what qpdf happens to emit into the directory.
  const expectedCount = Math.ceil(totalPages / n);
  if (expectedCount > ctx.maxOutputFiles) {
    return fail("resource.max_output_files", "resource" as Stage);
  }

  // Single qpdf split operation (never a loop of --pages). qpdf substitutes the
  // `%d` in the pattern with the page RANGE (e.g. "1-2"), so the intermediate
  // names are non-sequential; we discover and deterministically rename them.
  const pattern = join(ctx.stagingDir, `${outputNamePrefix}-%d.pdf`);
  if (!resolveTarget(ctx, "staging", pattern).ok) return fail("workspace.escape", "workspace");
  // Check existing leaves qpdf may replace, as well as every deterministic
  // target. qpdf range filenames are produced by the pinned engine itself.
  for (const name of readdirSync(ctx.stagingDir)) {
    if (name.startsWith(`${outputNamePrefix}-`) && name.toLowerCase().endsWith(".pdf") &&
        !resolveTarget(ctx, "staging", join(ctx.stagingDir, name)).ok) {
      return fail("workspace.escape", "workspace");
    }
  }
  for (let i = 0; i < expectedCount; i++) {
    const name = `part-${String(i + 1).padStart(4, "0")}.pdf`;
    if (!resolveTarget(ctx, "staging", join(ctx.stagingDir, name)).ok ||
        !resolveTarget(ctx, "output", join(ctx.outputDir, name)).ok) {
      return fail("workspace.escape", "workspace");
    }
  }
  const plan = planSplit(input.absolutePath, n, pattern, expectedCount);
  const res = await runProcess(ctx.exe, plan.argv, {
    timeoutMs: ctx.timeoutMs,
    stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
  });
  if (res.timedOut) return fail("timeout.engine", "timeout" as Stage);
  if (res.exitCode !== 0) return fail("engine.nonzero_exit", "engine" as Stage);

  // Discover the actual chunk files qpdf emitted (named by page range).
  let entries: string[];
  try {
    entries = readdirSync(ctx.stagingDir);
  } catch {
    return fail("output.missing", "output" as Stage, "staging directory unreadable after split");
  }
  const prefix = `${outputNamePrefix}-`;
  const rawNames = entries.filter((e) => e.startsWith(prefix) && e.toLowerCase().endsWith(".pdf"));
  if (rawNames.length !== expectedCount) {
    rollbackStaging(ctx);
    return fail("output.missing", "output" as Stage,
      `split produced ${rawNames.length} files, expected ${expectedCount}`);
  }
  // Deterministic chunk order: sort by the range's START page (1-based).
  const startPage = (name: string): number => {
    const m = name.slice(prefix.length).match(/^(\d+)-/);
    return m && m[1] ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  rawNames.sort((a, b) => startPage(a) - startPage(b));

  // Verify + rename each chunk to a deterministic `part-NNNN.pdf`.
  const finalNames: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    const rawName = rawNames[i]!;
    const rawPath = join(ctx.stagingDir, rawName);
    if (!resolveTarget(ctx, "staging", rawPath).ok) {
      rollbackStaging(ctx);
      return fail("workspace.escape", "workspace");
    }
    const expectedPages = chunkPageCount(i + 1, totalPages, n);
    const verified = await verifyOutput(ctx.exe, rawPath, expectedPages, ctx.timeoutMs);
    if (!verified.ok) {
      rollbackStaging(ctx);
      return fail("output.wrong_type", "output" as Stage, `${rawName}: ${verified.reason}`);
    }
    const finalName = `part-${String(i + 1).padStart(4, "0")}.pdf`;
    const finalPath = join(ctx.stagingDir, finalName);
    const source = resolveTarget(ctx, "staging", rawPath);
    const dest = resolveTarget(ctx, "staging", finalPath);
    if (!source.ok || !dest.ok) {
      rollbackStaging(ctx);
      return fail("workspace.escape", "workspace");
    }
    try {
      renameSync(source.value, dest.value);
    } catch {
      rollbackStaging(ctx);
      return fail("publish.failed", "publish" as Stage, `rename split chunk ${rawName}`);
    }
    finalNames.push(finalName);
  }

  // All-or-none publish. Any failure rolls back already-published outputs.
  const publishedNames: string[] = [];
  for (const finalName of finalNames) {
    const stagingPath = join(ctx.stagingDir, finalName);
    const pub = publishOne(ctx, stagingPath, finalName);
    if (!pub.ok) {
      rollbackPublished(ctx, publishedNames);
      return fail(pub.code, pub.stage);
    }
    publishedNames.push(finalName);
  }

  const produced: ProducedOutput[] = finalNames.map((finalName, i) => ({
    id: `out-${i}`,
    displayName: finalName,
    relativePath: `output/${finalName}`,
    byteSize: 0,
    sha256: "",
    pageCount: chunkPageCount(i + 1, totalPages, n)
  }));
  // Re-read facts from the published files (authoritative byteSize/sha256).
  for (let i = 0; i < finalNames.length; i++) {
    const publishedPath = resolveTarget(ctx, "output", join(ctx.outputDir, finalNames[i]!));
    if (!publishedPath.ok) {
      rollbackPublished(ctx, publishedNames);
      return fail("workspace.escape", "workspace");
    }
    const verified = await verifyOutput(ctx.exe, publishedPath.value, chunkPageCount(i + 1, totalPages, n), ctx.timeoutMs);
    if (!verified.ok) {
      rollbackPublished(ctx, publishedNames);
      return fail("output.wrong_type", "output" as Stage, `${finalNames[i]}: ${verified.reason}`);
    }
    produced[i]!.byteSize = verified.facts.byteSize;
    produced[i]!.sha256 = verified.facts.sha256;
    produced[i]!.pageCount = verified.facts.pageCount;
  }

  return {
    ok: true,
    outputs: produced,
    warnings: ["w.document_features_dropped"]
  };
}

/** Best-effort remove every split artifact left in staging (rollback). */
function rollbackStaging(ctx: EngineContext): void {
  if (!resolveTarget(ctx, "staging", ctx.stagingDir).ok) return;
  try {
    for (const name of readdirSync(ctx.stagingDir)) {
      if (name.toLowerCase().endsWith(".pdf")) {
        const target = resolveTarget(ctx, "staging", join(ctx.stagingDir, name));
        if (target.ok) {
          try { rmSync(target.value, { force: true }); } catch { /* best effort */ }
        }
      }
    }
  } catch { /* best effort */ }
}

/** Best-effort remove already-published outputs (rollback on partial publish). */
function rollbackPublished(ctx: EngineContext, publishedNames: string[]): void {
  for (const name of publishedNames) {
    const p = resolveTarget(ctx, "output", join(ctx.outputDir, name));
    if (p.ok && existsSync(p.value)) {
      try { rmSync(p.value, { force: true }); } catch { /* best effort */ }
    }
  }
}
