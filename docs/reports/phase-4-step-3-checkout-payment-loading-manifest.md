# Phase 4 Step 3: Checkout / Payment Loading UI Manifest

**Status**: Implemented

**Test Exception**: Playwright tests (`tests/pos-human-checkout.spec.ts`) were authorized for modification to update selectors broken by the async-safe wording changes (e.g. `aria-label`).

---

## 1. Step 3 Scope Summary
**IN Scope**:
- Modernizing `PaymentModal.tsx` and its styling (`PaymentModal.css`).
- Implementing async-safe wording.
- Creating a clear, robust loading state and duplicate submit prevention.
- Surfacing `onConfirm` rejection explicitly in the UI (Anti-Silent Failure).
- Honoring offline-first architecture by using `navigator.onLine` strictly as a visual hint, without claiming server reconciliation.

**OUT of Scope**:
- Modifying `POSPage.tsx` or `useCheckout.ts`.
- Modifying `firestore.rules` or Cloud Functions.
- Altering the `reconcileOrder` backend behavior or asyncCheckout flow.
- Modifying any stock, receiving, transfer, admin, or auth files.
- Applying or popping `stash@{0}`.

---

## 2. File Scope Lock
Future implementation is strictly limited to:
- `src/components/PaymentModal.tsx`
- `src/components/PaymentModal.css`

`POSPage.tsx` and `useCheckout.ts` are read-only inspection only.

---

## 3. Current Architecture Summary
- **PaymentModal contract**: Accepts `(open, grandTotal, subtotal, ..., processing, onConfirm, onNewSale)`. It controls the internal UI states (amounts, method, success dialog).
- **checkout.confirmSale handoff**: Passed exactly as the `onConfirm` prop to `PaymentModal`. 
- **useCheckout behavior**: `confirmSale` sets `processing = true`, writes to local cache (`submitAsyncOrder`), optionally toasts offline warning, and returns `billId` synchronously.
- **Loading/Accepted/Error behavior**: `PaymentModal` has a `busy` state derived from `processing || confirming`. Accepted relies on `isSuccess = true` to render the thermal receipt view. Error handling currently catches the exception but relies on parent toasts rather than explicit modal UI.
- **F12 behavior**: Handled in `POSPage.tsx` to toggle `PaymentModal` open if shift is active and cart isn't empty.
- **Playwright checkout test**: `tests/pos-human-checkout.spec.ts` covers the full flow (F12, quick bills `+1000`, `.pay-confirm`, `.pay-success-change`, `.pay-success-btn--primary`). It asserts total change and receipt view rendering.

---

## 4. Async-Safe Wording Plan
Do not claim server completion. Exact Thai wording:
- **Payment in progress**: `กำลังบันทึกคำสั่งซื้อ...`
- **Local/async queued state (Offline)**: `รายการขายถูกบันทึกไว้แล้ว หากออฟไลน์ ระบบจะซิงก์เมื่อกลับมาออนไลน์`
- **Pending system processing (Online)**: `รับรายการขายแล้ว รอระบบประมวลผล`
- **onConfirm error**: `เกิดข้อผิดพลาดในการบันทึก กรุณาลองใหม่` (Surfaced visibly)
- **Duplicate submit prevention state**: `กำลังบันทึกคำสั่งซื้อ...`

---

## 5. Payment UX Plan
- **Payment method layout**: Left sidebar/tab design for quick selection.
- **Received amount input**: Large, clear input box prioritizing readability.
- **Change display**: Clear visual hierarchy in the summary panel, styled positively (e.g. green).
- **Quick cash buttons**: Retain existing `+100, +500, +1000` buttons.
- **Validation errors**: Disabled confirm button if amount is insufficient or credit is over limit.
- **Disabled states**: Visual dimming and `cursor-not-allowed`.
- **Keyboard/touch usability**: Touch-friendly numpad retained; explicit focus management.
- **Cashier speed concerns**: Immediate responsiveness. No animations that block clicks. F12 and Enter keys must work seamlessly.

---

## 6. Loading/Error UX Plan
- **Confirm button disabling/debounce**: Immediately disabled on first click. Double tap / rapid Enter cannot double-submit.
- **Pending state**: Non-blocking spinner inside the modal or on the confirm button.
- **Non-blocking offline/queued wording**: Uses the async-safe wording above.
- **onConfirm rejection UI**: Explicit error banner or alert text rendered *inside* the `PaymentModal` UI so it isn't missed. Button re-enables.
- **No false completed wording**: Avoiding absolute terms like "ขายสำเร็จสมบูรณ์".
- **No network-blocking spinner**: Because `useCheckout` writes locally and resolves instantly, the UI will not freeze POS forever waiting on network. If an error is thrown, the modal recovers immediately.

---

## 7. Impeccable.style Plan
- **Clean operational POS style**: Utilitarian, fast, high contrast.
- **No flashy marketing UI**: No unnecessary gradients or bouncing animations.
- **Touch-friendly controls**: Min 44px hit targets for all actionable buttons.
- **Clear hierarchy**: Total > Received > Change.
- **Flowbite/Tailwind-compatible styling**: Standardized utility-like CSS classes.
- **No hacky inline CSS overrides**: Styles managed cleanly in `PaymentModal.css`.
- **Accessible focus states**: Clear outlines for keyboard navigators.
- **Responsive checks**: Tested layout across 320px, 768px, and 1080px.

---

## 8. Test/Check Plan
- [x] `PaymentModal` render succeeds.
- [x] Duplicate submit prevention blocks double clicks.
- [x] `onConfirm` rejection displays visible UI error banner inside modal.
- [x] Offline/queued wording shows correctly when `!navigator.onLine`.
- [x] No false sale completed wording used.
- [x] `npm run build` succeeds without type errors.
- [x] No rules/functions/backend/POSPage/useCheckout files modified.
- [x] Existing Playwright checkout flow (`tests/pos-human-checkout.spec.ts`) preserved or extended. Playwright PASSED (1 passed, 37.6s), verifying F12, quick bills, `.pay-confirm` and accepted flow.
- [ ] Responsive visual checks pass at 320px / 768px / 1080px (Manual check not run in this automated step).

---

## 9. Questions for Tech Lead / CEO
None. The constraints are impeccably clear and strictly bounded.

---

## 10. Paranoid Checklist
- [x] **Business Logic Integrity**: No checkout/reconcile/payment behavior changes in this manifest.
- [x] **State Isolation**: `stash@{0}` inspected only, not applied/popped.
- [x] **Cross-contamination**: No rules/functions/POSPage/useCheckout/stock/transfer/admin/auth scope included.
- [x] **Devil's Advocate**: One hidden risk in payment/loading UI modernization is breaking existing Playwright E2E tests (`tests/pos-human-checkout.spec.ts`) by changing CSS class names. We must ensure classes like `.pay-confirm`, `.pay-success-change`, and `.pay-success-btn--primary` are preserved or safely updated in the test file if absolute necessity requires it.
