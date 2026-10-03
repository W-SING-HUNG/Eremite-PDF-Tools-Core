import { afterEach, describe, expect, it, vi } from "vitest";
import { delimiter, dirname, join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveQpdfExecutable, verifyQpdfVersion } from "../src/engine/runtime.js";
import * as engineSpawn from "../src/engine/spawn.js";
import { executeRequest } from "../src/core/index.js";
import { tmp } from "./helpers/temp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function request() {
  const t = tmp();
  const content = Buffer.from("input unchanged on dependency rejection");
  t.write("inputs/a.pdf", content);
  return { t, req: {
    kind: "pdf.tools.request" as const, protocolVersion: 1 as const, invocationId: randomUUID(),
    operation: "pdf.merge" as const, workspace: { rootPath: t.root },
    inputs: [{ id: "a", relativePath: "inputs/a.pdf", snapshot: {
      byteSize: content.length, sha256: createHash("sha256").update(content).digest("hex"), displayName: "a.pdf"
    } }]
  } };
}

describe("external qpdf prerequisite", () => {
  it("resolves only absolute PATH entries, respecting their order", () => {
    const t = tmp();
    const first = t.mkdir("first"), second = t.mkdir("second");
    const name = process.platform === "win32" ? "qpdf.exe" : "qpdf";
    t.write("first/" + name, "resolver fixture");t.write("second/" + name, "resolver fixture");
    vi.stubEnv("PATH", ["", ".", '"' + first + '"', second].join(delimiter));
    expect(resolveQpdfExecutable()).toBe(realpathSync(join(first, name)));
    vi.stubEnv("PATH", "");
    expect(resolveQpdfExecutable()).toBeNull();
  });

  it.each(["12.3.2", "12.4.1", "12.4.0-rc1", "12.4.0.1"])("rejects reported version %s before any transform", async version => {
    const { t, req } = request();
    const name = process.platform === "win32" ? "qpdf.exe" : "qpdf";
    t.write("bin/" + name, "resolver fixture");
    vi.stubEnv("PATH", t.join("bin"));
    const spy = vi.spyOn(engineSpawn, "runProcess").mockResolvedValue({
      exitCode: 0, signal: null, stdout: "qpdf version " + version + "\n", stderr: "",
      timedOut: false, stdoutTruncated: false, stderrTruncated: false
    });
    const { response } = await executeRequest(req);
    expect(response.status).toBe("failed");
    if (response.status === "failed") expect(response.error).toEqual({ code: "engine.not_found", stage: "engine", retryable: false });
    expect(response).not.toHaveProperty("outputs");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual(["--version"]);
    expect(readFileSync(t.join("inputs/a.pdf"), "utf8")).toBe("input unchanged on dependency rejection");
  });

  it("missing PATH qpdf is a canonical CLI dependency failure with no vendor fallback", () => {
    const { t, req } = request();
    const reqFile = t.write("request.json", JSON.stringify(req)), respFile = t.join("response.json");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"));
    env["PATH"] = "";
    const r = spawnSync(process.execPath, [join(ROOT, "dist/cli/cli.js"), "--protocol", "1", "--request", reqFile, "--response", respFile], {
      env, encoding: "utf8", windowsHide: true
    });
    expect(r.status, r.stderr).toBe(0);
    const response = JSON.parse(readFileSync(respFile, "utf8"));
    expect(response.status).toBe("failed");
    expect(response.error).toEqual({ code: "engine.not_found", stage: "engine", retryable: false });
    expect(response).not.toHaveProperty("outputs");
  });

  it("does not accept a failed version process that happens to print 12.4.0", async () => {
    vi.spyOn(engineSpawn, "runProcess").mockResolvedValue({
      exitCode: 1, signal: null, stdout: "qpdf version 12.4.0\n", stderr: "",
      timedOut: false, stdoutTruncated: false, stderrTruncated: false
    });
    expect(await verifyQpdfVersion(1000, process.execPath)).not.toBeNull();
  });
});
