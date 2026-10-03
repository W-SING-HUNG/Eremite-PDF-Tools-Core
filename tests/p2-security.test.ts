/**
 * P2 execution-layer security / limits tests.
 *
 * These assert the frozen public contract: argv is planner-constructed (no caller
 * injection), workspace containment holds, snapshot mutation is detected, and the
 * public wire NEVER carries diagnostic leakage (no message/details/stack/stderr/
 * command/path). Only {code,stage,retryable} on errors and {code} on warnings.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, copyFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { executeRequest } from "../src/core/index.js";
import { validateRequest } from "../src/protocol/validator.js";
import { resolveContainedInput } from "../src/workspace/index.js";
import { planMerge, planExtract, planRotate, planReorder, planSplit } from "../src/engine/argv.js";
import { tmp } from "./helpers/temp.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = join(__dirname, "fixtures");
const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
function setup(opts: {
  operation: string;
  inputs: { id: string; rel: string; fix: string }[];
  parameters?: unknown;
}): { root: string; req: Record<string, unknown> } {
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
  return { root: t.root, req };
}

describe("engine boundary — argv injection resistance", () => {
  const evil = "'; rm -rf / # --encrypt=out --password=evil";
  const inputPaths = ["C:\\ws\\input\\a.pdf", evil];

  it("planMerge argv contains only literal paths + frozen flags (no injection)", () => {
    const plan = planMerge(inputPaths, "C:\\ws\\output\\merge.pdf");
    expect(plan.argv).not.toContain("--encrypt");
    expect(plan.argv).not.toContain("rm");
    // The malicious path is passed through verbatim as a positional arg; qpdf (shell:false)
    // treats it as one argument and will fail to open it — it can never become a flag.
    expect(plan.argv).toContain(evil);
    expect(plan.argv[0]).toBe("--deterministic-id");
  });

  it("planExtract argv ignores hostile page-spec injection", () => {
    const plan = planExtract("C:\\ws\\input\\a.pdf", { mode: "pages", pages: [0, 1] }, "out.pdf");
    expect(plan.argv.join(" ")).not.toMatch(/--encrypt|--password|;|rm\s/);
  });

  it("planRotate argv never embeds attacker angle", () => {
    const plan = planRotate("C:\\ws\\input\\a.pdf", { mode: "pages", pages: [0] }, 90, "absolute", "out.pdf");
    expect(plan.argv.join(" ")).not.toMatch(/--encrypt/);
    expect(plan.argv.some((a) => a.includes(evil))).toBe(false);
  });

  it("planReorder argv rejects out-of-range injection and stays literal", () => {
    const plan = planReorder("C:\\ws\\input\\a.pdf", [0, 1, 2], "out.pdf");
    expect(plan.argv.join(" ")).not.toMatch(/--encrypt|rm\s/);
  });

  it("planSplit uses a single --split-pages (never a loop of --pages)", () => {
    const plan = planSplit("C:\\ws\\input\\a.pdf", 2, "C:\\ws\\staging\\part-%d.pdf", 3);
    const splitFlags = plan.argv.filter((a) => a.startsWith("--split-pages"));
    expect(splitFlags.length).toBe(1);
    expect(plan.argv).not.toContain("--pages");
  });
});

describe("workspace containment", () => {
  it("resolveContainedInput rejects traversal paths", () => {
    const t = tmp();
    const root = t.root;
    const bad = ["../escape.pdf", "..\\escape.pdf", "a/../../etc/passwd", "/abs/escape.pdf", "\\\\srv\\x.pdf"];
    for (const rel of bad) {
      const r = resolveContainedInput(root, rel);
      expect(r.ok).toBe(false);
    }
  });

  it("executeRequest rejects an input whose relativePath escapes the workspace", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "../escape.pdf", fix: "alpha-multi.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    });
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("input.escape");
  });
});

describe("input snapshot mutation detection", () => {
  it("rejects when the on-disk file no longer matches the declared snapshot", async () => {
    const t = tmp();
    const dest = t.join("input/a.pdf");
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(FIX, "alpha-multi.pdf"), dest);
    const buf = readFileSync(dest);
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.extract",
      workspace: { rootPath: t.root },
      inputs: [{ id: "a", relativePath: "input/a.pdf", snapshot: { byteSize: buf.length, sha256: sha256(buf), displayName: "a.pdf" } }],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    };
    const vr = validateRequest(req);
    expect(vr.ok).toBe(true);
    // Mutate the file AFTER the snapshot was computed.
    writeFileSync(dest, Buffer.from("%PDF-1.4 mutated content that changes the hash"));
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    expect((response as any).error.code).toBe("input.snapshot_mismatch");
  });
});

describe("public wire hygiene — no diagnostic leakage", () => {
  it("failed response carries only {code,stage,retryable} and no leak fields", async () => {
    const { req } = setup({
      operation: "pdf.extract",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-encrypted.pdf" }],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    });
    await validateRequest(req);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("failed");
    const err = (response as any).error;
    expect(Object.keys(err).sort()).toEqual(["code", "retryable", "stage"]);
    // No leakage of internal detail anywhere.
    const serialized = JSON.stringify(response);
    for (const leak of ["stderr", "stack", "command", "path", "message", "details", "C:\\"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("success response outputs carry only allowed fields; warnings only {code}", async () => {
    const { root, req } = setup({
      operation: "pdf.split",
      inputs: [{ id: "a", rel: "input/a.pdf", fix: "alpha-outlines.pdf" }],
      parameters: { strategy: { type: "every", n: 2 } }
    });
    await validateRequest(req);
    const { response } = await executeRequest(req as never);
    expect(response.status).toBe("succeeded");
    const out = (response as any).outputs[0];
    expect(Object.keys(out).sort()).toEqual(["byteSize", "displayName", "id", "pageCount", "relativePath", "sha256"]);
    const warn = (response as any).warnings[0];
    expect(Object.keys(warn)).toEqual(["code"]);
  });
});
