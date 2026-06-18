# Latest Developer Report

## Phase

7C-UI-06-HOTFIX-DISCOUNT-UI -- authorized hotfix after CEO Physical UAT failed on the UI-06 commit (`630b742`).

## 1. Summary

Three targeted UI hotfixes were implemented for the UAT-failed issues. All changes are presentation / interaction only; no business logic was touched. Preflight matched expectations: working tree clean, HEAD at `630b742`, staging empty, `stash@{0}` present and untouched. TypeScript build passed (`tsc -b`, exit 0). Targeted POS tests passed (235) and the full Vitest unit suite passed (727 tests, 32 files). `git diff --check` PASS. Nothing staged, nothing committed.

- Fix 1: the cart row discount badge now displays the actual formatted discount amount and no longer cramps/overflows.
- Fix 2: the item discount modal value input opens the custom on-screen numpad on touch.
- Fix 3: the bill-discount (and item-discount) numpad no longer flashes and instantly closes on iPad/touch.

## 2. Files changed

App:
- src/pages/POSPage.tsx -- cart row discount badge now renders the formatted amount.
- src/pages/POSPage.css -- `.pos-ci-disc-tag` readability (inline-block, nowrap, padding).
- src/components/pos/ItemDiscountModal.tsx -- value input opens the custom numpad; numpad element added.
- src/components/pos/NumpadDialog.tsx -- backdrop dismiss changed from onClick to onPointerDown.

Docs:
- docs/agent-workflow/STATE.md
- docs/agent-workflow/CURRENT_PACKET.md
- docs/agent-workflow/NEXT_ACTION.md
- docs/reports/latest-developer-report.md (this report)

No conditional test files were modified (the `?raw` contract suites stay green unchanged; no asserted substring/region was removed, so no test edit was justified).

## 3. Files inspected

- src/pages/POSPage.tsx (cart row block; bill-discount trigger block; numpad invocations; ESC/F12 handlers).
- src/components/pos/NumpadDialog.tsx and NumpadDialog.css (overlay z-index 660).
- src/components/pos/ItemDiscountModal.tsx.
- src/lib/pos/cartUtils.ts (getLineTotal / formatMoney; read-only, not modified).
- src/lib/dashboard/format.ts (fmtBaht returns the "฿1,234.00" form with decimals).
- src/pages/POSPage.keyboard-contract.test.ts and product-card.test.ts (to confirm no `?raw` assertion is broken).
- src/pages/POSPage.css (.pos-modal-bg z-index 500, confirming numpad 660 layers above the modal).

## 4. Fix 1 -- discount badge details

- Root issue: the badge rendered a static label ("มีส่วนลด") with no amount, in a small pill that read as cramped and could overflow.
- Change (POSPage.tsx): added a display-only value `discAmount = line.unitPrice * line.qty - finalPrice`, where `finalPrice = getLineTotal(line)` is already computed in the row. The badge now renders `ลด {fmtBaht(discAmount, { decimals: 2 })}` and is gated on `hasDisc && discAmount > 0` (so a price-override that does not reduce the price shows no false discount).
- Change (POSPage.css): `.pos-ci-disc-tag` set to `display: inline-block; white-space: nowrap; font-weight: 500;` with padding raised to `2px 6px`, so the amount stays on one line (never breaks mid-number) and wraps as a whole unit on narrow rows.
- No new discount math: the amount is the difference of two values the row already computes; `getLineTotal` (the real discount calculation in cartUtils) is unchanged. Line total math is untouched.

## 5. Fix 2 -- item discount modal numpad wiring details

- Root issue: the modal used a native `<input type="number">`, so on touch terminals it opened the native keyboard instead of the custom on-screen numpad.
- Change (ItemDiscountModal.tsx): added `numpadOpen` state; the value input now has `onPointerDown` that calls `e.preventDefault()` (suppresses native focus/keyboard) and opens the numpad -- mirroring the existing bill-discount field. A `NumpadDialog` (with `allowDecimal` + `allowZero`, `maxLength={7}`, `initialValue={num}`, `title={IDP_LABELS[mode]}`) is rendered; `onConfirm` writes the value back via `setValue(String(v))` and closes.
- Preserved: keyboard (Tab) editing still works for desktop; the existing Save button still applies the discount via `onSave` (no auto-submit); discount math unchanged; modal open/close behavior unchanged. The numpad portals to `document.body` and layers above the modal (z-index 660 vs 500).

## 6. Fix 3 -- bill discount touch/focus race root cause and fix

- Root cause: the bill-discount input opens the numpad on `onPointerDown` (with `preventDefault`). On a touch tap the browser emits, after the pointer events, COMPATIBILITY mouse events (`mousedown`, `mouseup`, `click`) at touch-end. By then the numpad portal/overlay has already rendered under the finger. The `NumpadDialog` backdrop closed on `onClick` with `e.target === e.currentTarget`, so that ghost `click` -- part of the very tap that opened the dialog -- landed on the fresh backdrop and immediately closed it (flash-and-close). The qty numpad never showed this because it opens on a button's `onClick` (touch-end), after which no further click is dispatched in the same gesture.
- Racing event path: input `pointerdown` (opens dialog) -> same tap's compatibility `mousedown`/`mouseup`/`click` dispatched to the just-rendered backdrop -> backdrop `onClick` -> `onClose()`.
- Exact mitigation: the `NumpadDialog` backdrop now dismisses on `onPointerDown` (still gated by `e.target === e.currentTarget`) instead of `onClick`. The opener's `pointerdown` lands on the input BEFORE the overlay exists, and the ghost compatibility events are MOUSE/click events -- which do not trigger a pointerdown handler -- so the opening tap can no longer dismiss the dialog. A genuine separate outside press still emits its own `pointerdown` on the backdrop and closes it. Desktop mouse closes on its real pointerdown; the qty numpad (opened on a button click) is unaffected.
- Why it does not affect cart math or checkout/payment: the change is purely the backdrop's dismiss event binding (onClick -> onPointerDown). It alters no value, no confirm path, no setter (`setBillDiscValue`, `setLineDiscount`, `setLineQty` are untouched), and no checkout/payment code. Confirm is still `onClick={handleConfirm}`; Clear and keys are unchanged.

## 7. Tests / checks run and results

- `npx tsc -b` -- exit 0 (TypeScript build PASS).
- `npx vitest run src/pages/POSPage.keyboard-contract.test.ts src/pages/POSPage.product-card.test.ts src/hooks/pos/useCart.contract.test.ts` -- 3 files passed, 235 tests passed, 0 failed.
- `npx vitest run` (full unit suite) -- 32 files passed, 727 tests passed, 0 failed.
- `git diff --check` -- PASS (no whitespace / conflict-marker errors).

Note: the POS contract suites are source-level `?raw` assertions in a node env with no DOM. The NumpadDialog touch-only guards (no `onKeyDown` / `isComposing` / `Escape`; confirm still `onClick`) remain satisfied after the backdrop change.

## 8. Scope boundary confirmation

- no cart math changed: confirmed
- no discount calculation changed: confirmed (getLineTotal / cartUtils untouched)
- no total calculation changed: confirmed
- no pricing/tax logic changed: confirmed
- no checkout/payment calculation changed: confirmed
- no stock/inventory changed: confirmed
- no useCart business rules changed: confirmed
- no cartUtils calculation changed: confirmed
- no Firebase/functions/rules: confirmed
- no Android/Capacitor: confirmed
- no .claude: confirmed
- no scripts/tooling: confirmed
- no UI-07/UI-08/UI-09: confirmed

## 9. AGY Review Result

- AGY verdict: **PASS** (confirmed from `docs/reports/latest-agy-review.md`).
- AGY confirmed: discount badge amount displays correctly, numpad wiring works on touch, backdrop race fix resolves the flash-and-close, no regressions.
- `docs/reports/latest-agy-review.md` was modified during the AGY review step as an AGY-generated review artifact. It is included in the package file list.

## 10. Codex Review Result

- Codex verdict: **REQUEST CHANGES**.
- App hotfix scope: **confirmed safe by Codex** (all four app files verified, no business logic changes).
- Codex blockers (docs/hygiene only):
  1. Trailing whitespace in `docs/reports/latest-agy-review.md` line 11 -- FIXED (removed trailing space).
  2. Documentation evidence mismatch: developer report claimed git diff --check PASS, but Codex found it FAIL due to the AGY report trailing whitespace -- FIXED (this section now documents the sequence: Codex found the failure, Developer fixed it, rerun git diff --check PASS).
  3. Stale handoff routing: STATE.md and NEXT_ACTION.md still routed to AGY after AGY had completed -- FIXED (updated to reflect AGY PASS, Codex REQUEST CHANGES, Developer fix, then Codex re-review).
- No app code changed during this fix cycle.
- STATE.md updated because it had stale owner/routing (Rule 3).

## 11. Git status (after Codex blocker fix)

- git status --short:
  - M src/pages/POSPage.tsx
  - M src/pages/POSPage.css
  - M src/components/pos/ItemDiscountModal.tsx
  - M src/components/pos/NumpadDialog.tsx
  - M docs/agent-workflow/STATE.md
  - M docs/agent-workflow/CURRENT_PACKET.md
  - M docs/agent-workflow/NEXT_ACTION.md
  - M docs/reports/latest-developer-report.md
  - M docs/reports/latest-agy-review.md
- git diff --name-only: the nine files above.
- git diff --stat: four app files plus five docs.
- git diff --check: PASS (after trailing whitespace fix).
- git diff --cached --name-only: empty (nothing staged).

## 12. Staging / commit confirmation

- staged: no
- committed: no

## 13. Next owner

Codex Reviewer (focused re-review after docs/hygiene fix).

## 14. Stop condition

Stop after this report. No staging, no commit. Waiting for Codex focused re-review. Do not route to Principal Engineer until Codex returns PASS or PASS WITH NOTES.

## STATE CARD

```
STATE CARD
Phase: 7C-UI-06-HOTFIX-DISCOUNT-UI
Current owner: Developer (fixing Codex REQUEST CHANGES blockers)
Verdict: Codex REQUEST CHANGES (docs/hygiene blockers); AGY PASS; app scope confirmed safe
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.css; src/components/pos/ItemDiscountModal.tsx; src/components/pos/NumpadDialog.tsx; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md; docs/reports/latest-agy-review.md
Files inspected: POSPage.tsx; NumpadDialog.tsx/.css; ItemDiscountModal.tsx; cartUtils.ts; dashboard/format.ts; POSPage.keyboard-contract.test.ts; POSPage.product-card.test.ts; POSPage.css
Tests/checks: tsc -b exit 0; vitest targeted 235 passed; vitest full 727 passed (32 files); git diff --check PASS (after fix)
Staged: no
Committed: no
Required fixes: trailing whitespace, stale routing, evidence mismatch (all fixed)
Next owner: Codex Reviewer
Next action: Codex focused re-review of full package with docs/hygiene fixes applied
Stop condition: No staging, no commit; wait for Codex re-review
```
