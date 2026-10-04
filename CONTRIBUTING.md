# Contributing

Small, focused changes are preferred. For larger behavior or contract changes,
first describe the problem and proposal in [GitHub Issues](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core/issues).

## Supported environment and setup

Windows x64, Node.js >=24 <25 and external qpdf exactly 12.4.0 on PATH.

```powershell
git clone https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core.git
cd Eremite-PDF-Tools-Core
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
```

Use a separate branch and submit a Pull Request with the problem, resulting
behavior, compatibility impact and the checks actually run. Report skips and
missing prerequisites explicitly.

## CI

[GitHub Actions CI](.github/workflows/ci.yml) runs automatically for PRs targeting
`main` and pushes to `main`. Before submitting, still run `npm.cmd run typecheck`,
`npm.cmd run build` and `npm.cmd test` locally with external qpdf exactly 12.4.0.
Resolve CI failures; never lower validators, contracts or tests to bypass them.

## Tests and contract compatibility

Use synthetic test data only, in isolated temporary workspaces. Never use private
documents, production datasets or credentials. Runtime behavior changes must
include tests covering the behavior.

Do not lower validators, contracts or tests to make checks pass.
Supplier contract changes must explicitly describe compatibility impact on
request/response shapes, error behavior and Host adapters.

Supplier Core does not own Host UI, persistence or lifecycle. Host owns policy,
authorization, workspace isolation, routing, validation, File Lifecycle and
Run History; a Supplier capability registry does not grant Host authority.

## Repository hygiene and security

Do not commit secrets, unsanitized files/logs, generated QA/temp artifacts,
dependencies, caches or build output. Preserve third-party licenses and notices.
Avoid unrelated formatting.

Ordinary support is described in [SUPPORT.md](SUPPORT.md).
Security issues must use [Private Vulnerability Reporting](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core/security/advisories/new),
not public Issues. Follow [SECURITY.md](SECURITY.md).
