/**
 * Engine barrel — the qpdf-backed V1 implementation.
 *
 * Only the frozen, intentionally-public surface is re-exported here. Internal
 * details (argv planning, spawn plumbing, page math) remain importable from
 * their own modules but are not part of the top-level contract barrel.
 */

export {
  executeMerge,
  executeExtract,
  executeRotate,
  executeReorder,
  executeSplit,
  type EngineContext,
  type ResolvedInput,
  type ProducedOutput,
  type EngineOutcome
} from "./operations.js";

export {
  structuralGate,
  gateReasonToErrorCode,
  type GateFailureReason,
  type GateOutcome,
  type GateOptions
} from "./gate.js";

export {
  getQpdfExecutable,
  resolveQpdfExecutable,
  isRuntimePresent,
  verifyQpdfVersion,
  QPDF_VERSION
} from "./runtime.js";

export { readPageRotations, parseRotationsFromJson, normalizeRotation } from "./verify.js";
