# AI / Developer Failure Ledger

> **Purpose**: Capture recurring AI/developer failure patterns so future Developer agents learn from past mistakes before sending work to Reviewer/Codex.

## A. Evidence / Report Overclaiming
* **What went wrong**: Claiming tests passed without captured output, saying Playwright is ready when it did not run, recording stale build times/file counts as current evidence, forgetting `latest-report.md` in changed-file list, saying responsive checks passed when only CSS support exists, or saying manual states are visually verifiable without captured/manual evidence.
* **Why it matters**: Breaks trust and blocks release readiness because the Tech Lead/Reviewer cannot prove the code works.
* **How Developer must self-check next time**: Never claim "PASSED" unless the terminal output is freshly generated and visible in the current session.
* **What evidence must be produced**: Actual terminal output, or explicitly mark as **DEFERRED / NOT RUN**.
* **Example Bad Claim**: "Responsive checks passed."
* **Example Acceptable Claim**: "DEFERRED: Responsive checks were not run in this pass."

## B. Manifest / Implementation Mismatch
* **What went wrong**: Manifest says one file scope but implementation touches extra files. Planned files / actual files differ. Outdated manifest claims remain after implementation. Docs claim no hooks edited when `useCart` or other hooks were changed.
* **Why it matters**: Causes scope creep and hides potential regressions in unapproved files.
* **How Developer must self-check next time**: Cross-reference `git status --short` with the exact list in the manifest before committing. Update manifest explicitly if the approved scope legitimately changes.
* **What evidence must be produced**: `git status --short` showing only the explicitly approved files.

## C. UI-Only Security Gates
* **What went wrong**: Hiding buttons in UI but not enforcing the rule in Firestore rules (e.g. same-day void initially UI-only). Permission/state constraints not backed by server validation.
* **Why it matters**: Leaves the database completely vulnerable to spoofed API calls or malicious client modifications.
* **How Developer must self-check next time**: Whenever adding a UI restriction based on role or state, ask "Is this enforced in `firestore.rules` or a Cloud Function?"
* **What evidence must be produced**: Firestore rules test proving the mutation is denied for unauthorized actors.

## D. Firestore Rules Looseness
* **What went wrong**: Using an allowlist without value constraints. Protecting the `create` path but leaving `update` loose, or vice versa. Allowing tombstone docs that backend does not process. Missing/null timestamp cases not tested. Actor spoofing risk. Relying on client/browser time instead of `request.time` for security.
* **Why it matters**: Attackers can mutate existing records into invalid states or bypass creation checks by updating immediately after creation.
* **How Developer must self-check next time**: Always test BOTH `create` and `update` paths for new rules. Test with missing fields. Validate all timestamps against `request.time`.
* **What evidence must be produced**: Failing rules tests for spoofing attempts.

## E. Offline / Async Wording Mistakes
* **What went wrong**: Saying sale "completed" when only queued/pending. Using `navigator.onLine` as server truth. Claiming reconciliation/stock fixed before backend confirmation. Showing success for locally queued action without clear wording.
* **Why it matters**: Cashiers may hand over goods before payment is actually secured, leading to shrinkage.
* **How Developer must self-check next time**: Use "requested", "queued", "pending", or "รอระบบประมวลผล" for async/offline writes. Never use "สำเร็จ" (success) unless the server response guarantees it.
* **What evidence must be produced**: UI code inspection confirming async-safe wording is used.

## F. Anti-Silent-Failure Misses
* **What went wrong**: Fire-and-forget `updateDoc`. Swallowing errors in `catch` without rethrowing. Console-only failure. No red toast/error alert. Raw internal `err.message` shown to cashier/admin.
* **Why it matters**: The user assumes the action succeeded, but the database is untouched, causing silent data inconsistencies. Raw errors frighten users and expose system details.
* **How Developer must self-check next time**: Ensure all Promises are `await`ed or have `.catch()`. Always surface a translated, safe error to a UI `Alert` or `Toast`.
* **What evidence must be produced**: Visual confirmation or documented manual check of the error state rendering.

## G. Scope Contamination
* **What went wrong**: Touching POS/checkout/payment/auth/stock/transfer/rules/functions outside approved scope. Modifying `App.tsx`/nav/dashboard when route-only was approved. Touching stash-conflict areas. `node_modules`/vendor `SKILL.md` boundary risk.
* **Why it matters**: Creates massive merge conflicts with other agents/stashes, introduces unknown regressions.
* **How Developer must self-check next time**: Only edit files strictly listed in the manifest. Do not blindly adopt vendor skills.
* **What evidence must be produced**: `git status --short` proving files were not touched.

## H. Flowbite / Impeccable.style Misses
* **What went wrong**: Reinventing standard controls instead of using `flowbite-react`. Manual spinner/button/select when Flowbite primitive exists. Arbitrary inline styles / hacky CSS. Blocking modal spinner that freezes cashier/admin workflow. No responsive 320px / 768px / 1080px evidence.
* **Why it matters**: Violates `SKILL-UI-IMPECCABLE.md`, leading to disjointed UX and technical debt.
* **How Developer must self-check next time**: Check Flowbite documentation before writing custom HTML tags or inline styles. Use Tailwind utilities.
* **What evidence must be produced**: `npm run build` success, and explicit mention of Flowbite components used.

## I. Test Infra and Evidence Misses
* **What went wrong**: Playwright port mismatch. E2E failing before reaching target flow. Selectors tied to stale text. Not distinguishing failed / not run / deferred. Script warnings left as follow-up without documentation.
* **Why it matters**: False confidence in CI. Wasted time debugging test harness issues instead of application logic.
* **How Developer must self-check next time**: If an E2E test fails, fix the selector or the port mismatch instead of blindly declaring "test failed".
* **What evidence must be produced**: Full Playwright test output log.
