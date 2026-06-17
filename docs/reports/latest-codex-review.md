# Codex Review Report

## Phase

**7C-UI-03-POLISH**

## Verdict

**FAIL**

## Summary

The app implementation is correct at code/contract level, but the package cannot pass because `git diff --check` fails on trailing whitespace in `docs/reports/latest-agy-review.md`.

App behavior reviewed:

- The standalone `pos-sync-banner` render block is removed from `POSPage.tsx`.
- Pending manager update now toggles `pos-action-link--update` on the always-present Refresh button.
- Update detection and refresh behavior remain driven by `updateBanner`, `setUpdateBanner(false)`, and `refreshInventory()`.
- Hold-Bill and Suspended-Bills `onClose` handlers now close and call `focusSearch()`.
- Border polish is scoped to `POSPage.css` category pills and Select Customer button.
- No cart math, checkout/payment business logic, stock, Toast, Firebase, Android, or `.claude/` changes were found.

## Findings

### 1. `git diff --check` fails on AGY report trailing whitespace

Severity: **Blocker**

`git diff --check` reports trailing whitespace in `docs/reports/latest-agy-review.md`:

- line 9
- line 11
- line 12
- line 27

This is not an app-code bug, but it fails the repository hygiene gate and must be fixed before commit.

## Code / Behavior Review

- **Banner removal / zero layout shift:** PASS — the conditional `{updateBanner && (...)}` banner mount is gone. The update state changes only the Refresh button class/title, not the DOM structure.
- **Refresh behavior:** PASS — `handleManualRefresh` still clears `updateBanner`, calls `refreshInventory()`, and refocuses the scan box.
- **Hold-Bill close focus:** PASS — `HoldBillNoteModal.onClose` now calls `focusSearch()` after closing.
- **Suspended-Bills close focus:** PASS — `SuspendedBillsListModal.onClose` now calls `focusSearch()` after closing.
- **Modal-owned focus:** PASS — UOM, Payment, ProductPicker multi-UOM sequencing, bill-discount numpad, Ctrl+F, auto-focus, F12, and scanner paths remain intact at source-contract level.
- **Border polish:** PASS at code scope — CSS changes are local to update glow, category pill border, and Select Customer border. AGY recorded PASS for visual validation.

## Files Reviewed

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.css`
- `src/pages/POSPage.keyboard-contract.test.ts`
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`
- `docs/reports/latest-agy-review.md`
- `docs/reports/latest-codex-review.md` (this report)

## Tests / Checks And Results

| Check | Result |
|---|---|
| `git status --short` | Dirty files are UI-03 app files plus workflow/review docs |
| `git diff --name-only` | `POSPage.tsx`, `POSPage.css`, `POSPage.keyboard-contract.test.ts`, workflow docs, developer report, AGY report |
| `git diff --stat` | 8 files, 314 insertions, 250 deletions before this Codex report rewrite |
| `git diff --check` | **FAIL** — trailing whitespace in `docs/reports/latest-agy-review.md` |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | PASS, 142 tests |
| `npx.cmd vitest run` | PASS, 31 files / 709 tests |

## Boundary Confirmation

- [x] App changes are limited to `POSPage.tsx`, `POSPage.css`, and `POSPage.keyboard-contract.test.ts`.
- [x] `useCart.ts` untouched.
- [x] `cartUtils.ts` untouched.
- [x] No cart math changed.
- [x] Checkout/payment business logic untouched.
- [x] Stock matrix untouched.
- [x] Seed data untouched.
- [x] Toast files untouched.
- [x] Firebase/functions/rules untouched.
- [x] Android/Capacitor untouched.
- [x] `.claude/` untouched.
- [x] No scripts created.
- [x] No UI-04 work.
- [x] No staging.
- [x] No commit.
- [x] `stash@{0}` remains present and untouched.

## Required Fixes

1. Remove trailing whitespace in `docs/reports/latest-agy-review.md` so `git diff --check` passes.
2. Re-run `git diff --check`. TypeScript and Vitest do not need code changes based on this review, but re-running the standard validation after cleanup is recommended.

## Notes

- I found no blocker in the app implementation itself.
- The modified `docs/reports/latest-agy-review.md` is expected by the packet’s AGY-before-Codex gate, although the packet’s “Authorized workflow/report files” list does not explicitly include AGY/Codex report files. Tech Lead may want to clarify report-file scope in future packets.

## Next Owner

**Developer Agent**

## Next Action

Clean the trailing whitespace in the AGY report, rerun `git diff --check`, and return to Codex for a narrow re-check.

---

STATE CARD
Phase: 7C-UI-03-POLISH
Current owner: Codex Reviewer
Verdict: FAIL
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.css; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md; docs/reports/latest-agy-review.md; docs/reports/latest-codex-review.md
Tests/checks: git status/diff/diff-stat reviewed; git diff --check FAIL due trailing whitespace in latest-agy-review.md; npx.cmd tsc -b PASS; POSPage.keyboard-contract 142 passed; full vitest 709 passed
Staged: None
Committed: None
Required fixes: Remove trailing whitespace in docs/reports/latest-agy-review.md and rerun git diff --check
Next owner: Developer Agent
Next action: Fix whitespace-only report hygiene issue, then return to Codex for narrow re-check
Stop condition: No staging; no commit; do not start UI-04
