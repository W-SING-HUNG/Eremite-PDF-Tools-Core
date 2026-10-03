/**
 * Input identity + snapshot verification.
 *
 * Snapshot = byteSize + sha256 (+ displayName, which is metadata only and
 * never participates in identity or path resolution).
 *
 * Verification is streaming (no whole-file buffering) and compares BOTH size
 * and hash. Size-only or mtime-only comparison is deliberately insufficient:
 * a same-size content replacement must be detected.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { statSync } from "node:fs";

import type { InputSnapshot } from "../protocol/index.js";

export interface SnapshotCheck {
  ok: boolean;
  /** Actual on-disk size, for diagnostics only. */
  actualSize: number;
  /** Actual on-disk sha256, for diagnostics only. */
  actualSha256: string;
  /** Why it failed (internal only). */
  reason?: "size_mismatch" | "hash_mismatch" | "stat_failed";
}

/** Stream a file's SHA-256 without buffering it in memory. */
export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/** Synchronous size check (cheap first gate). */
export function fileSize(absPath: string): number {
  return statSync(absPath).size;
}

/**
 * Verify a file against a snapshot (size + sha256). This is the pre-operation
 * check. The same function is reused for the post-operation check (double-ended
 * snapshot verification) in P2, which is why it is standalone.
 */
export async function verifySnapshot(
  absPath: string,
  snapshot: InputSnapshot
): Promise<SnapshotCheck> {
  let size: number;
  try {
    size = fileSize(absPath);
  } catch {
    return { ok: false, actualSize: -1, actualSha256: "", reason: "stat_failed" };
  }

  if (size !== snapshot.byteSize) {
    return { ok: false, actualSize: size, actualSha256: "", reason: "size_mismatch" };
  }

  // Streaming hash can fail if the file is replaced/deleted between stat and
  // read (TOCTOU). Treat that as a mismatch, not an uncaught crash.
  let actual: string;
  try {
    actual = await sha256File(absPath);
  } catch {
    return { ok: false, actualSize: size, actualSha256: "", reason: "stat_failed" };
  }

  // Normalize case for comparison (sha256 is conventionally lowercase, but a
  // Host may send uppercase).
  if (actual.toLowerCase() !== snapshot.sha256.toLowerCase()) {
    return { ok: false, actualSize: size, actualSha256: actual, reason: "hash_mismatch" };
  }

  return { ok: true, actualSize: size, actualSha256: actual };
}

/**
 * Verify a file is a regular, non-empty, non-reparse file and matches the
 * snapshot. Combine with workspace containment for the full input gate.
 */
export function snapshotMatches(actual: string, expected: string): boolean {
  return actual.toLowerCase() === expected.toLowerCase();
}
