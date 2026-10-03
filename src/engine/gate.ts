/**
 * V1 input structural gate — executed before ANY real transform.
 *
 * Frozen policy (P0):
 *  - qpdf structural check exit 0  -> may enter V1.
 *  - recoverable anomaly / warning -> FAIL (never silently repair).
 *  - malformed / error             -> FAIL.
 *  - encrypted / requires password -> FAIL (no password, no decrypt).
 *
 * Uses qpdf's documented inspection options only. Results are mapped onto the
 * P1 CLOSED error enum; no new public codes are introduced here.
 */

import { runProcess, DEFAULT_STDERR_MAX_BYTES, DEFAULT_STDOUT_MAX_BYTES } from "./spawn.js";

export type GateFailureReason =
  | "encrypted"
  | "requires_password"
  | "malformed"
  | "recoverable_anomaly"
  | "probe_timeout"
  | "probe_unavailable";

export type GateOutcome =
  | { ok: true; pageCount: number }
  | { ok: false; reason: GateFailureReason };

export interface GateOptions {
  timeoutMs: number;
}

async function probe(
  exe: string,
  args: string[],
  timeoutMs: number
): Promise<{ exitCode: number | null; timedOut: boolean; stdout: string }> {
  const res = await runProcess(exe, args, {
    timeoutMs,
    stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
  });
  return { exitCode: res.exitCode, timedOut: res.timedOut, stdout: res.stdout };
}

/**
 * Run the full V1 structural gate for one input file.
 *
 * Order: encryption probes first (cheap, hard-fail), then --check, then page
 * count. Any failure short-circuits so a damaged/encrypted file never reaches
 * a transform.
 */
export async function structuralGate(
  exe: string,
  inputPath: string,
  opts: GateOptions
): Promise<GateOutcome> {
  // 1. Encryption probes. Verified against qpdf 12.4.0 (win-x64):
  //      --is-encrypted / --requires-password return EXIT 0 when the condition
  //      is TRUE, and a NON-ZERO code (empirically 2) when it is FALSE or the
  //      file is unreadable. We therefore treat ONLY exit 0 as the positive
  //      signal; every other code (including 2) is "not encrypted / not
  //      password-protected" here and is deferred to --check, which maps a
  //      genuinely unreadable file to malformed (exit 2).
  const enc = await probe(exe, ["--is-encrypted", inputPath], opts.timeoutMs);
  if (enc.timedOut) return { ok: false, reason: "probe_timeout" };
  if (enc.exitCode === 0) return { ok: false, reason: "encrypted" };

  const req = await probe(exe, ["--requires-password", inputPath], opts.timeoutMs);
  if (req.timedOut) return { ok: false, reason: "probe_timeout" };
  if (req.exitCode === 0) return { ok: false, reason: "requires_password" };

  // 2. Structural check. exit 0 = clean, 2 = errors, 3 = warnings only.
  //    V1: warnings are ALSO a failure (recoverable anomaly -> reject).
  const check = await probe(exe, ["--check", inputPath], opts.timeoutMs);
  if (check.timedOut) return { ok: false, reason: "probe_timeout" };
  if (check.exitCode === 2) return { ok: false, reason: "malformed" };
  if (check.exitCode === 3) return { ok: false, reason: "recoverable_anomaly" };
  if (check.exitCode !== 0) return { ok: false, reason: "probe_unavailable" };

  // 3. Page count (needed for planning and out-of-range validation).
  const np = await probe(exe, ["--show-npages", inputPath], opts.timeoutMs);
  if (np.timedOut) return { ok: false, reason: "probe_timeout" };
  if (np.exitCode !== 0) return { ok: false, reason: "probe_unavailable" };
  const pageCount = Number.parseInt(np.stdout.trim(), 10);
  if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
    return { ok: false, reason: "probe_unavailable" };
  }

  return { ok: true, pageCount };
}

/** Map a gate failure onto the P1 closed error enum (no new codes). */
export function gateReasonToErrorCode(
  reason: GateFailureReason
): "pdf_validation.encrypted" | "pdf_validation.requires_password" | "pdf_validation.malformed" | "pdf_validation.recoverable_anomaly" | "timeout.engine" | "engine.nonzero_exit" {
  switch (reason) {
    case "encrypted":
      return "pdf_validation.encrypted";
    case "requires_password":
      return "pdf_validation.requires_password";
    case "malformed":
      return "pdf_validation.malformed";
    case "recoverable_anomaly":
      return "pdf_validation.recoverable_anomaly";
    case "probe_timeout":
      return "timeout.engine";
    case "probe_unavailable":
      return "engine.nonzero_exit";
  }
}
