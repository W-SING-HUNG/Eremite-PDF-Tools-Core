/**
 * Windows behavioral workspace containment.
 *
 * This is NOT an OS sandbox. It is behavioral containment: every path the core
 * touches is resolved (lexically + via realpath) and must provably resolve
 * inside the invocation workspace root. Symlinks, junctions, reparse points,
 * UNC, and traversal are rejected.
 *
 * Design notes (Windows):
 *  - Use forward-slash normalization for case-insensitive comparison.
 *  - `path.resolve` handles drive-relative and `..` lexical normalization.
 *  - `fs.realpath` resolves symlinks/junctions to their final target.
 *  - `fs.lstat` exposes symlink/junction/reparse status before following.
 *  - Reject `\\?\` prefixes and UNC roots defensively.
 */

import path from "node:path";
import fs from "node:fs";

/** Windows reserved device names (case-insensitive), stem-only. */
const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);

function isUnc(p: string): boolean {
  return p.startsWith("\\\\") || p.startsWith("//");
}

function isExtendedLengthPrefix(p: string): boolean {
  return p.startsWith("\\\\?\\") || p.startsWith("//?/");
}

/** Device namespace `\\.\` (Win32 device namespace) — reject. */
function isDeviceNamespace(p: string): boolean {
  return p.startsWith("\\\\.\\") || p.startsWith("//./");
}

/**
 * Drive-relative reference like `C:foo` or `C:` (a drive letter + colon that is
 * NOT followed by a separator). This is NOT an absolute path (`C:\foo` is
 * absolute), but Node's `path.resolve` folds it against the current drive,
 * which can map a same-drive workspace input into the root. The frozen lexical
 * protocol requires rejection regardless of where it ultimately resolves.
 */
function isDriveRelative(p: string): boolean {
  return /^[a-zA-Z]:/.test(p);
}

/** Any colon in a relative path is an NTFS Alternate Data Stream (ADS) marker. */
function hasAds(p: string): boolean {
  // A colon is legal ONLY as a drive-letter separator at index 1 (e.g. "C:\...").
  // Any other colon is an NTFS Alternate Data Stream marker.
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ":" && i !== 1) return true;
  }
  return false;
}

/** Windows silently trims trailing dots and spaces in path components. */
function hasTrailingDotOrSpace(p: string): boolean {
  return p.split(/[\\/]/).some((part) => {
    if (part === "." || part === "..") return false; // traversal markers, not trailing dot
    return /[. ]$/.test(part);
  });
}

/** Normalize for comparison: lowercase + forward slashes + strip trailing sep. */
function normalizeForCompare(p: string): string {
  let out = p.replace(/\\/g, "/").toLowerCase();
  while (out.endsWith("/") && out.length > 1) out = out.slice(0, -1);
  return out;
}

/** True if `child` is lexically inside `root` (both already resolved/absolute). */
function isInside(root: string, child: string): boolean {
  const r = normalizeForCompare(root);
  const c = normalizeForCompare(child);
  if (c === r) return true;
  return c.startsWith(r + "/");
}

/** Reject Windows reserved device names in any path component. */
function hasReservedComponent(p: string): boolean {
  return p.split(/[\\/]/).some((part) => {
    if (part === "") return false;
    const stem = part.split(".")[0] ?? part;
    return RESERVED_NAMES.has(stem.toUpperCase());
  });
}

export type ContainmentResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Validate a workspace rootPath.
 *
 * Requirements: absolute, local Windows path (drive-letter), not UNC, not
 * `\\?\`, no reserved names, exists, is a real directory, and is not itself a
 * symlink/junction/reparse point.
 */
export function validateWorkspaceRoot(rootPath: string): ContainmentResult<string> {
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    return { ok: false, reason: "rootPath empty" };
  }
  if (isUnc(rootPath)) return { ok: false, reason: "UNC root not allowed" };
  if (isExtendedLengthPrefix(rootPath)) return { ok: false, reason: "extended-length prefix not allowed" };
  if (isDeviceNamespace(rootPath)) return { ok: false, reason: "device namespace not allowed" };
  if (!path.isAbsolute(rootPath)) return { ok: false, reason: "rootPath must be absolute" };
  if (hasAds(rootPath)) return { ok: false, reason: "ADS not allowed in root path" };
  if (hasReservedComponent(rootPath)) return { ok: false, reason: "reserved name in root path" };

  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(rootPath);
  } catch {
    return { ok: false, reason: "root does not exist" };
  }
  if (lst.isSymbolicLink()) return { ok: false, reason: "root is a symlink/junction" };
  if (!lst.isDirectory()) return { ok: false, reason: "root is not a directory" };

  const real = fs.realpathSync(rootPath);
  if (isUnc(real) || isExtendedLengthPrefix(real)) {
    return { ok: false, reason: "root resolves to UNC/reparse" };
  }
  return { ok: true, value: real };
}

/**
 * Resolve an input relativePath against a validated root, enforcing
 * containment. Rejects: absolute, UNC, `\\?\`, `..` traversal, reserved names,
 * symlinks/junctions/reparse points in any component, and any path that
 * resolves outside the root.
 *
 * Returns the canonical absolute path only when the file provably lives inside
 * the root.
 */
function resolveContainedCandidate(
  rootPath: string,
  relativePath: string
): ContainmentResult<{ rootReal: string; candidate: string }> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return { ok: false, reason: "relativePath empty" };
  }
  if (path.isAbsolute(relativePath)) return { ok: false, reason: "absolute path not allowed" };
  if (isUnc(relativePath)) return { ok: false, reason: "UNC path not allowed" };
  if (isExtendedLengthPrefix(relativePath)) return { ok: false, reason: "extended-length prefix not allowed" };
  if (isDeviceNamespace(relativePath)) return { ok: false, reason: "device namespace not allowed" };
  // Lexical rejections (must reject regardless of where realpath lands):
  if (isDriveRelative(relativePath)) return { ok: false, reason: "drive-relative path not allowed" };
  if (hasAds(relativePath)) return { ok: false, reason: "ADS path not allowed" };
  if (hasTrailingDotOrSpace(relativePath)) return { ok: false, reason: "trailing dot/space not allowed" };
  if (hasReservedComponent(relativePath)) return { ok: false, reason: "reserved name in relativePath" };

  let rootReal: string;
  try {
    rootReal = fs.realpathSync(rootPath);
  } catch {
    return { ok: false, reason: "root does not exist" };
  }
  const candidate = path.resolve(rootReal, relativePath);

  // Lexical containment (rejects `..` that escapes).
  if (!isInside(rootReal, candidate)) {
    return { ok: false, reason: "path escapes root" };
  }

  // Reject any symlink/junction/reparse component along the candidate path
  // (the "ancestor reparse" case).
  if (hasReparseComponent(rootReal, candidate)) {
    return { ok: false, reason: "reparse point in path" };
  }

  return { ok: true, value: { rootReal, candidate } };
}

export function resolveContainedInput(
  rootPath: string,
  relativePath: string
): ContainmentResult<string> {
  const resolved = resolveContainedCandidate(rootPath, relativePath);
  if (!resolved.ok) return resolved;
  const { rootReal, candidate } = resolved.value;

  // Realpath containment (defense in depth).
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, reason: "path does not exist" };
  }
  if (!isInside(rootReal, real)) {
    return { ok: false, reason: "path resolves outside root (reparse)" };
  }
  if (isUnc(real) || isExtendedLengthPrefix(real)) {
    return { ok: false, reason: "path resolves to UNC/reparse" };
  }

  return { ok: true, value: real };
}

/**
 * Resolve a generated target before writing. Reuse the input lexical/reparse
 * policy, but allow a missing leaf only when its real parent already exists.
 * The managed directory is the existing work/staging/output ownership boundary.
 * Call again at each write/publish boundary; an earlier directory check alone
 * cannot validate a later target.
 */
export function resolveContainedTarget(
  rootPath: string,
  relativePath: string,
  managedDirectory: "work" | "staging" | "output"
): ContainmentResult<string> {
  try {
    const root = validateWorkspaceRoot(rootPath);
    if (!root.ok) return root;
    // rootPath is the invocation's already-canonical root, not a fresh alias.
    if (normalizeForCompare(root.value) !== normalizeForCompare(rootPath)) {
      return { ok: false, reason: "invocation root changed" };
    }
    const resolved = resolveContainedCandidate(rootPath, relativePath);
    if (!resolved.ok) return resolved;
    const { rootReal, candidate } = resolved.value;
    const allowed = path.join(rootReal, managedDirectory);
    if (!isInside(allowed, candidate)) return { ok: false, reason: "target escapes managed directory" };

    const parent = fs.realpathSync(path.dirname(candidate));
    if (!isInside(rootReal, parent) || !fs.statSync(parent).isDirectory()) {
      return { ok: false, reason: "target parent escapes root" };
    }
    const target = path.join(parent, path.basename(candidate));
    if (!isInside(allowed, target)) return { ok: false, reason: "target resolves outside managed directory" };
    // Existing leaves must obey exactly the same realpath policy as inputs.
    if (fs.existsSync(candidate)) return resolveContainedInput(rootPath, relativePath);
    return { ok: true, value: target };
  } catch {
    return { ok: false, reason: "target parent unavailable" };
  }
}

/**
 * Walk each component of `candidate` strictly below `rootReal` and return true
 * if any component is itself a symlink/junction/reparse point. This rejects
 * ancestor reparse points before realpath would silently resolve them.
 */
export function hasReparseComponent(rootReal: string, absoluteCandidate: string): boolean {
  const rootParts = absoluteCandidate.replace(/\\/g, "/").split("/").length;
  const candidateParts = absoluteCandidate.replace(/\\/g, "/").split("/");
  let current = rootReal;
  // rootReal is already the resolved root; reconstruct component-by-component.
  const rootResolvedParts = rootReal.replace(/\\/g, "/").split("/");
  const relStart = rootResolvedParts.length;
  for (let i = relStart; i < candidateParts.length; i++) {
    current = path.join(current, candidateParts[i]!);
    try {
      const st = fs.lstatSync(current);
      if (st.isSymbolicLink()) return true;
    } catch {
      // Component does not exist yet; nothing further to inspect.
      break;
    }
  }
  void rootParts;
  return false;
}

/**
 * Verify a file is a regular file (not symlink/junction/reparse) at an
 * already-resolved absolute path.
 */
export function isRegularFileNoReparse(absPath: string): boolean {
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) return false;
    return st.isFile();
  } catch {
    return false;
  }
}
