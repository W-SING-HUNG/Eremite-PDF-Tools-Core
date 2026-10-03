# Security policy — source-first distribution

## Supported Versions

Source version: 1.0.0-rc5 (rc5 prerelease). No security maintenance
version matrix or response SLA is promised.

## Reporting a Vulnerability

GitHub Private Vulnerability Reporting is enabled.

Report security vulnerabilities privately through this repository's
**Security → Advisories → Report a vulnerability**, or use
[Report a vulnerability](https://github.com/W-SING-HUNG/Eremite-PDF-Tools-Core/security/advisories/new).

Do not disclose sensitive vulnerability details in public Issues. Do not submit
API keys, credentials, databases, private files or raw Provider responses.
Provide the affected version, a minimal synthetic reproduction, impact and
sanitized diagnostics. Share only what is needed to reproduce.
No unapproved response SLA or resolution timeline is promised.

## Local execution boundary

Supplier Core executes only the bounded Host request inside the Host-owned
workspace. Host authorization and output validation remain required.
