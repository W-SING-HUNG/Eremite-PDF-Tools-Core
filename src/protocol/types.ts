/**
 * TypeScript types for the PDF Tools Core Supplier Protocol v1.
 *
 * These types mirror the JSON Schema exactly. The closed enums are imported
 * from the taxonomy module (single source of truth), so the types can never
 * drift from the runtime validator or the schema.
 */

import type {
  Operation,
  Stage,
  ErrorCode,
  WarningCode,
  Status
} from "../taxonomy/index.js";

/* ------------------------------------------------------------------ *
 * Page selection (0-based, machine protocol only — no free strings)
 * ------------------------------------------------------------------ */

export type PageSelector =
  | { mode: "pages"; pages: number[] }
  | { mode: "ranges"; ranges: PageRange[] };

export interface PageRange {
  /** 0-based, inclusive. start <= end. */
  start: number;
  /** 0-based, inclusive. */
  end: number;
}

/* ------------------------------------------------------------------ *
 * Operation parameters (typed per operation)
 * ------------------------------------------------------------------ */

export interface SplitStrategy {
  type: "every";
  /** Positive integer — number of pages per output part. */
  n: number;
}

export interface SplitParameters {
  strategy: SplitStrategy;
}

export interface ExtractParameters {
  pageSelector: PageSelector;
}

export interface RotateParameters {
  pages: PageSelector;
  angle: 90 | 180 | 270;
  mode: "relative" | "absolute";
}

export interface ReorderParameters {
  /** Non-negative integer page order (0-based). */
  pageOrder: number[];
}

export type OperationParameters =
  | SplitParameters
  | ExtractParameters
  | RotateParameters
  | ReorderParameters;

/* ------------------------------------------------------------------ *
 * Workspace + input identity
 * ------------------------------------------------------------------ */

export interface Workspace {
  /** Absolute, Host-owned invocation workspace root. */
  rootPath: string;
}

export interface InputSnapshot {
  byteSize: number;
  /** 64 lowercase hex chars. */
  sha256: string;
  /** Metadata only — never used for identity or path resolution. */
  displayName: string;
}

export interface InputRef {
  /** Stable id, unique within the request. Never derived from displayName. */
  id: string;
  /**
   * Canonical workspace-relative path to the physical input file.
   * Not absolute, not UNC, no ".." traversal.
   */
  relativePath: string;
  snapshot: InputSnapshot;
}

/* ------------------------------------------------------------------ *
 * Limits (all positive, safe integers; validated at runtime)
 * ------------------------------------------------------------------ */

export interface Limits {
  maxInputFiles: number;
  maxInputBytesPerFile: number;
  maxTotalInputBytes: number;
  maxOutputFiles: number;
  maxOutputBytesPerFile: number;
  maxTotalOutputBytes: number;
  maxPagesPerInput: number;
  maxTotalPages: number;
  maxWorkspaceBytes: number;
  timeoutMs: number;
}

/* ------------------------------------------------------------------ *
 * Request
 * ------------------------------------------------------------------ */

export interface Request {
  kind: "pdf.tools.request";
  protocolVersion: 1;
  /** RFC 9562 UUID v1–v7. Echoed verbatim in the response. */
  invocationId: string;
  operation: Operation;
  workspace: Workspace;
  inputs: InputRef[];
  /** Present for split/extract/rotate; absent for merge/reorder (which have none). */
  parameters?: OperationParameters;
  limits?: Limits;
}

/* ------------------------------------------------------------------ *
 * Response
 * ------------------------------------------------------------------ */

export interface Output {
  id: string;
  displayName: string;
  byteSize: number;
  sha256: string;
  pageCount: number;
  /** Workspace-relative path only. Never an absolute path. */
  relativePath: string;
}

/** Provenance skeleton — expanded in P2+ with engine id/version, duration, etc. */
export interface Provenance {
  coreVersion: string;
  protocolVersion: 1;
  operation: Operation;
}

export interface ErrorEnvelope {
  code: ErrorCode;
  stage: Stage;
  retryable: boolean;
}

export interface WarningEnvelope {
  code: WarningCode;
}

export interface SuccessResponse {
  kind: "pdf.tools.response";
  protocolVersion: 1;
  /** Verbatim echo of request.invocationId. */
  invocationId: string;
  operation: Operation;
  status: Extract<Status, "succeeded">;
  outputs: Output[];
  provenance: Provenance;
  warnings: WarningEnvelope[];
}

export interface FailureResponse {
  kind: "pdf.tools.response";
  protocolVersion: 1;
  /** Verbatim echo of request.invocationId. */
  invocationId: string;
  operation: Operation;
  status: Extract<Status, "failed">;
  error: ErrorEnvelope;
  /**
   * V1: failures never carry warnings (damaged/recoverable anomaly is a
   * failure, not a warning). Frozen as empty array for a stable shape.
   */
  warnings: WarningEnvelope[];
}

export type Response = SuccessResponse | FailureResponse;
