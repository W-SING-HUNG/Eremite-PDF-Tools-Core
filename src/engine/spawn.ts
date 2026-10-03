/**
 * Controlled subprocess execution for the qpdf engine.
 *
 * Guarantees:
 *  - Always `spawn(executable, argvArray, { shell: false })`. Never a shell
 *    command string, never cmd.exe /c, never powershell.
 *  - argv is constructed only by the operation planner; callers cannot inject
 *    arbitrary flags (see argv.ts).
 *  - stdout / stderr are capped (prevents unbounded memory / disk use).
 *  - A hard timeout terminates the child AND its process tree.
 *  - Minimal environment (no inherited PATH — reduces DLL-hijack surface).
 *  - No network capability is granted or required.
 */

import { spawn, execFile } from "node:child_process";
import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SpawnOptions {
  timeoutMs: number;
  /** Max bytes retained from stdout. */
  stdoutMaxBytes: number;
  /** Max bytes retained from stderr. */
  stderrMaxBytes: number;
  cwd?: string;
}

export const DEFAULT_STDOUT_MAX_BYTES = 1024 * 64; // 64 KiB
export const DEFAULT_STDERR_MAX_BYTES = 1024 * 64; // 64 KiB

/**
 * Minimal child environment. Windows needs SYSTEMROOT for some loader paths;
 * PATH is deliberately NOT inherited. The runtime resolves the prerequisite to
 * an absolute executable before invoking this process boundary.
 */
function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === "win32") {
    const sysRoot = process.env["SystemRoot"] ?? process.env["SYSTEMROOT"];
    if (sysRoot) env["SystemRoot"] = sysRoot;
  }
  return env;
}

/** Force-kill a child and its process tree (Windows: taskkill /T). */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* already exited */
  }
  if (process.platform === "win32") {
    // Best-effort tree kill. argv array, shell:false — no string interpolation.
    execFile("taskkill", ["/PID", String(pid), "/T", "/F"], () => {
      /* swallow: the process may already be gone */
    });
  }
}

/**
 * Run `executable` with `args`, enforcing timeout and output caps.
 *
 * Resolves with a SpawnResult on normal exit OR timeout; rejects only for
 * spawn-level failures (e.g. executable missing / not executable).
 */
export function runProcess(
  executable: string,
  args: string[],
  opts: SpawnOptions
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(executable, args, {
        shell: false,
        cwd: opts.cwd,
        env: minimalEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (e) {
      reject(e as Error);
      return;
    }

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutText = "";
    let stderrText = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout: stdoutText,
        stderr: stderrText,
        timedOut,
        stdoutTruncated,
        stderrTruncated
      });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= opts.stdoutMaxBytes) {
        stdoutTruncated = true;
        return; // keep draining, stop retaining
      }
      stdoutBytes += chunk.length;
      stdoutText += chunk.toString("utf-8");
      if (stdoutText.length > opts.stdoutMaxBytes) {
        stdoutText = stdoutText.slice(0, opts.stdoutMaxBytes);
        stdoutTruncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= opts.stderrMaxBytes) {
        stderrTruncated = true;
        return;
      }
      stderrBytes += chunk.length;
      stderrText += chunk.toString("utf-8");
      if (stderrText.length > opts.stderrMaxBytes) {
        stderrText = stderrText.slice(0, opts.stderrMaxBytes);
        stderrTruncated = true;
      }
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      finish(code, signal ?? null);
    });
  });
}
