/**
 * Operation planner: builds the exact qpdf argv for each frozen V1 operation.
 *
 * This is the ONLY place qpdf CLI syntax exists. Nothing here leaks into the
 * protocol layer, and no caller can inject arbitrary flags: every argv element
 * is either a literal qpdf flag chosen by this module, a Core-resolved absolute
 * path, or a page spec generated from 0-based protocol integers by pages.ts.
 *
 * Page numbers are converted 0-based -> 1-based here (engine boundary only).
 */

import { selectorToQpdfSpec, pagesToQpdfSpec } from "./pages.js";
import type { PageSelector } from "../protocol/types.js";

/** Discriminated plan per operation. argv is fully constructed; never mutated later. */
export type QpdfPlan =
  | { kind: "merge"; argv: string[]; outputPath: string }
  | { kind: "split"; argv: string[]; outputPattern: string; expectedCount: number }
  | { kind: "extract"; argv: string[]; outputPath: string }
  | { kind: "rotate"; argv: string[]; outputPath: string }
  | { kind: "reorder"; argv: string[]; outputPath: string };

/**
 * Frozen: deterministic output identity. qpdf is documented as NOT guaranteeing
 * byte-for-byte idempotency (document ID can vary). --deterministic-id improves
 * reproducibility within a pinned qpdf version; it must never be advertised as
 * a cross-run byte-identity guarantee (see P0 determinism contract).
 */
const DETERMINISTIC_ID = "--deterministic-id";

/**
 * merge: N inputs -> 1 output.
 *
 * Frozen semantics: an EMPTY document is the primary, so no document-level
 * information (outlines, page labels) is inherited from any single input.
 * Input order is preserved exactly.
 */
export function planMerge(inputPaths: string[], outputPath: string): QpdfPlan {
  return {
    kind: "merge",
    argv: [DETERMINISTIC_ID, "--empty", "--pages", ...inputPaths, "--", outputPath],
    outputPath
  };
}

/**
 * split: 1 input -> N outputs using ONE qpdf split operation.
 *
 * Frozen: only strategy {type:"every", n}. Never a loop of --pages.
 * `outputPattern` must contain a single printf `%d` (qpdf substitutes the
 * 1-based chunk index); Core later renames to deterministic `part-NNNN.pdf`.
 */
export function planSplit(
  inputPath: string,
  n: number,
  outputPattern: string,
  expectedCount: number
): QpdfPlan {
  return {
    kind: "split",
    argv: [DETERMINISTIC_ID, `--split-pages=${n}`, inputPath, outputPattern],
    outputPattern,
    expectedCount
  };
}

/**
 * extract: 1 input -> 1 output, selected pages only.
 *
 * Primary is the SOURCE document (not --empty), so document-level info is
 * preserved per the frozen preservation policy. Selector order, duplicates and
 * range semantics are preserved exactly (no sorting, no dedup).
 */
export function planExtract(
  inputPath: string,
  selector: PageSelector,
  outputPath: string
): QpdfPlan {
  return {
    kind: "extract",
    argv: [
      DETERMINISTIC_ID,
      inputPath,
      "--pages",
      ".",
      selectorToQpdfSpec(selector),
      "--",
      outputPath
    ],
    outputPath
  };
}

/**
 * rotate: 1 input -> 1 output. Only selected pages rotated; others untouched.
 *
 * angle is 90/180/270 (frozen; no 0, no arbitrary angles).
 * mode "relative" -> "+angle" (adds to any existing /Rotate).
 * mode "absolute" -> "angle" (sets /Rotate exactly).
 */
export function planRotate(
  inputPath: string,
  selector: PageSelector,
  angle: 90 | 180 | 270,
  mode: "relative" | "absolute",
  outputPath: string
): QpdfPlan {
  const angleToken = mode === "relative" ? `+${angle}` : `${angle}`;
  const spec = selectorToQpdfSpec(selector);
  return {
    kind: "rotate",
    argv: [DETERMINISTIC_ID, inputPath, outputPath, `--rotate=${angleToken}:${spec}`],
    outputPath
  };
}

/**
 * reorder: 1 input -> 1 output with an explicit page order.
 *
 * pageOrder is 0-based (frozen protocol). Duplicates are allowed; omission of
 * any source page is rejected upstream (deleting pages belongs to extract).
 * Primary is the SOURCE document, so document-level info is preserved.
 */
export function planReorder(
  inputPath: string,
  pageOrder: number[],
  outputPath: string
): QpdfPlan {
  return {
    kind: "reorder",
    argv: [
      DETERMINISTIC_ID,
      inputPath,
      "--pages",
      ".",
      pagesToQpdfSpec(pageOrder),
      "--",
      outputPath
    ],
    outputPath
  };
}
