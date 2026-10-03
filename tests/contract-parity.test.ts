/**
 * Contract / runtime parity tests.
 *
 * The single source of truth is src/taxonomy/taxonomy.ts. These tests assert
 * that the committed JSON Schema's closed enums are byte-for-byte identical to
 * the runtime enums, so the wire contract can never drift from the code.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

import {
  OPERATIONS,
  STAGES,
  ERROR_CODES,
  WARNING_CODES,
  STATUS
} from "../src/taxonomy/index.js";
import { validateRequest } from "../src/protocol/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, "..", "schema", "supplier-protocol-v1.schema.json");

function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as Record<string, unknown>;
}

function getDef(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const defs = schema["$defs"] as Record<string, Record<string, unknown>>;
  return defs[name]!;
}

function getEnum(def: Record<string, unknown>): string[] {
  return def["enum"] as string[];
}

describe("Contract / runtime parity", () => {
  it("operation enum matches schema", () => {
    const schemaOps = getEnum(getDef(loadSchema(), "operation"));
    expect([...schemaOps].sort()).toEqual([...OPERATIONS].sort());
  });

  it("stage enum matches schema", () => {
    const schemaStages = getEnum(getDef(loadSchema(), "stage"));
    expect([...schemaStages].sort()).toEqual([...STAGES].sort());
  });

  it("error code enum matches schema", () => {
    const schemaErrors = getEnum(getDef(loadSchema(), "errorCode"));
    expect([...schemaErrors].sort()).toEqual([...ERROR_CODES].sort());
  });

  it("warning code enum matches schema", () => {
    const schemaWarnings = getEnum(getDef(loadSchema(), "warningCode"));
    expect([...schemaWarnings].sort()).toEqual([...WARNING_CODES].sort());
  });

  it("status enum matches schema (succeeded/failed)", () => {
    const schema = loadSchema();
    const success = getDef(schema, "successResponse");
    const failure = getDef(schema, "failureResponse");
    const successStatus = (success["properties"] as Record<string, Record<string, unknown>>)["status"]!["const"];
    const failureStatus = (failure["properties"] as Record<string, Record<string, unknown>>)["status"]!["const"];
    expect(successStatus).toBe("succeeded");
    expect(failureStatus).toBe("failed");
    expect([...STATUS].sort()).toEqual(["failed", "succeeded"]);
  });

  it("warning taxonomy is exactly two codes (frozen)", () => {
    expect([...WARNING_CODES].sort()).toEqual(
      ["w.document_features_dropped", "w.duplicate_page_emitted"].sort()
    );
  });

  it("every error code maps to a defined stage namespace (sanity)", () => {
    // Every error code's prefix (before first '.') must be a real stage OR a
    // known exception. This guards against typos in the enum itself.
    const stagePrefixes = new Set(STAGES);
    // error codes are <namespace>.<name>; the namespace should be a stage.
    for (const code of ERROR_CODES) {
      const ns = code.split(".")[0]!;
      expect(stagePrefixes.has(ns as (typeof STAGES)[number]), `error code "${code}" has unknown namespace "${ns}"`).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Schema / runtime differential: parameter SHAPE parity
 * ------------------------------------------------------------------ */

const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "pdf.tools.request",
    protocolVersion: 1,
    invocationId: UUID_V7,
    operation: "pdf.extract",
    workspace: { rootPath: "C:\\tmp\\ws" },
    inputs: [
      { id: "in-0", relativePath: "input/in-0000.pdf", snapshot: { byteSize: 1, sha256: "a".repeat(64), displayName: "a.pdf" } }
    ],
    parameters: { pageSelector: { mode: "pages", pages: [0] } },
    ...overrides
  };
}

function compileRequestSchema(): ValidateFunction {
  const schema = loadSchema();
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return ajv.compile({ $defs: schema["$defs"], $ref: "#/$defs/request" });
}

describe("Schema / runtime differential — parameter SHAPE", () => {
  const validator = compileRequestSchema();

  // Each case: the schema and the runtime MUST agree on accept/reject for
  // wire-shape concerns (unknown fields, enum, integer, required,
  // additionalProperties). Semantic-only rules (start<=end) are excluded here
  // because JSON Schema cannot express them.
  const cases: Array<{ name: string; req: Record<string, unknown>; accept: boolean }> = [
    { name: "merge (no parameters)", req: base({ operation: "pdf.merge", parameters: undefined }), accept: true },
    { name: "merge with parameters", req: base({ operation: "pdf.merge", parameters: { strategy: { type: "every", n: 1 } } }), accept: false },
    { name: "split valid", req: base({ operation: "pdf.split", parameters: { strategy: { type: "every", n: 3 } } }), accept: true },
    { name: "split missing strategy", req: base({ operation: "pdf.split", parameters: {} }), accept: false },
    { name: "split n = 0", req: base({ operation: "pdf.split", parameters: { strategy: { type: "every", n: 0 } } }), accept: false },
    { name: "split n negative", req: base({ operation: "pdf.split", parameters: { strategy: { type: "every", n: -3 } } }), accept: false },
    { name: "split n float", req: base({ operation: "pdf.split", parameters: { strategy: { type: "every", n: 1.5 } } }), accept: false },
    { name: "split unknown strategy field", req: base({ operation: "pdf.split", parameters: { strategy: { type: "every", n: 2, x: 1 } } }), accept: false },
    { name: "extract valid", req: base({ operation: "pdf.extract", parameters: { pageSelector: { mode: "pages", pages: [0] } } }), accept: true },
    { name: "extract missing pageSelector", req: base({ operation: "pdf.extract", parameters: {} }), accept: false },
    { name: "rotate valid", req: base({ operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "relative" } }), accept: true },
    { name: "rotate angle 45", req: base({ operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 45, mode: "relative" } }), accept: false },
    { name: "rotate angle 360", req: base({ operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 360, mode: "relative" } }), accept: false },
    { name: "rotate mode bogus", req: base({ operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "sideways" } }), accept: false },
    { name: "rotate unknown field", req: base({ operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "relative", x: 1 } }), accept: false },
    { name: "reorder valid", req: base({ operation: "pdf.reorder", parameters: { pageOrder: [0, 1, 0] } }), accept: true },
    { name: "reorder empty pageOrder", req: base({ operation: "pdf.reorder", parameters: { pageOrder: [] } }), accept: false },
    { name: "reorder negative index", req: base({ operation: "pdf.reorder", parameters: { pageOrder: [-1] } }), accept: false },
    { name: "reorder float index", req: base({ operation: "pdf.reorder", parameters: { pageOrder: [1.5] } }), accept: false },
    { name: "pageSelector unknown field", req: base({ operation: "pdf.extract", parameters: { pageSelector: { mode: "pages", pages: [0], x: 1 } } }), accept: false },
    { name: "range item unknown field", req: base({ operation: "pdf.extract", parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 0, end: 1, x: 1 }] } } }), accept: false },
    { name: "range start > end (semantic-only)", req: base({ operation: "pdf.extract", parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 5, end: 2 }] } } }), accept: true }
  ];

  for (const c of cases) {
    it(`agrees on ${c.name}`, () => {
      // Drop undefined properties (JSON round-trip semantics).
      const req = JSON.parse(JSON.stringify(c.req));
      const schemaOk = validator(req);
      const runtimeOk = validateRequest(req).ok;

      // The schema is the authoritative SHAPE gate. For the one semantic-only
      // case (start>end), the schema accepts but the runtime rejects — that is
      // an intentional, documented divergence, not drift.
      expect(schemaOk, `schema accept for "${c.name}"`).toBe(c.accept);
      if (c.name === "range start > end (semantic-only)") {
        expect(runtimeOk).toBe(false);
      } else {
        expect(runtimeOk, `runtime must agree with schema for "${c.name}"`).toBe(schemaOk);
      }
    });
  }
});
