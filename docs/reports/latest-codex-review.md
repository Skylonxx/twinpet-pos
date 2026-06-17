# Codex Review Report

## Phase

7C-UI-04-SYNC-AND-MACRO-LAYOUT

## Verdict

FAIL

## Summary

The UI-04 app implementation passes the code, behavior, scope, and keyboard-contract review. The package still cannot pass because `git diff --check` currently fails on trailing whitespace in `docs/reports/latest-agy-review.md` line 11.

No app-code blocker was found. The required fix is report hygiene only.

## Findings

### 1. `git diff --check` fails on AGY report trailing whitespace

Severity: Blocker

Current output includes:

```text
docs/reports/latest-agy-review.md:11: trailing whitespace.
```

This is outside the app implementation, but it is a repository hygiene gate failure and must be fixed before commit.

## A. Macro Layout Review

PASS. `.pos-cart` changed from `margin: 8px 8px 8px 0` to `margin: 0 8px 8px 8px`, aligning the cart top with the category bar and creating a consistent left/right/bottom gutter. The cart structure and cart math were not changed.

PASS. The Select Customer dashed border is untouched. No `.pos-cust-pick` CSS hunk is present.

## B. Category Sync Review

PASS. `visibleCategories` now merges product-derived category strings with the categories collection (`richCategories`). The merged list is deduped through `seen`, carries collection metadata where available, and still runs through `getVisibleCategories(enriched, posBranchId)` plus `sortCategories(...)`, preserving branch visibility and ordering.

PASS. Update bell and manual refresh behavior remain catalog-wide through the existing `lastForceUpdate` / `refreshInventory()` path. Product detection paths were not changed.

## C. Category Bar Scroll Review

PASS. `.pos-cat-bar` now uses `flex-wrap: nowrap` with existing horizontal overflow and hidden scrollbar handling, so category pills scroll horizontally instead of wrapping or pushing the cart.

## Keyboard / Focus Contract Review

PASS. UI-03 focus recovery and refresh glow remain intact at source level. Ctrl+F, F12, scanner paths, UOM modal, Payment modal, ProductPicker, and bill-discount numpad behavior are not touched by the UI-04 implementation diff.

## Files Reviewed

- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/reports/latest-developer-report.md`
- `docs/reports/latest-agy-review.md`
- `src/pages/POSPage.tsx`
- `src/pages/POSPage.css`
- `src/pages/POSPage.keyboard-contract.test.ts`

## Tests / Checks And Results

| Check | Result |
|---|---|
| `git status --short` | Dirty working tree contains UI-04 app files plus workflow/report docs |
| `git diff --name-only` | `POSPage.tsx`, `POSPage.css`, `POSPage.keyboard-contract.test.ts`, workflow docs, developer report, AGY report, Codex report |
| `git diff --stat` | 9 files changed before this report rewrite |
| `git diff --check` | FAIL: trailing whitespace in `docs/reports/latest-agy-review.md:11` |
| `git diff --cached --name-only` | Empty; no staging |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | PASS, 145 tests |
| `npx.cmd vitest run` | PASS, 31 files / 712 tests |
| `git stash list` | `stash@{0}` present and untouched |
| `git rev-parse --short HEAD` | `ce49a82`; no commit performed |

Note: Git emitted warnings about inaccessible global ignore config and LF to CRLF conversion warnings. These did not block the commands; the blocking failure is the AGY report trailing whitespace.

## Boundary Confirmation

- Authorized app files changed: `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, `src/pages/POSPage.keyboard-contract.test.ts`.
- Workflow/report docs changed as expected for the current handoff flow.
- `useCart.ts` untouched.
- `useCart.contract.test.ts` untouched.
- `cartUtils.ts` untouched.
- No cart math changed.
- Checkout/payment business logic untouched.
- Stock matrix untouched.
- Toast untouched.
- Firebase/functions/rules untouched.
- Android/Capacitor untouched.
- `.claude/` untouched.
- No scripts created.
- No UI-05 work found.
- No staging.
- No commit.

## Required Fixes

1. Remove trailing whitespace from `docs/reports/latest-agy-review.md` line 11.
2. Re-run `git diff --check`.

No app code changes are required based on this review.

## Next Owner

Developer Agent

## Next Action

Perform whitespace-only cleanup in `docs/reports/latest-agy-review.md`, rerun `git diff --check`, then return to Codex for a narrow package-hygiene re-check.

---

STATE CARD
Phase: 7C-UI-04-SYNC-AND-MACRO-LAYOUT
Current owner: Codex Reviewer
Verdict: FAIL
Files changed: docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/agent-workflow/STATE.md; docs/reports/latest-agy-review.md; docs/reports/latest-codex-review.md; docs/reports/latest-developer-report.md; src/pages/POSPage.css; src/pages/POSPage.keyboard-contract.test.ts; src/pages/POSPage.tsx
Tests/checks: git status --short reviewed; git diff --name-only reviewed; git diff --stat reviewed; git diff --check FAIL due trailing whitespace in docs/reports/latest-agy-review.md:11; git diff --cached --name-only empty; npx.cmd tsc -b PASS; POSPage.keyboard-contract 145 passed; full vitest 712 passed; stash@{0} present; HEAD ce49a82
Staged: None
Committed: None
Required fixes: Remove trailing whitespace in docs/reports/latest-agy-review.md line 11 and rerun git diff --check
Next owner: Developer Agent
Next action: Whitespace-only cleanup, then return to Codex for narrow re-check
Stop condition: No staging; no commit; do not start UI-05
