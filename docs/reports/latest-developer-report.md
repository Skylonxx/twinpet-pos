# Developer Report

## Phase

**7C-UI-02-HOTFIX-FOCUS-EDGE** — Comprehensive POS Focus Recovery Edge Hotfix

## 1. Summary

Extended the scanner focus-recovery line (`42ff3ed`) to the remaining POS controls that Physical UAT found stealing focus and never returning it to the scan box. Goal: **zero focus drops** — every non-modal cart/bill control returns focus to `searchInputRef` after its action resolves, and the cash/shift/clear-cart modals return focus on close/resolution — without ever stealing focus from a modal that should own it (UOM / Payment / bill-discount numpad). Implemented with a single shared rAF-deferred helper `runAndRefocus(action)` for the inline controls, plus direct `focusSearch()` calls on the modal close/resolution handlers. **No CSS change; no cart math change.**

## 2. Files Changed

| File | Action | Description |
|---|---|---|
| `src/pages/POSPage.tsx` | Modified | Added shared `runAndRefocus(action)` helper; wired it into qty ＋/−, remove-line, fee chips, and bill-discount ฿/% toggles; added `focusSearch()` to `handleCashTxRecorded`, `CashTransactionModal.onClose`, `CloseShiftModal.onClose`, and `DestructiveConfirmModal.onCancel`. |
| `src/pages/POSPage.keyboard-contract.test.ts` | Modified | Added `7C-UI-02-HOTFIX-FOCUS-EDGE` describe block (9 tests) covering all targets + a modal-ownership regression guard. |

`src/pages/POSPage.css` — **not modified.** `useCart.ts`, `cartUtils.ts`, checkout/payment, stock matrix, toast, seed, Firebase, Android, `.claude/` — untouched.

## 3. CURRENT_PACKET.md Update Confirmation — all 9 targets

`docs/agent-workflow/CURRENT_PACKET.md` updated for phase `7C-UI-02-HOTFIX-FOCUS-EDGE` with the CEO UAT issue summary and **all 9 mandatory focus-recovery targets** (Cash In/Out, Close Shift, Clear Cart, Remove Line, Qty ＋, Qty −, Add/Edit Fee, Discount Baht, Discount Percent), the critical focus rules, the role sequence (Developer → Codex → Tech Lead/CEO), the AGY bypass note, and explicit role files for each role. ✅

## 4. Implementation Details

All runtime changes are in `src/pages/POSPage.tsx`:

- **Shared helper `runAndRefocus(action)`** — declared right after `focusSearch` (`deps: [focusSearch]`): runs the mutation, then calls the existing rAF-deferred `focusSearch()`. Because the refocus is deferred to the next animation frame, it lands **after** React commits the re-render — so it survives state-driven re-renders and the removed line unmounting. It only appends a focus call; mutation semantics are untouched.
- **Non-modal controls** now call `runAndRefocus(() => cart.<mutation>(…))`:
  - qty − `cart.changeQty(line.lineKey, -1)`, qty ＋ `cart.changeQty(line.lineKey, 1)`
  - remove `cart.removeLine(line.lineKey)`
  - fee chips `cart.setFeeRate(rate)`
  - bill-discount toggles `cart.setBillDiscPercent(false)` (฿) and `cart.setBillDiscPercent(true)` (%)
- **Modal close/resolution handlers** call `focusSearch()` directly (consistent with the file's other modal-close handlers):
  - `handleCashTxRecorded` (Cash In/Out success) — refocus after `setShowCashTx(false)` (dep `[focusSearch]`).
  - `CashTransactionModal.onClose` — refocus after `setShowCashTx(false)`.
  - `CloseShiftModal.onClose` — refocus after `setShowCloseShift(false)`; the success path already routes through `handleNewSale`, which refocuses.
  - `DestructiveConfirmModal.onCancel` — refocus after dismissing (the confirm originates from a cart/topbar button); the `onConfirm` branches already refocus.

### What was deliberately NOT changed (to avoid stealing modal-owned focus)

- The bill-discount **numpad** (`NumpadDialog`) keeps its own `onConfirm`/`onClose`/`onClear` refocus — the ฿/% toggles only switch mode and refocus; the value entry stays modal-owned until the numpad closes.
- The bill-discount number `<input>` `onChange` is **not** refocused (would break typing); entry is primarily via the numpad, which refocuses on close.
- UOM modal, Payment modal, ItemDiscount modal, qty numpad — all retain their existing focus behavior.

## 5. Focus Recovery Target-by-Target Checklist

| # | Target | Mechanism | Status |
|---|---|---|---|
| 1 | Cash In / Cash Out | `CashTransactionModal.onClose` + `handleCashTxRecorded` → `focusSearch()` | ✅ |
| 2 | Close Shift | `CloseShiftModal.onClose` → `focusSearch()`; success via `handleNewSale` (already refocuses) | ✅ |
| 3 | Clear Cart | confirm `onConfirm` (existing) + `onCancel` (new) → `focusSearch()` | ✅ |
| 4 | Remove Line Item | `runAndRefocus(() => cart.removeLine(line.lineKey))` (rAF survives unmount) | ✅ |
| 5 | Quantity Increment (＋) | `runAndRefocus(() => cart.changeQty(line.lineKey, 1))` | ✅ |
| 6 | Quantity Decrement (−) | `runAndRefocus(() => cart.changeQty(line.lineKey, -1))` | ✅ |
| 7 | Add/Edit Fee | `runAndRefocus(() => cart.setFeeRate(rate))` | ✅ |
| 8 | Discount Baht (฿) | `runAndRefocus(() => cart.setBillDiscPercent(false))` | ✅ |
| 9 | Discount Percent (%) | `runAndRefocus(() => cart.setBillDiscPercent(true))` | ✅ |

## 6. Tests / Checks Run

| Check | Result |
|---|---|
| `git status --short` | `M src/pages/POSPage.tsx`, `M src/pages/POSPage.keyboard-contract.test.ts` (+ workflow/report docs) |
| `git diff --name-only` | `POSPage.tsx`, `POSPage.keyboard-contract.test.ts` (+ workflow/report docs) |
| `git diff --stat` | `POSPage.tsx | 49`, `POSPage.keyboard-contract.test.ts | 68` |
| `git diff --check` | clean |
| `git diff -- src/pages/POSPage.css` | empty (untouched) |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | **137 passed** (was 128; +9 edge tests) |
| `npx.cmd vitest run` | **704 passed (31 files)** |

### New tests (describe `7C-UI-02-HOTFIX-FOCUS-EDGE`, 9 tests)

`runAndRefocus` order (mutate→refocus); qty ＋/−; remove line; fee chips; ฿/% toggles; Cash In/Out (close + success); Close Shift (close + `handleNewSale`); Clear Cart confirm AND cancel; and a regression guard that UOM still owns focus (2 `focusSearch()` in its region) and the ProductPicker multi-UOM fix (`if (!pickerWillOpenUomRef.current) focusSearch();`) is intact.

### Test limitation note

The suite runs in a `node` environment with source-level `?raw` assertions (POSPage cannot be mounted here — heavy Firebase/router/cart harness). These tests pin structural intent (the mutation is followed by a refocus via the shared helper / modal handler) rather than live DOM focus. The highest-risk paths (qty ＋/−, remove, fee, discount, cash/shift/clear modals) are all covered; physical UAT remains the behavioral confirmation.

## 7. Boundary Confirmation

- [x] `POSPage.css` untouched (no UI style change)
- [x] No cart math change (helper only appends a focus call after the existing mutation)
- [x] `useCart.ts` / `useCart.contract.test.ts` / `cartUtils.ts` untouched
- [x] Checkout / payment business logic untouched
- [x] Stock matrix untouched; seed data untouched; Toast untouched
- [x] Firebase / functions / rules untouched; Android / Capacitor untouched; `.claude/` untouched
- [x] No scripts created; no new dependencies
- [x] Only authorized files changed; no UI-03 work
- [x] No staging, no commit; `stash@{0}` untouched (only `git stash list` used)

## 8. Hidden Risks / Notes

- **Multiple rAF refocuses can coexist.** Rapid clicking (e.g. ＋＋＋) schedules several `requestAnimationFrame` focus calls on the same stable input — harmless (last one wins; no modal in the way).
- **Modal-owned focus respected.** The ฿/% toggles refocus the scan box, but the discount *value* numpad keeps its own modal-close refocus, so switching mode does not yank focus out of an open numpad (the toggles live in the footer row, not inside the numpad).
- **rAF (not setTimeout).** Reused the proven rAF helper rather than `setTimeout(…,0)`; the directive allowed either. rAF fires after commit and before paint, which is sufficient for the re-render and the remove-line unmount. If physical UAT shows a specific control still dropping focus, a layered rAF+timeout is the next lever — flagged for Codex.
- **No DOM/runtime test** for live focus (node env, by design) — structural-intent coverage + physical UAT.

## 9. Next Owner and Next Action

**Next owner: Codex Reviewer** (ROLE FILE: `docs/ai-roles/reviewer.md`). Human operator sends Codex the current packet, this report, and the current `git diff` for behavior/code/keyboard-contract review (AGY bypassed — behavioral hotfix). On Codex PASS / PASS WITH NOTES, route to Principal Engineer Reviewer / Tech Lead for closure memo and exact staging/commit commands. Do not stage or commit. Do not start UI-03.

---

STATE CARD
Phase: 7C-UI-02-HOTFIX-FOCUS-EDGE
Current owner: Developer (complete) → Codex Reviewer
Verdict: In Progress — Developer implementation complete, awaiting Codex review
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md (POSPage.css NOT modified)
Tests/checks: git diff --check clean; POSPage.css diff empty; tsc -b PASS; POSPage.keyboard-contract 137 passed; full vitest 704 passed
Staged: None
Committed: None
Required fixes: None
Next owner: Codex Reviewer (ROLE FILE: docs/ai-roles/reviewer.md)
Next action: Human operator sends Codex the current packet + this report + current diff using ROLE FILE: docs/ai-roles/reviewer.md; AGY bypassed unless explicitly requested
Stop condition: No staging, no commit, no UI-03+, no CSS change, no cart/checkout/stock work; stash@{0} untouched; wait for Codex review
