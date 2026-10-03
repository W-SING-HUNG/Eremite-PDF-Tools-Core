/** Run unchanged against RC2 and RC3 dependency trees to detect schema drift. */
import { describe, it, expect } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { validateRequest } from "../src/protocol/index.js";

const schema = JSON.parse(readFileSync(new URL("../schema/supplier-protocol-v1.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
const common = {
  protocolVersion: 1, invocationId: "0189c68d-7b3a-7f2c-9d1e-123456789abc", operation: "pdf.extract"
};
const request = {
  ...common, kind: "pdf.tools.request", workspace: { rootPath: "D:\\temporary-consumer" },
  inputs: [{ id: "in-0", relativePath: "input/a.pdf", snapshot: { byteSize: 100, sha256: "a".repeat(64), displayName: "a.pdf" } }],
  parameters: { pageSelector: { mode: "pages", pages: [0] } }
};
const success = {
  ...common, kind: "pdf.tools.response", status: "succeeded",
  outputs: [{ id: "out-0", relativePath: "output/a.pdf", displayName: "a.pdf", byteSize: 100, sha256: "b".repeat(64), pageCount: 1 }],
  provenance: { coreVersion: "1.0.0-rc2", protocolVersion: 1, operation: "pdf.extract" }, warnings: []
};
const failure = {
  ...common, kind: "pdf.tools.response", status: "failed",
  error: { code: "input.snapshot_mismatch", stage: "input", retryable: false }, warnings: []
};

describe("security patch — strict protocol compatibility", () => {
  it.each([["request", request], ["success", success], ["failure", failure]])("accepts valid %s; rejects every top-level omission and extra field", (_name, wire) => {
    expect(validate(wire)).toBe(true);
    expect(validate({ ...wire, unexpected: true })).toBe(false);
    for (const key of Object.keys(wire)) {
      if (key === "parameters") continue; // operation-dependent, covered separately below
      const mutated: Record<string, unknown> = structuredClone(wire);
      delete mutated[key];
      expect(validate(mutated), `missing ${key}`).toBe(false);
    }
  });

  it("rejects nested request omissions/extras through the production validator", () => {
    for (const path of [["workspace"], ["inputs", "0"], ["inputs", "0", "snapshot"], ["parameters"], ["parameters", "pageSelector"]]) {
      const original: any = path.reduce((obj: any, key) => obj[key], request);
      for (const key of [...Object.keys(original), "unexpected"]) {
        const mutated: any = structuredClone(request);
        const target = path.reduce((obj: any, part) => obj[part], mutated);
        if (key === "unexpected") target[key] = true;
        else delete target[key];
        expect(validate(mutated), `${path.join(".")}.${key}`).toBe(false);
        expect(validateRequest(mutated).ok).toBe(false);
      }
    }
  });

  it("rejects nested response omissions/extras and invalid closed enums", () => {
    for (const [wire, paths] of [[success, [["outputs", "0"], ["provenance"]]], [failure, [["error"]]]] as const) {
      for (const path of paths) {
        const original: any = path.reduce((obj: any, key) => obj[key], wire);
        for (const key of [...Object.keys(original), "unexpected"]) {
          const mutated: any = structuredClone(wire);
          const target = path.reduce((obj: any, part) => obj[part], mutated);
          if (key === "unexpected") target[key] = true;
          else delete target[key];
          expect(validate(mutated), `${path.join(".")}.${key}`).toBe(false);
        }
      }
    }
    expect(validate({ ...failure, error: { ...failure.error, code: "unknown" } })).toBe(false);
    expect(validate({ ...failure, error: { ...failure.error, stage: "unknown" } })).toBe(false);
    expect(validate({ ...success, warnings: [{ code: "unknown" }] })).toBe(false);
  });

  it("resolves the canonical absolute schema ID and fragment without remote loading", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addSchema(schema);
    const requestOnly = ajv.compile({ $ref: `${schema.$id}#/$defs/request` });
    expect(requestOnly(request)).toBe(true);
    expect(requestOnly(success)).toBe(false);
    expect(requestOnly(failure)).toBe(false);
  });

  it("resolves HTTPS relative references and escaped JSON Pointer fragments", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    ajv.addSchema({ $id: "https://supplier.example/schemas/types.json", $defs: { "page/index": { type: "integer", minimum: 0 } } });
    const ref = ajv.compile({ $id: "https://supplier.example/schemas/request.json", $ref: "./types.json#/$defs/page~1index" });
    expect(ref(0)).toBe(true);
    expect(ref(-1)).toBe(false);
    expect(ref("0")).toBe(false);
    expect(() => ajv.compile({ $ref: "https://supplier.example/missing.json" })).toThrow();
  });
});
