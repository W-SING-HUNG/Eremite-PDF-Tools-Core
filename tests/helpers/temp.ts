/**
 * Unified temp-directory helper.
 *
 * Two helpers:
 *  - tmp(): registers afterEach auto-cleanup (for per-test dirs).
 *  - tmpScope(): NO auto-cleanup; caller uses afterAll (for describe-scoped
 *    dirs shared across multiple `it` blocks).
 *
 * A process-level safety net (cleanupAll) is wired via globalSetup teardown so
 * no residue survives even on abnormal exit. No `fc-test-*` residue.
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const PREFIX = "pdf-tools-core-test-";

/** Track every temp dir created in this process for safety-net cleanup. */
const created: string[] = [];

export interface TempDir {
  root: string;
  write(rel: string, content: string | Buffer): string;
  mkdir(rel: string): string;
  join(...parts: string[]): string;
  cleanup(): void;
}

function makeTempDir(): TempDir {
  const root = mkdtempSync(path.join(tmpdir(), PREFIX));
  created.push(root);
  const t: TempDir = {
    root,
    write(rel: string, content: string | Buffer): string {
      const abs = path.join(root, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      return abs;
    },
    mkdir(rel: string): string {
      const abs = path.join(root, rel);
      mkdirSync(abs, { recursive: true });
      return abs;
    },
    join(...parts: string[]): string {
      return path.join(root, ...parts);
    },
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    }
  };
  return t;
}

/** Per-test temp dir with automatic afterEach cleanup. */
export function tmp(): TempDir {
  const t = makeTempDir();
  afterEach(() => t.cleanup());
  return t;
}

/** Describe-scoped temp dir — NO auto-cleanup; caller must use afterAll. */
export function tmpScope(): TempDir {
  return makeTempDir();
}

/** Process-level safety net for abnormal exit. */
export function cleanupAll(): void {
  for (const dir of created) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

export function exists(p: string): boolean {
  return existsSync(p);
}
