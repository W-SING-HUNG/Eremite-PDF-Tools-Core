/**
 * Limits tests: negative/zero/unsafe-integer/overflow rejection, safe-integer
 * arithmetic.
 */

import { describe, it, expect } from "vitest";
import { validateLimits, safeAdd, safeSum, isValidLimitValue } from "../src/limits/index.js";

function validLimits() {
  return {
    maxInputFiles: 64,
    maxInputBytesPerFile: 512 * 1024 * 1024,
    maxTotalInputBytes: 2 * 1024 * 1024 * 1024,
    maxOutputFiles: 2000,
    maxOutputBytesPerFile: 1024 * 1024 * 1024,
    maxTotalOutputBytes: 4 * 1024 * 1024 * 1024,
    maxPagesPerInput: 10000,
    maxTotalPages: 50000,
    maxWorkspaceBytes: 8 * 1024 * 1024 * 1024,
    timeoutMs: 600000
  };
}

describe("validateLimits", () => {
  it("accepts valid limits", () => {
    expect(validateLimits(validLimits())).toBeNull();
  });

  it("accepts undefined (optional)", () => {
    expect(validateLimits(undefined)).toBeNull();
  });

  it("rejects negative", () => {
    const l = validLimits();
    l.maxInputFiles = -1;
    expect(validateLimits(l)).not.toBeNull();
  });

  it("rejects zero", () => {
    const l = validLimits();
    l.timeoutMs = 0;
    expect(validateLimits(l)).not.toBeNull();
  });

  it("rejects unsafe integer", () => {
    const l = validLimits();
    (l as Record<string, unknown>).maxPagesPerInput = Number.MAX_SAFE_INTEGER + 1;
    expect(validateLimits(l)).not.toBeNull();
  });

  it("rejects float", () => {
    const l = validLimits();
    (l as Record<string, unknown>).maxOutputFiles = 1.5;
    expect(validateLimits(l)).not.toBeNull();
  });

  it("rejects non-number", () => {
    const l = validLimits();
    (l as Record<string, unknown>).maxInputFiles = "64";
    expect(validateLimits(l)).not.toBeNull();
  });
});

describe("safe arithmetic", () => {
  it("safeAdd returns null on overflow", () => {
    expect(safeAdd(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
    expect(safeAdd(1, 2)).toBe(3);
  });

  it("safeSum returns null on overflow", () => {
    expect(safeSum([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    expect(safeSum([1, 2, 3])).toBe(6);
    expect(safeSum([1.5, 2])).toBeNull();
  });

  it("isValidLimitValue bounds check", () => {
    expect(isValidLimitValue(1)).toBe(true);
    expect(isValidLimitValue(0)).toBe(false);
    expect(isValidLimitValue(-1)).toBe(false);
    expect(isValidLimitValue(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isValidLimitValue(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isValidLimitValue(1.5)).toBe(false);
  });
});
