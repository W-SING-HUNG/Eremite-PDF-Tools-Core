# PDF Tools Core

`pdf-tools-core@1.0.0-rc5` is a local, headless PDF page-processing Supplier.
It implements Supplier Protocol v1 and requires external qpdf 12.4.0 on PATH. It performs
no document-format conversion and makes no network requests at runtime.

Version **1.0.0-rc5** is a prerelease in the source-first distribution; its rc5 identity is retained.

## Operations

| Operation | Behavior |
|---|---|
| `pdf.merge` | Concatenate inputs in input order. |
| `pdf.split` | Split one input into chunks with `strategy: { type: "every", n }`. |
| `pdf.extract` | Select pages using `pageSelector` with pages or ranges. |
| `pdf.rotate` | Rotate selected pages by 90, 180 or 270 degrees, relative or absolute. |
| `pdf.reorder` | Emit every source page in a supplied order. |

Protocol page indices are zero-based. The qpdf adapter converts them to
one-based indices. The canonical request and response definitions are in
`schema/supplier-protocol-v1.schema.json`; parameter shapes and closed
operation, error, warning and stage enums are unchanged in this candidate.

## Requirements and installation

- Windows x64 and Node.js `>=24 <25` (ES modules).
- **qpdf 12.4.0 is an EXTERNAL PREREQUISITE.** Obtain and install it from the
  [official qpdf v12.4.0 release](https://github.com/qpdf/qpdf/releases/tag/v12.4.0).
  Follow the [official Windows distribution guidance](https://github.com/qpdf/qpdf/blob/v12.4.0/README-what-to-download.md).
- Add the installed qpdf `bin` directory to PATH for the process running PDF Tools.
  `qpdf --version` must report exactly `qpdf version 12.4.0`.
- **PDF Tools does not redistribute qpdf.exe, qpdf30.dll or Microsoft VC Runtime binaries.**
  The user installs and licenses the external qpdf distribution and its prerequisites.
- The npm runtime dependencies are bundled in the formal candidate tgz.
- Node.js, npm, Windows and qpdf are external prerequisites.

For a runtime archive produced by the release builder:

```powershell
npm.cmd install ./pdf-tools-core-1.0.0-rc5.tgz --omit=dev --offline
```

The formal tgz includes ajv and its four npm runtime dependencies, so this local
package installation can run offline. Execution also requires an independently
installed qpdf 12.4.0 on PATH. Building from source with `npm ci` requires
the locked dependencies to be available from the registry or npm cache.
`private: true` prevents accidental npm publication; it does not describe repository visibility.

## CLI and protocol

```text
pdf-tools-core --protocol 1 --request <absolute request.json> --response <absolute response.json>
```

From a development checkout, use `node dist/cli/cli.js` with the same arguments.
CLI invocations use files; there is no server or background service.

A request includes `kind`, `protocolVersion`, `invocationId`, `operation`,
`workspace.rootPath`, and input references with a relative path and a
`snapshot` containing `displayName`, `byteSize` and `sha256`, plus
operation parameters and optional limits. Use the schema for exact object
structure. The invocation ID is echoed verbatim.

- Exit `2`: invalid CLI/protocol/JSON boundary input; no canonical response is written.
- Exit `0`: a canonical response is written. An operation failure also exits
  `0`, with `status: "failed"` and the closed error envelope in the response.

The caller owns the workspace and input snapshots. The Supplier manages
`work/`, `staging/` and `output/` under that workspace. The Host owns its UI,
database, confirmation policy, File Lifecycle, Run History and final persistence.
This package grants no Host capability authority and supplies no Host integration.

## Limits and runtime behavior

Optional limits cover input/output file counts, per-file and total byte sizes,
page counts, workspace accounting and timeout. Input accounting precedes
transforms; output limits apply to the entire output set. Workspace byte
accounting covers the Supplier-managed directories and is not an OS quota.
Default output count is 1000 and default timeout is 30 seconds.

The existing validator checks input paths and snapshots. Encrypted and malformed
PDFs are rejected; the engine does not repair documents. Published outputs are
not overwritten. Failures use the canonical error envelope rather than exposing
engine stderr or internal paths. The workspace containment regression is included in the formal test suite.
Host integration has completed independent technical review. npm publication is a separate process.

Before each invocation, PDF Tools resolves qpdf from PATH, runs `qpdf --version`,
and requires exactly 12.4.0 before processing inputs. It retains that resolved
absolute executable for the invocation. Missing, unusable or mismatched qpdf
produces the existing `engine.not_found` failure envelope. There is no bundled
runtime fallback or automatic download.

## Build, test and package

```powershell
qpdf --version         # must report 12.4.0
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd audit --omit=dev
npm.cmd pack --dry-run
npm.cmd run build:release
```

The release builder stages the package allowlist and bundled runtime dependency
closure, retains license files, prunes dependency development assets, and creates
`pdf-tools-core-1.0.0-rc5.tgz`. Direct `npm pack` from the checkout may contain
more dependency files; use `build:release` for the formal candidate. The tgz
contains `dist/`, schema, npm runtime dependencies, metadata, README and
license/notices. No qpdf/native binaries, vendor runtime manifest or vendor
licenses are shipped. The release file-list gate rejects native binaries and
vendor entries. Source, tests, local release evidence and downloaded prerequisites
are not package inputs.

`scripts/consumer-smoke.mjs` is the existing independent consumer harness. Copy
it into a temporary consumer containing only an installation of the local tgz
and run it with Node.js. It generates its own PDFs and verifies all five
operations using real external qpdf 12.4.0 from PATH and the installed canonical schema.
It also checks that the installed package has no native binaries and that
workspace containment still holds.

## License and distributed components

Supplier-owned code is Apache-2.0; see `LICENSE`. Copyright 2026 翁成航 (Chenghang Weng). See [NOTICE](NOTICE). Distributed npm components
retain their own licenses, reproduced in `THIRD-PARTY-NOTICES`.

qpdf is an external prerequisite and is **not redistributed** by PDF Tools.
Microsoft VC Runtime binaries are **not redistributed** by PDF Tools. Their
licenses belong to the independent distributions obtained by the user.

## Source repository and finalization

Canonical source repository: https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core. Source-first version: 1.0.0-rc5 (prerelease).

Owner attribution is finalized in [NOTICE](NOTICE) and the existing licensing paragraph.
Keep the standard Apache LICENSE text unchanged. Upstream third-party copyright
notices are retained and must not be replaced with the Supplier holder.

See [finalization checklist](docs/PUBLIC-FINALIZATION.md) and [security policy](SECURITY.md).
