# Phase 7C-D2 POS Cashier UX Boundary Audit

> **Status:** Read-only boundary audit. No source/schema/rules/POS code modified. No implementation performed.
> **Authorization:** Tech Lead / CEO — Option B (read-only audit).
> **Baseline:** HEAD `00ab856 style(admin): add subtle card elevation to isolated views`; `stash@{0}` present and untouched.

## Executive Summary

The POS cashier surface is a single dense page (`/pos → src/pages/POSPage.tsx`, ~1156 lines) styled by a **page-exclusive `pos-*` CSS namespace** (`src/pages/POSPage.css`), orchestrating ~14 modals plus a product grid and a cart aside. It is **offline-first and cashier-critical**: the checkout path is a queueable Firestore `setDoc` (`asyncOrders`), the shift drawer is a single-writer local ledger, and oversell is intentionally allowed (UI warns but never blocks). Visual polish is feasible and valuable on the **presentation chrome (`pos-*` layout/typography/tiles/cart density)**, but a large fraction of the page is **interaction-sensitive** (focus management, F12/Enter contracts, modal mount/disabled-state) or **transactional/write-path hazardous** (`confirmSale`/`submitAsyncOrder`, totals/pricing math, shift ledger, suspended-bill persistence, oversell allowance, offline reversal/manual-review). Future POS UI work must be sliced narrowly and CSS-/layout-first, with keyboard and offline-checkout regression gates.

## Scope and Baseline

Full cashier workflow: entry point, POS view, product grid/search/barcode, cart, payment/checkout, keyboard-first interactions, and offline/manual-review/oversell boundaries. Read-only inspection only; classifications are Green (presentation-safe), Yellow (interaction-sensitive), Red (transactional/write-path hazardous).

## Files / Areas Inspected (read-only)

- `src/App.tsx` (route `/pos`)
- `src/pages/POSPage.tsx`, `src/pages/POSPage.css`
- `src/components/pos/*` — `PaymentModal.tsx`, `UomModal.tsx`, `ItemDiscountModal.tsx`, `NumpadDialog.tsx`, `SortingSettingsModal.tsx`, `SyncIndicator.tsx`, `CashTransactionModal.tsx`, `ShiftModals.tsx`, `SuspendedBillModals.tsx`, `ProductPickerDialog.tsx`
- Active checkout modal: `src/components/PaymentModal.tsx` (POSPage imports `../components/PaymentModal`, not the `components/pos/` variant)
- `src/hooks/pos/*` — `useCheckout.ts`, `useCart.ts`, `usePosInventory.ts`, `usePosSyncSignal.ts`
- `src/lib/pos/*` — `asyncCheckout.ts`, `cartUtils.ts`, `shiftService.ts`, `shiftLedger.ts`, `localLedger.ts`, `suspendedBills.ts`, `billId.ts`, `categoryService.ts`, `voidPendingOrder.ts`, `offline/*` (reversal queue, manual review, stock overlay, evidence logging)

## POS Entry Point Map

- **Route:** `src/App.tsx:64` → `<Route path="/pos" element={<POSPage />} />` (behind the authed app shell).
- **Page import:** `src/App.tsx:14` → `import POSPage from './pages/POSPage'`.
- **Page-local CSS:** `src/pages/POSPage.css` (`import './POSPage.css'`, `pos-*` prefix — page-exclusive per the C1-0 namespace audit).
- **Embedded-modal entry points** (mounted by POSPage): UomModal, ItemDiscountModal, ProductPickerDialog, CustomerPickerModal, PaymentModal, OpenShift/CloseShiftModal, CashTransactionModal, HoldBillNoteModal, SuspendedBillsListModal, NumpadDialog, **SortingSettingsModal (imports `SortingSettingsPage.css` → `ss-*`, the POS-embedded coupling flagged in C1-0)**, DestructiveConfirmModal, plus an inline category-picker overlay.

## POS View Component Map

- **Top bar (`pos-topbar`)**: search input (`#pos-search`, `searchInputRef`, `autoFocus`), "เลือกสินค้า" picker, "จัดเรียง" (sorting modal), manual-refresh button (`refreshInventory`), `SyncIndicator`, offline badge; shift-action buttons (suspended bills, hold, cash in/out, close shift, clear cart) — all gated on `activeShift`.
- **Product area (`pos-product-area`)**: category pill bar (All / Quick Menus / physical categories), product grid (`pos-product-grid`) of `pos-prod-card` tiles (image, name, price, stock, in-cart qty badge), plus loading/empty/error/offline display states.
- **Cart aside (`pos-cart`)**: customer bar, cart line items (`pos-ci` — name/uom/disc/tier/oversell badges, price bar, qty −/＋, qty numpad, discount pencil, remove), footer (`pos-cart-footer`) with bill discount/fee controls, subtotal/discount/fee/grand-total rows, and the checkout button.
- **Data source:** `usePosInventory(branchId)` — static, pull-based snapshot (no mid-sale live reshuffle); refreshed on demand or via the admin sync signal (deferred while a sale is in progress).

## Cart State and Interaction Boundary

- **Owner:** `useCart({ products, customer, showToast })` (`src/hooks/pos/useCart.ts`) — owns `cart`, `cartLines`, `totals`, and the mutators `addToCart`, `changeQty`, `setLineQty`, `setLineDiscount`, `removeLine`, `clearCart`, `restoreCart`, plus bill discount/fee setters.
- **Derived totals & pricing:** `totals` (subtotal/billDiscount/fee/grandTotal/itemCount/totalQty) and per-line pricing via `getActivePriceForCustomer` (tier pricing) + `getLineTotal`/`formatMoney` (`cartUtils.ts`). **These figures flow directly into the order/payment amounts.**
- **Boundary:** button *placement/size/visual density* of the qty/discount/remove controls is presentation; the *handlers and the totals/pricing math are Red* (they determine charged amounts).

## Payment Modal / Checkout Boundary

- **Entry:** checkout button or **F12** → `setPaymentOpen(true)` (gated `cartLines.length>0 && activeShift`).
- **Modal:** `src/components/PaymentModal.tsx` receives totals/lines/customer credit context; `onConfirm(payments) → checkout.confirmSale(payments, cartLines, totals)`; `processing` disables close.
- **Write path (RED):** `useCheckout.confirmSale` → `asyncCheckout.buildAsyncOrder` (pure order/payment/totals construction) → `submitAsyncOrder` → **`setDoc(doc(db,'asyncOrders', order.id), order)` — a single fire-and-forget queueable write** (offline-first; "not yet acked (queued, will retry)") + local-ledger append driving the shift drawer. Receipt prefix via `billId.refreshReceiptConfigCache`.
- **Boundary:** the modal's visual chrome is polishable; payment-method calculation, credit/outstanding handling, `onConfirm`/`confirmSale`/`submitAsyncOrder`, and order construction are Red.

## Keyboard-first UX Boundary

- **Search autofocus:** `autoFocus` on `#pos-search` + `focusSearch()` (RAF → `searchInputRef.current?.focus()`) re-focuses after add/scan/modal close — fragile and central to scan speed.
- **Barcode/Enter:** `handleSearchKeyDown` (Enter) → `findByScanCode(products, code)` → direct `addToCart` for UOM-specific barcodes or `onProductClick` (UomModal for multi-UOM); clears search + refocuses; "ไม่พบสินค้านี้" toast on miss.
- **F12:** global `keydown` listener opens the payment modal (when cart non-empty + shift active). **Project hotkey contract (SKILL-UI-IMPECCABLE §4: preserve F12).**
- **Modal focus:** several modals carry their own `autoFocus` (category search, numpad, etc.) — competing focus is a known fragility.
- **Boundary:** all focus/keyboard wiring is **Yellow** — visually invisible but behaviorally critical to cashier throughput; do not reorder/alter without a focus regression check.

## Offline Queue / IndexedDB Boundary

- **Checkout queue:** `asyncOrders` `setDoc` relies on Firestore offline persistence (queued + retried); the cashier must never be blocked on ack (SKILL §3).
- **Local ledger:** `useLocalLedger` + `shiftLedger.deriveShiftDrawer` — the terminal is the single writer of its shift drawer totals (derived live from the local ledger; offline-safe).
- **Suspended bills:** `useSuspendedBills` / `suspendedBills.ts` — durable local persistence of parked carts.
- **Offline reversal / manual review (H7 area):** `src/lib/pos/offline/*` — `offlineReversalQueue`, `reversalStockOverlay` (POS overlay of pending reversal deltas), `manualReviewOps`/`manualReviewResolution`, `reversalLocalStore` (IndexedDB, `DB_VERSION = 2`), `recordEvidenceRejection`/`reversalRejectionLog`. **All Red; the durable-rejection + manual-review work (Phase 7B-H) closed here and must not be disturbed.**
- **Sync signal:** `usePosSyncSignal` + the mid-sale defer logic (banner vs instant refresh) — Red/Yellow (correctness-critical: prices must not shift mid-sale).

## Oversell / Stock / Manual Review Boundary

- **Oversell UI (GREEN):** the per-line "ขายเกินสต๊อก (n)" badge + yellow row tint is a **soft, presentation-only warning** computed from `product.allowNegativeStock` and `product.stock` — it never blocks the sale.
- **Oversell allowance LOGIC (RED):** the `allowNegativeStock`/stock decision and the server-side reconciliation/oversell guardrails are off-limits (system rule: oversell allowed; reconciliation server-side).
- **Stock display (`p.stock`) (GREEN to display):** read-only; do not recompute or sum lots in the UI (FIFO rule).
- **Manual review:** ties to the H7 Manual Review Ops surface (separate page) — not edited from POS.

## Safe Presentation Surfaces — Green

- `pos-*` layout/spacing/typography in `POSPage.css` (page-exclusive namespace).
- Product tile visual hierarchy (`pos-prod-card`/`-img`/`-info`/`-name`/`-price`/`-stock`, in-cart badge) — display only.
- Cart line **visual** density/spacing/typography (`pos-ci*` chrome), badges (offline, oversell warning, tier/disc tags) — presentation only.
- Totals/footer **visual** layout (`pos-cart-footer`, grand-total row) — formatting via existing `formatMoney`/`fmtBaht` only; do not change math.
- Category pill bar visuals, toast styling (`pos-toast`), loading/empty/error text, `SyncIndicator` visuals, offline `Badge`.
- Static icons, section grouping, non-interactive containers.

## Interaction-sensitive Surfaces — Yellow

- Search input focus management (`autoFocus`, `focusSearch`/RAF, `searchInputRef`).
- Enter-to-scan handler and the "not found" toast trigger.
- **F12** hotkey and any global key listener.
- Modal open/close wiring and competing `autoFocus`; modal mount conditions.
- Checkout/clear/hold/close-shift **disabled** states (`cartLines.length===0 || !activeShift`).
- Qty −/＋, numpad open, discount pencil, remove **button placement** (handlers are Red).
- Update banner (mid-sale refresh defer) presentation tied to correctness logic.
- `SortingSettingsModal` (pulls `ss-*` POS-embedded CSS — any `ss-*` change affects POS).

## Transactional / Write-path Hazard Surfaces — Red

- `useCheckout.confirmSale` → `buildAsyncOrder` → `submitAsyncOrder` → `setDoc('asyncOrders')`; local-ledger append.
- `useCart` totals/pricing math (`getActivePriceForCustomer`, tier pricing, `getLineTotal`, bill discount/fee).
- PaymentModal payment-method calculation, credit/outstanding handling, `onConfirm`.
- Shift lifecycle: `getActiveShift`, Open/CloseShift, `recordCashTransaction`, `shiftLedger`/`deriveShiftDrawer`.
- Suspended-bill persistence (`useSuspendedBills`/`suspendedBills.ts`).
- Oversell **allowance** logic (`allowNegativeStock`/stock guardrails).
- Offline reversal/manual-review/stock-overlay/evidence logging (`src/lib/pos/offline/*`, IndexedDB, `DB_VERSION`).
- `usePosInventory` data load/`refreshInventory`; `usePosSyncSignal` defer logic; `billId` receipt config.
- Any Firestore write / Cloud Function call / offline schema / Firestore rules.

## Future Safe Implementation Slice Recommendations

*(Recommendations only — not authorized here.)*

- **D3-A — POS Read-only Visual Shell Polish:** `POSPage.css` (`pos-*`) and className/layout-wrapper-only changes — product-tile hierarchy, cart visual density, footer/totals layout, category-pill and topbar button styling, toast/empty/loading visuals. **No handler/state/query/keyboard/disabled-state/totals changes.** Respect touch targets ≥44px and non-blocking UX (SKILL §3–4).
- **D3-B — Keyboard UX / Focus Audit (read-only or test-only first):** map focus traps (search autofocus vs modal autofocus contention), the F12 + Enter-scan contracts, and refocus timing; produce findings only — no behavior change until separately authorized.
- **D3-C — Payment Modal Presentation Polish:** presentation-only inside `src/components/PaymentModal.tsx` chrome (spacing/labels/hierarchy). **No payment calculation, no `onConfirm`/`confirmSale` path, no credit logic, no queue/write changes.**

## Forbidden Areas for Future POS UI Polish (without separate authorization + dedicated Codex review)

`confirmSale` / `buildAsyncOrder` / `submitAsyncOrder` / `asyncOrders` write; `useCart` totals & pricing; PaymentModal payment calc / credit / `onConfirm`; shift ledger/drawer & `recordCashTransaction`; suspended-bill persistence; oversell allowance logic; `usePosInventory`/`refreshInventory`; `usePosSyncSignal` defer logic; offline reversal/manual-review/stock-overlay/evidence (`src/lib/pos/offline/*`), IndexedDB, `DB_VERSION`; `billId`; Firestore rules / Cloud Functions; H7-F protected transfer pages; shared/global CSS (`index.css`, `variables.css`) and the `ss-*` stylesheet (POS-embedded via SortingSettingsModal); the F12 / Enter-scan / autofocus contracts (Yellow — change only under D3-B authorization with regression gates); `stash@{0}`.

## Required Tests / Review Gates for Future POS UI Work

- `npx vitest run` (incl. `localLedger`, `shiftLedger`, `voidPendingOrder`, offline-reversal/manual-review suites) + `tsc -b` clean.
- Visual UAT at 320 / 768 / 1080px: no overflow/overlap, totals & buttons readable, cart/payment dimensions stable, touch targets ≥44px.
- Keyboard regression: F12 opens payment (gated), Enter-scan adds/【not-found toast】, search re-focus after add/scan/modal-close, no modal focus-steal.
- Offline-checkout smoke: queued/pending wording (never false "completed"); checkout never blocks on network.
- Oversell soft-warning still renders and never blocks.
- Forbidden-area diff EMPTY; `stash@{0}` untouched; mandatory Codex GPT-5.5 High review.

## Hidden Risks

- POS is offline-first and revenue-facing: a "cosmetic" JSX reorder can silently break the **F12 / Enter-scan / autofocus** contracts or the **mid-sale refresh-defer** logic, which no unit test fully covers — keyboard + offline smoke UAT is mandatory for any POS UI slice.
- `pos-*` is page-exclusive (low collision risk), but `SortingSettingsModal` drags in `ss-*` (POS-embedded), so "POS polish" can leak into the settings namespace.

## Final Recommendation

Approve **D3-A (POS read-only visual shell polish, `pos-*`/layout-only)** as the first and safest POS UI slice, gated by the keyboard + offline-checkout regression UAT above; keep **D3-B (keyboard/focus)** read-only-first; treat **D3-C (payment modal)** as presentation-only with hard write-path exclusion. All Red surfaces remain off-limits without separate authorization and dedicated Codex review.
