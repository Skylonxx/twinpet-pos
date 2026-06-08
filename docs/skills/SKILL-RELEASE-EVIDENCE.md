# SKILL: Release Evidence

Every phase or step release must provide undeniable evidence of its success or failure.

- **Build output evidence:** Always capture the exact result of `npm run build` or equivalent.
- **Rules test output evidence:** Always capture the result of `npm run test:rules`.
- **Playwright evidence:** Always capture the result of E2E tests (`npx playwright test`).
- **Do not overclaim:** Only report success if the test actually completed the assertion path.
- **Captured output:** Exact output logs must be recorded as sample evidence (but recognize that file sizes and timings are point-in-time samples, not permanent invariants).
- **Distinguish status clearly:** Reports MUST explicitly distinguish:
  - Passed
  - Failed
  - Not run
  - Deferred
  - Blocked by infrastructure
