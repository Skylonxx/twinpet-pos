# Phase 4 Step 2 — Main POS / Cart / Void UI Manifest

**Role:** UI Implementer / Stash Planner  
**Date:** 2026-06-07  
**Scope:** Modernize the core Point of Sale operational interface, cart mutation UX, and void handling using Flowbite/Tailwind, while strictly preserving checkout flow and inventory behaviors.

---

## 1. Step 2 Scope Summary & Option A Expansion

Step 2 focuses on the operational cashier interface, with a **Tech Lead / CEO approved scope expansion (Option A)** to address a critical mismatch in void authorization.

* **Includes:** 
  * Main POS screen layout (`POSPage.tsx`), cart mapping (`useCart.ts`), and void actions (`SalesHistoryPage.tsx`, `voidPendingOrder.ts`).
  * **Option A Expansion:** Narrow `firestore.rules` modifications to securely permit cashiers to trigger async void requests, plus corresponding updates to the `rules-tests` suite to assert accurate actor logging (`voidedBy`).
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
* **Permissions:** Checked via `user.permissions?.includes('pos_void')` (or similar logic within `user.role`).
* **Async checkout boundary (EXCLUDED):** `src/hooks/pos/useCheckout.ts` and `src/components/PaymentModal.tsx` handle the actual transaction commit. We only call these, we do not modify them.

---

## 4. New Files Planned

1. **`src/components/pos/CartPanel.tsx`** (Optional extraction, depending on `POSPage.tsx` size)
   * **Purpose:** Isolate the right-hand cart presentation and line-item list.
   * **Origin:** Newly created (extracted from `POSPage.tsx`).
   * **Visual/UX:** Touch-friendly line items, clear quantity indicators, and integrated void/remove buttons.
   * **Why Step 2-only:** Purely presentational for the cart.

2. **`src/components/pos/ProductGrid.tsx`** (Optional extraction)
   * **Purpose:** Isolate the left-hand category tabs and product buttons.
   * **Origin:** Newly created (extracted from `POSPage.tsx`).
   * **Visual/UX:** High-contrast, easy-to-tap square buttons for products.
   * **Why Step 2-only:** Purely presentational for POS inventory viewing.

---

## 5. Existing Files Planned for Modification

1. **`src/pages/POSPage.tsx`**
   * **Exact Reason:** UI layout overhaul. Converting the massive DOM structure to a clean Tailwind Grid/Flex layout.
   * **Change Type:** UI layout, cart presentation, void UI, styling.
   * **Risk Level:** Medium (High lines-of-code churn, but isolated strictly to presentation).
   * **Why it does not touch excluded scope:** Logic hooks (`useCart`, `useCheckout`, `usePosInventory`) are imported and used as-is.

2. **`src/pages/POSPage.css`**
   * **Exact Reason:** Styling cleanup.
   * **Change Type:** Styling. Delete legacy hacky CSS rules in favor of Tailwind utility classes.
   * **Risk Level:** Low.
   * **Why it does not touch excluded scope:** Scoped only to the POS visual layer.

---

## 6. Files Explicitly NOT Touched in Step 2

* **Checkout/Payment:** `src/components/PaymentModal.tsx`, `src/hooks/pos/useCheckout.ts`, `src/components/pos/CashTransactionModal.tsx`
* **Receiving/Stock:** `src/pages/ReceivingPage.tsx`, `src/pages/ReceivingHistoryPage.tsx`
* **Transfer:** `src/pages/inventory/TransferPage.tsx`, `src/pages/inventory/TransferHistoryPage.tsx`
* **Admin Exception UI:** `src/pages/admin/ReconciliationExceptionsPage.tsx`
* **Auth/Login:** `src/pages/LoginPage.tsx`, `src/components/auth/*`
* **Backend:** `firestore.rules`, `functions/src/*`, `src/lib/pos/reconcileSync.ts`

---

## 7. Business Logic Preservation Plan

* **Oversell allowed:** The UI will display stock levels but will *never* block the `addItem` or `increaseQty` functions if stock is zero or negative.
* **Async checkout/reconcile flow:** The `handleCheckout` invocation will remain exactly the same, passing control to the untouched `PaymentModal`.
* **pos_void permission handling:** Cart item deletion and global cart clearing will conditionally render or trigger authorization checks exactly as currently implemented.
* **Cart state behavior:** `useCart` will not be altered. The UI will faithfully render whatever `cart.items`, `cart.subtotal`, and `cart.total` output.
* **Product quantity/price behavior:** All price levels, discounts, and UOM multipliers calculated by the existing hooks will be preserved.
* **No client-side stock sufficiency blocker:** Re-verified. The UI is strictly dumb to validation limits.

---

## 8. Void UI Plan

* **Presentation:** Voiding a line item will use a distinct icon (e.g., a red trash can or `ti-x`) with a clear touch target inside the `CartPanel`. Global void (Clear Cart) will be a secondary button at the bottom of the cart.
* **Permission denial:** If the user lacks the `pos_void` permission, the void buttons will either be disabled (`opacity-50 cursor-not-allowed`) or will trigger the existing manager PIN override flow if one exists in the current architecture.
* **Loading/Disabled:** During void execution or cart resetting, buttons will show a Flowbite spinner to prevent double-tapping.
* **Explicitly NOT refactored:** The actual state mutation removing the item from the array will remain handled by `useCart`.

---

## 9. Cart UX Plan

* **Feedback:** Tapping a product in the grid will show a brief micro-animation or toast indicating addition.
* **Quantity Controls:** Tapping a cart line item will open the existing `NumpadDialog` or provide inline `+`/`-` buttons if space permits, prioritizing touch speed.
* **Empty State:** A professional, centered empty state (e.g., an icon of a shopping cart with "ยังไม่มีสินค้าในตะกร้า").
* **Error State:** Any hook errors will render standard Flowbite red alerts.
* **Keyboard/Touch:** The layout will prioritize large touch targets (min 44px) for cashiers using iPads/tablets.
* **Responsive Layout:** 
  * Desktop/Tablet Landscape: Left side Product Grid (65%), Right side Cart (35%).
  * Mobile: Tabbed or stacked view (Cart hidden behind a sliding drawer or FAB).

---

## 10. Impeccable.style Plan

* **Layout System:** Tailwind CSS Grid for the main layout to ensure strict, unmoving panes.
* **Spacing/Typography:** Clean Inter/Prompt fonts, using standard Tailwind spacing (`p-4`, `gap-3`).
* **Direction:** Operational, high-contrast, flat UI. No gradients, no blurs. Clean white/gray backgrounds (`bg-gray-50`) with stark borders for separation.
* **Spinners & States:** Standard Flowbite `animate-spin` SVGs for loading.
* **Accessibility:** `aria-label` on all icon-only buttons (like void/remove).

---

## 11. Test/Check Plan

1. **POS page render:** Verify layout is strictly bounded to the viewport height (`h-screen overflow-hidden`) with internal scrolling.
2. **Product search/grid render:** Verify categories load and filter products correctly.
3. **Add item to cart:** Verify tapping a product instantly updates the cart pane.
4. **Increase/decrease quantity:** Verify the numpad or controls correctly update the line item total.
5. **Remove item / Void:** Verify `pos_void` checks apply and the item is removed.
6. **Empty cart:** Verify the global clear function resets the state and shows the empty UI.
7. **Oversell check:** Add an item with 0 stock and verify the UI does not block the addition.
8. **Checkout handoff:** Click Pay and verify the `PaymentModal` opens normally without errors.
9. **Responsive check:** Test at 320px (Mobile stack), 768px (Tablet split), and 1080px (Desktop split).
10. **Build check:** `npm run build` passes with 0 TypeScript errors.

---

## 12. Packaging Plan

* **Commit boundary:** One strictly isolated commit for "phase 4 step 2 pos cart void ui".
* **Isolation:** No backend, checkout, or stock transfer logic will be staged in this commit.
* **Report update:** Update `latest-report.md` with build evidence upon completion.

---

## 13. Questions for Tech Lead / CEO

* *Are there any specific manager PIN override behaviors for voiding that currently exist but are broken, or should we strictly honor the boolean `user.permissions.includes('pos_void')`?*
* *For mobile (phone) viewports, do you prefer the cart as a sliding bottom drawer or a separate tab?* (Defaulting to sliding drawer for speed).

---

## 14. Paranoid Checklist

* **Business Logic Integrity:** Confirmed. No stock/reconcile/checkout hooks will be edited.
* **State Isolation:** Confirmed. `stash@{0}` remains unpopped.
* **Cross-contamination:** Confirmed. Payment/admin/transfer UI is strictly excluded.
* **Devil's Advocate (Hidden Risk):** Extracting components from the massive `POSPage.tsx` could sever `useMemo` dependencies, causing the entire product grid to re-render on every keystroke in the search bar. We must carefully maintain React rendering boundaries.
