# Codex Review Report

## Phase

**7C-UI-02-HOTFIX-FOCUS**

## Verdict

**PASS WITH NOTES**

## Summary

Revision 2 fixes the prior Codex blocker. ProductPicker confirm now computes whether the confirmed selection will open `UomModal`, suppresses scan-box refocus for the entire batch when needed, and makes picker `onClose` skip `focusSearch()` while a UOM modal is pending/opening. The direct product-card, category, refresh, sort, payment, Ctrl+F, auto-focus, F12, and scanner contracts remain intact at source level and in the keyboard-contract test suite.

## Prior Blocker Status

**Fixed.**

Previous blocker: ProductPicker confirm with a multi-UOM product called `onConfirm(...)` then `onClose()`, and POS picker `onClose` unconditionally called `focusSearch()`, which could focus the scan box behind the about-to-open UOM modal.

Current behavior reviewed:

- `ProductPickerDialog` still calls `onConfirm(selectedProducts)` then `onClose()` synchronously.
- `POSPage.tsx` now uses `pickerWillOpenUomRef` to bridge that synchronous confirm/close pair.
- ProductPicker `onConfirm` resolves selected products, computes `willOpenUom`, calls `onProductClick(product, { skipFocus: willOpenUom })`, then records `pickerWillOpenUomRef.current = willOpenUom`.
- ProductPicker `onClose` now calls `focusSearch()` only when `pickerWillOpenUomRef.current` is false, then resets the ref.
- `onProductClick` still does not refocus in the direct multi-UOM branch.
- Standard single-UOM direct card clicks still refocus unless explicitly suppressed by a mixed ProductPicker batch that will open UOM.

This addresses the issue without changing cart math or UOM selection behavior.

## Files Reviewed

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.keyboard-contract.test.ts`
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`
- `docs/reports/latest-codex-review.md` (this report)
- Related read-only context: `src/components/products/ProductPickerDialog.tsx`, `src/components/PaymentModal.tsx`

## Behavior Review

- Standard product card click: **PASS** — single-UOM `cart.addToCart(...)` path calls `focusSearch()` unless intentionally suppressed by ProductPicker batch UOM sequencing.
- Direct multi-UOM product card click: **PASS** — enqueue branch still does not call `focusSearch()`.
- ProductPicker confirm with multi-UOM product: **PASS** — guarded by `willOpenUom`, `skipFocus`, and `pickerWillOpenUomRef`.
- ProductPicker confirm with standard-only products: **PASS** — no UOM pending, so picker close restores focus.
- ProductPicker cancel/plain close: **PASS** — ref defaults false, so close restores focus.
- Category tabs / quick menus: **PASS** — `selectCategory` and `selectQuickMenu` restore focus.
- Refresh button / sync banner: **PASS** — both route through `handleManualRefresh`, which restores focus.
- Sort modal close: **PASS** — close restores focus.
- Select picker open/close: **PASS** — focus returns on close when no UOM modal is pending.
- UOM modal: **PASS** — modal select/close remains the path that restores focus after UOM ownership ends.
- Payment modal: **PASS** — close/focus behavior and processing guard remain intact.
- Ctrl+F, auto-focus, F12, scanner Enter logic: **PASS** — source wiring is preserved and focused contract tests pass.

## Tests / Checks And Results

| Check | Result |
|---|---|
| `git status --short` | Dirty files limited to active TSX/test/docs/report scope |
| `git diff --name-only` | `POSPage.tsx`, `POSPage.keyboard-contract.test.ts`, workflow docs, developer report, Codex report |
| `git diff --stat` | 7 files, 455 insertions, 234 deletions before this report rewrite |
| `git diff --check` | PASS |
| `git diff -- src/pages/POSPage.css` | Empty / untouched |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | PASS, 128 tests |
| `npx.cmd vitest run` | PASS, 31 files / 695 tests |

## Boundary Confirmation

- [x] `POSPage.css` unchanged / no UI-02 style regression in diff.
- [x] No cart math changed.
- [x] `useCart.ts` untouched.
- [x] `cartUtils.ts` untouched.
- [x] Checkout/payment logic untouched.
- [x] Stock matrix untouched.
- [x] Seed data untouched.
- [x] Toast files untouched.
- [x] Firebase/functions/rules untouched.
- [x] Android/Capacitor untouched.
- [x] `.claude/` untouched.
- [x] No scripts created.
- [x] No UI-03 work.
- [x] No staging.
- [x] No commit.
- [x] `stash@{0}` remains present and untouched.

## Notes

- This review validates source behavior and contract tests. It is not a browser/physical focus UAT; physical scanner UAT should still confirm the cashier workflow on the target device.
- The ProductPicker batch behavior intentionally suppresses focus for all products in a mixed selection if any selected product opens UOM. That is the correct tradeoff because modal-owned focus is more important than immediate scan-box focus while UOM selection is pending.

## Required Fixes

None.

## Next Owner

**Principal Engineer Reviewer / Workflow Coordinator**

## Next Action

Prepare closure handoff for Tech Lead / CEO. Do not stage or commit until exact commands are authorized.

---

STATE CARD
Phase: 7C-UI-02-HOTFIX-FOCUS
Current owner: Codex Reviewer
Verdict: PASS WITH NOTES
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md; docs/reports/latest-codex-review.md
Tests/checks: git status/diff/diff-stat/diff-check reviewed; POSPage.css diff empty; npx.cmd tsc -b PASS; POSPage.keyboard-contract 128 passed; full vitest 695 passed
Staged: None
Committed: None
Required fixes: None
Next owner: Principal Engineer Reviewer / Workflow Coordinator
Next action: Prepare Tech Lead / CEO closure handoff and exact commit authorization request
Stop condition: Stop after review; no staging; no commit; wait for human operator
