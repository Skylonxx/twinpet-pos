# Phase 7C-D3-B POS Keyboard UX / Focus Audit

> **Status:** Read-only / test-only audit. No source/behavior/keyboard/focus code modified. No implementation performed.
> **Authorization:** Tech Lead / CEO — read-only Keyboard UX / Focus audit (after 7C-D3-A closure).
> **Baseline:** HEAD `71d5dac style(pos): improve green-zone cashier readability`; `stash@{0}` present and untouched.
> **Controlling safety doc:** `docs/reports/phase-7c-d2-pos-cashier-ux-boundary-audit.md`.

## Executive Summary

POS keyboard UX is **search-first**: the `#pos-search` input owns initial focus and is the only fast keyboard path — `Enter` runs a barcode/SKU scan that adds to the cart. There is exactly **one global shortcut (F12 → open payment)**, gated on `cart>0 && activeShift`. Everything else (product add, qty numpad, item discount, payment confirm) is **click/touch-first**; several modals run their own `autoFocus`/`Enter`, but focus-return to the search box after closing the qty/discount/UOM modals is **inconsistent**, and there is **no global Escape** and **no IME/composition guard** on the scan input. The sharpest real risk is the missing composition guard (Thai input can fire a premature scan on `Enter`); the rest are interaction-quality gaps. All keyboard/focus surfaces are Yellow or Red — only focus-ring/label *styling* is Green.

## Scope and Baseline

Full POS cashier keyboard/focus surface: focus bootstrap, search/barcode/Enter-scan, global shortcuts (F12), Escape/Enter contracts, modal focus contention, disabled/loading/offline impact, and touch/click/keyboard parity. Read-only; classifications Green (style-only), Yellow (interaction-sensitive), Red (transactional/write-path via keyboard).

## Files / Areas Inspected (read-only)

- `src/pages/POSPage.tsx` (focus bootstrap, scan handler, F12 listener, modal wiring), `src/pages/POSPage.css`
- `src/components/pos/NumpadDialog.tsx`, `ShiftModals.tsx`, `SuspendedBillModals.tsx`, `CashTransactionModal.tsx`, `SortingSettingsModal.tsx`, `SyncIndicator.tsx`
- `src/components/PaymentModal.tsx` (active checkout modal)
- Referenced: `src/hooks/pos/{useCheckout,useCart,usePosInventory,usePosSyncSignal}.ts` (behavioral owners; not modified)

## POS Focus Bootstrap Map

- **Initial focus:** `#pos-search` input carries `autoFocus` (`POSPage.tsx:498`) + `searchInputRef` (`:122`).
- **Refocus helper:** `focusSearch()` = `window.requestAnimationFrame(() => searchInputRef.current?.focus())` (`:327`).
- **Refocus IS called after:** successful scan add (`:359`), customer modal close/select (`:972`/`:976`), new sale (`:375`), hold confirm (`:410`), restore bill (`:426`), clear-cart confirm + cancel-parked confirm (`:1138`/`:1142`), PaymentModal `onClose` (`:997`).
- **Refocus is NOT called after:** `UomModal` select/close (`:939`–`:944`), `ItemDiscountModal` save/close (`:948`–`:953`), `NumpadDialog` confirm/close (`:1111`–`:1116`), category-overlay close (`:1051`). → after editing qty/discount/UOM, focus does not return to the scan box (cashier must click it).

## Search / Barcode / Enter Scan Contract

- **Value ownership:** `search` state (`:96`); input is controlled (`:501`).
- **Handler:** `handleSearchKeyDown` (`:342`) acts **only on `Enter`**; trims; `findByScanCode(products, code)` (module-local, `:51`) matches top-level `sku`/`barcode`, else a UOM-specific `barcode`.
- **On match:** UOM-specific barcode → `cart.addToCart(product, option)` directly; otherwise `onProductClick` (opens `UomModal` for multi-UOM, else adds base unit). Then `setSearch('')` + `focusSearch()`.
- **On miss:** `showToast('ไม่พบสินค้านี้')`; **search text is NOT cleared** (cashier can correct it) and focus stays.
- **Hardware scanners:** the keystrokes-then-Enter pattern works through this path.
- **GAP — no IME/composition handling:** no `isComposing`/`compositionstart`/`compositionend` checks; a Thai-IME `Enter` that commits composition can also trigger the scan prematurely. (Yellow + test gap.)

## Global Keyboard Shortcut Map

- **Exactly one** global listener: `POSPage.tsx:467` `window.addEventListener('keydown', onKey)` (cleaned up on unmount; deps `[cartLines.length, activeShift]`).
- **F12** → `e.preventDefault()` + `if (cartLines.length>0 && activeShift) setPaymentOpen(true)` (`:469`–`:472`).
- No `keyup`/`keypress`, no other F-keys, **no global Escape**.

## F12 Contract

- Opens the payment modal only when the cart is non-empty and a shift is active (same gate as the checkout button's `disabled`). `preventDefault` suppresses the browser/devtools default — intended for the cashier terminal.
- **Risk (Yellow):** the listener stays active while other modals are open (Numpad, UOM, ItemDiscount, Category, Shift, Cash, Suspended, or PaymentModal itself). F12 during one of those still fires `setPaymentOpen(true)`, **stacking** PaymentModal over the open modal.

## Escape / Enter Contract

- **No global Escape.** Modals close via close button, backdrop click (`NumpadDialog`/category overlay use `e.target===currentTarget`; PaymentModal backdrop `onClick={onClose}`), or `onClose`. There is **no Escape-to-close** anywhere → no keyboard dismissal. (Yellow, consistency gap.)
- **Enter inside modals — inconsistent:**
  - `NumpadDialog` (qty): **no hardware-key entry and no Enter-to-confirm** — purely on-screen numpad + click "ยืนยัน" (`NumpadDialog.tsx`: `handleKey`/`handleConfirm`, no `onKeyDown`, no input element).
  - `PaymentModal`: own on-screen numpad (`handleNumpad`); confirm is **click-only** behind `if (!canConfirm || confirming || processing) return` (`PaymentModal.tsx:229`); no Enter-to-confirm, no Escape.
  - `OpenShiftModal`: input `autoFocus` + `onKeyDown` `Enter` → `handleOpen` (`ShiftModals.tsx:75`–`77`).
  - `HoldBillNoteModal`: input focus via `setTimeout(...,50)` + `onKeyDown` `Enter` (preventDefault) → confirm (`SuspendedBillModals.tsx:22,63`).
  - `CashTransactionModal`: an input with `autoFocus` (`:113`).
  - Category overlay: search input `autoFocus`; **no Enter** (filter only); backdrop click closes.

## Modal Focus Contention Map

- Search `autoFocus` is one-time at mount; modal autofocus (`CashTx`, `OpenShift`, hold-note, category search) legitimately takes focus on open.
- **Focus-return inconsistency (Yellow):** PaymentModal/customer/new-sale/hold/restore/clear paths restore focus to search; UOM/ItemDiscount/Numpad/category-close paths do not.
- **PaymentModal while `processing`:** `onClose` is blocked (`POSPage.tsx:995` `if (checkout.processing) return`) and confirm is guarded — good double-submit protection.
- Manual-review/durable-rejection UI is a separate admin route (not mounted in POS); no POS modal adjacency.

## Disabled / Loading / Offline Keyboard Impact

- Checkout button `disabled={cartLines.length===0 || !activeShift}` (`:928`) mirrors the F12 gate — consistent keyboard/click parity for opening payment.
- PaymentModal `confirming`/`processing` guards prevent double-confirm; `busy` disables actions.
- Mid-sale update banner defers inventory refresh; **no keyboard/checkout impact** (prices won't shift mid-sale).
- Offline/`fromCache` affects display only; checkout remains a queueable write (never blocks).

## Touch / Click / Keyboard Parity

- **Product add:** click-only on `<button>` tiles; the only keyboard path is search+Enter scan. Tiles are native buttons (Tab+Enter activates), but there is **no managed tab order or arrow-key grid navigation** (6-column grid → long Tab traversal).
- **Qty:** `−`/`＋` are native buttons; the qty value opens the **touch-only** `NumpadDialog` (no hardware digits/Enter).
- **Checkout:** keyboard-first to *open* (F12); payment confirm is click-only.
- **Focus-visible:** `POSPage.css` defines **no `:focus-visible` styling** — keyboard focus relies on the browser default ring (often weak/inconsistent on styled buttons). (Green opportunity.)
- **Touch targets:** qty segs 32×32, icon btns 36×36 — below the SKILL §4 ≥44px guidance; checkout 60px is good. (Yellow note.)

## Green — Safe Presentation Surfaces

- CSS-only `:focus-visible` ring color/width/offset on `pos-*` buttons/inputs (improves keyboard visibility; **no focus mechanics**).
- Keyboard-hint label text/placement (search placeholder already shows "(Ctrl+f)"; checkout shows "(F12)") — text/spacing only.

## Yellow — Interaction-sensitive Surfaces

- Search `autoFocus` + RAF `focusSearch`; inconsistent focus-return after UOM/ItemDiscount/Numpad/category close.
- Enter-scan contract; **missing IME/composition guard** (premature scan on Thai `Enter`).
- Single global F12 listener active during modals (stacking risk).
- No global Escape; inconsistent modal Escape/Enter dismissal.
- `NumpadDialog` touch-only (no hardware-key/Enter) — cashier-speed/parity.
- Tab order across the 6-col grid; 32px touch targets vs 44px guidance.
- Disabled/loading keyboard affordance presentation.

## Red — Transactional / Write-path Keyboard Hazards

- **F12 → opens PaymentModal** (entry to checkout) — *opening* is Yellow, but any change that lets `Enter`/a key **confirm** the sale is Red.
- `PaymentModal` confirm (`onConfirm` → `confirmSale` → `buildAsyncOrder` → `submitAsyncOrder` → `setDoc('asyncOrders')`).
- Cart mutation on `Enter` (scan → `addToCart`); qty/discount mutations.
- `OpenShiftModal` `Enter` → shift open; `HoldBillNoteModal` `Enter` → suspended-bill persistence; cash-drawer actions.
- Oversell/stock evaluation, offline queue, IndexedDB, manual-review/evidence — none should be reachable/altered via keyboard work.

## Test Coverage Gaps

- `findByScanCode` is **module-local (not exported)** → no unit test for top-level vs UOM-specific barcode match, trimming, or miss. (Refactor-to-export or `?raw`/extraction needed for D4-A.)
- No test asserts **F12 gating** (open only when `cart>0 && activeShift`).
- No test/spec for **focus-return** expectations after modal close.
- No coverage for **IME/composition** behavior on the scan input (the behavior itself is absent).
- No test for **double-confirm** guard in PaymentModal (`!canConfirm || confirming || processing`).
- POS page has no DOM mount harness in repo (precedent: pure-helper + `?raw` source-level assertions).

## Future Safe Slice Recommendations *(recommendations only — not authorized here)*

- **D4-A — Keyboard Contract Tests (test-only):** extract `findByScanCode` (or test via `?raw`/a pure helper) and assert scan match/miss; source-level assert the F12 gate and the `disabled` parity; document focus-return expectations. **No runtime behavior change.**
- **D4-B — Focus Ring / Shortcut Label Polish (CSS/text-only):** add `:focus-visible` outlines on `pos-*` controls and tidy keyboard-hint labels; **no focus mechanics, no handlers.**
- **D4-C — Modal Focus & IME Fix Planning (read-only first):** plan (a) an IME/composition guard on the scan `Enter`, (b) consistent focus-return after UOM/Numpad/ItemDiscount close, (c) Escape-to-close consistency, (d) suppressing F12 while a modal is open. **Implementation only after separate Tech Lead authorization, with tests + Codex review** (these are Yellow/Red-adjacent behavior changes).

## Forbidden Areas for Future Keyboard UX Work (without separate authorization + dedicated Codex review)

Payment confirm via keyboard; cart-mutation/checkout/order-submit/offline-queue/IndexedDB writes via keyboard; the F12→payment **gating logic**; the scan→`addToCart` path; shift cash-drawer and suspended-bill persistence keyboard paths; oversell/stock evaluation; any handler/state/query in `POSPage.tsx`/`src/components/pos/*`/`src/lib/pos/*`/`src/lib/offline/*`; `SortingSettingsModal`/`ss-*`; Firestore rules/Functions; H7-F transfer/reversal files; `index.css`/`variables.css`; `stash@{0}`.

## Hidden Risks

- The **missing IME/composition guard** is a genuine behavioral bug risk (not cosmetic): a Thai cashier committing composition with `Enter` in the scan box can fire a premature `findByScanCode`/`addToCart` — must be handled as a tested behavior change under D4-C, never as "polish."
- The **always-on F12 listener** can stack PaymentModal over an open modal; and **inconsistent focus-return** quietly slows the next scan — both are invisible to unit tests, so any future change here needs explicit keyboard UAT.

## Final Recommendation

Proceed with **D4-A (keyboard contract tests, test-only)** and **D4-B (focus-ring/label CSS polish)** as the safe next steps; treat **D4-C (IME guard / focus-return / Escape / F12-during-modal)** as read-only planning that requires separate authorization, tests, and Codex review before any behavior change. No interaction-level POS implementation should proceed from this audit without that gate.
