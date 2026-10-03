/**
 * UUID validation tests: v1–v7 accepted, v7 mandatory, v8/nil/malformed rejected.
 */

import { describe, it, expect } from "vitest";
import { parseUuid, isValidUuid, InvalidUuidError } from "../src/uuid/index.js";

// Known-good canonical UUIDs per version.
const SAMPLES: Record<number, string> = {
  1: "c232ab00-9414-11ec-b3c8-9f6bdeed8465",
  4: "1b4e28ba-2fa1-4d5b-a3c1-e7a2f4c8d901",
  5: "12345678-1234-5123-9234-1234567890ab",
  6: "1e7a5c6f-1234-6123-8123-123456789abc",
  7: "0189c68d-7b3a-7f2c-9d1e-123456789abc"
};

describe("UUID v1–v7 acceptance", () => {
  for (const [ver, uuid] of Object.entries(SAMPLES)) {
    it(`accepts UUIDv${ver}`, () => {
      const info = parseUuid(uuid);
      expect(info.version).toBe(Number(ver));
      expect(isValidUuid(uuid)).toBe(true);
    });
  }

  it("accepts uppercase UUIDs", () => {
    expect(isValidUuid(SAMPLES[4]!.toUpperCase())).toBe(true);
  });

  it("does not re-normalize identity (echo-safe: parse only)", () => {
    // parseUuid returns a normalized form, but callers echo the ORIGINAL.
    const info = parseUuid(SAMPLES[7]!);
    expect(info.normalized).toBe(SAMPLES[7]!.toLowerCase());
  });
});

describe("UUID rejection", () => {
  it("rejects v8", () => {
    const v8 = "0189c68d-7b3a-8f2c-9d1e-123456789abc";
    expect(() => parseUuid(v8)).toThrow(InvalidUuidError);
    expect(isValidUuid(v8)).toBe(false);
  });

  it("rejects nil UUID", () => {
    const nil = "00000000-0000-0000-0000-000000000000";
    expect(() => parseUuid(nil)).toThrow(InvalidUuidError);
    expect(isValidUuid(nil)).toBe(false);
  });

  it("rejects malformed UUIDs", () => {
    const malformed = [
      "not-a-uuid",
      "0189c68d7b3a7f2c9d1e123456789abc", // no dashes
      "0189c68d-7b3a-7f2c-9d1e-123456789abc-extra",
      "0189c68d-7b3a-7f2c-9d1e-123456789ab", // too short
      "0189c68d-7b3a-7f2c-9d1e-123456789abcd", // too long
      "0189c68d-7b3a-7f2c-9g1e-123456789abc", // non-hex
      ""
    ];
    for (const m of malformed) {
      expect(isValidUuid(m), `should reject "${m}"`).toBe(false);
    }
  });

  it("rejects non-string input", () => {
    expect(isValidUuid(123 as unknown as string)).toBe(false);
    expect(isValidUuid(null as unknown as string)).toBe(false);
    expect(isValidUuid(undefined as unknown as string)).toBe(false);
  });

  it("rejects v0 (version nibble 0)", () => {
    expect(isValidUuid("0189c68d-7b3a-0f2c-9d1e-123456789abc")).toBe(false);
  });

  it("rejects max UUID (version nibble f)", () => {
    expect(isValidUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(false);
  });
});

describe("UUID variant (RFC 9562 §4.1)", () => {
  // All use version 4 (4000) so the version check passes; only the variant
  // nibble (4th group first char) varies.
  it("accepts RFC 9562 variant 10xx (8/9/a/b)", () => {
    for (const v of ["8", "9", "a", "b", "A", "B"]) {
      const uuid = `00000000-0000-4000-${v}000-000000000000`;
      expect(isValidUuid(uuid), `variant ${v} should be accepted`).toBe(true);
    }
  });

  it("rejects NCS variant (0xxx): 0 and 7", () => {
    for (const v of ["0", "7"]) {
      const uuid = `00000000-0000-4000-${v}000-000000000000`;
      expect(isValidUuid(uuid), `variant ${v} should be rejected`).toBe(false);
    }
  });

  it("rejects Microsoft variant (110x): c", () => {
    expect(isValidUuid("00000000-0000-4000-c000-000000000000")).toBe(false);
  });

  it("rejects future-reserved variant (111x): e", () => {
    expect(isValidUuid("00000000-0000-4000-e000-000000000000")).toBe(false);
  });

  it("rejects wrong-variant UUIDs end-to-end via parseUuid reason", () => {
    expect(() => parseUuid("00000000-0000-4000-0000-000000000000")).toThrow(InvalidUuidError);
    expect(() => parseUuid("00000000-0000-4000-7000-000000000000")).toThrow(InvalidUuidError);
    expect(() => parseUuid("00000000-0000-4000-c000-000000000000")).toThrow(InvalidUuidError);
    expect(() => parseUuid("00000000-0000-4000-e000-000000000000")).toThrow(InvalidUuidError);
  });
});
