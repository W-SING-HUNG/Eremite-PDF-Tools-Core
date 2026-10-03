/**
 * PDF Tools Core — public entry.
 *
 * Exports the protocol (types + validator + response builders), taxonomy,
 * UUID validation, workspace containment, input snapshot, and limits. The CLI
 * entry (src/cli/cli.ts) is wired via package.json "bin".
 */

export * from "./protocol/index.js";
export * from "./taxonomy/index.js";
export * from "./uuid/index.js";
export * from "./workspace/index.js";
export * from "./input/index.js";
export * from "./limits/index.js";
export * from "./engine/index.js";
export * from "./core/index.js";
