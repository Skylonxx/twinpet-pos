# Phase 7C-D4-C Modal Focus & IME Fix Planning

> **Status:** READ-ONLY PLANNING ONLY. No implementation. No runtime/keyboard/focus/test changes.
> **Authorization:** Tech Lead / CEO — D4-C Modal Focus & IME Fix Planning (after D4-A closure/commit `74371db`).
> **Baseline:** HEAD `74371db test(pos): add keyboard contract coverage`; `stash@{0}` present and untouched.
> **Controlling docs:** `docs/reports/phase-7c-d2-pos-cashier-ux-boundary-audit.md`, `docs/reports/phase-7c-d3-b-pos-keyboard-focus-audit.md`, contracts locked by `src/pages/POSPage.keyboard-contract.test.ts`.

## Executive Summary

D3-B mapped four keyboard/focus weaknesses; D4-A then **locked the current behavior** in 22 source-level contract tests. This blueprint plans the *future* fixes — **no code is changed here**. The four work items, in risk order:

1. **IME/composition guard** on the scan input (Yellow, highest real risk): a Thai-IME `Enter` that commits composition can also fire `findByScanCode`→`addToCart`. The fix is a narrow guard on `handleSearchKeyDown` that ignores `Enter` while composing, **without** slowing hardware-scanner input (scanners emit no composition events).
2. **F12 modal suppression** (Yellow): the single global F12 listener stays active while any modal is open, so F12 can stack `PaymentModal` over another modal. The fix gates F12 on "no POS modal open."
3. **Focus-return consistency** (Yellow): focus returns to `#pos-search` after most close paths but **not** after UOM / ItemDiscount / Numpad / category-overlay close. The fix routes those closes through `focusSearch()`.
4. **Escape behavior consistency** (Yellow): Escape-to-close exists today **only** on `CustomerPickerModal` (input-level) and `DestructiveConfirmModal` (overlay-level, `!loading`-guarded); the other modals have none. The fix is a per-modal Escape map (Red modals — Payment / OpenShift — get deliberate, guarded treatment, not blanket dismissal).

Every item is Yellow/Red-adjacent: each requires its **own** authorization, test updates, and Codex review before any implementation. **The Red payment-confirm path is explicitly out of scope** — none of these fixes may add a *global or modal-level* `Enter`-to-confirm shortcut for `PaymentModal`. (The existing `.pay-confirm` native button is already keyboard-activatable via Enter/Space when focused — that is part of the current Red surface and must be preserved with its existing guards, not removed.)

## Scope and Baseline

Read-only planning for the four D3-B follow-ups (IME guard, F12 suppression, focus-return, Escape map). Baseline HEAD `74371db`; the contracts under discussion are pinned by the D4-A spec. No runtime, test, or CSS file is modified by this phase. Classifications reuse the project Green (presentation-only) / Yellow (interaction-sensitive) / Red (transactional write-path) scheme.

## Files / Areas Inspected (read-only)

- `src/pages/POSPage.tsx` — `findByScanCode` (`:51`), `focusSearch` (`:327`), `handleSearchKeyDown` (`:342`), `handleHoldConfirm` (`:391`/focus `:410`), `handleRestoreBill` (`:415`/focus `:426`), F12 listener (`:467–476`), search `autoFocus` (`:498`), checkout `disabled` (`:928`), modal wiring `UomModal` (`:937`), `ItemDiscountModal` (`:946`), `CustomerPickerModal` (`:967`), `PaymentModal` (`:980`), `NumpadDialog` (`:1107`), `DestructiveConfirmModal` (`:1125–1147`).
- `src/components/PaymentModal.tsx` — confirm guard (`:229`), confirm button (`:667–674`), `pay-modal-bg` (`:411`, no backdrop `onClick`).
- `src/components/customers/CustomerPickerModal.tsx` — RAF search focus (`:59`), **input-level Escape→onClose** (`:102–104`), overlay backdrop close (`:84`).
- `src/components/pos/NumpadDialog.tsx` — touch-only, backdrop `currentTarget`→onClose (`:66–68`), confirm `onClick` (`:96`).
- `src/components/pos/ShiftModals.tsx` — `OpenShiftModal` `autoFocus`+Enter→`handleOpen` (`:75–78`); `CloseShiftModal` `autoFocus`+backdrop close-when-`!closedShift` (`:289–290`).
- `src/components/pos/SuspendedBillModals.tsx` — `HoldBillNoteModal` `setTimeout` focus + Enter→confirm (`:22`,`:63–68`); `SuspendedBillsListModal` backdrop close.
- `src/components/pos/CashTransactionModal.tsx` — `autoFocus` (`:113`), backdrop `currentTarget`→onClose (`:67`), no Enter handler.
- `src/components/common/DestructiveConfirmModal.tsx` — overlay-level Escape→onCancel when `!loading` (`:88–93`), overlay click→onCancel (`:87`).
- `src/components/pos/SortingSettingsModal.tsx` — overlay `onClick`→onClose (`:437`); `ss-*` namespace (POS-protected per prior phases).
- `src/components/pos/UomModal.tsx`, `src/components/pos/ItemDiscountModal.tsx` — no Escape/Enter/autoFocus/backdrop close.

## Current Keyboard / Focus Contract Summary

- **Scan:** `#pos-search` owns mount focus; `handleSearchKeyDown` acts only on `Enter` → `findByScanCode` (top-level SKU/barcode before UOM-specific barcode) → add/`onProductClick`, then `setSearch('')`+`focusSearch()`; miss → toast only (text preserved). **No IME guard.**
- **Global shortcut:** exactly one `window keydown`; `F12`→`preventDefault`+open payment iff `cartLines.length>0 && activeShift`; cleaned up on unmount. Active during modals.
- **Checkout parity:** button `disabled={cartLines.length===0 || !activeShift}` = De-Morgan complement of the F12 gate.
- **Focus-return present:** scan add, customer close/select, new sale, hold, restore, clear-cart, cancel-parked, payment close. **Absent:** UOM, ItemDiscount, Numpad, category overlay.
- **Escape present:** CustomerPicker (input-level), DestructiveConfirm (overlay-level, `!loading`). **Absent elsewhere.**
- **Payment confirm:** native `<button>` (keyboard-activatable when focused) guarded by `!canConfirm||confirming||processing`; no extra modal-level key handler. **Red.**

## IME / Composition Guard Plan

**Current (`handleSearchKeyDown`, `:342`):** `if (e.key !== 'Enter') return;` then trims and scans. There is no `isComposing`/`compositionstart`/`compositionend` check (locked by the D4-A test `GAP (locked): scan input has NO IME/composition guard today`).

**Risk:** a Thai-IME user pressing `Enter` to commit a composition can have that same `Enter` interpreted as a scan, firing `findByScanCode`/`addToCart` on a half-typed string — a wrong-item or phantom add.

**Recommended future behavior (NOT implemented here):**
- Guard `Enter` while composing: ignore the scan when `e.nativeEvent.isComposing` is true (and/or `e.keyCode === 229`, the legacy composing sentinel). React exposes `isComposing` on the native event; this is the standard, scanner-safe approach.
- **Scanner-speed preservation:** hardware barcode scanners emit synthetic keystrokes with **no composition events**, so `isComposing` is always false for them — the guard adds zero latency to scanning. Only genuine IME commits are suppressed.
- Do **not** debounce or add timers (would slow scanners and risk dropped scans).
- Optionally track `onCompositionStart`/`onCompositionEnd` state as a fallback for browsers with inconsistent `isComposing`, but prefer the single `isComposing` check first to minimize surface area.

**Exact future test updates required (before implementation):**
- Flip the locked `GAP` test: assert the handler now references `isComposing` (and/or guards `keyCode === 229`) **before** invoking `findByScanCode`.
- Add a contract assertion that the early `if (e.key !== 'Enter') return;` short-circuit and the trim/empty guard are preserved.
- Add a note that hardware-scanner behavior is unchanged (documented invariant; not unit-testable at source level — flag for keyboard UAT).
- Keep all other scan match/miss assertions green (no regression to priority/clear/toast contracts).

## F12 Modal Suppression Plan

**Current (`:467–476`):** one `window keydown`; `F12`→`preventDefault`+open payment iff `cartLines.length>0 && activeShift`; deps `[cartLines.length, activeShift]`. The listener does not consider open modals, so F12 fires even while `UomModal`/`ItemDiscountModal`/`NumpadDialog`/`CustomerPickerModal`/`PaymentModal`/shift/hold/suspended/destructive/sorting modals are open → can **stack** `PaymentModal` over them.

**Recommended future behavior (NOT implemented here):**
- Add an "any POS modal open" predicate derived from existing open-state (e.g. `paymentOpen`, `uomProduct`, `discountLineKey`, `qtyNumpadLineKey`, `pickerOpen`, `customerModalOpen`, `holdNoteOpen`, `suspendedListOpen`, `confirmModalState.open`, `isSortingModalOpen`, plus the shift gate). When any is true, F12 returns without opening payment.
- Keep `preventDefault` on F12 unconditionally (so devtools never opens on the cashier terminal) but **suppress the open action** when a modal is up.
- Preserve the existing open gate (`cartLines.length>0 && activeShift`) and its De-Morgan parity with the checkout button.
- Re-confirm the single-listener + cleanup invariant; expand the dependency array to include the modal-open signals so the closure stays current.

**Exact future test updates required (before implementation):**
- Extend the F12 parity test: assert the listener now also gates on a "no modal open" condition (source-level: the new predicate name appears inside the `onKey` body before `setPaymentOpen(true)`).
- Assert the single-listener and `removeEventListener` cleanup invariants still hold, and the dependency array includes the new modal-open signals.
- Add a keyboard-UAT note (stacking is a runtime behavior; source-level tests can only prove the guard is wired).

## Focus-return Consistency Plan

| Close path | Current focus-return | Recommended future | Risk |
|---|---|---|---|
| Scan add (`:359`) | ✅ `focusSearch()` | unchanged | Yellow |
| Customer close/select (`:972`/`:976`) | ✅ | unchanged | Yellow |
| New sale (`:375`) | ✅ | unchanged | Yellow |
| Hold (`:410`) | ✅ | unchanged | Yellow |
| Restore (`:426`) | ✅ | unchanged | Yellow |
| Clear cart (`:1138`) | ✅ | unchanged | Yellow |
| Cancel parked (`:1142`) | ✅ | unchanged | Yellow |
| Payment close (`:997`, post-`processing`) | ✅ | unchanged | Yellow |
| **UOM modal close/select (`:939–944`)** | ❌ none | add `focusSearch()` in `onSelect` + `onClose` | Yellow |
| **ItemDiscount save/close (`:948–953`)** | ❌ none | add `focusSearch()` in `onSave`/`onClose` | Yellow |
| **NumpadDialog confirm/close (`:1111–1116`)** | ❌ none | add `focusSearch()` after `setQtyNumpadLineKey(null)` (both confirm & close) | Yellow |
| **Category overlay close (`:1051`)** | ❌ none | add `focusSearch()` on overlay close | Yellow |

**Notes:** Use the existing `focusSearch()` helper (RAF-based) for consistency; do not introduce a new focus mechanism. The Numpad case must return focus on **both** confirm and close, and only after the line-key is cleared so the modal has fully unmounted before the RAF callback runs.

**Exact future test updates required (before implementation):**
- Flip the three locked GAP tests (UOM, ItemDiscount, NumpadDialog) from `not.toContain('focusSearch')` to region-scoped **presence** assertions.
- Add a category-overlay focus-return assertion.
- Preserve the existing present-path assertions (hold/restore/clear/cancel/customer/payment/new-sale) unchanged.

## NumpadDialog Focus-return Plan

**Current:** `NumpadDialog` is touch-only (`:84–98`, on-screen numpad; no `onKeyDown`, no `<input>`); POS wiring (`:1107–1117`) clears `qtyNumpadLineKey` on confirm/close but does **not** call `focusSearch()` (locked by the D4-A `CURRENT GAP` test). After editing qty the cashier must click the search box to resume scanning.

**Recommended future behavior (NOT implemented here):**
- In the POSPage `NumpadDialog` wiring, after the qty is applied (`setQtyNumpadLineKey(null)` in `onConfirm`) **and** in `onClose`, call `focusSearch()` so the scan box regains focus.
- Keep `NumpadDialog` itself touch-only — **do not** add hardware-key/Enter entry in this item (that would be a separate, larger interaction change with its own Red considerations around qty mutation).
- Sequence focus-return after the dialog unmounts (the RAF in `focusSearch()` already defers a frame, which is sufficient).

**Exact future test updates required:** flip the `NumpadDialog (qty) path provides NO focus-return contract` GAP test to assert `focusSearch` now appears in the `<NumpadDialog>` region; keep the "touch-only / no `onKeyDown` / no `isComposing`" assertions green.

## Escape Behavior Matrix by Modal

> "Current Enter" = Enter-key behavior while a field in the modal is focused. "Backdrop" = click-outside dismissal. Risk reflects the modal's *contents* (Red = transactional write path reachable from it).

| Modal | Current Escape | Current Enter | Current autoFocus | Backdrop | Risk | Recommended future Escape | Tests required before impl |
|---|---|---|---|---|---|---|---|
| **PaymentModal** | none | **No explicit modal-level Enter handler. The `.pay-confirm` native `<button>` is keyboard-activatable when focused via Enter/Space, so payment confirmation remains a Red path** (it is NOT click-only and NOT unreachable by keyboard) | none on confirm; on-screen numpad | none (X button only, `:411`) | **Red** | **Do not add global/modal-level Enter-to-confirm.** Preserve native button semantics + the `!canConfirm\|\|confirming\|\|processing` guard. Escape allowed to **close** only when `!processing && !confirming` (mirror existing `onClose` guard); Escape/backdrop close must remain **blocked during processing/submitting**; Escape must **never** confirm | assert Escape path is guarded by `processing/confirming`; assert Escape cannot trigger `handleConfirm`; assert no modal-level Enter handler is added (native-button activation stays the only keyboard path) |
| **CustomerPickerModal** | ✅ input-level→onClose (`:102–104`) | none (filter only) | RAF search focus (`:59`) | ✅ overlay→onClose (`:84`) | Yellow | promote to overlay/dialog-level Escape for consistency (keep onClose) | assert Escape handler present at dialog level; no select on Escape |
| **UomModal** | none | none | none | none | Yellow | Escape→`onClose` (cancel; no add) | assert Escape→onClose, never `onSelect` |
| **ItemDiscountModal** | none | none | none | none | Yellow | Escape→`onClose` (cancel; **no save**) | assert Escape→onClose, never `onSave` |
| **NumpadDialog** | none | none (touch-only) | none | ✅ `currentTarget`→onClose (`:66`) | Yellow | Escape→`onClose` (cancel; no qty apply) | assert Escape→onClose, never `onConfirm` |
| **OpenShiftModal** | none | ✅ Enter→`handleOpen` (`:77`) | ✅ starting-cash (`:75`) | none | **Red** (opens shift) | **no** Escape dismissal (shift must be opened or page left) — document as intentional | assert no Escape-close added; Enter→handleOpen preserved |
| **CloseShiftModal** | none | none | ✅ actual-cash (`:327`) | ✅ `currentTarget`→onClose when `!closedShift` (`:290`) | **Red** (closes shift / Z-report) | Escape→`onClose` only pre-submit (`!closedShift && !submitting`); never after Z-report | assert Escape guarded by `!closedShift && !submitting` |
| **HoldBillNoteModal** | none | ✅ Enter→`handleConfirm` (`:64`) | ✅ setTimeout focus (`:22`) | ✅ `currentTarget`→onClose (`:39`) | **Red** (persists suspended bill) | Escape→`onClose` (cancel hold) | assert Escape→onClose, never `handleConfirm`; Enter→confirm preserved |
| **SuspendedBillsListModal** | none | none | none | ✅ `currentTarget`→onClose (`:118`) | Yellow (restore is Red but click-only) | Escape→`onClose` | assert Escape→onClose, no restore/remove on Escape |
| **CashTransactionModal** | none | none | ✅ amount input (`:113`) | ✅ `currentTarget`→onClose (`:67`) | **Red** (drawer pay-in/out) | Escape→`onClose` only pre-submit | assert Escape guarded; never commits a cash txn |
| **DestructiveConfirmModal** | ✅ overlay→onCancel when `!loading` (`:88–93`) | none | none explicit | ✅ overlay→onCancel (`:87`) | **Red** (clear cart / cancel parked) | unchanged — already correct (Escape cancels, never confirms; `!loading` guard) | assert existing Escape→onCancel + `!loading` guard preserved |
| **SortingSettingsModal** | none | none | none | ✅ overlay→onClose (`:437`) | Yellow (`ss-*`, POS-protected) | Escape→`onClose` (low priority) | assert Escape→onClose; **`ss-*` remains protected** |

**Cross-cutting rule for the Escape map:** Escape may only ever **cancel/close** a modal. It must **never** trigger a confirm/save/submit on any modal — most importantly never `PaymentModal.handleConfirm`, `OpenShiftModal.handleOpen`, `CloseShiftModal.handleClose`, `CashTransactionModal` submit, or `HoldBillNoteModal.handleConfirm`. Red modals get `processing/submitting`-guarded Escape (or no Escape, for OpenShift) so a dismissal can't race an in-flight write.

## Required Test Updates for Future Implementation

Consolidated (all in `src/pages/POSPage.keyboard-contract.test.ts` unless noted; **do not edit tests in this phase**):
1. **IME:** flip the no-IME-guard GAP test to assert `isComposing`/`keyCode===229` guard precedes `findByScanCode`; keep Enter-only + trim/empty + match/miss/priority assertions green.
2. **F12:** extend parity test to assert a "no modal open" predicate gates `setPaymentOpen(true)`; preserve single-listener + cleanup + open-gate parity; expand-dep assertion.
3. **Focus-return:** flip UOM / ItemDiscount / NumpadDialog GAP tests to presence; add category-overlay presence; keep all current present-path assertions.
4. **Escape:** add per-modal assertions per the matrix (Escape→close/cancel only; guarded on Red modals; never confirm). Some live in the modal components' own future specs rather than the POS page spec — to be decided at implementation time.
5. **Keyboard UAT** (non-unit, flagged): scanner-speed unchanged by IME guard; F12 no longer stacks; focus actually lands after each close; Escape never commits a Red action.

## Implementation Slice Recommendations

Sequence each as its own authorized + Codex-reviewed slice (tests-first where possible):
- **D4-C-1 — IME guard** (highest value/risk-reduction; smallest surface; `handleSearchKeyDown` only).
- **D4-C-2 — Focus-return consistency** (UOM/ItemDiscount/Numpad/category; pure additive `focusSearch()` calls).
- **D4-C-3 — F12 modal suppression** (touches the global listener + deps; needs careful UAT).
- **D4-C-4 — Escape map** (largest; per-modal; Red modals last and individually). Consider splitting Yellow modals (UOM/ItemDiscount/Numpad/Suspended/Sorting) from Red modals (Payment/Shift/Cash/Hold) into separate sub-slices.

Each slice: flip/extend the relevant locked contract tests **first**, implement minimally, run `vitest run` + `tsc -b`, then keyboard UAT, then Codex review.

## Forbidden Areas

No implementation in D4-C. For the future slices, the following remain off-limits without their own authorization + dedicated Codex review: the Red **payment-confirm** path (`onConfirm`→`confirmSale`→`submitAsyncOrder`→`setDoc('asyncOrders')`) must not gain a new *global or modal-level* `Enter`-to-confirm shortcut, and its existing native-button keyboard activation (Enter/Space when focused) plus the `!canConfirm||confirming||processing` guard must be preserved (not removed, not bypassed); the scan→`addToCart` mutation semantics; the F12 **open gate** logic and its checkout-parity; shift open/close and cash-drawer and suspended-bill **write** paths; oversell/stock evaluation; offline queue / IndexedDB / manual-review-evidence; `SortingSettingsModal`/`ss-*` styling beyond an Escape handler; Firestore rules/Functions; H7-F transfer/reversal files; `index.css`/`variables.css`; `stash@{0}`.

## Risk Assessment

- **IME guard:** Low implementation risk, high value; main hazard is a browser where `isComposing` is unreliable → mitigate with the `keyCode===229` fallback and keyboard UAT. Scanner regression risk ≈ none (no composition events).
- **F12 suppression:** Medium; the dependency array must include every modal-open signal or the closure goes stale and re-introduces stacking; needs explicit UAT.
- **Focus-return:** Low; additive `focusSearch()` calls. Only subtlety is ordering after unmount (RAF already handles).
- **Escape map:** Medium-high due to breadth and the Red modals; the cross-cutting "Escape never confirms" rule is the key safety invariant; guard Escape on in-flight writes.

## Hidden Risks

- The D3-B prose described the PaymentModal backdrop as `onClick={onClose}`; the **current source has no backdrop dismissal** on `pay-modal-bg` (X-button only). Any Escape work on PaymentModal must not silently add backdrop-dismiss as a side effect, and the matrix above reflects the verified current state.
- DestructiveConfirmModal's Escape is **overlay-level** (catches bubbling keydown from a focused child); if a future modal copies this pattern but has no initially-focused child, Escape may not fire until the user tabs in — a focus-management subtlety worth a UAT check.
- `CloseShiftModal` and the success/Z-report state share one component; Escape must be inert once `closedShift` is set (Z-report showing) to avoid dismissing the report before the operator reads variance.
- Source-level contract tests prove **wiring**, not runtime focus timing or event ordering — every slice needs keyboard UAT in addition to the flipped unit assertions.

## Final Recommendation

Proceed slice-by-slice in the order D4-C-1 (IME) → D4-C-2 (focus-return) → D4-C-3 (F12 suppression) → D4-C-4 (Escape map), each tests-first, each separately authorized and Codex-reviewed, with mandatory keyboard UAT. This planning report itself requires Codex GPT-5.5 High review before Tech Lead closure or any D4-C implementation authorization. No interaction-level POS behavior change is authorized by this document.
