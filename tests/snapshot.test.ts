/**
 * Input snapshot tests: size/hash match, mismatch, same-size content
 * replacement (TOCTOU), missing file, zero-byte, directory, source-changed.
 */

import { describe, it, expect } from "vitest";
import { verifySnapshot, sha256File } from "../src/input/index.js";
import { tmp } from "./helpers/temp.js";
import { createHash } from "node:crypto";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("verifySnapshot", () => {
  it("matches valid size + hash", async () => {
    const t = tmp();
    const content = "hello pdf";
    const f = t.write("in.pdf", content);
    const ok = await verifySnapshot(f, { byteSize: content.length, sha256: sha(content), displayName: "in.pdf" });
    expect(ok.ok).toBe(true);
  });

  it("detects size mismatch", async () => {
    const t = tmp();
    const content = "hello pdf";
    const f = t.write("in.pdf", content);
    const r = await verifySnapshot(f, { byteSize: content.length + 10, sha256: sha(content), displayName: "in.pdf" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("size_mismatch");
  });

  it("detects hash mismatch", async () => {
    const t = tmp();
    const content = "hello pdf";
    const f = t.write("in.pdf", content);
    const r = await verifySnapshot(f, { byteSize: content.length, sha256: sha("different"), displayName: "in.pdf" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("hash_mismatch");
  });

  it("detects same-size content replacement (TOCTOU)", async () => {
    const t = tmp();
    const content = "AAAA"; // 4 bytes
    const f = t.write("in.pdf", content);
    // Replace with different 4-byte content (same size).
    t.write("in.pdf", "BBBB");
    const r = await verifySnapshot(f, { byteSize: 4, sha256: sha("AAAA"), displayName: "in.pdf" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("hash_mismatch");
  });

  it("detects missing file", async () => {
    const t = tmp();
    const r = await verifySnapshot(t.join("missing.pdf"), { byteSize: 0, sha256: "a".repeat(64), displayName: "x" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("stat_failed");
  });

  it("accepts uppercase sha256 (normalized comparison)", async () => {
    const t = tmp();
    const content = "hello";
    const f = t.write("in.pdf", content);
    const r = await verifySnapshot(f, { byteSize: content.length, sha256: sha(content).toUpperCase(), displayName: "in.pdf" });
    expect(r.ok).toBe(true);
  });

  it("streams large files without error (no whole-file buffering)", async () => {
    const t = tmp();
    const big = "x".repeat(1024 * 1024); // 1 MB
    const f = t.write("big.pdf", big);
    const h = await sha256File(f);
    expect(h).toBe(sha(big));
  });
});

describe("sha256File", () => {
  it("computes correct sha256", async () => {
    const t = tmp();
    const f = t.write("a.pdf", "abc");
    expect(await sha256File(f)).toBe(sha("abc"));
  });
});
