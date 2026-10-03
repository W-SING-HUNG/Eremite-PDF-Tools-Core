/**
 * Output verification helpers — never trust a zero exit code alone.
 *
 * Every produced output is re-verified by Core: regular file, contained,
 * non-reparse, structurally valid PDF, and expected page count. Rotation is
 * verified by actually reading the output's per-page /Rotate values rather
 * than trusting that the command ran.
 */

import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import { runProcess, DEFAULT_STDERR_MAX_BYTES, DEFAULT_STDOUT_MAX_BYTES } from "./spawn.js";
import { isRegularFileNoReparse } from "../workspace/containment.js";

export interface OutputFacts {
  byteSize: number;
  sha256: string;
  pageCount: number;
}

function sha256File(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/** Read the page count of an output using qpdf (authoritative, not a guess). */
export async function readPageCount(
  exe: string,
  absPath: string,
  timeoutMs: number
): Promise<number | null> {
  const res = await runProcess(exe, ["--show-npages", absPath], {
    timeoutMs,
    stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
  });
  if (res.timedOut || res.exitCode !== 0) return null;
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Per-page /Rotate values from the output, read via qpdf --json.
 * Used by rotate to prove the actual result, not just exit 0.
 */
export async function readPageRotations(
  exe: string,
  absPath: string,
  timeoutMs: number
): Promise<number[] | null> {
  // NOTE: `--json` alone prints the document model to stdout. Combining it with
  // `--show-npages` is rejected by qpdf ("no output file may be given for this
  // option"), so only `--json` is used here. The model includes per-page /Rotate.
  const res = await runProcess(exe, ["--json", absPath], {
    timeoutMs,
    stdoutMaxBytes: 8 * 1024 * 1024,
    stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
  });
  if (res.timedOut || res.exitCode !== 0) return null;
  return parseRotationsFromJson(res.stdout);
}

/**
 * Extract per-page rotate values from qpdf --json output.
 *
 * qpdf 12.4.0 layout: the structured `pages[i]` objects do NOT carry the page
 * dictionary's /Rotate. Instead the raw object dictionaries are dumped in
 * `obj:N R` entries (location varies by qpdf internals — e.g. nested under a
 * `qpdf` section), and `pages[i].object` holds the object reference (e.g.
 * "3 0 R") that maps into them. The rotation lives at `obj:<id>.value["/Rotate"]`
 * (omitted when 0). We collect every `obj:N R` value dict in a single tree walk
 * (robust to where qpdf nests them) and resolve each page through `object`. A
 * direct `pages[i]["/Rotate"]` probe is kept first as a future-proofing hedge.
 */
export function parseRotationsFromJson(json: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  const pages = root["pages"];
  if (!Array.isArray(pages)) return null;

  // Single pass: every "obj:N R" -> its value dict. Object IDs are unique, so
  // this is an O(objects) lookup table regardless of where qpdf nests them.
  const objValues = new Map<string, Record<string, unknown>>();
  collectObjValues(root, objValues);

  const out: number[] = [];
  for (const p of pages) {
    if (typeof p !== "object" || p === null) return null;
    const page = p as Record<string, unknown>;
    const rotate = extractPageRotation(page, objValues);
    out.push(rotate === null ? 0 : rotate);
  }
  return out;
}

/** Recursively collect all `obj:N R` value dicts into the map. */
function collectObjValues(node: unknown, out: Map<string, Record<string, unknown>>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const c of node) collectObjValues(c, out);
    return;
  }
  for (const k of Object.keys(node)) {
    // qpdf object-dump entries look like "obj:3 0 R" (key has a space).
    if (k.startsWith("obj:") && k.includes(" ")) {
      const v = (node as Record<string, unknown>)[k];
      if (v && typeof v === "object" && "value" in (v as object)) {
        const value = (v as Record<string, unknown>)["value"];
        if (value && typeof value === "object") {
          out.set(k, value as Record<string, unknown>);
        }
      }
    }
    collectObjValues((node as Record<string, unknown>)[k], out);
  }
}

/** Resolve a single page's rotation (0/90/180/270), or null when unreadable. */
function extractPageRotation(
  page: Record<string, unknown>,
  objValues: Map<string, Record<string, unknown>>
): number | null {
  // 1) Direct probe (future-proof against qpdf format changes).
  const direct = page["/Rotate"];
  if (typeof direct === "number") return normalizeRotation(direct);

  // 2) qpdf object-dump mapping: pages[i].object -> "obj:<id>".value.
  const objId = typeof page["object"] === "string" ? page["object"] : "";
  if (objId) {
    const value = objValues.get(`obj:${objId}`);
    if (value) {
      const r = value["/Rotate"];
      if (typeof r === "number") return normalizeRotation(r);
    }
  }
  return null;
}

/** Normalize a /Rotate value into [0,360). */
export function normalizeRotation(deg: number): number {
  const m = ((deg % 360) + 360) % 360;
  return m;
}

/**
 * Verify a produced output file: regular, non-reparse, non-empty, structurally
 * valid PDF, and matching the expected page count.
 */
export async function verifyOutput(
  exe: string,
  absPath: string,
  expectedPageCount: number,
  timeoutMs: number
): Promise<{ ok: true; facts: OutputFacts } | { ok: false; reason: string }> {
  if (!isRegularFileNoReparse(absPath)) {
    return { ok: false, reason: "output not a regular non-reparse file" };
  }
  let size: number;
  try {
    size = statSync(absPath).size;
  } catch {
    return { ok: false, reason: "output stat failed" };
  }
  if (size <= 0) return { ok: false, reason: "output empty" };

  // Structural validity of the OUTPUT (re-check, not just exit code).
  const check = await runProcess(exe, ["--check", absPath], {
    timeoutMs,
    stdoutMaxBytes: DEFAULT_STDOUT_MAX_BYTES,
    stderrMaxBytes: DEFAULT_STDERR_MAX_BYTES
  });
  if (check.timedOut) return { ok: false, reason: "output check timed out" };
  if (check.exitCode !== 0) return { ok: false, reason: "output failed structural check" };

  const pageCount = await readPageCount(exe, absPath, timeoutMs);
  if (pageCount === null) return { ok: false, reason: "output page count unreadable" };
  if (pageCount !== expectedPageCount) {
    return { ok: false, reason: `output page count ${pageCount} != expected ${expectedPageCount}` };
  }

  let sha256: string;
  try {
    sha256 = await sha256File(absPath);
  } catch {
    return { ok: false, reason: "output hash failed" };
  }

  return { ok: true, facts: { byteSize: size, sha256, pageCount } };
}
