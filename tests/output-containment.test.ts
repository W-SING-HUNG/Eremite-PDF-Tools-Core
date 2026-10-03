import { describe, it, expect, vi } from "vitest";
import { copyFileSync, readFileSync, readdirSync, existsSync, symlinkSync, realpathSync, rmdirSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { executeRequest } from "../src/core/index.js";
import { validateRequest } from "../src/protocol/validator.js";
import { CORE_VERSION } from "../src/protocol/response.js";
import * as engineSpawn from "../src/engine/spawn.js";
import type { Request, Response } from "../src/protocol/types.js";
import { tmp } from "./helpers/temp.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

function setup(operation: "pdf.merge" | "pdf.split" = "pdf.merge") {
  const t = tmp();
  const workspace = t.mkdir("workspace");
  t.mkdir("workspace/inputs");
  const inputs = ["alpha-multi.pdf", "alpha-multi-b.pdf"].map((name, i) => {
    const dest = join(workspace, "inputs", name);
    copyFileSync(join(ROOT, "tests/fixtures", name), dest);
    return { id: `in-${i}`, relativePath: `inputs/${name}`, snapshot: {
      byteSize: readFileSync(dest).length, sha256: hash(dest), displayName: name
    } };
  });

  const request: Request = {
    kind: "pdf.tools.request", protocolVersion: 1, invocationId: randomUUID(),
    operation, workspace: { rootPath: workspace }, inputs: operation === "pdf.split" ? [inputs[0]!] : inputs,
    ...(operation === "pdf.split" ? { parameters: { strategy: { type: "every" as const, n: 2 } } } : {})
  };
  return { t, workspace, inputs, request };
}

describe("generated output containment — exact rc3 directory-junction regression", () => {
  it("rechecks output at publish time and cleans the generated staging file on rejection", async () => {
    const { t, workspace, inputs, request } = setup();
    const outside = t.mkdir("outside");
    const original = engineSpawn.runProcess;
    let swapped = false;
    const spy = vi.spyOn(engineSpawn, "runProcess").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].includes("--empty")) {
        expect(existsSync(join(workspace, "staging/merge.pdf"))).toBe(true);
        rmdirSync(join(workspace, "output"));
        symlinkSync(outside, join(workspace, "output"), "junction");
        swapped = true;
      }
      return result;
    });
    try {
      const { response } = await executeRequest(request);
      expect(swapped).toBe(true);
      expect(response.status).toBe("failed");
      if (response.status === "failed") expect(response.error.code).toBe("workspace.escape");
      expect(response).not.toHaveProperty("outputs");
      expect(readdirSync(outside)).toEqual([]);
      expect(readdirSync(join(workspace, "staging"))).toEqual([]);
      for (const input of inputs) expect(hash(join(workspace, input.relativePath))).toBe(input.snapshot.sha256);
    } finally {
      spy.mockRestore();
    }
    t.cleanup();
    expect(existsSync(t.root)).toBe(false);
  });
  it.each([
    ["output", "pdf.merge"], ["output", "pdf.split"],
    ["staging", "pdf.merge"], ["staging", "pdf.split"]
  ] as const)("rejects %s junction before %s writes any output", async (directory, operation) => {
    const { t, workspace, inputs, request } = setup(operation);
    const outside = t.mkdir("outside");
    symlinkSync(outside, join(workspace, directory), "junction");
    expect(validateRequest(request).ok).toBe(true);

    const { response } = await executeRequest(request);
    expect(response.status).toBe("failed");
    if (response.status === "failed") {
      expect(response.error).toEqual({ code: "workspace.escape", stage: "workspace", retryable: false });
      expect(response).not.toHaveProperty("outputs");
    }
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, "merge.pdf"))).toBe(false);
    for (const input of inputs) expect(hash(join(workspace, input.relativePath))).toBe(input.snapshot.sha256);
    for (const dir of ["work", "staging", "output"]) {
      const abs = join(workspace, dir);
      if (existsSync(abs)) expect(readdirSync(abs)).toEqual([]);
    }
    t.cleanup();
    expect(existsSync(t.root)).toBe(false);
  });

  it("keeps workspace/output normal and package/runtime/real CLI response identity aligned", () => {
    const { t, workspace, inputs, request } = setup();
    const requestFile = t.write("request.json", JSON.stringify(request));
    const responseFile = t.join("response.json");
    const cli = spawnSync(process.execPath, [join(ROOT, "dist/cli/cli.js"), "--protocol", "1", "--request", requestFile, "--response", responseFile], {
      encoding: "utf8", windowsHide: true
    });
    expect(cli.status, cli.stderr).toBe(0);
    const response = JSON.parse(readFileSync(responseFile, "utf8")) as Response;
    expect(response.status).toBe("succeeded");
    if (response.status !== "succeeded") throw new Error("normal merge failed");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.version).toBe("1.0.0-rc5");
    expect(pkg.version).toBe(CORE_VERSION);
    expect(response.provenance.coreVersion).toBe(pkg.version);
    expect(response.outputs).toHaveLength(1);
    expect(response.outputs[0]!.relativePath).toBe("output/merge.pdf");
    const output = realpathSync(join(workspace, response.outputs[0]!.relativePath));
    const rel = relative(realpathSync(join(workspace, "output")), output);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);
    expect(response.outputs[0]!.pageCount).toBe(8);
    expect(hash(output)).toBe(response.outputs[0]!.sha256);
    expect(readdirSync(join(workspace, "staging"))).toEqual([]);
    for (const input of inputs) expect(hash(join(workspace, input.relativePath))).toBe(input.snapshot.sha256);
    t.cleanup();
    expect(existsSync(t.root)).toBe(false);
  });
});
