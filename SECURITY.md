# Security policy — source-first distribution

## Supported Versions

Source version: 1.0.0-rc5 (rc5 prerelease). No security maintenance
version matrix or response SLA is promised.

## Reporting a Vulnerability

Status: BLOCKED_PENDING_PUBLIC_REPO_SECURITY_CHANNEL.

GitHub Private Vulnerability Reporting has not been enabled or verified.
Immediately after public cutover, enable it and verify the channel before
inserting actual usable reporting instructions. No report URL or email is
claimed here. Do not submit sensitive vulnerability details, API keys, credentials,
private files, databases or raw engine diagnostics in public Issues. Use a
verified private channel with synthetic reproduction and sanitized diagnostics.

## Local execution boundary

Supplier Core executes only the bounded Host request inside the Host-owned
workspace. Host authorization and output validation remain required.
