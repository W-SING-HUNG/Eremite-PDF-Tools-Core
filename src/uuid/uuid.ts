/**
 * RFC 9562 UUID validation.
 *
 * Accepts UUID versions 1–7 (v7 is mandatory for Host Run IDs) with the RFC
 * 9562 variant (10xx). Rejects: v8, nil UUID, wrong variant (NCS / Microsoft /
 * future reserved), and any malformed string.
 *
 * This is deliberately byte-level parsing, not a "v1–v5" legacy regex. Version
 * is read from the 3rd group's first nibble; the variant is read from the 4th
 * group's first nibble per RFC 9562 §4.1.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** Hex digit value for a single char (already lowercased), or -1 if invalid. */
function hexValue(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

export interface UuidInfo {
  /** Canonical lowercase form (for provenance / echo safety is NOT normalized — see echo note). */
  normalized: string;
  version: number;
}

export class InvalidUuidError extends Error {
  readonly reason: "malformed" | "nil" | "unsupported_version" | "invalid_variant";
  constructor(reason: "malformed" | "nil" | "unsupported_version" | "invalid_variant") {
    super(`invalid UUID: ${reason}`);
    this.name = "InvalidUuidError";
    this.reason = reason;
  }
}

/**
 * Parse and validate a UUID string.
 *
 * @returns UuidInfo on success.
 * @throws InvalidUuidError on malformed, nil, unsupported version (v8+), or
 *         non-RFC-9562 variant.
 */
export function parseUuid(input: string): UuidInfo {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) {
    throw new InvalidUuidError("malformed");
  }

  const lower = input.toLowerCase();
  if (lower === NIL_UUID) {
    throw new InvalidUuidError("nil");
  }

  // Version nibble is the first char of the 3rd group (index 14).
  const version = hexValue(lower.charAt(14));
  // Valid UUID versions are 1..7 for our protocol (v8 is intentionally rejected).
  if (version < 1 || version > 7) {
    throw new InvalidUuidError("unsupported_version");
  }

  // Variant nibble is the first char of the 4th group (index 19).
  // RFC 9562 §4.1 MUST 10: the variant is 10xx (8/9/a/b). Reject NCS (0xxx),
  // Microsoft (110x), and future-reserved (111x) variants.
  const variant = hexValue(lower.charAt(19));
  const variantBits = variant & 0xc; // top two bits
  if (variantBits !== 0x8) {
    throw new InvalidUuidError("invalid_variant");
  }

  return { normalized: lower, version };
}

/**
 * Validate without throwing; returns true only for accepted v1–v7 non-nil
 * RFC-9562-variant UUIDs.
 */
export function isValidUuid(input: string): boolean {
  try {
    parseUuid(input);
    return true;
  } catch {
    return false;
  }
}
