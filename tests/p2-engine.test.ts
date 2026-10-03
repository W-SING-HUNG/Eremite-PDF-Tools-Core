/**
 * P2 real-engine tests: the five frozen V1 operations executed through qpdf
 * 12.4.0 (win-x64), plus the V1 input structural gate. Every assertion is
 * empirical — it inspects the real qpdf output, never a stubbed exit code.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

import { executeRequest } from "../src/core/index.js";
import { executeSplit } from "../src/engine/operations.js";
import { validateRequest } from "../src/protocol/validator.js";
import { getQpdfExecutable, isRuntimePresent, verifyQpdfVersion, QPDF_VERSION } from "../src/engine/runtime.js";
import { readPageRotations } from "../src/engine/verify.js";
import { tmp } from "./helpers/temp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
function qpdfPages(p: string): number {
  const out = execFileSync(getQpdfExecutable(), ["--show-npages", p], { encoding: "utf-8" });
  return parseInt(out.trim(), 10);
}
function hasMarker(p: string, marker: string): boolean {
  return readFileSync(p).includes(Buffer.from(marker));
}

interface SetupOpts {
  operation: string;
  inputs: { id: string; rel: string; fix: string }[];
  parameters?: unknown;
  limits?: unknown;
}
function setup(opts: SetupOpts): { root: string; req: Record<string, unknown> } {
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

async function runValid(req: Record<string, unknown>) {
  const vr = validateRequest(req);
  if (!vr.ok) throw new Error(`request failed validation: ${JSON.stringify(vr)}`);
  return executeRequest(req as never);
}

/* ------------------------------------------------------------------ */
describe("qpdf runtime gate (external prerequisite)", () => {
  it("PATH runtime present and version 12.4.0 verified", async () => {
    expect(isRuntimePresent()).toBe(true);
    expect(await verifyQpdfVersion(30_000)).toBeNull();
    expect(QPDF_VERSION).toBe("12.4.0");
    expect(execFileSync(getQpdfExecutable(), ["--version"], { encoding: "utf-8" })).toContain("12.4.0");
  });
});

/* ------------------------------------------------------------------ */
describe("pdf.merge (N -> 1, empty primary)", () => {
  it("concatenates page counts in input order", async () => {
    const { root, req } = setup({
      operation: "pdf.merge",
      inputs: [
        { id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" },
        { id: "b", rel: "input/b.pdf", fix: "alpha-multi-b.pdf" }
      ]
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    const out: any = (response as any).outputs[0];
    expect(out.pageCount).toBe(8); // 5 + 3
    const outPath = join(root, out.relativePath);
    expect(existsSync(outPath)).toBe(true);
    expect(qpdfPages(outPath)).toBe(8);
  });

  it("uses empty primary: drops document-level /Outlines but keeps page-level /Annots", async () => {
    const { root, req } = setup({
      operation: "pdf.merge",
      inputs: [
        { id: "a", rel: "input/a.pdf", fix: "alpha-outlines.pdf" },
        { id: "b", rel: "input/b.pdf", fix: "alpha-annotations.pdf" }
      ]
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    const out: any = (response as any).outputs[0];
    const outPath = join(root, out.relativePath);
    // Document-level outlines are NOT inherited from the primary (empty doc).
    expect(hasMarker(outPath, "/Outlines")).toBe(false);
    // Page-level annotations ARE preserved (they live on the pages).
    expect(hasMarker(outPath, "/Annots")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe("pdf.split (1 -> N, all-or-none, drops features)", () => {
  it("splits 5-page outlined doc into 3 deterministic chunks with w.document_features_dropped", async () => {
    const { root, req } = setup({
      operation: "pdf.split",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-outlines.pdf" }],
      parameters: { strategy: { type: "every", n: 2 } }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    const outs: any[] = (response as any).outputs;
    expect(outs.length).toBe(3); // ceil(5/2)
    const names = outs.map((o) => o.displayName).sort();
    expect(names).toEqual(["part-0001.pdf", "part-0002.pdf", "part-0003.pdf"]);
    const counts = outs.map((o) => o.pageCount).sort((x, y) => x - y);
    expect(counts).toEqual([1, 2, 2]);
    const warns: string[] = (response as any).warnings.map((w: any) => w.code);
    expect(warns).toContain("w.document_features_dropped");
    for (const o of outs) {
      const p = join(root, o.relativePath);
      expect(existsSync(p)).toBe(true);
      expect(hasMarker(p, "/Outlines")).toBe(false); // features dropped
    }
  });

  it("preflight rejects split that would exceed maxOutputFiles", async () => {
    const t = tmp();
    const ctx: any = {
      exe: getQpdfExecutable(),
      timeoutMs: 30_000,
      stagingDir: t.join("staging"),
      outputDir: t.join("output"),
      maxOutputFiles: 2
    };
    mkdirSync(ctx.stagingDir, { recursive: true });
    mkdirSync(ctx.outputDir, { recursive: true });
    // 5-page input, n=1 -> 5 expected outputs > maxOutputFiles(2).
    const out = await executeSplit(ctx, { id: "a", absolutePath: "x", relativePath: "x", pageCount: 5 } as any, 1);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("resource.max_output_files");
  });
});

/* ------------------------------------------------------------------ */
describe("pdf.extract (1 -> 1, page selector semantics)", () => {
  it("extracts pages [0,2,4] in order (3 pages)", async () => {
    const { root, req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0, 2, 4] } }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    const out: any = (response as any).outputs[0];
    expect(out.pageCount).toBe(3);
    expect(qpdfPages(join(root, out.relativePath))).toBe(3);
  });

  it("extracts a closed range [0,2] (3 pages)", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }],
      parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 0, end: 2 }] } }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    expect((response as any).outputs[0].pageCount).toBe(3);
  });

  it("emits w.duplicate_page_emitted on repeated page", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0, 0] } }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    expect((response as any).outputs[0].pageCount).toBe(2);
    const warns: string[] = (response as any).warnings.map((w: any) => w.code);
    expect(warns).toContain("w.duplicate_page_emitted");
  });
});

/* ------------------------------------------------------------------ */
describe("pdf.rotate (1 -> 1, verified rotation)", () => {
  it("absolute rotate page 0 by 90; other pages untouched", async () => {
    const { root, req } = setup({
      operation: "pdf.rotate",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }],
      parameters: { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "absolute" }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    const out: any = (response as any).outputs[0];
    const rotations = await readPageRotations(getQpdfExecutable(), join(root, out.relativePath), 30_000);
    expect(rotations).not.toBeNull();
    expect(rotations![0]).toBe(90);
    for (let i = 1; i < rotations!.length; i++) expect(rotations![i]).toBe(0);
  });

  it("relative rotate page 0 by 180; result verified", async () => {
    const { root, req } = setup({
      operation: "pdf.rotate",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi.pdf" }],
      parameters: { pages: { mode: "pages", pages: [0] }, angle: 180, mode: "relative" }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    const out: any = (response as any).outputs[0];
    const rotations = await readPageRotations(getQpdfExecutable(), join(root, out.relativePath), 30_000);
    expect(rotations![0]).toBe(180);
  });
});

/* ------------------------------------------------------------------ */
describe("pdf.reorder (1 -> 1, full coverage required)", () => {
  it("reorders [2,1,0] on a 3-page doc (success)", async () => {
    const { req } = setup({
      operation: "pdf.reorder",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi-b.pdf" }],
      parameters: { pageOrder: [2, 1, 0] }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    expect((response as any).outputs[0].pageCount).toBe(3);
  });

  it("duplicate page order [0,1,2,0] covers all pages and emits w.duplicate_page_emitted", async () => {
    const { req } = setup({
      operation: "pdf.reorder",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi-b.pdf" }],
      parameters: { pageOrder: [0, 1, 2, 0] }
    });
    const { response } = await runValid(req);
    expect(response.status).toBe("succeeded");
    expect((response as any).outputs[0].pageCount).toBe(4);
    const warns: string[] = (response as any).warnings.map((w: any) => w.code);
    expect(warns).toContain("w.duplicate_page_emitted");
  });

  it("omission [0,1] on 3-page doc FAILS (reorder must cover every page)", async () => {
    const { req } = setup({
      operation: "pdf.reorder",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi-b.pdf" }],
      parameters: { pageOrder: [0, 1] }
    });
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("parameter.invalid_page_selector");
  });

  it("out-of-range pageOrder [0,1,3] FAILS", async () => {
    const { req } = setup({
      operation: "pdf.reorder",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-multi-b.pdf" }],
      parameters: { pageOrder: [0, 1, 3] }
    });
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("parameter.out_of_range");
  });
});

/* ------------------------------------------------------------------ */
describe("V1 input structural gate (no repair / no decrypt)", () => {
  it("encrypted input -> pdf_validation.encrypted", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-encrypted.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    });
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("pdf_validation.encrypted");
    expect((response as any).error.stage).toBe("pdf_validation");
  });

  it("malformed input -> pdf_validation.malformed", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-malformed.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    });
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("pdf_validation.malformed");
  });

  it("recoverable anomaly (missing /MediaBox) -> pdf_validation.recoverable_anomaly (NOT silently repaired)", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-recoverable.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    });
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("pdf_validation.recoverable_anomaly");
  });
});
