#!/usr/bin/env node
/**
 * PDF Tools Core production CLI (P2 — real qpdf engine).
 *
 * Surface (frozen):
 *   pdf-tools-core --protocol 1 --request <abs request.json> --response <abs response.json>
 *
 * Semantics (locked from P1):
 *   - Protocol / crash errors  -> non-zero exit (stderr message, no file).
 *   - Structured business failure (invalid request, snapshot mismatch,
 *     structural gate failure, engine failure) -> exit 0 + canonical failed
 *     response written to --response.
 *
 * P2 implements the five frozen V1 PDF operations on top of a pinned,
 * version-verified external qpdf engine. The CLI performs REQUEST-ONLY validation, then
 * delegates all workspace/input/structural-gate/engine work to the Core
 * orchestrator. No arbitrary command, no caller output dir, no DEV API, no
 * shell, no network.
 */

import { readFileSync, writeFileSync } from "node:fs";

import {
  validateRequest,
  isMalformedJson,
  buildFailure,
  buildErrorEnvelope,
  serializeResponse
} from "../protocol/index.js";
import { executeRequest, serialize as serializeCore } from "../core/index.js";
import type { Request } from "../protocol/index.js";
import type { Operation, ErrorCode, Stage } from "../taxonomy/index.js";

const PROTOCOL_ARG = "--protocol";
const REQUEST_ARG = "--request";
const RESPONSE_ARG = "--response";

interface CliArgs {
  protocol: number;
  request: string;
  response: string;
}

function usage(): string {
  return [
    "usage: pdf-tools-core --protocol 1 --request <abs request.json> --response <abs response.json>",
    "",
    "  --protocol <n>    protocol version (must be 1)",
    "  --request <path>  absolute path to request JSON",
    "  --response <path> absolute path to write response JSON"
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs | null {
  let protocol: number | undefined;
  let request: string | undefined;
  let response: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === PROTOCOL_ARG) {
      const v = argv[i + 1];
      if (v === undefined) return null;
      protocol = Number(v);
      i++;
    } else if (a === REQUEST_ARG) {
      request = argv[i + 1];
      if (request === undefined) return null;
      i++;
    } else if (a === RESPONSE_ARG) {
      response = argv[i + 1];
      if (response === undefined) return null;
      i++;
    } else {
      return null; // unknown arg
    }
  }
  if (protocol === undefined || request === undefined || response === undefined) {
    return null;
  }
  return { protocol, request, response };
}

/**
 * Write a canonical failure response to --response and exit 0 (business
 * failure semantics). Never writes absolute paths / stack / stderr.
 */
function failBusiness(
  responsePath: string,
  invocationId: string,
  operation: Operation,
  code: ErrorCode,
  stage: Stage
): never {
  const err = buildErrorEnvelope(code, stage);
  const resp = buildFailure(invocationId, operation, err);
  writeFileSync(responsePath, serializeResponse(resp), "utf-8");
  process.exit(0);
}

/** Protocol / crash error: print a short message to stderr and exit non-zero. */
function failProtocol(message: string): never {
  process.stderr.write(`pdf-tools-core: ${message}\n`);
  process.exit(2);
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(usage() + "\n");
    process.exit(2);
  }

  // Protocol version gate (protocol error -> non-zero).
  if (args.protocol !== 1) {
    failProtocol(`unsupported protocol version ${args.protocol}`);
  }

  // Load request. Missing/unreadable -> protocol error (non-zero).
  let rawText: string;
  try {
    rawText = readFileSync(args.request, "utf-8");
  } catch {
    failProtocol(`cannot read request file`);
  }

  // Malformed JSON -> protocol error (non-zero).
  if (isMalformedJson(rawText)) {
    failProtocol(`request is not valid JSON`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    failProtocol(`request is not valid JSON`);
  }

  // Validate request (structural + semantic). A failure here is a protocol-level
  // business failure: exit 0 + canonical failed response.
  const result = validateRequest(raw);
  if (!result.ok) {
    const f = result.failure;
    const req = raw as { invocationId?: unknown; operation?: unknown };
    if (typeof req.invocationId !== "string" || typeof req.operation !== "string") {
      failProtocol(`request missing invocationId/operation`);
    }
    failBusiness(args.response, req.invocationId, req.operation as Operation, f.code, f.stage);
  }

  // Validated request -> Core orchestrator (workspace + input double-gated +
  // V1 structural gate + pinned qpdf engine). The orchestrator returns the
  // canonical response; diagnostics are internal-only and never serialized.
  const req = result.value as Request;
  const { response } = await executeRequest(req);
  writeFileSync(args.response, serializeCore(response), "utf-8");
  process.exit(0);
}

// Unexpected internal crash boundary: never leak stack / absolute path / raw
// exception to the public surface. A generic one-line message + non-zero exit.
run().catch(() => {
  process.stderr.write("pdf-tools-core: internal error\n");
  process.exit(1);
});
