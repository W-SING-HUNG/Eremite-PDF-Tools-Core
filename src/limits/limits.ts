/**
 * Resource limits validation.
 *
 * All limits must be positive safe integers. Total-value arithmetic uses safe
 * integer checks to prevent overflow. NaN / Infinity / negative / unsafe
 * integer are rejected.
 *
 * NOTE: this module deliberately does NOT import from the protocol layer, so
 * the protocol validator can import it without a dependency cycle. It returns
 * a bare string (the offending field name) or null; the protocol validator
 * maps that to a canonical ValidationFailure and wires it into the request
 * validation path.
 */

import type { Limits } from "../protocol/types.js";

const LIMIT_FIELDS = [
  "maxInputFiles",
  "maxInputBytesPerFile",
  "maxTotalInputBytes",
  "maxOutputFiles",
  "maxOutputBytesPerFile",
  "maxTotalOutputBytes",
  "maxPagesPerInput",
  "maxTotalPages",
  "maxWorkspaceBytes",
  "timeoutMs"
] as const;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * Validate a limits object. Returns null on success, or the offending field
 * name (or a generic reason string) on failure.
 */
export function validateLimits(limits: unknown): string | null {
  if (limits === undefined) return null; // optional; Core applies policy defaults
  if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
    return "limits must be an object";
  }
  const l = limits as Record<string, unknown>;
  for (const field of LIMIT_FIELDS) {
    const v = l[field];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
      return field;
    }
  }
  return null;
}

/** Sum two values, returning null on safe-integer overflow. */
export function safeAdd(a: number, b: number): number | null {
  const s = a + b;
  if (!Number.isSafeInteger(s)) return null;
  return s;
}

/** Sum an array, returning null on safe-integer overflow or any non-integer. */
export function safeSum(values: number[]): number | null {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) return null;
    const next = total + v;
    if (!Number.isSafeInteger(next)) return null;
    total = next;
  }
  return total;
}

/** Guard against absurd values in limits (defensive upper bound). */
export const ABSOLUTE_CEILING = MAX_SAFE;

export function isValidLimitValue(v: unknown): boolean {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_SAFE;
}

export type { Limits };
