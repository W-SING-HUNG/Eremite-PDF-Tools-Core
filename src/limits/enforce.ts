/**
 * REAL resource-limit enforcement.
 *
 * IMPORTANT DISTINCTION:
 *   validateLimits() (limits.ts) only checks that limit VALUES are well-formed
 *   (positive safe integers). It never compares them to real usage. That gap is
 *   exactly the Host Gate BLOCKER 1 defect: limits were validated but not
 *   enforced. This module closes it.
 *
 * Enforcement points (wired in src/core/execute.ts):
 *   - inputs:    preflight, AFTER real page counts are known (structural gate),
 *                BEFORE any qpdf transform runs.
 *   - outputs:   post-check over the WHOLE produced set, BEFORE a success
 *                response is built. Any violation fails the whole invocation.
 *   - workspace: preflight AND post-check over the Core-managed
 *                work/ + staging/ + output/ directories of this invocation.
 *
 * Semantics:
 *   A limit <= 0 (or absent) means "no policy limit". Core's defaults leave
 *   every limit at 0, so omitting `limits` preserves P1-P4 behavior exactly.
 *   When the Host supplies `limits`, the frozen schema requires all ten fields
 *   to be >= 1, so every one of them is enforced.
 *
 * Honesty boundary:
 *   No OS-level hard quota is claimed and none is attempted. This is
 *   application-level accounting over the directories Core itself owns for this
 *   invocation, which is what the Contract promises.
 */

import { readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

import type { Limits } from "../protocol/types.js";
import type { ErrorCode, Stage } from "../taxonomy/index.js";
import { safeAdd } from "./limits.js";

export interface LimitViolation {
  code: ErrorCode;
  stage: Stage;
  /** Internal-only detail (never serialized onto the public wire). */
  detail: string;
}

export interface InputFacts {
  id: string;
  byteSize: number;
  pageCount: number;
}

export interface OutputFacts {
  id: string;
  byteSize: number;
}

const RESOURCE: Stage = "resource";

/** True only when the Host actually set a policy for this limit. */
function active(limit: number): boolean {
  return typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0;
}

/** Sum, saturating at MAX_SAFE_INTEGER (an overflow is itself a violation). */
function sumBytes(values: number[]): { total: number; overflow: boolean } {
  let total = 0;
  for (const v of values) {
    const next = safeAdd(total, v);
    if (next === null) return { total: Number.MAX_SAFE_INTEGER, overflow: true };
    total = next;
  }
  return { total, overflow: false };
}

/**
 * Enforce every input-side limit. Runs BEFORE any transform.
 * Order: arity -> per-file/per-input (most specific) -> aggregates.
 */
export function checkInputLimits(inputs: InputFacts[], limits: Limits): LimitViolation | null {
  if (active(limits.maxInputFiles) && inputs.length > limits.maxInputFiles) {
    return {
      code: "resource.max_input_files",
      stage: RESOURCE,
      detail: `inputs=${inputs.length} exceeds maxInputFiles=${limits.maxInputFiles}`
    };
  }

  if (active(limits.maxInputBytesPerFile)) {
    for (const i of inputs) {
      if (i.byteSize > limits.maxInputBytesPerFile) {
        return {
          code: "resource.max_input_bytes",
          stage: RESOURCE,
          detail: `input ${i.id} bytes=${i.byteSize} exceeds maxInputBytesPerFile=${limits.maxInputBytesPerFile}`
        };
      }
    }
  }

  if (active(limits.maxPagesPerInput)) {
    for (const i of inputs) {
      if (i.pageCount > limits.maxPagesPerInput) {
        return {
          code: "resource.max_pages",
          stage: RESOURCE,
          detail: `input ${i.id} pages=${i.pageCount} exceeds maxPagesPerInput=${limits.maxPagesPerInput}`
        };
      }
    }
  }

  if (active(limits.maxTotalInputBytes)) {
    const { total, overflow } = sumBytes(inputs.map((i) => i.byteSize));
    if (overflow || total > limits.maxTotalInputBytes) {
      return {
        code: "resource.max_total_input_bytes",
        stage: RESOURCE,
        detail: `aggregate input bytes${overflow ? " (overflow)" : `=${total}`} exceeds maxTotalInputBytes=${limits.maxTotalInputBytes}`
      };
    }
  }

  if (active(limits.maxTotalPages)) {
    const { total, overflow } = sumBytes(inputs.map((i) => i.pageCount));
    if (overflow || total > limits.maxTotalPages) {
      return {
        code: "resource.max_total_pages",
        stage: RESOURCE,
        detail: `aggregate pages${overflow ? " (overflow)" : `=${total}`} exceeds maxTotalPages=${limits.maxTotalPages}`
      };
    }
  }

  return null;
}

/**
 * Enforce every output-side limit over the WHOLE produced set.
 * Split / multi-output is checked as a set: any single violation fails the
 * entire invocation (never a partial success).
 */
export function checkOutputLimits(outputs: OutputFacts[], limits: Limits): LimitViolation | null {
  if (active(limits.maxOutputFiles) && outputs.length > limits.maxOutputFiles) {
    return {
      code: "resource.max_output_files",
      stage: RESOURCE,
      detail: `outputs=${outputs.length} exceeds maxOutputFiles=${limits.maxOutputFiles}`
    };
  }

  if (active(limits.maxOutputBytesPerFile)) {
    for (const o of outputs) {
      if (o.byteSize > limits.maxOutputBytesPerFile) {
        return {
          code: "resource.max_output_bytes",
          stage: RESOURCE,
          detail: `output ${o.id} bytes=${o.byteSize} exceeds maxOutputBytesPerFile=${limits.maxOutputBytesPerFile}`
        };
      }
    }
  }

  if (active(limits.maxTotalOutputBytes)) {
    const { total, overflow } = sumBytes(outputs.map((o) => o.byteSize));
    if (overflow || total > limits.maxTotalOutputBytes) {
      return {
        code: "resource.max_total_output_bytes",
        stage: RESOURCE,
        detail: `aggregate output bytes${overflow ? " (overflow)" : `=${total}`} exceeds maxTotalOutputBytes=${limits.maxTotalOutputBytes}`
      };
    }
  }

  return null;
}

/**
 * Recursive byte total of a directory tree. Best-effort: unreadable entries are
 * skipped. Symlinks / reparse points are counted by their own link metadata and
 * never followed, matching the Core's no-follow policy.
 */
export function measureTreeBytes(dir: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  let total = 0;
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const next = safeAdd(total, measureTreeBytes(p));
      total = next === null ? Number.MAX_SAFE_INTEGER : next;
    } else if (st.isFile()) {
      const next = safeAdd(total, st.size);
      total = next === null ? Number.MAX_SAFE_INTEGER : next;
    }
  }
  return total;
}

/** Sum the Core-managed invocation directories (work + staging + output). */
export function measureWorkspaceBytes(dirs: string[]): number {
  let total = 0;
  for (const d of dirs) {
    const next = safeAdd(total, measureTreeBytes(d));
    total = next === null ? Number.MAX_SAFE_INTEGER : next;
  }
  return total;
}
