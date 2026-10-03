/**
 * Host Gate BLOCKER 1 regression tests: REAL resource-limit enforcement.
 *
 * The Host proved that setting every limit to 1 still produced a SUCCESS
 * response (outputByteSize=1271, outputPageCount=3). Root cause: limits were
 * only checked at the parse/validate layer (validateLimits verifies the VALUES
 * are positive safe integers) and were never compared to actual resource usage.
 *
 * Every test below drives the REAL qpdf engine through executeRequest with real
 * PDF fixtures. Nothing is mocked: the planner runs, qpdf runs, real output
 * bytes are produced, and only then are they measured against the limit.
 *
 * A limit <= 0 (or absent) means "no policy limit", so omitting `limits`
 * preserves P1-P4 behavior; these tests only exercise HOST-SUPPLIED limits.
 */

import { describe, it, expect } from "vitest";
import {
  readFileSync,
  copyFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { executeRequest } from "../src/core/index.js";
import { validateRequest } from "../src/protocol/validator.js";
import { tmp } from "./helpers/temp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";
const ENGINE_TIMEOUT = 60_000;

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Full limits object with generous defaults; overrides applied on top. */
function limits(overrides: Record<string, number> = {}) {
  return {
    maxInputFiles: 100,
    maxInputBytesPerFile: 100 * 1024 * 1024,
    maxTotalInputBytes: 500 * 1024 * 1024,
    maxOutputFiles: 1000,
    maxOutputBytesPerFile: 100 * 1024 * 1024,
    maxTotalOutputBytes: 500 * 1024 * 1024,
    maxPagesPerInput: 10000,
    maxTotalPages: 100000,
    maxWorkspaceBytes: 1024 * 1024 * 1024,
    timeoutMs: 60000,
    ...overrides
  };
}

const MERGE_INPUTS = [
  { id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }, // 5 pages
  { id: "b", rel: "input/b.pdf", fix: "alpha-multi-b.pdf" } // 3 pages
];

interface SetupOpts {
  operation: string;
  inputs: { id: string; rel: string; fix: string }[];
  parameters?: unknown;
  limits?: unknown;
  /** Pre-existing content placed in output/ BEFORE the request runs. */
  seedOutput?: { name: string; bytes: number };
}

function setup(opts: SetupOpts) {
  const t = tmp();
  const inputs = opts.inputs.map((inp) => {
    const dest = t.join(inp.rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(FIX, inp.fix), dest);
    const buf = readFileSync(dest);
    return {
      id: inp.id,
      relativePath: inp.rel,
      snapshot: { byteSize: buf.length, sha256: sha256(buf), displayName: inp.rel }
    };
  });

  if (opts.seedOutput) {
    const dir = t.join("output");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, opts.seedOutput.name), Buffer.alloc(opts.seedOutput.bytes, 0x41));
  }

  const req: Record<string, unknown> = {
    kind: "pdf.tools.request",
    protocolVersion: 1,
    invocationId: UUID_V7,
    operation: opts.operation,
    workspace: { rootPath: t.root },
    inputs
  };
  if (opts.parameters !== undefined) req.parameters = opts.parameters;
  if (opts.limits !== undefined) req.limits = opts.limits;
  return { root: t.root, req };
}

async function run(req: Record<string, unknown>) {
  const vr = validateRequest(req);
  if (!vr.ok) throw new Error(`request failed validation: ${JSON.stringify(vr)}`);
  return executeRequest(req as never);
}

const outDir = (root: string) => join(root, "output");
const stageDir = (root: string) => join(root, "staging");

function pdfFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
}

/** Assert a controlled resource failure (never a crash, never a success). */
function expectResourceFailure(response: unknown, code: string) {
  const r = response as { status?: string; error?: { code?: string; stage?: string } };
  expect(r.status).toBe("failed");
  expect(r.error?.code).toBe(code);
  expect(r.error?.stage).toBe("resource");
}

/* ------------------------------------------------------------------ *
 * 1-2: input byte limits
 * ------------------------------------------------------------------ */
describe("Host limit probes (real qpdf)", () => {
  it(
    "1. maxInputBytesPerFile=1 -> resource.max_input_bytes (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxInputBytesPerFile: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_input_bytes");
      // Enforcement is preflight: qpdf must never have produced anything.
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  it(
    "2. maxTotalInputBytes=1 -> resource.max_total_input_bytes (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxTotalInputBytes: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_total_input_bytes");
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  /* ---------------------------------------------------------------- *
   * 3-4: output byte limits
   * ---------------------------------------------------------------- */
  it(
    "3. maxOutputBytesPerFile=1 -> resource.max_output_bytes (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxOutputBytesPerFile: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_output_bytes");
      // Rolled back: no output may survive a limit failure.
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  it(
    "4. maxTotalOutputBytes=1 -> resource.max_total_output_bytes (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxTotalOutputBytes: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_total_output_bytes");
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  /* ---------------------------------------------------------------- *
   * 5-6: page limits
   * ---------------------------------------------------------------- */
  it(
    "5. maxPagesPerInput=1 on a 5-page input -> resource.max_pages (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxPagesPerInput: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_pages");
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  it(
    "6. maxTotalPages=1 (5+3 pages) -> resource.max_total_pages (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxTotalPages: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_total_pages");
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  /* ---------------------------------------------------------------- *
   * 7: workspace budget
   * ---------------------------------------------------------------- */
  it(
    "7. maxWorkspaceBytes=1 -> resource.max_workspace_bytes (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxWorkspaceBytes: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_workspace_bytes");
      // Rolled back, so the Core-managed output area is empty again.
      expect(readdirSync(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  it(
    "7b. workspace preflight fails BEFORE transform when already over budget",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxWorkspaceBytes: 1000 }),
        seedOutput: { name: "preexisting.bin", bytes: 5000 }
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_workspace_bytes");
      // Preflight aborted before qpdf ran: no PDF was ever produced.
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
      // Host-owned content in the workspace is left untouched.
      expect(existsSync(join(outDir(root), "preexisting.bin"))).toBe(true);
    },
    ENGINE_TIMEOUT
  );

  it(
    "7c. maxInputFiles=1 with 2 inputs -> resource.max_input_files (RED)",
    async () => {
      const { root, req } = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({ maxInputFiles: 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_input_files");
      expect(pdfFilesIn(outDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );

  /* ---------------------------------------------------------------- *
   * 8: legal boundary values must NOT over-block
   * ---------------------------------------------------------------- */
  it(
    "8. limits exactly at the measured boundary -> succeeded (no over-blocking)",
    async () => {
      // Pass 1: measure the real output size with generous limits.
      const m = setup({ operation: "pdf.merge", inputs: MERGE_INPUTS, limits: limits() });
      const r1 = await run(m.req);
      expect(r1.response.status).toBe("succeeded");
      const outBytes = (r1.response as { outputs: { byteSize: number }[] }).outputs[0]!.byteSize;
      expect(outBytes).toBeGreaterThan(0);

      const aBytes = statSync(join(FIX, "alpha-multi.pdf")).size;
      const bBytes = statSync(join(FIX, "alpha-multi-b.pdf")).size;

      // Pass 2: every limit set to exactly the measured value (not exceeded).
      const b = setup({
        operation: "pdf.merge",
        inputs: MERGE_INPUTS,
        limits: limits({
          maxInputFiles: 2,
          maxInputBytesPerFile: Math.max(aBytes, bBytes),
          maxTotalInputBytes: aBytes + bBytes,
          maxPagesPerInput: 5, // largest single input
          maxTotalPages: 8, // 5 + 3
          maxOutputFiles: 1,
          maxOutputBytesPerFile: outBytes,
          maxTotalOutputBytes: outBytes,
          maxWorkspaceBytes: outBytes
        })
      });
      const r2 = await run(b.req);
      expect(r2.response.status).toBe("succeeded");
    },
    ENGINE_TIMEOUT
  );

  /* ---------------------------------------------------------------- *
   * 9-10: multi-output aggregate + no partial success
   * ---------------------------------------------------------------- */
  it(
    "9. split: per-file passes but AGGREGATE fails -> whole invocation fails",
    async () => {
      const splitParams = { strategy: { type: "every", n: 2 } };
      const single = [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }];

      // Measure the real multi-output set (5 pages, every 2 -> 3 outputs).
      const m = setup({
        operation: "pdf.split",
        inputs: single,
        parameters: splitParams,
        limits: limits()
      });
      const rm = await run(m.req);
      expect(rm.response.status).toBe("succeeded");
      const sizes = (rm.response as { outputs: { byteSize: number }[] }).outputs.map((o) => o.byteSize);
      expect(sizes.length).toBe(3);
      const maxSingle = Math.max(...sizes);
      const total = sizes.reduce((a, c) => a + c, 0);
      // The aggregate is genuinely the binding constraint here.
      expect(total).toBeGreaterThan(maxSingle);

      // Per-file is satisfied, aggregate is violated by exactly 1 byte.
      const s = setup({
        operation: "pdf.split",
        inputs: single,
        parameters: splitParams,
        limits: limits({ maxOutputBytesPerFile: maxSingle, maxTotalOutputBytes: total - 1 })
      });
      const rs = await run(s.req);
      expectResourceFailure(rs.response, "resource.max_total_output_bytes");
    },
    ENGINE_TIMEOUT
  );

  it(
    "10. limit failure leaves NO partial outputs and NO staging residue",
    async () => {
      const splitParams = { strategy: { type: "every", n: 2 } };
      const single = [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }];

      const m = setup({
        operation: "pdf.split",
        inputs: single,
        parameters: splitParams,
        limits: limits()
      });
      const rm = await run(m.req);
      const sizes = (rm.response as { outputs: { byteSize: number }[] }).outputs.map((o) => o.byteSize);
      const total = sizes.reduce((a, c) => a + c, 0);

      const { root, req } = setup({
        operation: "pdf.split",
        inputs: single,
        parameters: splitParams,
        limits: limits({ maxOutputBytesPerFile: Math.max(...sizes), maxTotalOutputBytes: total - 1 })
      });
      const { response } = await run(req);
      expectResourceFailure(response, "resource.max_total_output_bytes");

      // No partial success: the published output area is completely empty.
      expect(readdirSync(outDir(root))).toHaveLength(0);
      // No staging residue either.
      expect(pdfFilesIn(stageDir(root))).toHaveLength(0);
    },
    ENGINE_TIMEOUT
  );
});

/* ------------------------------------------------------------------ *
 * Absence of `limits` must preserve P1-P4 behavior (no over-blocking).
 * ------------------------------------------------------------------ */
describe("limits omitted", () => {
  it(
    "omitting limits entirely still succeeds (policy defaults are unlimited)",
    async () => {
      const { req } = setup({ operation: "pdf.merge", inputs: MERGE_INPUTS });
      const { response } = await run(req);
      expect(response.status).toBe("succeeded");
    },
    ENGINE_TIMEOUT
  );
});
