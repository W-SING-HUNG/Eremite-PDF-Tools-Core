# Security policy

## Current version

This policy covers source version 1.0.0-rc5 (prerelease). Earlier versions have no declared
security maintenance commitment.

## Reporting a vulnerability

GitHub Private Vulnerability Reporting is enabled.

Report vulnerabilities through this repository's
**Security → Advisories → Report a vulnerability**, or use
[Report a vulnerability](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core/security/advisories/new).

Do not disclose sensitive vulnerability details in public Issues. Do not submit
API keys, credentials, databases, private files, private documents, proprietary
source files, production datasets or unsanitized input/output files.
Provide the affected version, a minimal synthetic reproduction, impact and
sanitized diagnostics. Share only what is needed to reproduce.
No response SLA or resolution timeline is promised.

## Local execution boundary

Supplier Core executes the bounded Host request inside the Host-owned workspace.
Host authorization, input policy and independent output validation remain required.
Use synthetic documents for reproductions; remove sensitive file contents,
paths and engine diagnostics before sharing.
