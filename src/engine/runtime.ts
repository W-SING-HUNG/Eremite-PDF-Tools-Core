/** External qpdf prerequisite. Resolve only PATH entries; never use vendor or cwd. */
import { statSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { runProcess, DEFAULT_STDERR_MAX_BYTES, DEFAULT_STDOUT_MAX_BYTES } from "./spawn.js";

export const QPDF_VERSION = "12.4.0";

/** Resolve the first qpdf executable on the caller's PATH to an absolute path. */
export function resolveQpdfExecutable(): string | null {
  const searchPath = process.env["PATH"] ?? process.env["Path"] ?? "";
  const name = process.platform === "win32" ? "qpdf.exe" : "qpdf";
  for (const entry of searchPath.split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1");
    // Empty/relative entries would implicitly search cwd instead of an installed prerequisite.
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch {
      // Continue to the next explicitly configured PATH directory.
    }
  }
  return null;
}

export function getQpdfExecutable(): string {
  const executable = resolveQpdfExecutable();
  if (executable === null) throw new Error("qpdf 12.4.0 external prerequisite not found on PATH");
  return executable;
}

export function isRuntimePresent(): boolean {
  return resolveQpdfExecutable() !== null;
}

/** Probe before execution; callers keep the same resolved executable for the invocation. */
export async function verifyQpdfVersion(timeoutMs: number, executable?: string): Promise<string | null> {
  const exe = executable ?? resolveQpdfExecutable();
  if (exe === null) return "qpdf external prerequisite missing from PATH";
  try {
    const res = await runProcess(exe, ["--version"], {
      timeoutMs,
      stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
      stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
    });
    if (res.timedOut) return "qpdf version probe timed out";
    if (res.exitCode !== 0) return "qpdf version probe failed";
    if (res.stdoutTruncated || res.stderrTruncated) return "qpdf version output truncated";
    const match = /^qpdf\s+version\s+(\S+)\s*$/im.exec(res.stdout + "\n" + res.stderr);
    if (!match) return "qpdf version not reported";
    return match[1] === QPDF_VERSION ? null : "qpdf version mismatch: " + match[1];
  } catch {
    return "qpdf executable not runnable";
  }
}
