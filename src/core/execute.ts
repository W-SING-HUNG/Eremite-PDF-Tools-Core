/**
 * Core orchestration: request -> input gate -> engine -> canonical response.
 *
 * This is the frozen Supplier Protocol wiring. It never invents public error or
 * warning codes; every failure maps onto the P1 closed taxonomy, and the
 * public wire carries only { code, stage, retryable } (errors) or { code }
 * (warnings). Internal detail (stderr, command, absolute paths, stack) is
 * dropped at this boundary.
 */

import { mkdirSync, existsSync, statSync, rmSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import {
  validateWorkspaceRoot,
  resolveContainedInput,
  resolveContainedTarget,
  isRegularFileNoReparse
} from "../workspace/index.js";
import { verifySnapshot } from "../input/index.js";
import { structuralGate, gateReasonToErrorCode } from "../engine/gate.js";
import {
  resolveQpdfExecutable,
  verifyQpdfVersion
} from "../engine/runtime.js";
import {
  executeMerge,
  executeExtract,
  executeRotate,
  executeReorder,
  executeSplit,
  type EngineContext,
  type ResolvedInput
} from "../engine/operations.js";
import {
  buildSuccess,
  buildFailure,
  buildErrorEnvelope,
  serializeResponse
} from "../protocol/response.js";
import type {
  Request,
  Output,
  WarningEnvelope,
  SuccessResponse,
  FailureResponse,
  SplitParameters,
  ExtractParameters,
  RotateParameters,
  ReorderParameters,
  Limits
} from "../protocol/types.js";
import type { ErrorCode, Stage, Operation, WarningCode } from "../taxonomy/index.js";
import {
  checkInputLimits,
  checkOutputLimits,
  measureWorkspaceBytes,
  type InputFacts,
  type OutputFacts
} from "../limits/enforce.js";

/** Default resource policy when the request omits limits. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_FILES = 1000;

interface EngineResult {
  response: SuccessResponse | FailureResponse;
  /** Internal-only diagnostics (never serialized). */
  diagnostics: string[];
}

function failResponse(
  invocationId: string,
  operation: Operation,
  code: ErrorCode,
  stage: Stage
): FailureResponse {
  return buildFailure(invocationId, operation, buildErrorEnvelope(code, stage));
}

/**
 * Remove the outputs published by THIS invocation, so a limit failure can never
 * leave files behind that a Host could mistake for a partial success.
 *
 * Containment-guarded: a produced relative path that escapes the workspace root
 * is ignored. It can never legitimately occur (Core generates these paths), so
 * this is defence in depth rather than a reachable branch.
 */
function rollbackOutputs(rootPath: string, outputs: { relativePath: string }[]): void {
  for (const o of outputs) {
    const target = resolveContainedTarget(rootPath, o.relativePath, "output");
    if (!target.ok) continue;
    try {
      rmSync(target.value, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Best-effort removal of any staging artifacts left by this invocation. */
function rollbackStagingArtifacts(rootPath: string, stagingDir: string): void {
  if (!resolveContainedTarget(rootPath, "staging", "staging").ok) return;
  let entries: string[];
  try {
    entries = readdirSync(stagingDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".pdf")) continue;
    const target = resolveContainedTarget(rootPath, relative(rootPath, join(stagingDir, name)), "staging");
    if (!target.ok) continue;
    try {
      rmSync(target.value, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Execute a fully-validated Supplier Protocol v1 request against the pinned
 * qpdf engine. Returns the canonical response plus internal diagnostics.
 */
export async function executeRequest(req: Request): Promise<EngineResult> {
  const diagnostics: string[] = [];
  const { invocationId, operation } = req;

  // 1. Workspace root.
  const root = validateWorkspaceRoot(req.workspace.rootPath);
  if (!root.ok) {
    return { response: failResponse(invocationId, operation, "workspace.invalid_root", "workspace"), diagnostics };
  }
  const rootPath = root.value;

  // 2. Host-owned invocation sub-workspaces (Core-managed only).
  const workDir = join(rootPath, "work");
  const stagingDir = join(rootPath, "staging");
  const outputDir = join(rootPath, "output");
  // Validate every existing/missing directory before creating any of them.
  for (const name of ["work", "staging", "output"] as const) {
    if (!resolveContainedTarget(rootPath, name, name).ok) {
      return { response: failResponse(invocationId, operation, "workspace.escape", "workspace"), diagnostics };
    }
  }
  for (const name of ["work", "staging", "output"] as const) {
    try {
      const target = resolveContainedTarget(rootPath, name, name);
      if (!target.ok) {
        return { response: failResponse(invocationId, operation, "workspace.escape", "workspace"), diagnostics };
      }
      if (!existsSync(target.value)) mkdirSync(target.value);
      if (!resolveContainedTarget(rootPath, name, name).ok || !statSync(target.value).isDirectory()) {
        return { response: failResponse(invocationId, operation, "workspace.escape", "workspace"), diagnostics };
      }
    } catch {
      return { response: failResponse(invocationId, operation, "workspace.invalid_root", "workspace"), diagnostics };
    }
  }

  // 3. External dependency gate. Resolve once, verify, then retain this executable.
  const gateExe = resolveQpdfExecutable();
  if (gateExe === null) {
    return { response: failResponse(invocationId, operation, "engine.not_found", "engine"), diagnostics };
  }
  const runtimeReason = await verifyQpdfVersion(DEFAULT_TIMEOUT_MS, gateExe);
  if (runtimeReason !== null) {
    diagnostics.push(`runtime prerequisite: ${runtimeReason}`);
    return { response: failResponse(invocationId, operation, "engine.not_found", "engine"), diagnostics };
  }

  // 4. Resolve + re-verify each input, then run the V1 structural gate.
  const inputs: ResolvedInput[] = [];
  for (const input of req.inputs) {
    const resolved = resolveContainedInput(rootPath, input.relativePath);
    if (!resolved.ok) {
      return { response: failResponse(invocationId, operation, "input.escape", "input"), diagnostics };
    }
    if (!isRegularFileNoReparse(resolved.value)) {
      return { response: failResponse(invocationId, operation, "input.not_regular_file", "input"), diagnostics };
    }
    // Double-ended snapshot re-verification.
    const snap = await verifySnapshot(resolved.value, {
      byteSize: input.snapshot.byteSize,
      sha256: input.snapshot.sha256,
      displayName: ""
    });
    if (!snap.ok) {
      diagnostics.push(`snapshot mismatch for ${input.id}: ${snap.reason}`);
      return { response: failResponse(invocationId, operation, "input.snapshot_mismatch", "input"), diagnostics };
    }
    // V1 structural gate (encrypted/malformed/recoverable -> fail, no repair).
    const gate = await structuralGate(gateExe, resolved.value, { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (!gate.ok) {
      const code = gateReasonToErrorCode(gate.reason);
      diagnostics.push(`gate ${input.id}: ${gate.reason}`);
      // Gate stage must reflect a pdf_validation failure (not "input").
      const stage: Stage = code.startsWith("pdf_validation") ? "pdf_validation" : code === "timeout.engine" ? "timeout" : "engine";
      return { response: failResponse(invocationId, operation, code, stage), diagnostics };
    }
    inputs.push({
      id: input.id,
      absolutePath: resolved.value,
      relativePath: input.relativePath,
      pageCount: gate.pageCount
    });
  }

  // 5. Limits policy.
  const limits: Limits = {
    maxInputFiles: 0,
    maxInputBytesPerFile: 0,
    maxTotalInputBytes: 0,
    maxOutputFiles: DEFAULT_MAX_OUTPUT_FILES,
    maxOutputBytesPerFile: 0,
    maxTotalOutputBytes: 0,
    maxPagesPerInput: 0,
    maxTotalPages: 0,
    maxWorkspaceBytes: 0,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ...(req.limits ?? {})
  };
  const maxOutputFiles = limits.maxOutputFiles > 0 ? limits.maxOutputFiles : DEFAULT_MAX_OUTPUT_FILES;
  const timeoutMs = limits.timeoutMs > 0 ? limits.timeoutMs : DEFAULT_TIMEOUT_MS;

  const ctx: EngineContext = {
    workspaceRoot: rootPath,
    exe: gateExe,
    timeoutMs,
    stagingDir,
    outputDir,
    maxOutputFiles
  };

  const coreDirs = [workDir, stagingDir, outputDir];

  // 5b. Input-side limit enforcement (REAL, preflight).
  //
  // Placed here deliberately: real page counts only exist after the structural
  // gate (step 4), and every check must run BEFORE any qpdf transform is
  // spawned. A limit <= 0 means "no policy limit" (Core default), so omitting
  // `limits` preserves the P1-P4 behavior exactly.
  const inputFacts: InputFacts[] = inputs.map((i) => {
    let byteSize = 0;
    try {
      byteSize = statSync(i.absolutePath).size;
    } catch {
      byteSize = Number.MAX_SAFE_INTEGER;
    }
    return { id: i.id, byteSize, pageCount: i.pageCount };
  });
  const inputViolation = checkInputLimits(inputFacts, limits);
  if (inputViolation !== null) {
    diagnostics.push(`input limit: ${inputViolation.detail}`);
    return {
      response: failResponse(invocationId, operation, inputViolation.code, inputViolation.stage),
      diagnostics
    };
  }

  // 5c. Workspace budget preflight over the Core-managed directories.
  if (limits.maxWorkspaceBytes > 0) {
    const used = measureWorkspaceBytes(coreDirs);
    if (used > limits.maxWorkspaceBytes) {
      diagnostics.push(
        `workspace preflight: ${used} bytes exceeds maxWorkspaceBytes=${limits.maxWorkspaceBytes}`
      );
      return {
        response: failResponse(invocationId, operation, "resource.max_workspace_bytes", "resource"),
        diagnostics
      };
    }
  }

  // 6. Dispatch.
  const outcome = await dispatch(operation, req, inputs, ctx);

  // 7. Map engine outcome -> canonical response.
  if (!outcome.ok) {
    rollbackStagingArtifacts(rootPath, stagingDir);
    return { response: failResponse(invocationId, operation, outcome.code, outcome.stage), diagnostics };
  }

  // 7b. Output-side limit enforcement (REAL, post-transform, pre-success).
  //
  // The whole produced set is checked together, so split / multi-output is never
  // partially accepted. Outputs are already published at this point, therefore a
  // violation MUST roll them back: no partial success, no residue.
  const outputFacts: OutputFacts[] = outcome.outputs.map((o) => ({
    id: o.id,
    byteSize: o.byteSize
  }));
  const outputViolation = checkOutputLimits(outputFacts, limits);
  if (outputViolation !== null) {
    diagnostics.push(`output limit: ${outputViolation.detail}`);
    rollbackOutputs(rootPath, outcome.outputs);
    rollbackStagingArtifacts(rootPath, stagingDir);
    return {
      response: failResponse(invocationId, operation, outputViolation.code, outputViolation.stage),
      diagnostics
    };
  }

  // 7c. Workspace budget post-check (REAL enforcement, not success-only).
  if (limits.maxWorkspaceBytes > 0) {
    const used = measureWorkspaceBytes(coreDirs);
    if (used > limits.maxWorkspaceBytes) {
      diagnostics.push(
        `workspace post: ${used} bytes exceeds maxWorkspaceBytes=${limits.maxWorkspaceBytes}`
      );
      rollbackOutputs(rootPath, outcome.outputs);
      rollbackStagingArtifacts(rootPath, stagingDir);
      return {
        response: failResponse(invocationId, operation, "resource.max_workspace_bytes", "resource"),
        diagnostics
      };
    }
  }

  const outputs: Output[] = outcome.outputs.map((o) => ({
    id: o.id,
    displayName: o.displayName,
    byteSize: o.byteSize,
    sha256: o.sha256,
    pageCount: o.pageCount,
    relativePath: o.relativePath
  }));
  const warnings: WarningEnvelope[] = (outcome.warnings as WarningCode[]).map((w) => ({ code: w }));

  return {
    response: buildSuccess(invocationId, operation, outputs, warnings),
    diagnostics
  };
}

/** Dispatch to the frozen V1 operation implementation. */
async function dispatch(
  operation: Operation,
  req: Request,
  inputs: ResolvedInput[],
  ctx: EngineContext
): Promise<import("../engine/operations.js").EngineOutcome> {
  switch (operation) {
    case "pdf.merge":
      return executeMerge(ctx, inputs);
    case "pdf.split": {
      const params = req.parameters as SplitParameters | undefined;
      if (!params || params.strategy.type !== "every") {
        return { ok: false, code: "parameter.invalid_page_selector", stage: "parameter" };
      }
      return executeSplit(ctx, inputs[0]!, params.strategy.n);
    }
    case "pdf.extract": {
      const params = req.parameters as ExtractParameters | undefined;
      if (!params || !params.pageSelector) {
        return { ok: false, code: "parameter.invalid_page_selector", stage: "parameter" };
      }
      return executeExtract(ctx, inputs[0]!, params.pageSelector);
    }
    case "pdf.rotate": {
      const params = req.parameters as RotateParameters | undefined;
      if (!params || !params.pages || !params.angle || !params.mode) {
        return { ok: false, code: "parameter.invalid_page_selector", stage: "parameter" };
      }
      return executeRotate(ctx, inputs[0]!, params.pages, params.angle, params.mode);
    }
    case "pdf.reorder": {
      const params = req.parameters as ReorderParameters | undefined;
      if (!params || !Array.isArray(params.pageOrder)) {
        return { ok: false, code: "parameter.invalid_page_selector", stage: "parameter" };
      }
      return executeReorder(ctx, inputs[0]!, params.pageOrder);
    }
    default:
      return { ok: false, code: "request.unknown_operation", stage: "request" };
  }
}

/** Serialize a response to JSON for the CLI (single public choke point). */
export function serialize(response: SuccessResponse | FailureResponse): string {
  return serializeResponse(response);
}
