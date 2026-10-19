# Public information checks

Public documentation describes supported behavior, reproducible validation and its limits. Preserve technical facts, licenses, required author credit and third-party attribution. Keep private data and local execution evidence outside the source tree.

Before preparing a public change, run:

```powershell
npm.cmd run check:public-exposure
npm.cmd run test:public-exposure
npm.cmd run check:public-delivery
node scripts/check-public-exposure.mjs --text-file <proposed-body-file>
node scripts/check-public-exposure.mjs --base <base-ref> --head <head-ref>
```

Enable the repository hooks with `git config --local core.hooksPath .githooks`. The pre-commit hook checks staged bytes and effective identities; commit-msg also checks the proposed message. Hooks can be bypassed, so CI remains required.

The source check includes tracked files and non-ignored new files. The delivery check inspects the Git index and effective author and committer identities, including environment overrides. Configure repository-local author settings with the account's GitHub no-reply address and `user.useConfigOnly=true`. Check actual server-generated squash metadata separately. An address-form check does not prove account ownership.

Use `--extra-file <archive>` to inspect prepared distribution bytes, including ignored build output about to be published. ZIP and gzip/TAR contents are inspected recursively in memory, including paths, extended headers, comments and document-container metadata. UTF-16, common escaped text and bounded base64 representations are checked. Invalid, encrypted or unsupported archives and inspection-limit failures block the check. Inspection never extracts archives.

CI checks source, new commit content/messages/identities, PR title/body changes and release name/body events. Supplier CI also inspects a prepared package. Run the text-file check before publication: a release event runs after GitHub accepts the release and cannot retract it. Comments, attachments, UI/API submissions and repository settings require separate review.

Recognized credentials, personal paths, private/generated data, private repository references and unnecessary development-assistant provenance are rejected. Legal authorship, dependency identifiers, supported model names, reserved example addresses and required upstream attribution remain allowed. Policy definitions and synthetic tests may name rejected examples; credentials and personal paths have no blanket exemption.

These are bounded checks. Encrypted documents, unsupported encodings, arbitrary steganography and external resources still need manual assessment. A successful source check does not certify all historical or hosted content. Ordinary changes cannot remove old snapshots, commit identities, cached PR diffs, logs, forks or downloaded copies. Historical removal, tag changes and hosting edits require separate review and authorization; existing protection and acceptance requirements remain in force.
