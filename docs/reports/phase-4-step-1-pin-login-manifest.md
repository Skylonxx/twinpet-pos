# Phase 4 Step 1 — PIN Login UI Manifest

**Role:** UI Implementer / Stash Planner  
**Date:** 2026-06-07  
**Scope:** Overhaul the authentication and PIN login entry points using Flowbite/Tailwind primitives.

---

## 1. Step 1 Scope Summary

Step 1 is strictly limited to the authentication and PIN login entry points. 
* **Includes:** Visual layout overhaul of the login screen to adopt modern Flowbite/Tailwind primitives, replacing custom CSS with utility classes. Rebinding existing `verifyPinLogin` logic to new Flowbite loading states, toasts, and visual cues.
* **Excludes:** Point of Sale (POS) cart, checkout logic, payment modals, administrative exception UI, stock transfer screens, and all Firestore security rules.

---

## 2. Stash Inspection Summary

* **`stash0` files related to auth/login/PIN:** **None.** The `stash@{0}` contains Batches 1-3 settings and transfer UI, but no files modifying the authentication or login layers.
* **`stash0` files NOT related to Step 1 that must remain untouched:** `src/lib/settings/*`, `src/pages/SettingsPage.tsx`, `src/pages/inventory/*`, `src/pages/settings/*`, `rp.md`.
* **Conflict risks with current Phase 3/security work:** **Very Low.** Because the stash does not touch authentication, and Phase 3 security work did not touch the React components for the login screen, modifying `LoginPage.tsx` will not cause merge conflicts with either the unapplied stash or the newly deployed backend logic.

---

## 3. New Files Planned

1. **`src/components/auth/PinPad.tsx`**
   * **Purpose:** A clean, reusable numeric keypad component.
   * **Origin:** Newly created (not from stash).
   * **Visual/UX:** Will use Flowbite Button primitives, managing its own disabled states, hover effects, and touch-target sizes for mobile to ensure "impeccable style."

2. **`src/components/auth/BranchSelector.tsx`**
   * **Purpose:** A dropdown for branch selection prior to PIN entry.
   * **Origin:** Newly created (not from stash).
   * **Visual/UX:** Will utilize Flowbite Select (`bg-gray-50 border-gray-300 text-gray-900 rounded-lg focus:ring-blue-500 focus:border-blue-500`) with clear disabled/loading states.

---

## 4. Existing Files Planned for Modification

1. **`src/pages/LoginPage.tsx`**
   * **Exact Reason:** Component replacement and styling upgrade to a responsive Flowbite Card layout.
   * **Change Type:** Component replacement and styling. The existing auth wiring (`verifyPinLogin` via `useAuth`) remains intact but will be rebound to new visual states.
   * **Risk Level:** Low.
   * **Why it does not touch excluded scope:** It is strictly isolated to the `/login` route.

2. **`src/pages/LoginPage.css`**
   * **Exact Reason:** Remove legacy hacky CSS.
   * **Change Type:** Styling. Replace custom sizing/layouts with Tailwind utility classes.
   * **Risk Level:** Zero.
   * **Why it does not touch excluded scope:** Scoped only to the login UI.

---

## 5. Files Explicitly NOT Touched in Step 1

* **POS/cart files:** `src/pages/POSPage.tsx`, `src/pages/ProductCRUDPage.tsx`
* **Payment/checkout files:** `src/pages/ReceivablesPage.tsx`
* **Receiving/stock/transfer files:** `src/pages/inventory/TransferPage.tsx`, `src/pages/inventory/TransferHistoryPage.tsx`, `src/pages/ReceivingPage.tsx`
* **Admin Exception UI files:** `src/pages/admin/ReconciliationExceptionsPage.tsx`
* **Firestore rules:** `firestore.rules`
* **Cloud Functions:** `functions/src/*`
* **Stash areas unrelated to Auth/PIN login:** `src/lib/settings/*`, `src/pages/settings/*`

---

## 6. `verifyPinLogin` Wiring Plan

* **Where called:** Inside `src/pages/LoginPage.tsx`'s `submitPin` handler via `loginWithPin` from the `useAuth()` hook.
* **Expected Request/Response Shape:** 
  * Request: `{ pin: string, branchId: string }`
  * Response: `{ success: boolean, user: { id: string, role: string, ... } }`
* **Loading state:** The login UI will lock inputs and render a Flowbite `Spinner` inside the submit mechanism while awaiting the callable response.
* **Invalid PIN state:** On `functions/permission-denied` or `INVALID_ARGUMENT`, the input fields gain `border-red-500` classes, and a clean Flowbite red helper text `<p className="mt-2 text-sm text-red-600">` will appear.
* **Success navigation:** The existing `completeLogin(user, branchId)` flow will be preserved, handing off to `PosShellRoute` to redirect to `/` or `/admin`.
* **Safe error handling:** Generic user-facing messages will be displayed. Actual PIN strings will never be exposed in `console.error` logs.

---

## 7. UI Quality Plan

* **Layout:** Centered Flex/Grid container with a Flowbite Card (`max-w-md mx-auto mt-10 p-6 bg-white rounded-lg shadow dark:bg-gray-800`).
* **Responsive behavior:** Full width on mobile, centered card on tablet/desktop. Padding adjusts to viewport sizes.
* **Flowbite components/classes expected:** `focus:ring-primary-600`, `focus:border-primary-600`, `dark:text-white`, `border-gray-300`, standard typography (`text-sm font-medium`), Buttons, and Spinners.
* **Loading spinner behavior:** Disables form submission and input interactions (`opacity-50 cursor-not-allowed`); displays an SVG spinner.
* **Disabled button behavior:** Grayed out with `cursor-not-allowed` when PIN < 4 digits or branch is unselected.
* **Error message behavior:** Instant inline validation feedback (no jarring layout shifts). The PinPad will pulse/shake (`animate-pulse`).
* **Keyboard/enter behavior:** Form submission bound to the `Enter` key. Physical numpad syncs with the on-screen PinPad.
* **Accessibility/focus behavior:** `aria-invalid` on error states, `aria-describedby` for screen readers; branch selector gains autofocus on mount.

---

## 8. Test/Check Plan

* **auth/PIN login render:** Verify layout aligns perfectly at 320px, 768px, and 1080px without horizontal scrolling.
* **verifyPinLogin success path:** Verify correct routing to the dashboard and global auth state updates.
* **invalid PIN path:** Verify red helper text appears, inputs clear, and unauthorized access is blocked safely.
* **loading state:** Verify spinner displays and double-clicking is prevented during active requests.
* **error state:** Verify network drops generate generic, safe error toasts without leaking stack traces.
* **mobile/responsive visual check:** Ensure buttons are easily tappable on small touchscreens.
* **no regression to auth guard/routing:** Verify hard refreshing the page preserves the login session.

---

## 9. Packaging Plan

* **Commit boundary:** Step 1 commit only (e.g., `ui: upgrade login screen to Flowbite components`).
* **Strict isolation:** No POS, cart, payment, or admin UI modifications will be permitted in this commit.
* **Report update path:** Update `latest-report.md` to flag Phase 4 Step 1 implementation as active/complete.

---

## 10. Paranoid Checklist

* **Business Logic Integrity:** Confirmed. No POS, stock calculation, or retry algorithms are modified in this UI-only plan.
* **State Isolation:** Confirmed. `stash@{0}` was inspected read-only and remains completely untouched and unapplied.
* **Cross-contamination:** Confirmed. No POS/cart/payment/admin/transfer/backend scope is included in this phase.
* **Devil's Advocate (Hidden Risk):** Refactoring `LoginPage.tsx` heavily could inadvertently alter the timing of the `completeLogin` context update, potentially locking users out of the global application before Step 2 begins. Close adherence to existing hook lifecycles is critical.
