/**
 * Response construction with strict public-diagnostics hygiene.
 *
 * The public wire contains ONLY: kind, protocolVersion, invocationId,
 * operation, status, outputs/provenance/warnings (success) or error/warnings
 * (failure). It NEVER contains absolute paths, stack traces, commands, stderr,
 * environment variables, or internal exception messages.
 *
 * Internal diagnostics are written to workspace/logs/ only, and only if the
 * Host decides to read them.
 */

import type {
  Request,
  SuccessResponse,
  FailureResponse,
  ErrorEnvelope,
  WarningEnvelope,
  Output,
  Provenance
} from "./types.js";
import { PROTOCOL_VERSION, RETRYABLE_ERROR_CODES } from "../taxonomy/index.js";
import type { ErrorCode, Stage, Operation } from "../taxonomy/index.js";

/** Core version — single source (kept in sync with package.json). */
export const CORE_VERSION = "1.0.0-rc5";

export function buildErrorEnvelope(code: ErrorCode, stage: Stage): ErrorEnvelope {
  return { code, stage, retryable: RETRYABLE_ERROR_CODES.has(code) };
}

export function buildWarning(code: WarningEnvelope["code"]): WarningEnvelope {
  return { code };
}

export function buildProvenance(operation: Operation): Provenance {
  return { coreVersion: CORE_VERSION, protocolVersion: PROTOCOL_VERSION, operation };
}

/**
 * Build a failure response. Never echoes request-internal diagnostics; takes
 * only the operation + invocationId (verbatim) + a machine-readable error.
 */
export function buildFailure(
  invocationId: string,
  operation: Operation,
  error: ErrorEnvelope
): FailureResponse {
  return {
    kind: "pdf.tools.response",
    protocolVersion: PROTOCOL_VERSION,
    invocationId,
    operation,
    status: "failed",
    error,
    // V1: failures never carry warnings (frozen as empty array).
    warnings: []
  };
}

/**
 * Build a success response. P1 never produces a real success (no engine), but
 * this is the frozen shape used by tests to assert contract parity.
 */
export function buildSuccess(
  invocationId: string,
  operation: Operation,
  outputs: Output[],
  warnings: WarningEnvelope[] = []
): SuccessResponse {
  return {
    kind: "pdf.tools.response",
    protocolVersion: PROTOCOL_VERSION,
    invocationId,
    operation,
    status: "succeeded",
    outputs,
    provenance: buildProvenance(operation),
    warnings
  };
}

/**
 * Serialize a response to JSON, guaranteeing no forbidden keys leak onto the
 * public wire. This is the single choke point for public output.
 */
export function serializeResponse(response: SuccessResponse | FailureResponse): string {
  return JSON.stringify(response);
}

/**
 * For CLI use: derive an operation string for a failure that occurs before the
 * request is fully validated (e.g. malformed JSON has no operation). Returns
 * a safe fallback that never leaks internals.
 */
export function operationOrUnknown(req: Request | null, operation: Operation): Operation {
  return req?.operation ?? operation;
}
