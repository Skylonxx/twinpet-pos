# Phase 4 Step 2 — Main POS / Cart / Void UI Manifest

**Role:** UI Implementer / Stash Planner  
**Date:** 2026-06-07  
**Scope:** Modernize the core Point of Sale operational interface, cart mutation UX, and void handling using Flowbite/Tailwind, while strictly preserving checkout flow and inventory behaviors.

---

## 1. Step 2 Scope Summary & Option A Expansion

Step 2 focuses on the operational cashier interface, with a **Tech Lead / CEO approved scope expansion (Option A2)** to address a critical mismatch in void authorization while enforcing an offline-first mandate.

* **Includes:** 
  * Main POS screen layout (`POSPage.tsx`), cart mapping (`useCart.ts`), and void actions (`SalesHistoryPage.tsx`, `voidPendingOrder.ts`).
  * **Option A2 Expansion:** Narrow `firestore.rules` modifications to securely permit cashiers to trigger async void requests by updating existing orders only, plus corresponding updates to the `rules-tests` suite to assert accurate actor logging (`voidedBy`).
* **Excludes:** Async checkout/reconciliation implementation (`useCheckout`), `PaymentModal`, receiving/stock logic, transfer pages, Admin Exception UI, Cloud Functions, and any canonical (`orders`) void rule changes.

---

## 2. Stash Inspection Summary

* **`stash0` files related to POS/cart/void:** **None.**
* **`stash0` files NOT related to Step 2:** `rp.md`, `src/lib/settings/*`, `src/pages/SettingsPage.tsx`, `src/pages/inventory/*`, `src/pages/settings/*`. These remain untouched.
* **Conflict risks with Phase 1-3 security work and Step 1 Auth UI:** **Zero.** Phase 1-3 touched backend Cloud Functions and reports. Step 1 touched `LoginPage.tsx` and `/auth` components. The POS UI layer is completely isolated from these.

---

## 3. Current POS Architecture Summary

* **POS page:** `src/pages/POSPage.tsx` (Current monolithic UI), `src/pages/POSPage.css` (Legacy styling).
* **Product grid/search:** Driven by `src/hooks/pos/usePosInventory.ts` and `src/lib/pos/categoryService.ts`.
* **Cart state:** Driven by `src/hooks/pos/useCart.ts` and `src/lib/pos/cartUtils.ts`.
* **Cart item mutation:** Driven by `NumpadDialog.tsx`, `UomModal.tsx`, and `ItemDiscountModal.tsx`.
* **Void action / intent:** Triggered from the cart line items or the global clear cart action.
* **Permissions:** Checked via server-side same-day timestamp rules (`serverCreatedAt` vs `request.time`) and strictly logged via `voidedBy`.
* **Async checkout boundary (EXCLUDED):** `src/hooks/pos/useCheckout.ts` and `src/components/PaymentModal.tsx` handle the actual transaction commit. We only call these, we do not modify them.

---


## 4. Final Scope & Files Modified

The Phase 4 Step 2 final scope included:
* `firestore.rules` (Added strictly validated `request.auth.token.staffId` and same-day bounds)
* `rules-tests/*` (Proved same-day logic, null/legacy safety, and identity gates)
* `src/hooks/pos/useCart.ts` (Removed client-side stock blockers)
* `src/pages/SalesHistoryPage.tsx` (Anti-silent-failure toast & void modal behavior)
* `src/lib/pos/voidPendingOrder.ts` (`requestPendingVoid` error propagation)
* `src/pages/POSPage.tsx` (UI warnings)
* Reports and manifests

Crucially, the following were explicitly **untouched**:
* `PaymentModal.tsx` and `useCheckout.ts` (Checkout/Payment boundaries)
* Cloud Functions (`functions/src/*`)
* `stash0` (Remains unapplied)
---

## 5. Files Explicitly NOT Touched in Step 2

* **Checkout/Payment:** `src/components/PaymentModal.tsx`, `src/hooks/pos/useCheckout.ts`, `src/components/pos/CashTransactionModal.tsx`
* **Receiving/Stock:** `src/pages/ReceivingPage.tsx`, `src/pages/ReceivingHistoryPage.tsx`
* **Transfer:** `src/pages/inventory/TransferPage.tsx`, `src/pages/inventory/TransferHistoryPage.tsx`
* **Admin Exception UI:** `src/pages/admin/ReconciliationExceptionsPage.tsx`
* **Auth/Login:** `src/pages/LoginPage.tsx`, `src/components/auth/*`
* **Backend Functions:** `functions/src/*`, `src/lib/pos/reconcileSync.ts`

---

## 6. Business Logic Preservation Plan

* **Oversell allowed:** The UI displays stock levels and warns, but *never* blocks the action if stock is zero or negative.
* **Async checkout/reconcile flow:** The `handleCheckout` invocation remains exactly the same, passing control to the untouched `PaymentModal`.
* **Product quantity/price behavior:** All price levels, discounts, and UOM multipliers calculated by the existing hooks are preserved.
* **No client-side stock sufficiency blocker:** Verified. 

---

## 7. Void UI & Network Plan

* **Actor Logging:** The `voidedBy` field securely logs the cashier's staffId and is firmly validated against `token.staffId` by `firestore.rules`.
* **Offline Resilience (Anti-Silent Failure):** The void write uses a fire-and-forget optimistic `updateDoc`. The UI renders instantly and never freezes the cashier. Crucially, the UI captures the promise `.catch()` so that any immediate or queue rejection perfectly surfaces as a prominent red toast, guaranteeing no silent console-only failures.

---

## 8. Cart UX Plan

* **Feedback:** Tapping a product in the grid will show a brief micro-animation or toast indicating addition.
* **Quantity Controls:** Tapping a cart line item will open the existing `NumpadDialog` or provide inline `+`/`-` buttons if space permits, prioritizing touch speed.
* **Empty State:** A professional, centered empty state (e.g., an icon of a shopping cart with "ยังไม่มีสินค้าในตะกร้า").
* **Error State:** Any hook errors will render standard Flowbite red alerts.
* **Keyboard/Touch:** The layout will prioritize large touch targets (min 44px) for cashiers using iPads/tablets.
* **Responsive Layout:** 
  * Desktop/Tablet Landscape: Left side Product Grid (65%), Right side Cart (35%).
  * Mobile: Tabbed or stacked view (Cart hidden behind a sliding drawer or FAB).

---

## 9. Impeccable.style Plan

* **Layout System:** Tailwind CSS Grid for the main layout to ensure strict, unmoving panes.
* **Spacing/Typography:** Clean Inter/Prompt fonts, using standard Tailwind spacing (`p-4`, `gap-3`).
* **Direction:** Operational, high-contrast, flat UI. No gradients, no blurs. Clean white/gray backgrounds (`bg-gray-50`) with stark borders for separation.
* **Spinners & States:** Standard Flowbite `animate-spin` SVGs for loading.
* **Accessibility:** `aria-label` on all icon-only buttons (like void/remove).

---

## 10. Test/Check Plan

1. **POS page render:** Verify layout is strictly bounded to the viewport height (`h-screen overflow-hidden`) with internal scrolling.
2. **Product search/grid render:** Verify categories load and filter products correctly.
3. **Add item to cart:** Verify tapping a product instantly updates the cart pane.
4. **Increase/decrease quantity:** Verify the numpad or controls correctly update the line item total.
5. **Remove item / Void:** Verify server-side same-day void checks apply for standard cashiers.
6. **Empty cart:** Verify the global clear function resets the state and shows the empty UI.
7. **Oversell check:** Add an item with 0 stock and verify the UI does not block the addition.
8. **Checkout handoff:** Click Pay and verify the `PaymentModal` opens normally without errors.
9. **Responsive check:** Test at 320px (Mobile stack), 768px (Tablet split), and 1080px (Desktop split).
10. **Build check:** `npm run build` passes with 0 TypeScript errors.

---

## 11. Packaging Plan

* **Commit boundary:** One strictly isolated commit for "phase 4 step 2 pos cart void ui".
* **Isolation:** No backend, checkout, or stock transfer logic will be staged in this commit.

---

## 12. Open Questions (Resolved)

* *Is cross-day voiding allowed for standard cashiers?* **No**. Cashiers may only void orders created on the same local calendar day. Cross-day voids are strictly denied by `firestore.rules`. Legacy documents missing `serverCreatedAt` are safely denied.

---

## 13. Paranoid Checklist

* **Business Logic Integrity:** Confirmed. The `useCart.ts` hook was safely modified to allow oversell per CEO mandate, but checkout/reconcile logic was strictly preserved.
* **State Isolation:** Confirmed. `stash@{0}` remains unpopped.
* **Cross-contamination:** Confirmed. Payment/admin/transfer UI is strictly excluded.
* **Devil's Advocate (Hidden Risk):** Extracting components from the massive `POSPage.tsx` could sever `useMemo` dependencies, causing the entire product grid to re-render on every keystroke in the search bar. We must carefully maintain React rendering boundaries.
