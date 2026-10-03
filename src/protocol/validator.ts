/**
 * Runtime validation of the Supplier Protocol v1 REQUEST.
 *
 * Layering (single source of truth):
 *  1. JSON Schema (Draft 2020-12) is the authoritative machine-readable wire
 *     shape: it now expresses per-operation parameter shapes (if/then),
 *     additionalProperties:false, integer/enum constraints, and safe-integer
 *     maximums. The schema is compiled REQUEST-ONLY (see loadRequestValidator).
 *  2. The runtime validator only enforces what JSON Schema cannot express:
 *     UUID version+variant (byte-level), operation arity, duplicate input id,
 *     range start <= end, and safe-integer defense-in-depth. It maps schema
 *     rejections to closed error codes but does NOT re-define the wire shape.
 *
 * The schema and the TS types and the taxonomy enums all derive from the same
 * closed source-of-truth, preventing contract drift.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction, ErrorObject } from "ajv";

import {
  OPERATIONS,
  OPERATION_ARITY,
  RETRYABLE_ERROR_CODES
} from "../taxonomy/index.js";
import { isValidUuid } from "../uuid/index.js";
import { validateLimits } from "../limits/index.js";
import type { ErrorCode, Stage } from "../taxonomy/index.js";

/* ------------------------------------------------------------------ *
 * Schema loading (single committed schema file = source of truth)
 * ------------------------------------------------------------------ */

const __dirname = dirname(fileURLToPath(import.meta.url));
// dist/protocol/validator.js -> ../../schema/... ; src/protocol/validator.ts -> ../../schema/...
const SCHEMA_PATH = join(__dirname, "..", "..", "schema", "supplier-protocol-v1.schema.json");

let compiledRequest: ValidateFunction | undefined;

/**
 * Compile the REQUEST-only validator. The committed schema's top level is a
 * oneOf(request, success, failure); we compile only the request $def so a
 * response-shaped object can NEVER pass request validation (BLOCKER B4).
 */
function loadRequestValidator(): ValidateFunction {
  if (compiledRequest) return compiledRequest;
  const raw = readFileSync(SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(raw) as Record<string, unknown>;
  // Compile ONLY the request $def. Do NOT carry the top-level oneOf (which
  // would admit success/failure responses and produce cross-branch noise).
  // $defs is retained so $refs inside request resolve.
  const requestSchema = {
    $defs: schema["$defs"],
    $ref: "#/$defs/request"
  };
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true
  });
  compiledRequest = ajv.compile(requestSchema);
  return compiledRequest;
}

/* ------------------------------------------------------------------ *
 * Validation result
 * ------------------------------------------------------------------ */

export interface ValidationFailure {
  code: ErrorCode;
  stage: Stage;
  retryable: boolean;
  /** Internal-only diagnostic. NEVER serialized to public response. */
  detail: string | undefined;
}

export function validationFailure(
  code: ErrorCode,
  stage: Stage,
  detail?: string
): ValidationFailure {
  return { code, stage, retryable: RETRYABLE_ERROR_CODES.has(code), detail };
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; failure: ValidationFailure };

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

/**
 * Validate an untrusted JSON value as a Supplier Protocol v1 REQUEST.
 *
 * Returns the typed request on success, or a machine-readable failure
 * (never a free-form message on the public wire).
 */
export function validateRequest(raw: unknown): ValidationResult<unknown> {
  // 1. Structural: REQUEST-only JSON Schema (authoritative wire shape).
  const validator = loadRequestValidator();
  if (!validator(raw)) {
    return { ok: false, failure: classifyStructural(validator.errors) };
  }

  const req = raw as Record<string, unknown>;

  // 2. UUID version + variant (schema only checks the textual shape).
  const invocationId = req["invocationId"] as string;
  if (!isValidUuid(invocationId)) {
    return { ok: false, failure: validationFailure("request.invalid_uuid", "request") };
  }

  // 3. Operation arity (schema does not key input count to operation).
  const operation = req["operation"] as (typeof OPERATIONS)[number];
  const inputs = req["inputs"] as Array<Record<string, unknown>>;
  const arity = OPERATION_ARITY[operation];
  if (inputs.length < arity.minInputs || inputs.length > arity.maxInputs) {
    return { ok: false, failure: validationFailure("request.invalid_parameter", "parameter") };
  }

  // 4. Duplicate input id (schema uniqueItems is shallow deep-equality; id
  //    uniqueness is a cross-field rule it cannot express).
  const dupId = findDuplicateInputId(inputs);
  if (dupId !== null) {
    return { ok: false, failure: validationFailure("request.invalid_parameter", "input", `duplicate input id: ${dupId}`) };
  }

  // 5. Limits (safe-integer defense in depth; wired into the request path).
  const limitField = validateLimits(req["limits"]);
  if (limitField !== null) {
    return { ok: false, failure: validationFailure("request.invalid_parameter", "resource", `invalid limit: ${limitField}`) };
  }

  // 6. Cross-field parameter semantics (rules JSON Schema cannot express).
  const paramFailure = validateOperationParameters(operation, req["parameters"]);
  if (paramFailure) {
    return { ok: false, failure: paramFailure };
  }

  return { ok: true, value: raw };
}

function findDuplicateInputId(inputs: Array<Record<string, unknown>>): string | null {
  const seen = new Set<string>();
  for (const input of inputs) {
    const id = input["id"];
    if (typeof id !== "string") continue; // schema guarantees string
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * Validate cross-field parameter semantics that JSON Schema cannot express.
 * Shape, additionalProperties, enum, and integer constraints are already
 * enforced by the schema; this function is deliberately NOT a second wire
 * shape source.
 */
function validateOperationParameters(
  operation: (typeof OPERATIONS)[number],
  parameters: unknown
): ValidationFailure | null {
  if (parameters === undefined || parameters === null) return null;

  switch (operation) {
    case "pdf.merge":
      // Schema enforces merge has no parameters; nothing semantic to add.
      return null;
    case "pdf.split": {
      const n = (parameters as { strategy?: { n?: unknown } }).strategy?.n;
      if (typeof n !== "number" || !Number.isSafeInteger(n)) {
        return validationFailure("request.invalid_parameter", "parameter", "split n not a safe integer");
      }
      return null;
    }
    case "pdf.extract": {
      const selector = (parameters as { pageSelector?: unknown }).pageSelector;
      return validatePageSelectorSemantics(selector);
    }
    case "pdf.rotate": {
      const selector = (parameters as { pages?: unknown }).pages;
      return validatePageSelectorSemantics(selector);
    }
    case "pdf.reorder": {
      const order = (parameters as { pageOrder?: unknown }).pageOrder;
      if (!Array.isArray(order)) return null; // schema guarantees array
      for (const idx of order) {
        if (typeof idx !== "number" || !Number.isSafeInteger(idx)) {
          return validationFailure("parameter.invalid_page_index", "parameter");
        }
      }
      return null;
    }
    default:
      return validationFailure("request.unknown_operation", "request");
  }
}

function validatePageSelectorSemantics(selector: unknown): ValidationFailure | null {
  if (typeof selector !== "object" || selector === null) return null; // schema guarantees shape
  const s = selector as { mode?: unknown; ranges?: Array<{ start?: unknown; end?: unknown }> };
  if (s.mode === "ranges" && Array.isArray(s.ranges)) {
    for (const r of s.ranges) {
      const start = r?.start;
      const end = r?.end;
      if (typeof start === "number" && typeof end === "number" && start > end) {
        return validationFailure("parameter.invalid_page_selector", "parameter", "range start must be <= end");
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Structural error classification
 * ------------------------------------------------------------------ */

function classifyStructural(errors: ErrorObject[] | null | undefined): ValidationFailure {
  const list = errors ?? [];

  // unknown operation (enum on /operation).
  for (const e of list) {
    if (e.instancePath === "/operation" && e.keyword === "enum") {
      return validationFailure("request.unknown_operation", "request");
    }
  }

  // protocol version mismatch (const on /protocolVersion).
  for (const e of list) {
    if (e.instancePath === "/protocolVersion") {
      return validationFailure("request.invalid_protocol_version", "request");
    }
  }

  // uuid shape violation (pattern on /invocationId).
  for (const e of list) {
    if (e.instancePath === "/invocationId") {
      return validationFailure("request.invalid_uuid", "request");
    }
  }

  // rotate angle enum violation -> parameter.invalid_angle.
  for (const e of list) {
    if (e.instancePath === "/parameters/angle" && e.keyword === "enum") {
      return validationFailure("parameter.invalid_angle", "parameter");
    }
  }

  // empty page selector (minItems on pages/ranges) -> parameter.empty_selector.
  for (const e of list) {
    if (e.keyword === "minItems" && /pageSelector\/(pages|ranges)$/.test(e.instancePath)) {
      return validationFailure("parameter.empty_selector", "parameter");
    }
  }

  // negative/float page index or range bound -> parameter.invalid_page_index.
  for (const e of list) {
    if ((e.keyword === "minimum" || e.keyword === "type") &&
        /(pageSelector\/(pages|ranges)|pageOrder)/.test(e.instancePath)) {
      return validationFailure("parameter.invalid_page_index", "parameter");
    }
  }

  // unknown field: additionalProperties anywhere in the request tree.
  for (const e of list) {
    if (e.keyword === "additionalProperties") {
      const params = e.params as Record<string, unknown> | undefined;
      const prop = params?.["additionalProperty"];
      if (typeof prop === "string") {
        return validationFailure("request.unknown_field", "request", `unknown field: ${prop}`);
      }
    }
  }

  // Fallback: structurally invalid request.
  return validationFailure("request.invalid_parameter", "request");
}

/**
 * Detect whether a raw string is malformed JSON (vs. structurally valid but
 * semantically invalid). Used by the CLI to choose exit code semantics.
 */
export function isMalformedJson(text: string): boolean {
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
}
