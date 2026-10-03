# Eremite PDF Tools Core

A local, headless PDF page-processing Supplier implementing **Supplier Protocol v1**.
Current source version: **1.0.0-rc5 (prerelease)**.

It supports merge, split, extract, rotate and reorder. It does not convert
document formats, provide an application UI or manage a user library.
**No runtime network requests** are made.

## Supported environment and prerequisites

- Windows x64 and Node.js **>=24 <25** (ES modules).
- External **qpdf exactly 12.4.0** on the process PATH.
  Obtain it from the [official qpdf release](https://github.com/qpdf/qpdf/releases/tag/v12.4.0)
  and follow the [Windows distribution guidance](https://github.com/qpdf/qpdf/blob/v12.4.0/README-what-to-download.md).
- `qpdf --version` must report `qpdf version 12.4.0`.
- **No bundled qpdf or Microsoft VC runtime.** Users install qpdf and its
  prerequisites separately. No automatic download or bundled fallback exists.
- Source installation requires the locked npm dependencies from the registry
  or npm cache.

Before each invocation, PDF Tools resolves qpdf from PATH, checks its version,
then retains that absolute executable for the invocation. Missing, unusable or
mismatched qpdf produces an `engine.not_found` failure response.

## Operations

| Operation | Behavior |
| --- | --- |
| `pdf.merge` | Concatenate inputs in input order. |
| `pdf.split` | Split one input into chunks with `strategy: { type: "every", n }`. |
| `pdf.extract` | Select pages using `pageSelector` with pages or ranges. |
| `pdf.rotate` | Rotate selected pages by 90, 180 or 270 degrees, relative or absolute. |
| `pdf.reorder` | Emit every source page in a supplied order. |

Protocol page indices are zero-based; the qpdf adapter converts them to
one-based indices. Exact parameter shapes and closed operation, error, warning
and stage enums are in the
[canonical schema](schema/supplier-protocol-v1.schema.json).

## CLI / protocol

```text
pdf-tools-core --protocol 1 --request <absolute-request.json> --response <absolute-response.json>
```

From a development checkout, use `node dist/cli/cli.js` with the same arguments.
Invocations use files; there is no server or background service.

Requests include `kind`, `protocolVersion`, `invocationId`, `operation`,
`workspace.rootPath`, input references and snapshots containing `displayName`,
`byteSize` and `sha256`, operation parameters and optional limits.
Use the schema for the exact structure. The invocation ID is echoed verbatim.

- Exit `2`: invalid CLI/protocol/JSON input; no canonical response is written.
- Exit `0`: a canonical response is written. An operation failure also exits
  `0`, with `status: "failed"` and the closed error envelope.

## Limits and security behavior

Optional limits cover input/output file counts, per-file and total byte sizes,
page counts, workspace accounting and timeout. Input accounting precedes
transforms; output limits cover the entire output set. Workspace accounting
covers the Supplier-managed directories and is not an operating-system quota.
Default output count is 1000; default timeout is 30 seconds.

The validator checks input paths and snapshots. Encrypted and malformed PDFs
are rejected; documents are not repaired. Existing outputs are not overwritten.
Failures use the canonical error envelope instead of exposing engine stderr
or private filesystem paths.

## Host / Supplier boundary

The caller owns the workspace and immutable input snapshots. The Supplier uses
`work/`, `staging/` and `output/` within that workspace.

Host owns UI, policy, authorization, workspace isolation, routing, validation,
persistence, File Lifecycle and Run History. The Supplier provides bounded
headless capability and grants no Host capability authority.
Host validation is still required before results enter persistent application data.

## Build and test

```powershell
git clone https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core.git
cd Eremite-PDF-Tools-Core
qpdf --version
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Run tests with independently installed qpdf 12.4.0 and synthetic files in temporary
workspaces. Inspect failures and skips; do not use real documents or production data.

[scripts/consumer-smoke.mjs](scripts/consumer-smoke.mjs) checks all five operations
against an installed local runtime archive, real qpdf and the canonical schema.
It generates synthetic PDFs and checks the absence of packaged native binaries
and workspace containment.

## Distribution

This [public source repository](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core)
and its [v1.0.0-rc5 source tag](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core/tree/v1.0.0-rc5)
contain source, tests, scripts and schema. The tag retains prerelease identity.

Eremite Host uses a separately packaged, fixed archive under `vendor/pdf-tools/`.
A GitHub source tag is not that compiled runtime archive; rebuilding source
does not establish byte identity with the Host-vendored artifact.

For packaging development, `npm.cmd run build:release` creates a new local
`pdf-tools-core-1.0.0-rc5.tgz`. The builder packages compiled `dist/`, schema,
metadata, README, licenses/notices and the npm runtime dependency closure:
ajv and its four dependencies. It prunes development assets and rejects
native binaries and vendor runtime entries. Direct `npm pack` can include a
different dependency file inventory.

A runtime archive made by this builder includes the npm dependency closure and
can be installed offline:

```powershell
npm.cmd install ./pdf-tools-core-1.0.0-rc5.tgz --omit=dev --offline
```

Execution still requires external qpdf exactly 12.4.0. New local archives do not
replace the Host artifact automatically. Public source documentation may differ
from documentation embedded in the fixed Host archive.
No npm package has been published; `private: true` prevents accidental npm publication.

## Contributing, support and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for tests and protocol compatibility,
and [SUPPORT.md](SUPPORT.md) for capability bugs versus Host integration questions.

Report vulnerabilities through this repository's
[Private Vulnerability Reporting](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core/security/advisories/new),
following [SECURITY.md](SECURITY.md). Do not disclose sensitive details in public Issues.

## License

Supplier-owned code is [Apache-2.0](LICENSE). Bundled npm components retain their
own licenses, reproduced in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
qpdf and Microsoft VC runtime are external prerequisites and are not redistributed.

Copyright 2026 翁成航 (Chenghang Weng). See [NOTICE](NOTICE) and the
[current public state](docs/PUBLIC-FINALIZATION.md).
