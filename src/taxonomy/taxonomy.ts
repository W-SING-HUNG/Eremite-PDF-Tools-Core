/**
 * Single source of truth for all closed enums in the PDF Tools Core
 * Supplier Protocol v1.
 *
 * This module is the ONLY place where operation ids, error codes, warning
 * codes, and stages are defined. The JSON Schema and the TypeScript types are
 * both generated/derived from these constants so that the wire contract can
 * never drift from the runtime.
 *
 * IMPORTANT: these strings are a public wire contract. Renaming or removing a
 * value is a breaking change. Add new values only; never repurpose an existing
 * value's meaning.
 */

/** All V1 operations (frozen). */
export const OPERATIONS = [
  "pdf.merge",
  "pdf.split",
  "pdf.extract",
  "pdf.rotate",
  "pdf.reorder"
] as const;

export type Operation = (typeof OPERATIONS)[number];

/** Pipeline stages for error classification (frozen). */
export const STAGES = [
  "request",
  "input",
  "workspace",
  "parameter",
  "resource",
  "pdf_validation",
  "engine",
  "timeout",
  "output",
  "publish",
  "internal"
] as const;

export type Stage = (typeof STAGES)[number];

/**
 * Closed error code enum.
 *
 * P1 actually needs: request.*, input.*, workspace.*, parameter.*, resource.*,
 * internal.*. The remaining namespaces (pdf_validation, engine, timeout,
 * output, publish) are frozen now because their wire meaning is stable and
 * P2+ will need them; defining them once avoids a breaking wire change later.
 * We deliberately do NOT invent speculative codes beyond these.
 */
export const ERROR_CODES = [
  // request
  "request.malformed_json",
  "request.invalid_protocol_version",
  "request.invalid_uuid",
  "request.unknown_operation",
  "request.unknown_field",
  "request.invalid_parameter",
  // input
  "input.not_found",
  "input.zero_byte",
  "input.not_regular_file",
  "input.invalid_path",
  "input.escape",
  "input.snapshot_mismatch",
  // workspace
  "workspace.invalid_root",
  "workspace.escape",
  // parameter
  "parameter.invalid_page_selector",
  "parameter.invalid_page_index",
  "parameter.out_of_range",
  "parameter.empty_selector",
  "parameter.duplicate_output_name",
  "parameter.invalid_angle",
  // resource
  "resource.max_input_files",
  "resource.max_input_bytes",
  "resource.max_total_input_bytes",
  "resource.max_output_files",
  "resource.max_output_bytes",
  "resource.max_total_output_bytes",
  "resource.max_pages",
  "resource.max_total_pages",
  "resource.max_workspace_bytes",
  "resource.timeout_exceeded",
  // pdf_validation (frozen for P2+)
  "pdf_validation.encrypted",
  "pdf_validation.requires_password",
  "pdf_validation.malformed",
  "pdf_validation.recoverable_anomaly",
  "pdf_validation.unsupported_feature",
  // engine (frozen for P2+)
  "engine.not_found",
  "engine.crash",
  "engine.nonzero_exit",
  "engine.invalid_output",
  // timeout (frozen for P2+)
  "timeout.engine",
  // output (frozen for P2+)
  "output.missing",
  "output.empty",
  "output.wrong_type",
  "output.page_count_mismatch",
  "output.exists",
  // publish (frozen for P2+)
  "publish.partial",
  "publish.failed",
  // internal
  "internal.unexpected",
  "internal.not_implemented"
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Closed warning code enum (frozen by P0 Final Corrections: exactly two).
 *
 * - normalization is a provenance fact, NOT a warning.
 * - damaged/recoverable anomaly is a failure in V1, so it can never appear in
 *   a success warning.
 */
export const WARNING_CODES = [
  "w.duplicate_page_emitted",
  "w.document_features_dropped"
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];

/** Which error codes are retryable (transient / likely to succeed on retry). */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "resource.timeout_exceeded",
  "timeout.engine",
  "engine.crash",
  "internal.unexpected"
]);

/** Protocol status values (frozen). */
export const STATUS = ["succeeded", "failed"] as const;

export type Status = (typeof STATUS)[number];

/** Protocol kind discriminator (frozen). */
export const PROTOCOL_VERSION = 1 as const;

/** Operation input/output arity map (for parameter validation). */
export const OPERATION_ARITY: Readonly<Record<Operation, { minInputs: number; maxInputs: number }>> = {
  "pdf.merge": { minInputs: 1, maxInputs: Infinity },
  "pdf.split": { minInputs: 1, maxInputs: 1 },
  "pdf.extract": { minInputs: 1, maxInputs: 1 },
  "pdf.rotate": { minInputs: 1, maxInputs: 1 },
  "pdf.reorder": { minInputs: 1, maxInputs: 1 }
};
