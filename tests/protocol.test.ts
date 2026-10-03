/**
 * Protocol tests: valid/malformed request, unknown field/operation, UUID,
 * closed enums, strict additionalProperties, response shapes.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  validateRequest,
  buildFailure,
  buildSuccess,
  buildErrorEnvelope,
  serializeResponse
} from "../src/protocol/index.js";

const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";
const UUID_V4 = "1b4e28ba-2fa1-4d5b-a3c1-e7a2f4c8d901";

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "pdf.tools.request",
    protocolVersion: 1,
    invocationId: UUID_V7,
    operation: "pdf.extract",
    workspace: { rootPath: "C:\\tmp\\ws" },
    inputs: [
      {
        id: "in-0",
        relativePath: "input/in-0000.pdf",
        snapshot: { byteSize: 1234, sha256: "a".repeat(64), displayName: "a.pdf" }
      }
    ],
    parameters: { pageSelector: { mode: "pages", pages: [0, 1] } },
    ...overrides
  };
}

describe("validateRequest — structural", () => {
  it("accepts a valid request", () => {
    const r = validateRequest(baseRequest());
    expect(r.ok).toBe(true);
  });

  it("rejects unknown field (additionalProperties:false)", () => {
    const r = validateRequest(baseRequest({ extraField: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.unknown_field");
  });

  it("rejects unknown operation", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.frobnicate" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.unknown_operation");
  });

  it("rejects protocol mismatch", () => {
    const r = validateRequest(baseRequest({ protocolVersion: 2 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.invalid_protocol_version");
  });

  it("rejects missing required field", () => {
    const { invocationId, ...rest } = baseRequest();
    const r = validateRequest(rest);
    expect(r.ok).toBe(false);
  });

  it("rejects unknown field inside nested input", () => {
    const req = baseRequest();
    (req.inputs as Array<Record<string, unknown>>)[0]!["nestedExtra"] = true;
    const r = validateRequest(req);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.unknown_field");
  });
});

describe("validateRequest — UUID", () => {
  it("accepts v7", () => {
    expect(validateRequest(baseRequest({ invocationId: UUID_V7 })).ok).toBe(true);
  });
  it("accepts v4", () => {
    expect(validateRequest(baseRequest({ invocationId: UUID_V4 })).ok).toBe(true);
  });
  it("rejects v8", () => {
    const r = validateRequest(baseRequest({ invocationId: "0189c68d-7b3a-8f2c-9d1e-123456789abc" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.invalid_uuid");
  });
  it("rejects nil", () => {
    const r = validateRequest(baseRequest({ invocationId: "00000000-0000-0000-0000-000000000000" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.invalid_uuid");
  });
  it("rejects malformed", () => {
    const r = validateRequest(baseRequest({ invocationId: "abc" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.invalid_uuid");
  });
});

describe("validateRequest — operation parameters", () => {
  it("merge rejects parameters", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.merge", parameters: { strategy: { type: "every", n: 1 } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.invalid_parameter");
  });

  it("merge accepts no parameters", () => {
    const req = baseRequest({ operation: "pdf.merge" });
    delete req.parameters;
    expect(validateRequest(req).ok).toBe(true);
  });

  it("split rejects n <= 0", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.split", parameters: { strategy: { type: "every", n: 0 } } }));
    expect(r.ok).toBe(false);
  });

  it("split accepts valid n", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.split", parameters: { strategy: { type: "every", n: 3 } } }));
    expect(r.ok).toBe(true);
  });

  it("rotate rejects invalid angle", () => {
    const r = validateRequest(baseRequest({
      operation: "pdf.rotate",
      parameters: { pages: { mode: "pages", pages: [0] }, angle: 45, mode: "relative" }
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("parameter.invalid_angle");
  });

  it("rotate accepts valid angle 90/180/270", () => {
    for (const angle of [90, 180, 270]) {
      const r = validateRequest(baseRequest({
        operation: "pdf.rotate",
        parameters: { pages: { mode: "pages", pages: [0] }, angle, mode: "absolute" }
      }));
      expect(r.ok, `angle ${angle}`).toBe(true);
    }
  });

  it("reorder rejects negative index", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.reorder", parameters: { pageOrder: [-1, 0] } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("parameter.invalid_page_index");
  });

  it("reorder accepts non-negative order (duplicates allowed)", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.reorder", parameters: { pageOrder: [0, 1, 0, 2] } }));
    expect(r.ok).toBe(true);
  });

  it("reorder rejects empty pageOrder", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.reorder", parameters: { pageOrder: [] } }));
    expect(r.ok).toBe(false);
  });
});

describe("validateRequest — PageSelector", () => {
  it("accepts pages mode with duplicates and order preserved", () => {
    const r = validateRequest(baseRequest({
      parameters: { pageSelector: { mode: "pages", pages: [3, 1, 3] } }
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects empty pages", () => {
    const r = validateRequest(baseRequest({ parameters: { pageSelector: { mode: "pages", pages: [] } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("parameter.empty_selector");
  });

  it("rejects negative page index", () => {
    const r = validateRequest(baseRequest({ parameters: { pageSelector: { mode: "pages", pages: [-1] } } }));
    expect(r.ok).toBe(false);
  });

  it("rejects float page index", () => {
    const r = validateRequest(baseRequest({ parameters: { pageSelector: { mode: "pages", pages: [1.5] } } }));
    expect(r.ok).toBe(false);
  });

  it("rejects range start > end", () => {
    const r = validateRequest(baseRequest({
      parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 5, end: 2 }] } }
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("parameter.invalid_page_selector");
  });

  it("accepts range start == end and start < end", () => {
    const r = validateRequest(baseRequest({
      parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 2, end: 2 }, { start: 1, end: 5 }] } }
    }));
    expect(r.ok).toBe(true);
  });

  it("rejects empty ranges", () => {
    const r = validateRequest(baseRequest({ parameters: { pageSelector: { mode: "ranges", ranges: [] } } }));
    expect(r.ok).toBe(false);
  });

  it("rejects unknown field inside PageSelector (mutation regression)", () => {
    const r = validateRequest(baseRequest({
      parameters: { pageSelector: { mode: "pages", pages: [0], extra: 1 } }
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.unknown_field");
  });

  it("rejects unknown field inside range item (mutation regression)", () => {
    const r = validateRequest(baseRequest({
      parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 0, end: 1, extra: 1 }] } }
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.unknown_field");
  });

  it("rejects unknown field inside split strategy (mutation regression)", () => {
    const r = validateRequest(baseRequest({
      operation: "pdf.split",
      parameters: { strategy: { type: "every", n: 2, extra: 1 } }
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe("request.unknown_field");
  });
});

describe("validateRequest — parameter-level additionalProperties (mutation B regression)", () => {
  // Mutation B = removing `additionalProperties:false` from any of the
  // operation parameter $defs (splitParameters / extractParameters /
  // rotateParameters / reorderParameters) or from the nested pageSelector /
  // strategy objects. Each case below must be rejected by the schema, so the
  // mutation MUST turn these RED.
  const cases: Array<{ name: string; operation: string; parameters: unknown }> = [
    // split: top-level + nested strategy
    { name: "split: unknown top-level field", operation: "pdf.split", parameters: { strategy: { type: "every", n: 2 }, extra: 1 } },
    { name: "split: unknown nested strategy field", operation: "pdf.split", parameters: { strategy: { type: "every", n: 2, extra: 1 } } },
    // extract: top-level + nested selector (pages branch) + nested range item
    { name: "extract: unknown top-level field", operation: "pdf.extract", parameters: { pageSelector: { mode: "pages", pages: [0] }, extra: 1 } },
    { name: "extract: unknown nested selector field (pages)", operation: "pdf.extract", parameters: { pageSelector: { mode: "pages", pages: [0], extra: 1 } } },
    { name: "extract: unknown nested range item field", operation: "pdf.extract", parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 0, end: 1, extra: 1 }] } } },
    { name: "extract: unknown nested selector field (ranges)", operation: "pdf.extract", parameters: { pageSelector: { mode: "ranges", ranges: [{ start: 0, end: 1 }], extra: 1 } } },
    // rotate: top-level + nested selector
    { name: "rotate: unknown top-level field", operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "relative", extra: 1 } },
    { name: "rotate: unknown nested selector field", operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0], extra: 1 }, angle: 90, mode: "relative" } },
    { name: "rotate: unknown nested range item field", operation: "pdf.rotate", parameters: { pages: { mode: "ranges", ranges: [{ start: 0, end: 1, extra: 1 }] }, angle: 90, mode: "relative" } },
    // reorder: top-level
    { name: "reorder: unknown top-level field", operation: "pdf.reorder", parameters: { pageOrder: [0, 1], extra: 1 } }
  ];

  for (const c of cases) {
    it(`rejects ${c.name}`, () => {
      const r = validateRequest(baseRequest({ operation: c.operation, parameters: c.parameters }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.code).toBe("request.unknown_field");
    });
  }

  it("rejects merge carrying any parameters object", () => {
    const r = validateRequest(baseRequest({ operation: "pdf.merge", parameters: { anything: 1 } }));
    expect(r.ok).toBe(false);
  });

  it("Mutation B: stripping parameter-level additionalProperties:false makes the regression RED", () => {
    // Re-implement the validator's REQUEST-only compilation so we can apply the
    // mutation to an in-memory copy of the committed schema.
    const here = dirname(fileURLToPath(import.meta.url));
    const SCHEMA_PATH = join(here, "..", "schema", "supplier-protocol-v1.schema.json");
    const raw = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

    const compileRequest = (schemaObj: any) => {
      const ajv = new Ajv2020({ strict: true, allErrors: true });
      return ajv.compile({ $defs: schemaObj.$defs, $ref: "#/$defs/request" });
    };
    const realValidate = compileRequest(raw);

    const bad = [
      { operation: "pdf.split", parameters: { strategy: { type: "every", n: 2 }, extra: 1 } },
      { operation: "pdf.extract", parameters: { pageSelector: { mode: "pages", pages: [0] }, extra: 1 } },
      { operation: "pdf.rotate", parameters: { pages: { mode: "pages", pages: [0] }, angle: 90, mode: "relative", extra: 1 } },
      { operation: "pdf.reorder", parameters: { pageOrder: [0, 1], extra: 1 } }
    ];

    // 1. Committed (frozen) schema REJECTS every bad request (regression GREEN).
    for (const b of bad) {
      const req = baseRequest({ operation: b.operation, parameters: b.parameters });
      expect(realValidate(req)).toBe(false);
    }

    // 2. Mutation: remove every `additionalProperties:false` (recursively).
    const mutated = JSON.parse(JSON.stringify(raw));
    const strip = (obj: any): void => {
      if (Array.isArray(obj)) { obj.forEach(strip); return; }
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          if (k === "additionalProperties" && obj[k] === false) delete obj[k];
          else strip(obj[k]);
        }
      }
    };
    strip(mutated);
    const mutatedValidate = compileRequest(mutated);

    // 3. After mutation the SAME requests are ACCEPTED -> the regression would
    //    turn RED. This proves parameter-level additionalProperties is load-bearing.
    for (const b of bad) {
      const req = baseRequest({ operation: b.operation, parameters: b.parameters });
      expect(mutatedValidate(req)).toBe(true);
    }
  });
});

describe("validateRequest — request/response isolation", () => {
  it("rejects a success-response-shaped object", () => {
    const resp = {
      kind: "pdf.tools.response",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.merge",
      status: "succeeded",
      outputs: [{ id: "o", displayName: "x", byteSize: 1, sha256: "a".repeat(64), pageCount: 1, relativePath: "output/x.pdf" }],
      provenance: { coreVersion: "0.1.0", protocolVersion: 1, operation: "pdf.merge" },
      warnings: []
    };
    const r = validateRequest(resp);
    expect(r.ok).toBe(false);
  });

  it("rejects a failure-response-shaped object", () => {
    const resp = {
      kind: "pdf.tools.response",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.merge",
      status: "failed",
      error: { code: "internal.not_implemented", stage: "internal", retryable: false },
      warnings: []
    };
    const r = validateRequest(resp);
    expect(r.ok).toBe(false);
  });
});

describe("validateRequest — input identity / safe integer", () => {
  it("rejects duplicate input id", () => {
    const req = baseRequest({ operation: "pdf.merge" });
    delete req.parameters;
    req.inputs = [
      { id: "dup", relativePath: "input/a.pdf", snapshot: { byteSize: 1, sha256: "a".repeat(64), displayName: "a" } },
      { id: "dup", relativePath: "input/b.pdf", snapshot: { byteSize: 1, sha256: "b".repeat(64), displayName: "b" } }
    ];
    const r = validateRequest(req);
    expect(r.ok).toBe(false);
  });

  it("rejects byteSize above MAX_SAFE_INTEGER", () => {
    const req = baseRequest();
    (req.inputs as Array<Record<string, unknown>>)[0]!["snapshot"] = {
      byteSize: Number.MAX_SAFE_INTEGER + 1,
      sha256: "a".repeat(64),
      displayName: "a.pdf"
    };
    const r = validateRequest(req);
    expect(r.ok).toBe(false);
  });

  it("rejects limits with unsafe integer", () => {
    const req = baseRequest({
      limits: {
        maxInputFiles: 2,
        maxInputBytesPerFile: 1,
        maxTotalInputBytes: 1,
        maxOutputFiles: 1,
        maxOutputBytesPerFile: 1,
        maxTotalOutputBytes: 1,
        maxPagesPerInput: 1,
        maxTotalPages: 1,
        maxWorkspaceBytes: 1,
        timeoutMs: Number.MAX_SAFE_INTEGER + 1
      }
    });
    const r = validateRequest(req);
    expect(r.ok).toBe(false);
  });
});

describe("response shapes", () => {
  it("failure response has exactly code/stage/retryable (no message/detail)", () => {
    const resp = buildFailure(UUID_V7, "pdf.extract", buildErrorEnvelope("input.snapshot_mismatch", "input"));
    expect(resp.status).toBe("failed");
    expect(resp.error).toEqual({ code: "input.snapshot_mismatch", stage: "input", retryable: false });
    expect(resp.warnings).toEqual([]);
    // No forbidden keys.
    expect("message" in resp.error).toBe(false);
    expect("detail" in resp.error).toBe(false);
    expect("stack" in resp).toBe(false);
  });

  it("success response supports 1..N outputs and echoes invocationId verbatim", () => {
    const resp = buildSuccess(UUID_V7, "pdf.merge", [
      { id: "out-0", displayName: "merge.pdf", byteSize: 100, sha256: "b".repeat(64), pageCount: 3, relativePath: "output/merge.pdf" }
    ]);
    expect(resp.invocationId).toBe(UUID_V7);
    expect(resp.status).toBe("succeeded");
    expect(resp.outputs).toHaveLength(1);
    expect(resp.provenance.operation).toBe("pdf.merge");
  });

  it("serializeResponse produces clean JSON with no diagnostics", () => {
    const resp = buildFailure(UUID_V7, "pdf.extract", buildErrorEnvelope("internal.unexpected", "internal"));
    const json = serializeResponse(resp);
    const parsed = JSON.parse(json);
    // No absolute path / stack / stderr / command / env anywhere.
    const s = json.toLowerCase();
    expect(s).not.toContain("\\\\");
    expect(s).not.toContain("c:\\");
    expect(s).not.toContain("stack");
    expect(s).not.toContain("stderr");
    expect(parsed).not.toHaveProperty("stack");
    expect(parsed).not.toHaveProperty("message");
  });
});
