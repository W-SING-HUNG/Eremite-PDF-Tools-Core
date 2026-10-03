/**
 * CLI integration tests: exit-code semantics + public diagnostics hygiene.
 *
 * Business failure -> exit 0 + canonical failed response.
 * Protocol/crash failure -> non-zero exit.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmp } from "./helpers/temp.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, "..", "dist", "cli", "cli.js");
const NODE = process.execPath; // current node (must be >=24 in CI)

const UUID_V7 = "0189c68d-7b3a-7f2c-9d1e-123456789abc";

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function runCli(args: string[]): { code: number; stderr: string } {
  try {
    execFileSync(NODE, [CLI_PATH, ...args], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf-8" });
    return { code: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { code: err.status ?? 1, stderr: err.stderr ?? "" };
  }
}

describe("CLI — business failure (exit 0)", () => {
  it("returns exit 0 + failed response for malformed input (structural gate)", () => {
    const t = tmp();
    const content = "%PDF-1.4 test";
    t.write("input/in-0000.pdf", content);
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.merge",
      workspace: { rootPath: t.root },
      inputs: [
        { id: "in-0", relativePath: "input/in-0000.pdf", snapshot: { byteSize: content.length, sha256: sha(content), displayName: "in.pdf" } }
      ]
    };
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");
    // write request file

    writeFileSync(reqPath, JSON.stringify(req));

    const { code } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).toBe(0);

    const resp = JSON.parse(readFileSync(respPath, "utf-8"));
    expect(resp.status).toBe("failed");
    // P2: a malformed input is now rejected by the V1 structural gate
    // (encrypted/malformed/recoverable -> fail) rather than reaching an engine.
    expect(resp.error.code).toBe("pdf_validation.malformed");
    expect(resp.invocationId).toBe(UUID_V7);
  });

  it("returns exit 0 + failed response for snapshot mismatch", () => {
    const t = tmp();
    const content = "%PDF-1.4 test";
    t.write("input/in-0000.pdf", content);
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.extract",
      workspace: { rootPath: t.root },
      inputs: [
        { id: "in-0", relativePath: "input/in-0000.pdf", snapshot: { byteSize: content.length + 99, sha256: sha(content), displayName: "in.pdf" } }
      ],
      parameters: { pageSelector: { mode: "pages", pages: [0] } }
    };
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");

    writeFileSync(reqPath, JSON.stringify(req));

    const { code } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).toBe(0);
    const resp = JSON.parse(readFileSync(respPath, "utf-8"));
    expect(resp.error.code).toBe("input.snapshot_mismatch");
  });

  it("returns exit 0 for unknown operation (business failure)", () => {
    const t = tmp();
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.nope",
      workspace: { rootPath: t.root },
      inputs: [
        { id: "in-0", relativePath: "input/x.pdf", snapshot: { byteSize: 1, sha256: "a".repeat(64), displayName: "x" } }
      ]
    };
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");

    writeFileSync(reqPath, JSON.stringify(req));

    const { code } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).toBe(0);
    const resp = JSON.parse(readFileSync(respPath, "utf-8"));
    expect(resp.error.code).toBe("request.unknown_operation");
  });
});

describe("CLI — protocol failure (non-zero exit)", () => {
  it("exits non-zero for malformed JSON", () => {
    const t = tmp();
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");

    writeFileSync(reqPath, "{ not valid json");

    const { code } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).not.toBe(0);
    // No response file written on protocol failure.
    expect(existsSync(respPath)).toBe(false);
  });

  it("exits non-zero for unsupported protocol version", () => {
    const t = tmp();
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");

    writeFileSync(reqPath, "{}");

    const { code } = runCli(["--protocol", "2", "--request", reqPath, "--response", respPath]);
    expect(code).not.toBe(0);
  });

  it("exits non-zero for missing request file", () => {
    const t = tmp();
    const { code } = runCli(["--protocol", "1", "--request", t.join("nope.json"), "--response", t.join("r.json")]);
    expect(code).not.toBe(0);
  });

  it("exits non-zero for unknown CLI args", () => {
    const { code } = runCli(["--bogus"]);
    expect(code).not.toBe(0);
  });
});

describe("CLI — public diagnostics hygiene", () => {
  it("response JSON never leaks absolute paths / stack / stderr / command / env", () => {
    const t = tmp();
    const content = "%PDF";
    t.write("input/in.pdf", content);
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.merge",
      workspace: { rootPath: t.root },
      inputs: [
        { id: "in-0", relativePath: "input/in.pdf", snapshot: { byteSize: content.length, sha256: sha(content), displayName: "in.pdf" } }
      ]
    };
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");

    writeFileSync(reqPath, JSON.stringify(req));

    const { code } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).toBe(0);
    const raw = readFileSync(respPath, "utf-8");
    const lower = raw.toLowerCase();
    // No absolute path (the workspace root must not appear).
    expect(raw).not.toContain(t.root);
    expect(lower).not.toContain("stack");
    expect(lower).not.toContain("stderr");
    expect(lower).not.toContain("command");
    expect(lower).not.toContain("process.env");
    expect(lower).not.toContain("\\users\\");
    // The parsed object has no forbidden keys.
    const parsed = JSON.parse(raw);
    expect(parsed).not.toHaveProperty("stack");
    expect(parsed).not.toHaveProperty("message");
    expect(parsed.error).not.toHaveProperty("detail");
  });
});

describe("CLI — request/response isolation", () => {
  it("response-shaped object → exit 0 + controlled failure (no crash)", () => {
    const t = tmp();
    const respShaped = {
      kind: "pdf.tools.response",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.merge",
      status: "succeeded",
      outputs: [{ id: "o", displayName: "x", byteSize: 1, sha256: "a".repeat(64), pageCount: 1, relativePath: "output/x.pdf" }],
      provenance: { coreVersion: "0.1.0", protocolVersion: 1, operation: "pdf.merge" },
      warnings: []
    };
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");
    writeFileSync(reqPath, JSON.stringify(respShaped));

    const { code, stderr } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).toBe(0);
    // No crash: stderr must be clean (no stack / file URL / source line).
    expect(stderr).not.toContain("file:///");
    expect(stderr).not.toContain("at ");
    expect(stderr.toLowerCase()).not.toContain("stack");
    const out = JSON.parse(readFileSync(respPath, "utf-8"));
    expect(out.status).toBe("failed");
  });
});

describe("CLI — UUID wrong-variant regression", () => {
  it("NCS-variant UUID → request.invalid_uuid (not not_implemented)", () => {
    const t = tmp();
    const content = "%PDF";
    t.write("input/in.pdf", content);
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: "00000000-0000-4000-0000-000000000000", // version 4, NCS variant 0
      operation: "pdf.merge",
      workspace: { rootPath: t.root },
      inputs: [
        { id: "in-0", relativePath: "input/in.pdf", snapshot: { byteSize: content.length, sha256: sha(content), displayName: "in.pdf" } }
      ]
    };
    const reqPath = t.join("request.json");
    const respPath = t.join("response.json");
    writeFileSync(reqPath, JSON.stringify(req));

    const { code } = runCli(["--protocol", "1", "--request", reqPath, "--response", respPath]);
    expect(code).toBe(0);
    const resp = JSON.parse(readFileSync(respPath, "utf-8"));
    expect(resp.error.code).toBe("request.invalid_uuid");
  });
});

describe("CLI — crash boundary hygiene", () => {
  it("unwritable response path → non-zero exit, no stack/absolute path leak", () => {
    const t = tmp();
    const content = "%PDF";
    t.write("input/in.pdf", content);
    const req = {
      kind: "pdf.tools.request",
      protocolVersion: 1,
      invocationId: UUID_V7,
      operation: "pdf.merge",
      workspace: { rootPath: t.root },
      inputs: [
        { id: "in-0", relativePath: "input/in.pdf", snapshot: { byteSize: content.length, sha256: sha(content), displayName: "in.pdf" } }
      ]
    };
    const reqPath = t.join("request.json");
    const respDir = t.mkdir("response-dir"); // a directory, not a writable file

    writeFileSync(reqPath, JSON.stringify(req));

    const { code, stderr } = runCli(["--protocol", "1", "--request", reqPath, "--response", respDir]);
    expect(code).not.toBe(0);
    // Public hygiene: generic message, no stack, no absolute path, no file URL.
    expect(stderr).not.toContain("file:///");
    expect(stderr).not.toContain("at ");
    expect(stderr).not.toContain(t.root);
    expect(stderr.toLowerCase()).not.toContain("stack");
  });
});
