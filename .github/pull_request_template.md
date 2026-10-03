## Problem and resulting behavior

Describe the problem, scope and resulting behavior. Link the related public issue if available.

## Validation

List checks actually run, results and any skips. Runtime behavior changes must include tests.
Use synthetic data and isolated workspaces.

## Compatibility and boundaries

Describe Supplier contract compatibility impact explicitly. Supplier Core does not own Host UI, persistence or lifecycle; preserve Host-owned policy and authorization.

## Review checklist

- [ ] The change is small and focused, with no unrelated formatting.
- [ ] No secrets, real user data, unsanitized logs or generated QA/temp artifacts are included.
- [ ] Validators, contracts and tests were not weakened to make checks pass.
- [ ] Any runtime behavior change includes relevant tests, and contract compatibility is described.
