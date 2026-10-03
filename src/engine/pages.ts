/**
 * Page index conversion — ENGINE BOUNDARY ONLY.
 *
 * The public Supplier Protocol is frozen 0-based. qpdf's CLI is 1-based. This
 * module is the ONLY place where that conversion is allowed to happen.
 * Nothing in protocol/, cli/, or the wire contract may see a 1-based index.
 *
 * qpdf page range syntax (1-based, inclusive, comma-separated):
 *   "1"        single page
 *   "1-3"      inclusive run
 *   "3-1"      descending run (reversed)
 *   "1,4,2"    explicit order, duplicates allowed
 */

import type { PageSelector, PageRange } from "../protocol/types.js";

/**
 * Compress an ordered 0-based page list into a 1-based qpdf page spec.
 *
 * Consecutive ascending runs are compressed to "a-b" to keep argv bounded
 * (critical for large documents — an expanded 100k-page list would blow the
 * Windows argv limit). Order and duplicates are preserved exactly.
 *
 * @param pages0 0-based page indices, in output order, duplicates allowed.
 * @returns 1-based qpdf page spec string.
 */
export function pagesToQpdfSpec(pages0: number[]): string {
  if (pages0.length === 0) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < pages0.length) {
    const start = pages0[i]!;
    let end = start;
    // Extend the ascending run while consecutive.
    while (i + 1 < pages0.length && pages0[i + 1] === end + 1) {
      end = pages0[i + 1]!;
      i++;
    }
    if (end === start) {
      parts.push(String(start + 1));
    } else {
      parts.push(`${start + 1}-${end + 1}`);
    }
    i++;
  }
  return parts.join(",");
}

/**
 * Expand a PageSelector (0-based, frozen protocol form) into an ordered
 * 0-based page index list. Order, duplicates and range semantics preserved.
 */
export function expandPageSelector(selector: PageSelector): number[] {
  if (selector.mode === "pages") {
    return selector.pages.slice();
  }
  const out: number[] = [];
  for (const r of selector.ranges) {
    for (let p = r.start; p <= r.end; p++) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Convert a frozen 0-based PageSelector into a 1-based qpdf page spec.
 * This is the single public entry used by the operation planner.
 */
export function selectorToQpdfSpec(selector: PageSelector): string {
  if (selector.mode === "ranges") {
    // Ranges map directly to qpdf range syntax (1-based, inclusive).
    const parts: string[] = [];
    for (const r of selector.ranges as PageRange[]) {
      parts.push(r.start === r.end ? `${r.start + 1}` : `${r.start + 1}-${r.end + 1}`);
    }
    return parts.join(",");
  }
  return pagesToQpdfSpec(selector.pages);
}

/**
 * qpdf page count is 1-based-oriented; a document with N pages has valid
 * 0-based indices 0..N-1. Used for out-of-range validation.
 */
export function isValidZeroBasedIndex(page0: number, pageCount: number): boolean {
  return Number.isSafeInteger(page0) && page0 >= 0 && page0 < pageCount;
}
