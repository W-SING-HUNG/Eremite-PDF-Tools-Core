/**
 * Workspace containment tests (Windows behavioral containment).
 *
 * Covers: traversal, absolute input relativePath, UNC, \\?\, \\.\, source
 * outside root, symlink/junction/reparse, ancestor escape, drive-relative,
 * ADS, reserved names (COM0/LPT0), trailing dot/space, prefix coincidence.
 *
 * Tests that require OS symlink privilege use an explicit `ctx.skip(reason)`
 * — never a silent `catch { return; }` fake-green.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  validateWorkspaceRoot,
  resolveContainedInput,
  isRegularFileNoReparse
} from "../src/workspace/index.js";
import { tmp, tmpScope, type TempDir } from "./helpers/temp.js";
import { symlinkSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

function isWindows(): boolean {
  return process.platform === "win32";
}

describe("validateWorkspaceRoot", () => {
  it("rejects UNC root", () => {
    expect(validateWorkspaceRoot("\\\\server\\share\\ws").ok).toBe(false);
    expect(validateWorkspaceRoot("//server/share/ws").ok).toBe(false);
  });

  it("rejects extended-length prefix", () => {
    expect(validateWorkspaceRoot("\\\\?\\C:\\tmp\\ws").ok).toBe(false);
  });

  it("rejects device namespace root", () => {
    expect(validateWorkspaceRoot("\\\\.\\COM1").ok).toBe(false);
  });

  it("rejects relative root", () => {
    expect(validateWorkspaceRoot("relative/path").ok).toBe(false);
  });

  it("rejects reserved name in root", () => {
    expect(validateWorkspaceRoot("C:\\tmp\\CON\\ws").ok).toBe(false);
  });

  it("rejects non-existent root", () => {
    expect(validateWorkspaceRoot("C:\\definitely\\not\\here\\ws").ok).toBe(false);
  });

  it("accepts a real existing directory", () => {
    const t = tmp();
    const r = validateWorkspaceRoot(t.root);
    expect(r.ok).toBe(true);
  });
});

describe("resolveContainedInput — string/lexical rejections", () => {
  let t: TempDir;
  let root: string;
  beforeAll(() => {
    t = tmpScope();
    root = t.root;
  });
  afterAll(() => t.cleanup());

  it("rejects absolute relativePath", () => {
    expect(resolveContainedInput(root, "C:\\tmp\\outside.pdf").ok).toBe(false);
  });

  it("rejects UNC relativePath", () => {
    expect(resolveContainedInput(root, "\\\\server\\share\\f.pdf").ok).toBe(false);
  });

  it("rejects extended-length relativePath", () => {
    expect(resolveContainedInput(root, "\\\\?\\C:\\x\\f.pdf").ok).toBe(false);
  });

  it("rejects device namespace relativePath", () => {
    expect(resolveContainedInput(root, "\\\\.\\COM1").ok).toBe(false);
  });

  it("rejects drive-relative path (C:foo) regardless of final resolve location", () => {
    // Even a same-drive workspace must lexically reject `C:foo`.
    expect(resolveContainedInput(root, "C:foo").ok).toBe(false);
    expect(resolveContainedInput(root, "c:foo").ok).toBe(false);
    expect(resolveContainedInput(root, "C:input\\in.pdf").ok).toBe(false);
  });

  it("rejects ADS paths (colon in any component)", () => {
    expect(resolveContainedInput(root, "a.pdf:secret").ok).toBe(false);
    expect(resolveContainedInput(root, "a.pdf::$DATA").ok).toBe(false);
    expect(resolveContainedInput(root, "input/a.pdf:secret").ok).toBe(false);
  });

  it("rejects trailing dot and trailing space components", () => {
    expect(resolveContainedInput(root, "file.pdf.").ok).toBe(false);
    expect(resolveContainedInput(root, "file.pdf ").ok).toBe(false);
    expect(resolveContainedInput(root, "dir./file.pdf").ok).toBe(false);
  });

  it("rejects .. traversal escaping root", () => {
    expect(resolveContainedInput(root, "../outside.pdf").ok).toBe(false);
    expect(resolveContainedInput(root, "input/../../outside.pdf").ok).toBe(false);
  });

  it("rejects reserved names including COM0/LPT0", () => {
    expect(resolveContainedInput(root, "CON").ok).toBe(false);
    expect(resolveContainedInput(root, "input/NUL.pdf").ok).toBe(false);
    expect(resolveContainedInput(root, "COM0").ok).toBe(false);
    expect(resolveContainedInput(root, "LPT0.pdf").ok).toBe(false);
  });

  it("resolves a valid in-root file", () => {
    const f = t.write("input/in-0000.pdf", "%PDF-1.4 dummy");
    const r = resolveContainedInput(root, "input/in-0000.pdf");
    expect(r.ok).toBe(true);
    if (r.ok) expect(path.resolve(r.value)).toBe(path.resolve(f));
  });

  it("is case-insensitive on Windows", () => {
    if (!isWindows()) return;
    const f = t.write("input/In-0000.PDF", "%PDF");
    const r = resolveContainedInput(root, "INPUT/IN-0000.pdf");
    expect(r.ok).toBe(true);
    if (r.ok) expect(path.resolve(r.value).toLowerCase()).toBe(path.resolve(f).toLowerCase());
  });
});

describe("resolveContainedInput — prefix coincidence (mutation regression)", () => {
  // Guards against the `isInside` implementation degrading to a naive
  // `child.startsWith(root)` — a sibling named `<root>-evil` must NOT be
  // considered inside `<root>`.
  let t: TempDir;
  let evilDir: string;
  beforeAll(() => {
    t = tmpScope();
    const base = t.root; // e.g. /tmp/pdf-tools-core-test-XXXX
    const parent = path.dirname(base);
    evilDir = path.join(parent, path.basename(base) + "-evil");
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(path.join(evilDir, "file.pdf"), "%PDF");
  });
  afterAll(() => {
    t.cleanup();
    rmSync(evilDir, { recursive: true, force: true });
  });

  it("rejects a sibling whose name is a prefix-coincidence of the root", () => {
    const rel = `../${path.basename(t.root)}-evil/file.pdf`;
    const r = resolveContainedInput(t.root, rel);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("path escapes root");
  });
});

describe("resolveContainedInput — symlink/junction/reparse", () => {
  it("rejects a symlinked file escaping root", (ctx) => {
    const t = tmp();
    const outside = t.write("outside.pdf", "%PDF");
    t.mkdir("input");
    const linkPath = t.join("input", "link.pdf");
    try {
      symlinkSync(outside, linkPath);
    } catch (e) {
      ctx.skip(`cannot create symlink (no SeCreateSymbolicLink privilege): ${(e as Error).message}`);
      return;
    }
    const r = resolveContainedInput(t.root, "input/link.pdf");
    expect(r.ok).toBe(false);
  });

  it("rejects a symlinked directory ancestor", (ctx) => {
    const t = tmp();
    const realDir = t.mkdir("real");
    t.write("real/inner.pdf", "%PDF");
    const linkDir = t.join("linkdir");
    try {
      symlinkSync(realDir, linkDir, "dir");
    } catch (e) {
      ctx.skip(`cannot create symlink: ${(e as Error).message}`);
      return;
    }
    const r = resolveContainedInput(t.root, "linkdir/inner.pdf");
    expect(r.ok).toBe(false);
  });

  it("rejects a junction escaping root (no privilege required on Windows)", (ctx) => {
    if (!isWindows()) {
      ctx.skip("junction requires Windows");
      return;
    }
    const t = tmp();
    const outsideDir = t.mkdir("outside-dir");
    t.write("outside-dir/secret.pdf", "%PDF");
    const junctionPath = t.join("junction");
    try {
      symlinkSync(outsideDir, junctionPath, "junction");
    } catch (e) {
      ctx.skip(`cannot create junction: ${(e as Error).message}`);
      return;
    }
    const r = resolveContainedInput(t.root, "junction/secret.pdf");
    expect(r.ok).toBe(false);
  });

  it("accepts a plain regular file (no reparse)", () => {
    const t = tmp();
    const f = t.write("input/a.pdf", "%PDF");
    expect(isRegularFileNoReparse(f)).toBe(true);
  });

  it("rejects a directory as a regular file", () => {
    const t = tmp();
    const d = t.mkdir("input");
    expect(isRegularFileNoReparse(d)).toBe(false);
  });
});
