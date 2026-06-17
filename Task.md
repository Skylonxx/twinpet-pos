# Current Task Tracker — Phase 7C-UI-01-ANIMATION (IMPECCABLE STYLE BUMP FLASH FOR RESCANNED CART ITEM / IMPLEMENTATION — AWAITING CODEX + AGY REVIEW)

> Living checkpoint doc for agents. Detailed history: `docs/reports/latest-report.md` (do not duplicate long-form evidence here).

## Current baseline

**Transfer Reversal Evidence sequence: FULLY CLOSED / COMMITTED**

- **H6-E2-A** — Pure Transfer Evidence Builder + Dual-Branch Invariant — CLOSED / COMMITTED — `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`
- **H6-E2-B** — Write Transfer Evidence Header at Completion — CLOSED / COMMITTED — `82d3352 feat(pos): write transfer reversal evidence header on completion`
- **H6-E2-C** — Transfer Evidence Coordinator Validation — CLOSED / COMMITTED — `fe3ff44 feat(pos): validate transfer reversal header evidence`

**Current clean baseline:** `07ed7c8 fix(pos): keep search local to active product context` (7C-UI-10-C, on top of 7C-UI-10-B `324bdf0` / 7C-L3-Rev2 `70b1698` / 7C-L3 `f8ce9ea` / 7C-L2 `654c704` / 7C-L1 `203f636` / 7C-P1 `d87110c` / 7C-D4-D2 `ca0d5d8` / 7C-D4-D `1a239b4` / 7C-E1 `0c7e924`). **7C-C3, 7C-C4, 7C-D2, 7C-D3-A, 7C-D3-B, 7C-D4-A, 7C-D4-C, 7C-D4-C-1..4, 7C-E1, 7C-D4-D, 7C-D4-D1, 7C-D4-D2, 7C-P1, 7C-L1, 7C-L2, 7C-L3, 7C-L3-Rev2, 7C-UI-10-B, and 7C-UI-10-C are CLOSED / COMMITTED.** 7C-POS-Stock-Matrix is an implementation slice on top of this baseline and NOT yet committed.

**✅ 7C-L2 PHYSICAL UAT PASSED / ACCEPTED → 7C-L3 AUTHORIZED.** CEO accepted the L2 empty-cart bill-level reset on the physical terminal. Tech Lead / CEO authorized **Phase 7C-L3 — UOM Barcode Search Result Display Alignment (APPROVED Option A)** — Medium severity / cashier confidence / search visibility. UAT finding: scanning a larger-unit (e.g. ลัง/carton) UOM barcode adds the correct unit on Enter (D4-D direct add works) but the visible result looks like only the base/small unit — reducing cashier confidence. **The D4-D direct UOM add-to-cart logic must remain intact.** UI-01 through UI-09 remain deferred; no visual UI polish, CSS, or checkout/payment/write-path change is authorized.

**Phase 7C-L3 — UOM Barcode Search Result Display Alignment (Tech Lead / CEO authorized) — IMPLEMENTATION / AWAITING CODEX REVIEW — NOT COMMITTED:**

**Root cause:** the product-grid filter (`matchesSearch`) and the product card key off product-level fields only, and the card always renders the BASE unit (`p.uomOptions[0]` price/name). So when a UOM-specific barcode for a larger unit is queried, the visible result shows base-unit info even though `findByScanCode` resolves `match.option` and Enter adds the correct unit. The display, not the add path, was misleading. **Fix (minimal, display-only):** a pure derived `scanUomHint` `useMemo` in `POSPage.tsx` runs the SAME `findByScanCode(products, search.trim())` the scan handler uses; when a UOM-specific barcode matched (`match.option` set) it returns `{ productName, unit }`, else `null` (text searches, SKU / product-level matches with `option === null`, and misses → null, so those displays are unchanged). A plain-text hint rendered next to the search box (`{scanUomHint && <span role="status">… {productName} — หน่วย: {unit}</span>}`) shows the cashier exactly which unit Enter will add. Uses existing Tailwind utilities already used in the file (`ml-2 whitespace-nowrap text-xs …`) — **no CSS file change, no new class.** **"หน่วย"** is the app-wide Thai term for unit (A4Invoice / ReceivingForm / UomModal). **No change** to: the `findByScanCode` scan/Enter add path (D4-D direct UOM add intact), product-level/SKU barcode behavior, scan-miss (toast-only), L1 multi-UOM queue, L2 bill-level reset (`useCart` untouched), discount numpad / `ล้างส่วนลด`, Product Picker / UOM modal UI, checkout/payment/write paths, or CSS.

**Test updates (`src/pages/POSPage.keyboard-contract.test.ts`, +6 L3 tests, new section I):** `scanUomHint` derives from `findByScanCode` and surfaces `{productName, unit}` only for a UOM-barcode match (`match?.option`), returning null otherwise; the memo is pure (no `addToCart`/`setSearch`/`setUom*`/write paths); the hint renders the product name + unit label as an accessible `role="status"` plain-text element using "หน่วย"; the D4-D Enter direct-UOM add path is unchanged; `findByScanCode` SKU-before-UOM priority and toast-only scan-miss are unchanged. All prior D4/L1 contracts green (unchanged).

**Forbidden boundaries honored (L3):** no CSS change (POSPage.css/index.css/styles untouched — hint uses existing Tailwind utilities); no `useCart.ts` / `useCart.contract.test.ts` change (L2 untouched); no Product Picker / UomModal / `components/pos/*` change; no `PaymentModal`/`App.tsx`/`lib/*` change; no checkout/payment/order-creation/offline/IndexedDB/manual-review change; no D4-D scan-routing change (add path identical); no D4-D2 numpad change; no UI-01…UI-09; no route/auth; no Firebase rules/Functions; no LAN/emulator; no Android/Capacitor/`.claude/`. Changed files = `src/pages/POSPage.tsx`, `src/pages/POSPage.keyboard-contract.test.ts`, `Context.md`, `Task.md`; `stash@{0}` untouched (read-only `git stash list` only). Validation: `tsc -b` clean; `vitest run` **564 passed** (31 files); targeted spec **64 passed**.

**7C-L3 + Revisions — CLOSED / COMMITTED.** L3 (`f8ce9ea`) shipped the derived hint; physical UAT then drove two revisions: Rev1 relocated the hint below the search bar (overflow fix), Rev2 (`70b1698 fix(pos): add permanent status bar for uom scans`, Codex PASS WITH NOTES) made it a PERMANENTLY-mounted System Status & Alert Bar (default idle hint + UOM-match state; always mounted → no layout shift; pure projection of `scanUomHint`; no CSS file / backend / scan-add change). Physical UAT for the status bar accepted.

---

## Phase 7C-UI-10 — Restore Best Seller System / Remove All Tab

**7C-UI-10-A — Discovery (read-only, design-proposal-first gate) — COMPLETE.** Conclusive: **no per-product best-seller boolean exists**; "best sellers" is the per-branch `sorting['best-sellers']` RANKING of the FULL catalog, and the legacy "ทั้งหมด" (All) tab (`activeCategory === ''`) was that full list, ranked. Product CRUD = `ProductCRUDPage.tsx` hosting `components/products/ProductDrawer.tsx`, deliberately separated from POS presentation. Recommended **Option A** (new optional global `isBestSeller`); **Option B** (reuse ordering array as membership) **rejected**. Tech Lead approved Option A.

**Scope-expansion history (two clean BLOCKs):** (1) first attempt blocked — the product form UI lives in `ProductDrawer.tsx`, not the authorized `ProductCRUDPage.tsx` → ProductDrawer authorized; (2) second attempt blocked — POS reads mapped `PosProduct`, not raw `Product`, so `isBestSeller` was dropped by the mapper → `src/lib/pos/types.ts` + `src/lib/pos/posProductMapper.ts` authorized.

**Phase 7C-UI-10-B — Restore Best Seller System / Remove All Tab (Tech Lead / CEO authorized, Option A) — CLOSED / COMMITTED — `324bdf0 feat(pos): restore best seller tab and product flag`:**

**Architecture (Option A):** additive optional `Product.isBestSeller?: boolean` and `PosProduct.isBestSeller?: boolean` (legacy/absent → `false`). `posProductMapper.toPosProduct` projects `product.isBestSeller ?? false`. Membership (the global flag) is kept **separate from ordering** — `sorting['best-sellers']` stays ordering-only; Product CRUD never writes the per-branch sorting docs. Option B not used.

**Product CRUD:** `ProductFormData.isBestSeller` wired through `emptyForm()` (false), `productToForm()` (`product.isBestSeller ?? false`), `formToProduct()` (persisted). `ProductDrawer` gains a `⭐ สินค้าขายดี` toggle (existing `pc-tog-row`/`Toggle` pattern) bound to `form.isBestSeller` with help text `ติ๊กเพื่อให้สินค้านี้แสดงในแท็บ ⭐ สินค้าขายดี ของหน้า POS`. Edit hydrates automatically via `productToForm`; `ProductCRUDPage` forwards the full form (no change needed). No sorting-doc mutation.

**POS (`POSPage.tsx`):** `ทั้งหมด` (All) tab removed from the pill bar AND the category overlay (the `selectCategory('')` / `setActiveCategory('')` sentinels are gone). `⭐ สินค้าขายดี` restored as the absolute first tab and the default active tab via the `BEST_SELLERS_KEY` sentinel (`useState<string>(BEST_SELLERS_KEY)`); the ghost-reset effect preserves the virtual sentinel and falls back to it (never to All). The grid filters mapped `PosProduct.isBestSeller === true` when idle; **search transcends the tab** (`q ? matchesSearch(p) : p.isBestSeller === true`) so any product stays findable from the default tab. Ordering still via `sortProductsByCustomOrder(filtered, sorting[sortKey])` with `sortKey` collapsing to `BEST_SELLERS_KEY` for the ⭐ tab. Empty state: `ยังไม่มีสินค้าขายดี — เลือกหมวดหมู่อื่น หรือค้นหา/สแกนสินค้า` (idle only; search/scan stay available).

**Tests (`src/pages/POSPage.keyboard-contract.test.ts`, +20, sections J + K):** All-tab removal (pill bar + overlay + sentinel handlers); ⭐ tab exists / first / default; filter on mapped `isBestSeller === true`; ordering still uses `sorting['best-sellers']` (Option B negative assertions); search transcends tab; empty-state text; ghost-reset preserves the sentinel; scan/UOM/SKU/scan-miss unchanged; L3 status bar present; L1 queue untouched; Product/PosProduct types carry the optional flag; mapper projects with `?? false`; form helpers wired; drawer label/help/binding; Product CRUD never calls the sorting-store mutation APIs.

**Forbidden boundaries honored (UI-10-B):** no CSS change; no `useCart.ts` / `useCart.contract.test.ts` (L2) change; no `PaymentModal`/`App.tsx` change; no checkout/payment/order-creation/cart-mutation change (beyond the approved additive product-save field); no Firebase rules/Functions; no backend promotion logic; no offline/manual-review; no Android/Capacitor/`.claude/`; no L1/L2/L3 regression; `sorting['best-sellers']` stays ordering-only. Changed files = `src/pages/POSPage.tsx`, `src/pages/POSPage.keyboard-contract.test.ts`, `src/components/products/ProductDrawer.tsx`, `src/lib/productCrud/types.ts`, `src/lib/types.ts`, `src/lib/pos/types.ts`, `src/lib/pos/posProductMapper.ts`, `Context.md`, `Task.md`; `stash@{0}` untouched (read-only `git stash list` only). Validation: `tsc -b` clean; `vitest run` **597 passed** (31 files); targeted spec **97 passed**.

**UI-10-B Revision 1 (Codex NEEDS REVISION → FIXED, narrow blocker-fix):** Codex flagged that overlay category buttons called `setActiveCategory(...)` + `closeCatModal()` directly, bypassing `selectCategory(...)` (which clears `activeQuickMenuId`) — so a previously-active Quick Menu survived an overlay category pick and the grid stayed filtered by the old Quick Menu (category-selection inconsistency). **Fix (POSPage only):** added a `selectCategoryFromOverlay(catId)` wrapper that delegates to `selectCategory(catId)` (clears the Quick Menu) then `closeCatModal()`; both overlay cells (⭐ best-seller + physical-category map) now route through it, and the overlay highlights gained `&& !activeQuickMenuId`. **Unchanged:** pill-bar `selectCategory` path, `selectQuickMenu`, Quick Menu precedence (filter still short-circuits on `activeQuickMenuId` first), scanner/search/UOM/L1/L2/L3, Product CRUD, mapper, membership & ordering logic. Tests: +7 section-L contracts (selectCategory clears Quick Menu; wrapper delegates + closes; both overlay cells route through the wrapper and no longer flip `setActiveCategory` directly; the exact bug shape `setActiveCategory(...)+closeCatModal()` is gone; pill bar unchanged; Quick Menu precedence intact when intentionally selected; scanner/UOM/miss/L3 no regression). Changed files: `src/pages/POSPage.tsx`, `src/pages/POSPage.keyboard-contract.test.ts`, `Context.md`, `Task.md`. `tsc -b` clean; `vitest run` **604 passed** (31 files); targeted spec **104 passed**. `stash@{0}` untouched.

**UI-10-B — CLOSED / COMMITTED (`324bdf0`).** Codex PASS, Tech Lead approved closure, committed; physical UAT then drove UI-10-C below.

---

## Phase 7C-UI-10-C — Strict Local Search + Sorting-Modal Best-Seller Scope

**7C-UI-10-C — UAT polish (Tech Lead / CEO authorized) — CLOSED / COMMITTED — `07ed7c8 fix(pos): keep search local to active product context`:**

**UAT feedback (on committed UI-10-B `324bdf0`):** (1) the POS grid search **escaped the active tab** — global search devalued category navigation and caused context loss; (2) the SortingSettingsModal `best-sellers` group **leaked the whole inventory** into the ranking list, because the modal's `SortableProduct` shape carried no `isBestSeller` membership flag.

**Initial slice blocked cleanly:** Fix 2 required the membership flag on the sorting data path (`SortableProduct` lacked `isBestSeller`); the authorized set covered only the modal. **Tech Lead approved scope expansion** for `src/lib/pos/categoryService.ts` + `src/lib/admin/sortingStore.ts` and corrected the modal path to `src/components/pos/SortingSettingsModal.tsx`.

**Fix 1 — POS search is a STRICT LOCAL / intersection filter (`POSPage.tsx`):**
- ⭐ สินค้าขายดี tab: `p.isBestSeller === true && matchesSearch(p)` — the old escape (`q ? matchesSearch(p) : p.isBestSeller === true`) is removed, so a matching non-best-seller can never surface in the ⭐ grid.
- Physical category tab: `matchCat && matchesSearch(p)` — a match from another category cannot leak in.
- Quick Menu: stays local (`idSet.has(p.id) && matchesSearch(p)`); precedence intact (its branch evaluated first).
- **Unchanged:** the branch-hidden exact-code reveal (`isExactCodeMatch`), `findByScanCode` (SKU-before-UOM), the Enter direct-UOM add path, scan-miss (toast-only). This slice targets **text-based grid filtering only** — scanner / direct-add behavior is byte-identical.

**Fix 2 — Sorting-modal best-seller membership scope (data path):**
- `SortableProduct` (`categoryService.ts`) gains `isBestSeller?: boolean` (membership; distinct from `sorting['best-sellers']` ordering).
- `sortingStore` projects `Product.isBestSeller ?? false` in BOTH `devSortableProducts()` and the live `useSortableProducts()` map.
- `SortingSettingsModal` scopes the `best-sellers` group to `products.filter((p) => p.isBestSeller === true)` — no full-inventory leak; the visible flagged subset is what gets ranked/saved.
- `sorting['best-sellers']` stays ORDERING-only (never membership); physical-category scope (`matchesCategoryFilter`) and the sort write API (`saveProductSortOrder`) unchanged.

**Tests (`src/pages/POSPage.keyboard-contract.test.ts`):** the old "search transcends the ⭐ tab" test is rewritten to assert the strict-local intersection contract; new section M adds POS local-search coverage (⭐ intersection / escape removed / physical-category intersection / Quick-Menu local / scanner-direct-add independence / hidden-product reveal preserved) and sorting-modal data-path coverage (`SortableProduct` carries `isBestSeller`; store maps `Product.isBestSeller ?? false` in both mappers; modal scopes best-sellers to `isBestSeller === true`; physical scope unchanged; `sorting['best-sellers']` not used as membership). `tsc -b` clean; `vitest run` **615 passed** (31 files); targeted spec **115 passed**.

**Forbidden boundaries honored (UI-10-C):** no CSS change; no `useCart.ts` / `useCart.contract.test.ts` (L2); no `PaymentModal`/`App.tsx`; no Product CRUD toggle/persistence pipeline change; no POS mapper change; no checkout/payment/cart-mutation; no Firebase rules/Functions/backend; no offline/manual-review; no Android/Capacitor/`.claude/`; no L1/L2/L3 regression; `sorting['best-sellers']` stays ordering-only. Changed files = `src/pages/POSPage.tsx`, `src/components/pos/SortingSettingsModal.tsx`, `src/lib/pos/categoryService.ts`, `src/lib/admin/sortingStore.ts`, `src/pages/POSPage.keyboard-contract.test.ts`, `Context.md`, `Task.md`; `stash@{0}` untouched (read-only `git stash list` only).

**UI-10-C — CLOSED / COMMITTED (`07ed7c8`).** Codex PASS WITH NOTES, Tech Lead approved closure, committed; physical UAT on the stock toggle then drove 7C-POS-Stock-Matrix below.

---

## Phase 7C-POS-Stock-Matrix — 3-Tier Oversell Control

**7C-POS-Stock-Matrix — Full-pipeline re-implementation (Tech Lead / CEO authorized) — IMPLEMENTATION / AWAITING CODEX REVIEW — NOT COMMITTED:**

**Context:** Tech Lead/CEO rejected the read-only discovery report and authorized a full-pipeline implementation. Confirmed root cause: stock validation existed and was wired to all add/update paths but was **advisory-only (toast, never blocked)**; the "ghost toast" was the validation branch being skipped entirely whenever `allowNegativeStock === true` (no secondary warn flag existed — it had been removed historically).

**The 3-Tier Stock Matrix (keyed on two product flags):**
- **Tier 1 — Strict Block** (`allowNegativeStock === false`): prevent the quantity increase, show a red 🚫 toast (`สต็อกไม่พอ …` / `สต็อกหมด …`) immediately.
- **Tier 2 — Warning Pass** (`allowNegativeStock === true && warnOnOversell !== false`): allow the oversell, show a yellow ⚠️ toast containing `สินค้าเกินสต็อกที่มีอยู่!`.
- **Tier 3 — Silent Pass** (`allowNegativeStock === true && warnOnOversell === false`): allow, no toast, no block.

**Schema & mapping:** added `warnOnOversell?: boolean` to `Product` (`src/lib/types.ts`); `ProductFormData` (`src/lib/productCrud/types.ts`) — field + `emptyForm` default `true` + `productToForm` `?? true` + `formToProduct` persists; `PosProduct` (`src/lib/pos/types.ts`); `posProductMapper` projects `product.warnOnOversell ?? true` (default-warn for safety). The save passthrough `sanitizeProductDocForFirestore` spreads the field automatically (no out-of-scope edit needed); legacy docs read back as warn via the mapper default.

**Product Admin UI:** restored the `แจ้งเตือนเมื่อสต็อกติดลบ (Warn on Oversell)` toggle in `ProductDrawer.tsx` (help text per directive), gated `disabled={!form.allowNegativeStock}` so it only applies when overselling is enabled.

**Cart enforcement (`cartUtils.ts` + `useCart.ts`):** pure `evaluateAddToCartStock(product, option, addQty, cart) → { mode, block, toast }`, plus `resolveStockMode` and `committedBaseUnits`. Validation **aggregates every UOM line of the product in BASE units** (`committed + addQty × option.factor`) before the boundary check, so multi-UOM and mixed-unit carts can't collectively slip past stock. `useCart.addToCart` / `changeQty` / `setLineQty` route every INCREASE through it: surface the toast, and on a Tier 1 block **return without mutating** (`setLineQty` returns `false` so the qty numpad stays open). **Decrements/removals are never blocked; NO checkout-level hard stop** (offline-first preserved — enforcement lives only at the cart-entry/mutation layer). Removed the old advisory `validateAddToCartStock`/`validateCartStock` and the `คำเตือนสต๊อก` copy.

**Revision 1 (Codex NEEDS REVISION → fixed):** **Blocker 1 — stale `rawCart` closure:** mutators validated against the render-time `rawCart` closure, so two same-tick increases could both read stale state and jointly cross a Tier 1 boundary. **Fix:** extracted the cart mutation into PURE appliers (`applyAddToCart`/`applyChangeQty`/`applySetLineQty` in `cartUtils.ts`, each `current cart → { cart, toast, block/ok }`); the hook threads the LATEST cart via a synchronously-updated `cartRef` + shared `commit(next)` (ref + state together), with a `useEffect` re-syncing the ref for reprice/clear/restore. **Blocker 2 — missing executable hook-level tests:** added a behavior harness around the SAME appliers + a `vi.fn()` `showToast` spy mirroring the hook's wrapper, proving real add/change/set behavior, toast Rule 1/2/3 (spy called/not-called/with-warning), same-tick guards, and aggregate multi-UOM. **Blocker 3 (tracker):** corrected the stale UI-10-C "not closed" wording in `Context.md` (UI-10-C is CLOSED/COMMITTED `07ed7c8`; active phase is 7C-POS-Stock-Matrix, NEEDS REVISION → revision active).

**Tests (`useCart.contract.test.ts`, 8 → 55):** pure-evaluator suites (`resolveStockMode` all 3 tiers + default-warn; Tier 1/2/3 incl. CEO 58→59, UOM multiplier, empty-stock; aggregate cross-UOM) PLUS executable hook-behavior suites via the harness (addToCart/changeQty/setLineQty qty applied-or-not, same-tick cannot bypass strict, decrement/zero-out never blocked, numpad-correction flow, toast spy Rule 1/2/3) PLUS source-level wiring (`cartRef.current` + appliers + `commit` + `return result.ok`). Existing L2 suite untouched.

**Validation:** `tsc -b` clean; `vitest run` **662 passed** (31 files); targeted `useCart.contract.test.ts` **55 passed**; POSPage spec **115 passed**. `stash@{0}` untouched (read-only `git stash list` only).

**Forbidden boundaries honored:** no checkout-level block (`useCheckout` untouched); no CSS/global styling; no `App.tsx`/`PaymentModal`; no Firebase rules/Functions/backend; no offline/manual-review; no Android/Capacitor/`.claude/`; no UI-01..09; no `POSPage.tsx`/`POSPage.keyboard-contract.test.ts` change; L1 multi-UOM queue + L2 bill reset + L3 status bar untouched. Changed files = `src/lib/types.ts`, `src/lib/productCrud/types.ts`, `src/lib/pos/types.ts`, `src/lib/pos/posProductMapper.ts`, `src/components/products/ProductDrawer.tsx`, `src/hooks/pos/useCart.ts`, `src/hooks/pos/useCart.contract.test.ts`, `src/lib/pos/cartUtils.ts`, `Context.md`, `Task.md`.

**Next step (7C-POS-Stock-Matrix):** CLOSED / COMMITTED at 29995ea.

---

## Phase 7C-UI-11-TOAST-UX — Global Toast Provider Refactor (REJECTED BY CEO PHYSICAL UAT → superseded by UI-12)

**Context:** Tech Lead rejected local POS toast expansion and authorized a Global Toast Provider Refactor; it was implemented but **CEO Physical UAT rejected it** for four critical reasons. The package is NOT committed and is being revised in-place by UI-12.

CEO rejection reasons:
- **Performance/flicker** — POSPage re-rendered entirely whenever a toast appeared (fatal for POS).
- **Stacking** — toasts piled vertically and could block the screen.
- **Double icons** — messages showed redundant emojis (e.g. ⚠️ ⚠️).
- **Ugly styling** — muddy, dark, unprofessional colors.

---

## Phase 7C-UI-12-FLOWBITE-TOAST — Toast Performance / Stacking / Icon / Visual Fix (ACTIVE)

**Goal:** Fix toast performance, stacking, double icons, and visual quality. In-place revision of the rejected UI-11 package.

- **No POSPage toast subscription:** added non-subscribing `useToastDispatcher()` in `use-toast.ts` (returns only the stable module-level `toast()`); `POSPage` uses it instead of `useToast()` → no read of the `toasts` array, no re-render/flicker on toast changes. Only `<Toaster />` subscribes.
- **Max 1 visible toast:** `MAX_VISIBLE_TOASTS = 1` in `use-toast.ts`; identical toast (same title/description/variant) refreshes the dismiss timer (dedupe), different toast replaces the current one. No vertical stacking; rapid scanner errors cannot pile boxes.
- **No hardcoded emojis in stock messages:** `useCart.dispatchStockToast` strips the leading glyph (`🚫`/`⚠️`) from the title and maps to variants (Tier 1 → `destructive`, Tier 2 → `warning`, Tier 3 → no toast). Icon comes only from the toast component's inline SVG. `cartUtils.ts` unchanged.
- **Flowbite-style soft variants:** `toast.tsx` rebuilt — default `bg-white`, destructive `bg-red-50`/`border-l-red-500`, warning `bg-yellow-50`/`border-l-yellow-400`, success `bg-green-50`/`border-l-green-500`, all `rounded-lg shadow-md`, clean inline SVG icons (no emoji). `toaster.tsx` top-center, `pointer-events-none` container with `pointer-events-auto` on the toast only; no full-screen overlay, no layout shift.
- stock matrix logic unchanged
- cart math / behavior unchanged
- L1/L2/L3 unchanged
- POS grid / search / category / Quick Menu / Best Seller unchanged
- no checkout hard stop
- `cartUtils.ts` / schema / mapper / Firebase / offline / Android / `.claude/` untouched
- `App.tsx` (Toaster injection unbroken), `POSPage.css`, and test files left as-is from UI-11
- UI-01 through UI-09 remain unauthorized
- Codex GPT-5.5 review mandatory before closure
- no staging/commit until Codex PASS / PASS WITH NOTES and Tech Lead authorization
- `stash@{0}` untouched

**Files changed in the UI-12 step:** `src/components/ui/toast.tsx`, `src/components/ui/toaster.tsx`, `src/components/ui/use-toast.ts`, `src/hooks/pos/useCart.ts`, `src/pages/POSPage.tsx`, `Context.md`, `Task.md`.

---

## Phase 7C-UI-13-TOAST-TYPOGRAPHY — Toast Typography / Layout Refinement (ACTIVE)

**Context:** CEO Physical UAT accepted UI-12 performance but **rejected typography/layout for "information clumping"** — product name + remaining quantity were merged into one long title with identical styling, width looked fluid/unstandardized, and the red Strict Block / yellow Warning Pass were not a single unified structured pattern. Layered on the uncommitted UI-11/UI-12 package.

**Goal:** Strict Block and Warning Pass share the EXACT same structured layout — differing only in semantic color + icon.

- **Standardized width:** `toast.tsx` root is now `w-full max-w-[400px]` (no content-driven stretch); `toaster.tsx` top-center container kept at `w-[min(92vw,420px)]` (width owned by the inner toast, so `toaster.tsx` is unchanged). Top-center placement, pointer-events safety, no overlay, no layout shift preserved.
- **Static titles:** `useCart.dispatchStockToast` no longer derives the title from `msg`. Strict Block title = static `สต็อกไม่พอ!`; Warning Pass title = static `สินค้าเกินสต็อก`. No product name, no remaining quantity, no emoji in the title; icon comes only from the toast component's SVG.
- **Structured description:** dynamic detail moved into a shared `\n`-joined string built by `buildStockDescription(ctx, includeDetail)` from product context already in the hook — Line 1 `[Product Name]`, Line 2 `คงเหลือ: [Stock] [Unit]`, Line 3 (strict only) `ไม่สามารถเพิ่มสินค้าเกินจำนวนสต็อกที่มีอยู่ได้`. Context resolved from `product` directly (`addToCart`) or via `resolveStockToastContext` over `products` + the cart line (`changeQty`/`setLineQty`); stock/unit are `product.stock` / `product.baseUnit`. No `cartUtils.ts` change; no stock-calc change.
- **Typography hierarchy / distinct remaining line:** `toast.tsx` `ToastDescription` splits on `\n` — the `คงเหลือ:` line renders `font-semibold` (visually distinct), Line 1 normal, the strict-only line smaller/lighter. Both variants share order + spacing; only color/icon differ.
- **`use-toast.ts` NOT modified** — description stays a string (React-node route avoided), so the store/type file out of scope was respected.
- **Contract test aligned (`useCart.contract.test.ts` newly authorized for UI-13):** harness `dispatchStockToast` mirrors the static-title + structured-description impl (threads `ctx`); source-contract assertions drop the old `title: msg.replace(/^🚫|^⚠️/)` patterns, reject any dynamic-title relapse, and pin the exact static titles + `buildStockDescription` usage; executable spy tests assert title equals the static copy (glyph-free, no product name/quantity) while the description carries name + distinct `คงเหลือ:` + stock/unit (+ strict-only third line; warning omits it). Stock-matrix behavior tests, same-tick stale-cart, and aggregate multi-UOM tests preserved unchanged.
- MAX_VISIBLE_TOASTS=1 / dedupe / replace / timer cleanup unchanged
- POSPage non-subscription unchanged; SVG icons + Flowbite semantic colors preserved; no double icons
- stock matrix logic unchanged; cart math / behavior unchanged; L1/L2/L3 unchanged; no checkout hard stop
- POS grid / search / category / Quick Menu / Best Seller unchanged
- `POSPage.tsx` / `POSPage.css` / `use-toast.ts` / `App.tsx` / `cartUtils.ts` / schema / mapper / Firebase / offline / Android / `.claude/` untouched
- UI-01 through UI-09 remain unauthorized
- Codex GPT-5.5 review mandatory before closure
- no staging/commit until Codex PASS / PASS WITH NOTES and Tech Lead authorization
- `stash@{0}` untouched

**Validation:** `tsc -b` clean; full vitest **681 passed** (31 files); `useCart.contract.test.ts` 68; `POSPage.keyboard-contract.test.ts` 121.

**Files changed in the UI-13 step:** `src/components/ui/toast.tsx`, `src/hooks/pos/useCart.ts`, `src/hooks/pos/useCart.contract.test.ts`, `Context.md`, `Task.md`.

> NOTE: The combined UI-12 + UI-13 toast package was committed as `f9d11ec fix(pos): polish toast feedback and typography` (Tech Lead/CEO Option B closure with notes).

---

## Phase 7C-UI-01-ANIMATION — Impeccable Style Bump Flash for Rescanned Cart Item (ACTIVE / IMPLEMENTATION — AWAITING CODEX + AGY REVIEW — NOT COMMITTED)

**Context:** CEO Physical UAT confirms the bump-to-top cart logic (`c3f7193`) works flawlessly. This slice adds the missing premium visual feedback so the cashier immediately notices that a rescanned EXISTING line incremented — calm, elegant, no harsh flash / eye strain. **UI-only; `useCart.ts` stays locked.**

- **Trigger (POSPage.tsx only):** `previousQtyByLineKeyRef` (`Record<lineKey, qty>`) + `flashingLineKeys` `Set<string>` state + per-line `flashTimeoutsRef`. An effect over `cartLines` records each line's current `qty` and, when a line that **existed before** has an INCREASED qty, calls `triggerBumpFlash(line.lineKey)`. The prev-qty map starts empty, so first render / post-clear hydration and brand-new lines have no prior qty and never flash; decrements and customer/tier re-prices keep the same qty and are ignored; removed lines drop from the map so a later re-add counts as new (no flash). Identity is the stable `line.lineKey` (never an index) — the correct row flashes through the bump-to-top reorder.
- **Retrigger:** `triggerBumpFlash` clears any pending removal timer, drops the key for one frame, then re-adds it on `requestAnimationFrame` so the CSS animation RESTARTS on rapid repeat scans of the same line; a single `setTimeout(BUMP_FLASH_MS = 900)` per line removes the class after the pulse; an unmount effect clears all pending timers.
- **Render:** the cart row (`.pos-ci`) gains `pos-cart-line--bump-flash` while flashing — no structural / key / layout change, cart actions intact.
- **CSS (POSPage.css):** new `@keyframes posCartBumpFlash` — soft Flowbite blue-50 (`rgba(239,246,255,…)`) background pulse + faint inset blue ring fading to transparent over `900ms ease-out`. **Only `background`/`box-shadow` animate (no transform/size/position) → zero layout shift.** No yellow/red alarm tint, no blink. A `prefers-reduced-motion: reduce` block collapses the pulse to `1ms`.
- **Unchanged / locked:** cart logic, cart array-order logic, stock validation, stock-matrix rules, cart math, discount/tax/totals, checkout hard stop, checkout/payment flow, Global Toast UX/provider, `MAX_VISIBLE_TOASTS = 1`, POS-preferences behavior, product-grid/scrollbar hotfix, local seed data, Firebase rules/Functions, Android/Capacitor, `.claude/`, stash.

**Files changed in this step:** `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, `Context.md`, `Task.md`.

**Visual UAT (physical, still required):** open POS → add A, B, C → re-scan B → B bumps to top and shows a soft ~0.8–1.0s premium pulse (no yellow/red, no layout shift) → cart total + F12 footer stay stable → Toast behavior unchanged → repeat quick B scans retrigger the pulse consistently.

**Closure gate:** Codex GPT-5.5 High + AGY QA/UX review mandatory before Tech Lead closure/commit. UI-02 through UI-09 remain unauthorized. `stash@{0}` untouched; no staging/commit.

---

## Phase 7C-UI-01-HOTFIX-BUMP-TO-TOP — Existing Cart Item Increment Bumps To Top (ACTIVE / IMPLEMENTATION — AWAITING CODEX REVIEW — NOT COMMITTED)

**Context:** CEO Physical UAT found that scanning/adding an item already in the cart incremented its quantity **in place** — `applyAddToCart` (cartUtils, forbidden) re-assigns the same record key, so the line kept its original slot and stayed buried (often scrolled out of view). No immediate "scan worked" feedback → double-scan risk.

- **Fix (useCart.ts only):** new pure module-level helper `bumpLineToEnd(cart, key)` returns a NEW record with the target key re-keyed to the LAST insertion slot (other lines keep their relative order; no in-place mutation of the record or any line object; identity stays the stable `lineKey`, never an index). `addToCart` captures `existed = cartRef.current[key] !== undefined` BEFORE the add, then commits `existed ? bumpLineToEnd(result.cart, key) : result.cart` after a non-blocked add. An existing line moves to the end of `cartLines` state; POSPage renders `cartLines.slice().reverse()`, so it visually bumps to the TOP. A brand-new line is already appended last by `applyAddToCart`, so no reorder is applied to it.
- **State examples:** `[A,B,C]` + re-add B → state `[A,C,B]` → visual reverse `[B,C,A]` (B on top). New item: `[A,B]` + add C → `[A,B,C]` → visual `[C,B,A]`.
- **Unchanged:** stock matrix validation, oversell block/warn/silent branches, qty math, totals/discount/tax, FIFO/cost, toast dispatch — only the key ORDER of an already-decided successful add changes. `changeQty` / `setLineQty` / `removeLine` / `setLineDiscount` / `restoreCart` / `clearCart` / checkout are NOT reordered (intentional).
- **Tests (`useCart.contract.test.ts`):** harness `addToCart` mirrors the bump (+ local `bumpLineToEnd`); new executable suite asserts `[A,B,C]`→`[A,C,B]` reorder, correct incremented qty on the bumped line, new-item append-last, blocked-add leaves order+qty inert, and a different UOM of an existing product is a NEW last line; new source-level assertions pin `bumpLineToEnd` purity/order and the `addToCart` existence-check + commit expression; the prior `addToCart` source-contract test updated for the new commit call (blocked-return still precedes commit).
- No POSPage layout/CSS, Global-Toast/`MAX_VISIBLE_TOASTS=1`, checkout-hard-stop, preferences-hook, local-seed, Firebase, or Android changes. `stash@{0}` untouched; no staging/commit. UI-02 through UI-09 remain unauthorized.

**Files changed in this step:** `src/hooks/pos/useCart.ts`, `src/hooks/pos/useCart.contract.test.ts`, `Context.md`, `Task.md`.

**Closure gate:** Codex GPT-5.5 High review mandatory before Tech Lead closure/commit. The prior scrollbar-gutter hotfix is COMMITTED at `1e83473`.

---

## Phase 7C-UI-01-HOTFIX — Scrollbar Layout Shift & Optical Balance (COMMITTED — `1e83473 fix(pos): stabilize product grid scrollbar gutter`)

**Context:** CEO Physical UAT on the committed UI-01 (`667093e`) found the product grid jumps horizontally when navigating between categories with different product counts — a short category shows no vertical scrollbar, a tall one shows it, and the appearing/disappearing scrollbar shifts the grid. CEO also required the cards to stay visually centered (a one-sided right gutter would look off-center).

- **Fix (CSS-only):** on the actual vertical scroll container `.pos-product-grid` — `overflow-y: scroll` (track permanently reserved; strong cross-browser baseline, removes the auto on/off toggle) **and** `scrollbar-gutter: stable both-edges` (reserves a matching empty gutter on the opposite/left inline edge using the browser's real scrollbar width). Cards stay dead-center; no hardcoded 15px compensation needed because `both-edges` mirrors the actual scrollbar width on both sides.
- POSPage.tsx not modified — the grid class wiring already exists; CSS-only.
- No layout restructuring; search bar, cart shell, cart footer, product-card content, grid-column + font-size preference behavior, category behavior, scanner/search, keyboard/F12, and toast behavior are all unchanged.
- No cart logic / cart math / stock validation / stock-matrix / checkout-hard-stop / Global-Toast / `MAX_VISIBLE_TOASTS` / POS-preferences-hook / local-seed / Firebase / Android changes.
- `stash@{0}` untouched; no staging/commit. UI-02 through UI-09 remain unauthorized.

**Files changed in the hotfix step:** `src/pages/POSPage.css`, `Context.md`, `Task.md`.

**Closure gate:** hotfix closure review required before any commit. UI-01 itself remains COMMITTED at `667093e`.

---

## Phase 7C-UI-01 — Main POS Layout & Core UX Preferences (COMMITTED — `667093e` [combined with local-seed, Option A])

**Context:** Tech Lead/CEO authorized resumption of the POS UI overhaul, starting with UI-01 — the main POS layout foundation, cart newest-on-top, a localStorage POS-preferences foundation, sticky search/cart regions, and Flowbite-style visual separation. Scoped strictly to `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, a new `src/hooks/pos/usePOSPreferences.ts`, and the trackers. Local seed UAT data (`mock-products.json`) is **not** part of UI-01 and was not touched.

- **Directive A — Cart newest-on-top (display-only):** POSPage renders a `displayCartLines = useMemo(() => cartLines.slice().reverse(), [cartLines])` reversed copy; `cartLines` (and the checkout/receipt/hold payloads derived from it) keep original insertion order. Row identity stays the stable `line.lineKey` (never an index), so every cart action targets the correct original line. No cart math / quantity / discount / FIFO / stock-matrix change; `useCart.ts` untouched.
- **Directive B — POS preferences foundation:** new `usePOSPreferences()` hook — `gridColumns: 4|5|6` (default 5) + `fontSize: small|normal|large` (default normal), localStorage-backed (`twinpet_pos_prefs`). Storage access is SSR/private-mode/quota safe; parsed values validated against the unions with recovery to defaults; validating setters exported for the future Settings page. POSPage consumes the values only — **no toggle UI on POS**.
- **Directive C — Dynamic grid + font scale:** product grid columns via `--pos-grid-cols` set by `pos-grid-cols-{4,5,6}` class (responsive media caps preserved after the preference classes); product-card text scales via `--pos-font-scale` set by `pos-fontsize-{small,normal,large}` on `.pos-page`. Class mapping, no inline styles, no Tailwind-purge risk (static class names).
- **Directive D — Independent scrolling / sticky:** product search lives in the always-visible top bar (never scrolls away) above the category bar; only `.pos-product-grid` scrolls (added `min-height:0` to product area + grid). Cart card: customer bar pinned top, `.pos-cart-items` is the only scroll region (`min-height:0`), totals + F12 checkout footer pinned bottom (`flex-shrink:0`). F12 / modal-suppression / focus-return / scan-input behavior unchanged.
- **Directive E — Flowbite visual separation:** app surface stays gray-50; cart is now a raised white card (`border-radius`, `box-shadow`, margin) floating on it. No broad redesign of unrelated components.
- **UI-12/UI-13 toast system untouched:** no toast files modified, `MAX_VISIBLE_TOASTS=1` unchanged, top-center single toast preserved.
- No stock-matrix / cart-math / Global-Toast / checkout-hard-stop / schema / mapper / Firebase / Android changes. `stash@{0}` untouched; no staging/commit.

**Files changed in the UI-01 step:** `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, `src/hooks/pos/usePOSPreferences.ts` (new), `Context.md`, `Task.md`.

**Closure gate:** Codex GPT-5.5 High review is MANDATORY before Tech Lead closure; no staging/commit until Codex PASS / PASS WITH NOTES + Tech Lead authorization. UI-01 is NOT closed.

---

## Phase 7C-LOCAL-SEED-INJECTION — Permanent Local/Emulator UI-Stress Seed Data (ACTIVE / data-seeding only)

**Context:** CEO authorized **permanent** local/emulator mock products (NOT transient frontend state, NOT production data) for consistent high-load visual UAT across UI-01..09.

**Seed source:** `src/lib/mocks/mock-products.json` — the dev/UAT mock array read by `src/lib/seedData.ts` (`seedMockData()`), which batch-writes the mock JSON into the Firestore **emulator** (`scripts/seed-emulator.mjs`, emulator host `127.0.0.1:8080`). Development/emulator-only; not a production data path.

- **Appended exactly 50** new products (`PROD-011`..`PROD-060`); original 10 (`PROD-001`..`PROD-010`) untouched.
- **Category coverage:** 30 × `ยาสัตว์` (long pharmaceutical names) + 20 × `อาหารไก่` (feed formula/package names).
- **Schema fidelity:** every record mirrors the existing `RawSeedProduct` shape exactly — `id, sku, barcode, name, category, description, imageUrl, baseUnit, cost, basePrice, stock, prices[], tierPrices{}, uomConversions[], allowNegativeStock, reorderPoint, isActive, muteAlerts`. No invented fields (the seed schema has no `warnOnOversell`, so none added).
- **Local-test namespace:** `sku` = `UISTRESS-01..50`; `barcode` = `990000000001..990000000050` (12-digit, distinct from existing `885*` / `PLU*`). All ids/skus/barcodes verified unique across the full 60.
- **Stress naming:** names 112–162 chars, each ending `(Index: 01..50)`; realistic Thai (medicine names for ยาสัตว์, feed formula/stage/package for อาหารไก่). `cost < basePrice`; `stock` 20–199; `allowNegativeStock: true` (matches existing seed default).
- No UI layout / cart / validation / Global-Toast / stock-matrix / schema / mapper / Firebase-rules / Functions / Android changes; no production data path touched.
- `stash@{0}` untouched; no staging/commit.

**Validation:** `tsc -b` clean; full vitest **681 passed**; JSON parses; counts/uniqueness verified (60 total, 30 ยาสัตว์ + 20 อาหารไก่ appended).

**Files changed in the seed step:** `src/lib/mocks/mock-products.json`, `Context.md`, `Task.md`.

---

**Phase 7C-L2 — Empty-cart Bill Discount Reset — CLOSED / COMMITTED — `654c704 fix(pos): reset bill state when cart empties` (Codex round 1 NEEDS REVISION → full bill-level reset → PASS WITH NOTES):** a shared `resetBillLevel` helper (zeroes `billDiscValue` + `billDiscPercent` + `feeRate`) is called by both a central empty-cart `useEffect` (guarded on any non-default field) and `clearCart`, so no bill-level state survives an empty cart (every emptying path covered; parity by construction). +8 source-level contract tests. Tech Lead Option B → committed. Physical UAT PASSED / ACCEPTED.

---

**Phase 7C-L1 — LOGIC-01 Product Picker Multi-UOM Selection Fix — CLOSED / COMMITTED — `203f636 fix(pos): queue multi-uom picker selections`:**

Fixed the single-`uomProduct`-slot overwrite: multi-select of several multi-UOM products now enqueues to a `uomQueue` and a drain effect prompts them one-at-a-time in selection order (single-UOM adds immediately; confirm adds-then-advances; cancel/Escape skips-current-then-advances, never a silent add). F12 blocking (`uomProduct` + `uomQueue.length > 0`) and the Escape single-close contract preserved literally; +9 section-H tests. Codex PASS WITH NOTES → Tech Lead Option B → committed. Physical UAT accepted (surfaced the empty-cart bill-discount leak → 7C-L2 above).

---

**Phase 7C-P1 — UI Polish Backlog Triage and Slice Plan — CLOSED / COMMITTED — `d87110c docs: add ui polish backlog triage plan`:** read-only triage of UI-01…UI-08 + LOGIC-01 into a safety-ordered slice plan (`docs/reports/phase-7c-p1-ui-polish-backlog-triage.md`). Recommended order LOGIC-01 → UI-04 → UI-03 → UI-02 → UI-01 → UI-07 → UI-05/06 → UI-08(blocked on CEO clarification). Codex PASS WITH NOTES → Tech Lead Option B → committed. LOGIC-01 authorized first as 7C-L1 (above).

---

**Phase 7C-D4-D2 — Discount Numpad Clear UX Refinement — CLOSED / COMMITTED — `ca0d5d8 fix(pos): refine discount numpad clear action`:** replaced the D4-D1 in-grid Clear key with a discount-only footer `ล้างส่วนลด` action (opt-in `clearLabel`/`onClear`/`showClearAction` on `NumpadDialog`; shown only when `cart.billDiscValue > 0`; sets 0 + closes + refocuses). Clean 3×4 decimal keypad restored; decimal/zero/F12/Escape/quantity contracts preserved; one justified `.npd-clear` class in `NumpadDialog.css`. Codex PASS WITH NOTES → Tech Lead Option B → committed. Final Touch UAT PASSED.

**Phase 7C-D4-D1 — Discount Numpad Clear Button — CLOSED / COMMITTED — `bc0fcf9 fix(pos): add discount numpad clear action`:** added an opt-in `allowClear` in-grid Clear (13-key `NUMPAD_KEYS_DECIMAL_CLEAR`) to the bill-discount numpad. Final Touch UAT then rejected the in-grid Clear (auto-flowed to a 5th row → looked like a layout bug); superseded by 7C-D4-D2 (footer `ล้างส่วนลด` action) above.

---

**Phase 7C-D4-D — POS Logic & Interaction Bugfixes — CLOSED / COMMITTED — `1a239b4 fix(pos): resolve UOM scans and discount numpad` (Tech Lead Option B — APPROVED WITH NOTES; Codex round 1 NEEDS REVISION → revision → PASS WITH NOTES):**

Two cross-platform bugfixes from Manual UAT. **Absolute rule honored: NO iOS/iPad Safari DOM focus workaround** — no `element.focus`/`setTimeout`/`requestAnimationFrame`/hidden-input traps/`isTrusted`/synthetic `KeyboardEvent`/viewport/CSS touch hacks. Hardware-scanner focus is deferred to the Native App / Capacitor wrapper phase.

- **Fix 1 — UOM barcode direct-add (`findByScanCode`) — Codex round 1 ACCEPTED, unchanged:** a scanned packaging-unit/UOM barcode now resolves that exact unit and **bypasses the UomModal**, adding it straight to the cart. Root cause: `posProductMapper.buildUomOptions` sets the base unit's `barcode` to the product's top-level `barcode`, so the old combined "`p.sku === trimmed || p.barcode === trimmed`" product-level check matched the base-unit barcode first (`option:null`) and re-opened the unit picker on multi-UOM products. New per-product order: (a) `p.sku === trimmed` → product-level (`option:null`, UomModal preserved); (b) `p.uomOptions.find(o => o.barcode === trimmed)` → direct add that unit (FIX); (c) `p.barcode === trimmed` not tied to any unit → product-level (UomModal preserved). Locked source-order contract (`p.sku === trimmed` before `p.uomOptions.find(`) + `trim()`/empty guard preserved; `cart.addToCart(product, option)` semantics unchanged; SKU / single-UOM / no-match behavior unchanged.
- **Fix 2 — discount-field touch target (REVISED per Codex round 1):** tapping/clicking the bill-discount input (`pos-disc-inp`) opens a custom `NumpadDialog` (new `discNumpadOpen` state + a second `<NumpadDialog>` placed **AFTER `<SortingSettingsModal>`** so the qty-numpad `?raw` region stays intact). The input gains `onPointerDown` → `e.preventDefault()` (suppresses, never forces, native focus — not an iOS hack) → `setDiscNumpadOpen(true)`; Tab keyboard editing still works.
  - **Codex Blocker 1 — keyboard-contract integration (FIXED):** `discNumpadOpen` is added to `hasBlockingModalOpen` (so F12 is suppressed / cannot stack PaymentModal while the discount numpad is open — F12 order + unconditional `preventDefault` + cart/shift gate unchanged) AND to `closeTopModalOnEscape` (Escape closes exactly it: `setDiscNumpadOpen(false)` + `focusSearch()`, returns true; deterministic single-close; no Red/write action). The helper's dep array gains `discNumpadOpen`.
  - **Codex Blocker 2 — value parity with the discount input (FIXED):** `NumpadDialog` gained **opt-in, backwards-compatible** props `allowDecimal` / `allowZero` (+ `maxLength`, default 4). **Defaults preserve the quantity contract byte-for-byte** (integer ≥1, floored `initialValue`, ≤0 rejected with the same Thai error, `parseInt`). The bill-discount instance opts in (`allowDecimal allowZero maxLength={7}`): seeds without flooring, exposes a decimal-point key (`NUMPAD_KEYS_DECIMAL` swaps the Clear key for `.` — same 12-key 3×4 grid, **no CSS change**), and confirms via `parseFloat(input) || 0` (so 0 and decimals are valid and an unchanged existing decimal is not truncated), writing through `cart.setBillDiscValue`. The qty `<NumpadDialog>` passes none of the new props → behavior unchanged. NumpadDialog stays touch-only (no `onKeyDown`/`isComposing`/`Escape`).

**Test updates (`src/pages/POSPage.keyboard-contract.test.ts`, +5 D4-D tests; existing D4-C arrays extended for the new Escape branch):** F12 predicate includes `discNumpadOpen`; Escape closes the discount numpad (returns true, no `setBillDiscValue`); deterministic-priority/coverage arrays now 12 closers; discount numpad opts into decimal/zero and writes via `cart.setBillDiscValue`; qty numpad keeps the default integer contract (no opt-in props); NumpadDialog decimal/zero is opt-in + backwards-compatible (qty `parseInt`/≤0-reject/floor preserved). All prior D4-A/C contracts green.

**Forbidden boundaries honored (D4-D):** no CSS change; no `PaymentModal`/`components/pos/*` (besides the authorized opt-in `NumpadDialog` props)/`lib/*` change; no checkout/payment/order-creation/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no cart/discount/UOM/quantity calculation change (only Fix 1's scan→unit routing + Fix 2 enabling the discount values the input already accepts); no LAN/emulator config change; no Firebase rules/Functions; no Android/Capacitor/`.claude/`; changed files = `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, `src/components/pos/NumpadDialog.tsx`, `src/pages/POSPage.keyboard-contract.test.ts`; `stash@{0}` untouched (read-only `git stash list` only). Validation: targeted spec **39 passed**; `vitest run` **531 passed**; `tsc -b` clean.

**D4-D next step (DONE):** Codex round 1 NEEDS REVISION → revision applied → Codex PASS WITH NOTES → Tech Lead Option B closure → committed `1a239b4`. CEO Manual UAT Round 2 then requested the discount-numpad Clear button, now in 7C-D4-D1 (top of this tracker).

---

**Phase 7C-E1 — Dynamic LAN Test Environment Setup — CLOSED / COMMITTED — `0c7e924 chore(dev): support LAN emulator testing` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

UAT was blocked because the physical POS terminal on the LAN couldn't reach the dev machine's Vite server / Firebase emulators (all bound to loopback). **Scope: config/infrastructure ONLY — no POS UI / business logic / CSS.** Changes: (1) `package.json` — added `"dev:lan": "vite --host"` (existing `dev`/`dev:web`/`dev:emulator`/build/test scripts untouched; no dependency change); (2) `firebase.json` — `"host": "0.0.0.0"` added to the `auth`/`functions`/`firestore`/`storage`/`ui` emulator sections (every existing port preserved; rules/Functions-source/deploy config untouched); (3) `src/lib/firebase.ts` — new exported helper `getEmulatorHost()` (browser → `window.location.hostname`, else `'localhost'`) replacing the hardcoded `'127.0.0.1'` in the Firestore/Auth/Storage emulator connections; (4) `src/lib/auth/verifyPinLogin.ts` — the Functions-emulator connection (`connectFunctionsEmulator`) now consumes the same exported `getEmulatorHost()` instead of a hardcoded `'127.0.0.1'`, so LAN PIN login works (one config line; no PIN/auth/callable/business-logic change). **Both emulator-host call paths are gated by the unchanged `USE_EMULATOR = import.meta.env.DEV && VITE_USE_EMULATOR === 'true'` guard, so production cloud connections are never affected; `localhost`/`127.0.0.1` browsers behave exactly as before (hostname resolves to itself).** A LAN device that loads the app at `http://<DEV_MACHINE_LAN_IP>:5173` now points its emulator SDKs at `<DEV_MACHINE_LAN_IP>`. Validation: `tsc -b` clean.

**Scope note (one file beyond the brief's listed allowed set):** the brief's §5.3 example (`connectFunctionsEmulator(functions, emulatorHost, 5001)`) anticipated the Functions emulator host living in the init file; in this codebase it lives in `src/lib/auth/verifyPinLogin.ts` (NOT in any forbidden-area list). It was edited for the emulator-host config line ONLY (consuming the shared exported helper — no duplicate logic, no auth/PIN/callable behavior change). Flagged here for Codex confirmation; without it, LAN PIN login — and therefore UAT login on the POS terminal — would fail, defeating the E1 goal.

**Forbidden boundaries honored (E1):** no POS UI / `POSPage.*` / `PaymentModal` / `NumpadDialog` / `components/pos/*` change; no checkout/payment/cart/UOM/discount/quantity calc change; no offline/IndexedDB/manual-review change; no CSS change; no Firestore rules / Functions source change; no Android/Capacitor/`.claude/` change; no dependency added; `stash@{0}` untouched (read-only `git stash list` only). Changed files: `package.json`, `firebase.json`, `src/lib/firebase.ts`, `src/lib/auth/verifyPinLogin.ts`, `Context.md`, `Task.md`.

**E1 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `0c7e924`. CEO ran D4-C Manual UAT via the LAN setup; outcome was the strategic pivot above (iOS Safari focus workarounds dropped) and the two D4-D bugfixes now in implementation. Recommended LAN command (emulators @ 0.0.0.0 + seed/snapshot + Vite `--host`): `npm run dev -- --host`; standalone `npm run dev:lan` serves Vite on the LAN but does NOT start emulators.

**Phase 7C-D4-C-4 — POS Escape Behavior — CLOSED / COMMITTED — `6f0f4c7 fix(pos): close POS modals with Escape` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

Final implementation slice off the D4-C plan. **Scope: Escape close/cancel/dismiss ONLY** — give the POS modals consistent Escape-to-close handling without ever confirming, submitting, or executing any Red write-path action. Tests updated FIRST (+8 D4-C-4 assertions), then runtime. In `src/pages/POSPage.tsx`: new close-only helper `const closeTopModalOnEscape = useCallback((): boolean => {...})` walks the page-owned modal states **top-most first** and closes exactly ONE per keypress, returning `true` when it closed something. It is wired into the **existing** `onKey` window listener — the F12 branch returns early, then `if (e.key === 'Escape') { if (closeTopModalOnEscape()) e.preventDefault(); }` — so the single global keydown listener + cleanup invariant is preserved (NO new listener); effect deps extended to `[cartLines.length, activeShift, hasBlockingModalOpen, closeTopModalOnEscape]`. Priority order: DestructiveConfirm (`setConfirmModalState({open:false})` — cancel branch) → Payment (`setPaymentOpen(false)`, guarded by `if (checkout.processing) return false;`) → CustomerPicker (`checkout.closeCustomerModal()`) → UOM (`setUomProduct(null)`) → ItemDiscount (`setDiscountLineKey(null)`) → Qty numpad (`setQtyNumpadLineKey(null)`) → HoldNote (`setHoldNoteOpen(false)`) → SuspendedList (`setSuspendedListOpen(false)`) → Category overlay (`closeCatModal()`) → Sorting (`setIsSortingModalOpen(false)`) → ProductPicker (`setPickerOpen(false)`); each path also `focusSearch()` per D4-C-2 (category overlay via its existing helper). **Red-path safety:** Escape NEVER calls `confirmSale`/`submitAsyncOrder`/`buildAsyncOrder`/`setDoc`/`clearCart`/`addToCart`/`setLineQty`/`setLineDiscount`/`addBill`/`removeBill`/`restoreCart`/`onConfirm`; PaymentModal closes only when `!checkout.processing` (mirrors its onClose guard) and never reaches the confirm path. **OpenShiftModal / CloseShiftModal / CashTransactionModal are intentionally NOT dismissed by the central Escape** — their submit / Z-report / in-flight-write state lives inside the component and is not observable from the page, so a page-level Escape can't prove it wouldn't drop a Z-report before the operator reads variance or race an in-flight drawer write (documented intentional exclusion; their own close affordances are unchanged). DestructiveConfirmModal (overlay-level Escape, `!loading`, `stopPropagation`) and CustomerPickerModal (input-level Escape) already self-handle Escape in their own components — UNCHANGED; the central handler is a deterministic, idempotent fallback (close setters are idempotent). **F12 behavior unchanged; no checkout/payment/processing/write-path/cart/UOM/discount/quantity change; no IME/focus-return-contract change; no CSS change; no PaymentModal/NumpadDialog component change (no Escape/onKeyDown added there).** Validation: targeted spec **34 passed**; `vitest run` **526 passed** (was 518; +8); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-4):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no cart/discount/UOM/quantity formula change; no line qty/discount mutation; no F12 behavior change; no new/duplicate global listener; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C-4 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `6f0f4c7`. The D4-C keyboard UX suite is now COMPLETE; implementation is PAUSED for CEO / Tech Lead Manual UAT (see the UAT-pause note at the top of this tracker). No new slice, component-level Escape follow-up, or UI polish is authorized until UAT findings + separate authorization.

---

**Phase 7C-D4-C-3 — POS F12 Modal Suppression — CLOSED / COMMITTED — `e6c0ce7 fix(pos): suppress F12 checkout when modal is open` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

Third implementation slice off the D4-C plan. **Scope: F12 modal suppression ONLY** — stop the F12 checkout shortcut from stacking `PaymentModal` over an already-open blocking dialog. Tests updated FIRST (added a suppression test + a no-new-listener/no-F12-in-PaymentModal test; preserved all existing F12 parity tests), then runtime. In `src/pages/POSPage.tsx`: new derived `const hasBlockingModalOpen = Boolean(uomProduct || pickerOpen || discountLineKey || qtyNumpadLineKey || showCloseShift || holdNoteOpen || suspendedListOpen || showCashTx || catModalOpen || isSortingModalOpen || confirmModalState.open || checkout.customerModalOpen)`; the F12 `onKey` now does `e.preventDefault()` (unconditional, devtools stays suppressed) then `if (hasBlockingModalOpen) return;` **before** the existing `if (cartLines.length > 0 && activeShift) setPaymentOpen(true)`; effect deps extended to `[cartLines.length, activeShift, hasBlockingModalOpen]`. **OpenShiftModal intentionally excluded** — F12 already requires `activeShift` (null while OpenShift shows). **Checkout-disabled parity preserved (`disabled={cartLines.length===0 || !activeShift}` unchanged); single global keydown listener + cleanup unchanged; no checkout/payment/processing/write-path/cart/UOM/discount/quantity change; no Escape/IME/focus-return/scanner change; no PaymentModal/CSS change.** Validation: targeted spec **26 passed**; `vitest run` **518 passed** (was 516; +2); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-3):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no cart/discount/UOM/quantity formula change; no Escape implementation; no new/duplicate global listener; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C-3 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `e6c0ce7`. Final slice D4-C-4 (Escape) now in implementation (above).

**Phase 7C-D4-C-2 — POS Focus-return Consistency — CLOSED / COMMITTED — `d4261f5 fix(pos): restore search focus after POS dialogs` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

Second implementation slice off the D4-C plan. **Scope: focus-return consistency ONLY** — restore focus to `#pos-search` after the four audited focus-drop modals close. Tests updated FIRST (flipped the three D4-A `CURRENT GAP` locks + added a category test), then runtime. Changes in `src/pages/POSPage.tsx`, all via the existing `focusSearch()` helper: **UomModal** `onSelect` + `onClose` → `focusSearch()`; **ItemDiscountModal** `onClose` → `focusSearch()` (the modal funnels both save and cancel through `onClose`); **NumpadDialog** `onClose` + `onConfirm` (only after a successful `setLineQty`) → `focusSearch()`; **category overlay** — new `closeCatModal = () => { setCatModalOpen(false); focusSearch(); }` helper now backs all four close routes (backdrop, close button, "ทั้งหมด" reset, category select), with `setActiveCategory` left in place. **No cart/discount/UOM/quantity/category-filter calculation changed; NumpadDialog stays touch-only (component not modified); no hardware-key/Enter added; no F12/Escape/IME/scanner change; no PaymentModal/CSS change.** Validation: targeted spec **24 passed**; `vitest run` **516 passed** (was 515; +1); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-2):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no cart/discount/UOM/quantity formula change; no F12-listener or Escape change; no scanner/IME-guard change; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C-2 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `d4261f5`. Third slice D4-C-3 (F12 suppression) now in implementation (above).

**Phase 7C-D4-C-1 — POS IME / Composition Guard — CLOSED / COMMITTED — `97a6bb2 fix(pos): guard scan input during IME composition` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

First implementation slice off the D4-C plan. **Scope: the IME/composition guard ONLY.** Added a single synchronous early-return in `handleSearchKeyDown` (`src/pages/POSPage.tsx`): after the `Enter` check, `if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;` so a Thai-IME `Enter` that commits an in-progress composition no longer fires `findByScanCode`/`addToCart`/clear/miss-toast. **Scanner speed preserved** — hardware scanners emit no composition events, so the guard is always false for them; **no debounce, no timers, no delay, no new listener; `findByScanCode` algorithm unchanged.** Test `src/pages/POSPage.keyboard-contract.test.ts`: flipped the prior D4-A "no IME guard" CURRENT GAP into a present-and-ordered-before-scan assertion (checks `isComposing` + `keyCode === 229`, guard precedes trim/`findByScanCode`), plus a new "NO debounce/timer/delayed scan" assertion (`not.toContain` setTimeout/setInterval/requestAnimationFrame/debounce). All other contracts (scan match/miss, F12 parity, focus-return present + UOM/ItemDiscount/Numpad GAPS, PaymentModal Red path) left unchanged. Validation: targeted spec **23 passed**; `vitest run` **515 passed** (was 514; +1 net); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-1):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; no F12-suppression / focus-return / Escape work (those are later slices); only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C-1 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `97a6bb2`. Second slice D4-C-2 (focus-return) now in implementation (above).

**Phase 7C-D4-C — Modal Focus & IME Fix Planning — CLOSED / COMMITTED — `dc8a08b docs: add modal focus ime fix plan` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES after two wording revisions):**

Read-only technical blueprint for the four D3-B follow-up fixes — **no implementation, no runtime/keyboard/focus/test change.** Deliverable `docs/reports/phase-7c-d4-c-modal-focus-ime-fix-plan.md` plans: (1) **IME/composition guard** on `handleSearchKeyDown` (`isComposing`/`keyCode===229` to suppress Thai-IME premature scan; scanner-speed preserved because scanners emit no composition events); (2) **F12 modal suppression** (gate the global F12 listener on a "no POS modal open" predicate to stop PaymentModal stacking; keep `preventDefault` + open-gate parity); (3) **focus-return consistency** (route UOM / ItemDiscount / NumpadDialog / category-overlay closes through `focusSearch()`); (4) **Escape behavior matrix** per modal — corrects the record that Escape is NOT globally absent (CustomerPicker input-level Escape `:102–104`; DestructiveConfirm overlay-level Escape `!loading` `:88–93`), with the cross-cutting rule that Escape may only cancel/close and must NEVER confirm a Red action (Payment/Shift/Cash/Hold). Recommends ordered slices D4-C-1 (IME) → D4-C-2 (focus-return) → D4-C-3 (F12) → D4-C-4 (Escape), each tests-first + separately authorized + Codex-reviewed + keyboard-UAT. Verified current source (read-only): PaymentModal `pay-modal-bg` has NO backdrop dismissal (X-button only), correcting the D3-B prose.

**Forbidden boundaries honored (D4-C):** no runtime POS source / keyboard / focus / handler / state / query change; no `POSPage.tsx`/`POSPage.css`/`PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` edit; no test edit (incl. `POSPage.keyboard-contract.test.ts`); no checkout/cart/payment/offline/IndexedDB/manual-review change; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, and the new D4-C report changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `dc8a08b`. First slice D4-C-1 (IME guard) now in implementation (above).

**Phase 7C-D4-A — POS Keyboard Contract Tests — CLOSED / COMMITTED — `74371db test(pos): add keyboard contract coverage` (Tech Lead Option B — APPROVED WITH NOTES; revised after Codex NEEDS REVISION, then Codex re-review PASS):**

Test-only coverage that **locks the CURRENT** POS keyboard & focus contracts mapped in D3-B before any behavior change — **no runtime behavior change, no POS source edit.** New spec `src/pages/POSPage.keyboard-contract.test.ts` (**22 tests**) uses source-level `?raw` assertions (mirroring the H7-G precedent; vitest unit env is `node`/no-DOM and POSPage's Firebase/cart/offline harness makes mounting unsafe). Covers: (A) scan match/miss — `findByScanCode` trims + empty-guard, top-level SKU/barcode priority over UOM-specific barcode, Enter-only handler, clear+`focusSearch` on match, toast-only (no clear) on miss, and the **locked GAP** that no IME/composition guard exists; (B) F12 ↔ checkout parity — single cleaned-up global keydown listener, `preventDefault`, gate `cart>0 && activeShift` = De-Morgan complement of `disabled={cartLines.length===0 || !activeShift}`; (C) focus-return present after **new-sale, customer close/select, payment-close, HOLD (`handleHoldConfirm`), RESTORE (`handleRestoreBill`), and BOTH clear-cart + cancel-parked confirmations** (region-scoped, exactly two `focusSearch()` in the destructive-confirm handler), plus **locked GAPS** of no focus-return after UOM / ItemDiscount close and **no focus-return contract on the NumpadDialog qty path** (labeled CURRENT GAP); (D) payment confirm is a guarded **Red** native button — keyboard-activatable via native button semantics when focused (Tab+Enter/Space), double-submit guard `!canConfirm||confirming||processing`, and **no extra modal-level Enter/composition handler** wired into `handleConfirm`; NumpadDialog touch-only. Validation: `vitest run` 514 passed (was 492; +22); `tsc -b` clean.

**Codex revision addressed:** added hold/restore/clear-cart/cancel-parked focus-return assertions + the NumpadDialog focus-return GAP lock; corrected the payment-confirm comment (native button IS keyboard-activatable when focused — that is why it is Red — assertion only proves no EXTRA modal-level key handler).

**Forbidden boundaries honored:** no runtime POS source / keyboard / focus / handler / state / query change; no `POSPage.tsx`/`PaymentModal`/`NumpadDialog`/CSS edit; no checkout/cart/payment/offline/IndexedDB/manual-review change; no helper extraction / no test-only production flag; no H7-F/Functions/rules; only `Task.md`, `Context.md`, and the new test file changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-A next step (DONE):** Codex re-review PASS → Tech Lead Option B closure → committed `74371db`. Superseded by D4-C planning above.

**Phase 7C-D3-B — POS Keyboard UX / Focus Audit — CLOSED / COMMITTED — `e754461 docs add pos keyboard focus audit`:**

Strictly read-only audit of POS keyboard & focus behavior. Deliverable `docs/reports/phase-7c-d3-b-pos-keyboard-focus-audit.md` maps: focus bootstrap (search `autoFocus` + RAF `focusSearch`), the Enter-scan contract (`findByScanCode`), the single global **F12** listener (gated `cart>0 && activeShift`, active during modals → stacking risk), the absence of a global **Escape**, per-modal Enter/autoFocus (Numpad touch-only; Payment confirm = native button, keyboard-activatable when focused — Red, no modal-level Enter handler; Shift/Hold/Cash have their own), inconsistent focus-return after UOM/Numpad/ItemDiscount close, and a **missing IME/composition guard** on the scan input (Thai-input premature-scan risk). Classifies surfaces Green (focus-ring/label CSS only), Yellow (focus/scan/F12/modal/parity), Red (keyboard-triggered checkout/cart/shift/offline). Recommends future slices D4-A (keyboard contract tests, test-only), D4-B (focus-ring/label CSS), D4-C (IME/focus-return/Escape/F12-during-modal — read-only planning, separate authorization required).

**Phase 7C-D2 — POS Cashier UX Boundary Audit (Tech Lead / CEO authorized Option B) — CLOSED / COMMITTED:**

Read-only mapping of the complete POS cashier workflow (entry `/pos → POSPage`, product grid/search/barcode, cart, payment/checkout, keyboard-first interactions, offline/manual-review/oversell). **No implementation; no POS source / offline-schema / IndexedDB / Firebase-rules / Functions edits; `stash@{0}` untouched.** Deliverable: `docs/reports/phase-7c-d2-pos-cashier-ux-boundary-audit.md` — classifies surfaces Green (presentation-safe `pos-*` chrome), Yellow (focus/F12/Enter-scan/modal/disabled-state), Red (write path `confirmSale→submitAsyncOrder→setDoc('asyncOrders')`, totals/pricing, shift ledger, suspended bills, oversell allowance, offline reversal/manual-review) and recommends narrow future slices (D3-A pos- visual shell; D3-B keyboard/focus read-only-first; D3-C payment-modal presentation-only). Codex: PASS WITH NOTES. Report: `docs/reports/phase-7c-d2-pos-cashier-ux-boundary-audit.md`.

**Next step:** Separately authorized Phase 7C-D3-A POS Read-only Visual Shell Polish. No POS implementation without separate authorization.

**Phase 7C-C4 — Admin UI Polish on Isolated Namespaces (Tech Lead / CEO authorized) — CLOSED / COMMITTED — `00ab856 style(admin): add subtle card elevation to isolated views`:**

Presentation-only polish building on the C3 isolation. **Scope: visual consistency only — NOT redesign, NOT business logic, NOT POS cashier, NOT broad Admin/Inventory polish.** Delivered a single coherent **card-elevation consistency pass**: a unified subtle resting `box-shadow: 0 1px 2px 0 rgba(16, 24, 40, 0.05)` added to all card surfaces on both isolated admin screens — `adash-kpi-card`/`adash-chart-box`/`adash-pay-section`/`adash-table-card` (in `AdminDashboardPage.css`) and `absr-metric-card`/`absr-chart-box`/`absr-card` (in `AllBranchesStockOverview.css`). **CSS-only, confined to the isolated `adash-*` / `absr-*` namespaces** (box-shadow does not affect layout flow). No TSX changes; behavior/state/query/lifecycle/chart-config/CSV-export/conditional-rendering unchanged.

**Target files (only):** `src/pages/admin/AdminDashboardPage.css`, `src/pages/admin/AllBranchesStockOverview.css`. No shared `DashboardPage.css`/`StockReportPage.css` edit; no global-token change; no H7-F or write-path page touched; `stash@{0}` untouched. Codex: PASS WITH NOTES. Tech Lead / CEO Option B — APPROVED WITH NOTES.

**7C-C1-0 (CSS Namespace Audit) and 7C-C2 (TSX-only Admin polish — evidence-based no-op/deferral) are CLOSED / COMMITTED at `b757c65`.** The C1-0 audit concluded that meaningful Admin/Inventory consistency requires namespace isolation first.

**Phase 7C-C3 — Admin Dashboard / Report Namespace Isolation (Tech Lead / CEO authorized) — CLOSED / COMMITTED — `4262a25 refactor(style): isolate admin dashboard and report css namespaces`:**

C3 scope was **namespace isolation only — NOT broad visual polish, NOT redesign, NOT business logic.** Breaks two shared-CSS couplings flagged by the C1-0 audit by forking admin-specific namespaces (rules copied 1:1; no visual change intended):

- **Admin Dashboard:** forked `dash-*` (+ shared `.dashboard-page`) → **`adash-*`** (+ `.adash-page`). New `src/pages/admin/AdminDashboardPage.css` defines the `adash-*` rules AdminDashboard consumes (footer rules not copied — unused); `AdminDashboardPage.tsx` now imports the local CSS instead of `../DashboardPage.css` and uses `adash-*`. Shared `DashboardPage.css` UNMODIFIED.
- **All Branches Stock Overview:** forked `sr-*` → **`absr-*`**. `AllBranchesStockOverview.css` now defines the `absr-*` rules it consumes (incl. the donut-legend scroll tweak); `AllBranchesStockOverview.tsx` drops `import '../StockReportPage.css'` and uses `absr-*`. Shared `StockReportPage.css` UNMODIFIED.

After the fork: `AdminDashboardPage.tsx` consumes no `dash-*`/`dashboard-page`; `AllBranchesStockOverview.tsx` consumes no `sr-*` (only a doc-comment references the old prefix). `AdminStockReportPage.tsx`/`.css` untouched.

**Forbidden boundaries honored:** no edit to shared `DashboardPage.css` / `StockReportPage.css`; no `index.css`/`variables.css`/global token change; no protected H7-F file touched; no deferred namespace (`sh-`/`inv-adj-`/`ss-`/`qm-`/`asr-`/`asr-bsel-`/`asup-`/`sup-`) implementation; no behavior/state/query/lifecycle/CSV-export change; no route/nav/server/rules/offline/POS change; `stash@{0}` untouched.

**Codex:** PASS WITH NOTES. **Verification:** structural CSS/DOM verification used as fallback for live seeded visual UAT (blocked by admin auth / seeded Firebase data requirements); 0 drift in forked rules after reverse mapping and full rendered-class coverage; no fake screenshots produced. Live seeded visual UAT is optional future confidence work, not a C3 closure blocker. Full web `npx vitest run` → **492 passed (29 files)**; `npx tsc -b` clean; forbidden-area diff EMPTY; `stash@{0}` untouched. Tech Lead accepted structural verification fallback and authorized closure.

**Next step:** Strategic next-slice decision — Admin UI polish leveraging isolated `adash-*` / `absr-*`; POS Cashier UX Boundary Audit; or optional seeded admin visual UAT confidence check. No implementation without separate authorization.

**H6-F1** — Transfer Reversal Evidence Rejection Visibility — CLOSED / COMMITTED — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`
**H6-G1** — Receiving Evidence Rejection Visibility & Void Error Handling — CLOSED / COMMITTED — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`
**H7-A** — Pure Latent Reversal Rejection Record — CLOSED / COMMITTED — `749e6e6 feat(pos): add latent reversal rejection record model`
**H7-B** — Storage Design Audit (read-only design artifact; Codex PASS WITH NOTES). No code/doc changes.
**H7-C** — Durable Rejection Log Store Wiring — CLOSED / COMMITTED — `76b7451 feat(pos): add latent durable reversal rejection log store`
**H7-D** — Catch-site Integration Design Audit (read-only design artifact; receiving-first recommended). No code/doc changes.
**H7-E** — Receiving-only Catch-site Integration — CLOSED / COMMITTED — `ad1ff61 feat(pos): log receiving reversal evidence rejections`
**H7-F** — Transfer Pair Catch-site Integration — **CLOSED / COMMITTED** — `872575a feat(pos): log transfer reversal evidence rejections`
**H7-G** — Manual Review Ops Durable Rejection Panel — **CLOSED / COMMITTED** — `86a628e feat(pos): add read-only manual review ops durable rejection panel`

**Phase 7B-H series is CLOSED / COMMITTED.** H7-E activated the durable rejection log for Receiving; H7-F extended it to BOTH transfer surfaces; H7-G surfaces those durable logs read-only in the existing Manual Review Ops page.

**Durable logging initiative is complete:**
1. Receiving capture — H7-E (`ad1ff61`)
2. Transfer capture — H7-F (`872575a`)
3. Admin/Ops local read-only surfacing — H7-G (`86a628e`)

**H7-G is visibility-only:** NO resolve/delete/retry/sync/export/queue/stock/server action button is added; `recordId` used only as internal React row key (not displayed); no write API introduced. Existing manual-review queue behavior unchanged. No catch-site/helper/model/log/store/schema/server/rules/write-path change.

**`stash@{0}` remains present and untouched.**

**Phase 7C (Stabilization & UI Polish) — 7C-A + 7C-D1 CLOSED / COMMITTED:**

**7C-A** — Regression Stabilization Pass — **CLOSED / COMMITTED** — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`
**7C-D1** — Operator Runbook for Durable Rejection Panel — **CLOSED / COMMITTED** — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`

7C-A de-brittled the H7-G source-level assertions (no production code touched); 7C-D1 added a plain-Thai operator runbook (`docs/operator-runbook-durable-rejection-panel.md`). **No production behavior changed, no UI behavior/layout/polish change, no POS cashier UX work, no source/write-path/schema/server/rules change.** Codex: PASS WITH NOTES (accepted: remaining source-level tests rely on stable semantic markers; materially better than exact whole-page button counts; CRLF warnings accepted; zero production code mutated). 492 web tests (29 files); `tsc -b` clean; forbidden diff EMPTY.

**Baseline is hardened for visual/UI polish planning.** No POS cashier UX work has started.

**7C-B1** — Manual Review Ops UI Polish — **CLOSED / COMMITTED** — `f4d9e7a style(pos): polish manual review ops durable rejection panel`. Option A APPROVED (Zero Behavioral Change). Presentation-only polish of `src/pages/ManualReviewOpsPage.tsx`: a stronger visual boundary between the actionable Manual Review Queue and the read-only Durable Rejection Forensic Log (thicker top divider `border-t-2` + increased `mt-8`/`pt-8` spacing), an "อ่านอย่างเดียว" (read-only) badge on the forensic-log header to reinforce its non-actionable nature, a softer dashed-border empty state for the forensic log, and monospace timestamps for scannability in both tables. **No behavior/state/query/lifecycle change, no gate change, durable panel still read-only with no action buttons, Thai disclaimer meaning preserved, `recordId` still internal-only (sole `key={r.recordId}` use), no route/nav/global-CSS/schema/server/rules/write-path change.** The 24 stabilized 7C-A assertions pass unchanged. Codex: PASS WITH NOTES (accepted: tracker wording precision about "one file" meant one production source file; zero business logic or state changes occurred; source-level tests still rely on semantic source markers, accepted as test-maintenance risk). `stash@{0}` remained untouched.

**Next step:** Strategic option selection for next Phase 7C slice — (C) Admin/Inventory visual consistency (batched, namespace-collision-aware); (B) POS cashier UX polish (highest value, requires read-only boundary audit first); or another separately authorized planning step. No Admin/Inventory or POS cashier UI work without separate authorization.

---

## Phase 7C-B1 — Manual Review Ops UI Polish (presentation-only)

**Status:** CLOSED / COMMITTED — `f4d9e7a style(pos): polish manual review ops durable rejection panel`
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED. Golden rule: **Zero Behavioral Change** (strictly cosmetic/layout). Codex: PASS WITH NOTES.
**Goal:** Improve readability/operator clarity of the Manual Review Ops page, especially the visual distinction between the actionable Manual Review Queue and the read-only Durable Rejection Forensic Log.

### What was delivered (all presentation-only, single file)

- `src/pages/ManualReviewOpsPage.tsx` (MOD, +16/−9):
  - Forensic-log section boundary strengthened: `mt-6 … border-t … pt-6` → `mt-8 … border-t-2 … pt-8`.
  - Forensic-log header gains a read-only badge (`<Badge>อ่านอย่างเดียว</Badge>`) beside the existing `<h2>` (heading text unchanged), with the heading row wrapped in a flex container; subtitle gets `mt-1`.
  - Forensic-log empty state restyled from `<Alert color="gray">` to a dashed-border centered muted `<div>` (same Thai text/meaning).
  - Timestamp cells in BOTH tables (`it.createdAt`, `r.createdAt`) gain `font-mono text-xs` for scannability.
  - No logic, state, handler, data-flow, gate, import-behavior, or marker change; `Badge` was already imported; `Alert` still used elsewhere.

### What is NOT in this slice

No business-logic/state/query/`useEffect`/`useMemo` change; no change to `listQueue`/`listReversalRejections`/`resolveManualReview`/`buildManualReviewResolvePayload`; no Manager/Admin gate or unauthorized-behavior change; no queue resolve-flow change; durable panel remains read-only (no resolve/delete/retry/sync/export/action button); Thai local-device disclaimer meaning preserved; no `recordId` display (still the sole `key={r.recordId}`); no route/nav change; no global/shared CSS, no inline styles, no cross-page Flowbite migration; no offline-schema/`DB_VERSION`/helper/model/log/store change; no Receiving/Transfer catch-site, server-resolver, or Firestore-rules change; no POS/cart/checkout/stock-mutation/write-path change; no test changes (stabilized assertions still pass); `stash@{0}` untouched.

### Verification

- Focused `manualReviewOps` 24 passed (stabilized assertions unchanged); `recordEvidenceRejection`/`reversalRejectionLog`/`reversalLocalStore`/`offlineReversalQueue` 75 passed.
- Full web `npx vitest run` → **492 passed (29 files)**; `npx tsc -b` clean; `functions resolveReversal` 43 passed (server unchanged).
- `git diff --check` clean; forbidden-area diff EMPTY; `git diff --stat` = 1 file (`ManualReviewOpsPage.tsx`); `stash@{0}` present and untouched.

### Closure

7C-B1 is **CLOSED / COMMITTED** — `f4d9e7a style(pos): polish manual review ops durable rejection panel`. Codex: PASS WITH NOTES. Accepted notes: tracker wording precision about "one file" meant one production source file; zero business logic or state changes occurred; source-level tests still rely on semantic source markers, accepted as test-maintenance risk.

### Final test evidence

```
npx.cmd vitest run manualReviewOps → PASS, 24 tests
npx.cmd vitest run → PASS, 492 tests / 29 files
npx.cmd tsc -b → PASS
forbidden diff → EMPTY
stash@{0} → present and untouched
```

---

## Phase 7C-A — Regression Stabilization Pass (+ 7C-D1 Operator Runbook)

**Status:** CLOSED / COMMITTED — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`
**Authorization:** Gemini / Tech Lead / CEO — Option B APPROVED (bundled 7C-A + 7C-D1; test/docs-only stabilization, no production behavior change). Codex: PASS WITH NOTES.
**Goal:** Harden the H7 source-level tests against brittle/formatting-sensitive assertions (preserving or strengthening safety coverage), document/guard the in-memory-store concurrent-write ordering artifact, and add an operator-facing runbook for the durable rejection panel.

### What was delivered

- `src/lib/pos/offline/manualReviewOps.test.ts` (MOD, 21 → 24 tests) — stabilized the H7-G `?raw` source-level assertions:
  - Replaced the brittle whole-page `expect(source.split('<Button').length - 1).toBe(3)` count with two intent-based tests: (a) a region-scoped check (`rejectionPanelRegion` helper slices the page from the panel's marker comment to the resolve `<Modal`) asserting the panel contains NO `<Button` and NO action wiring (`onClick`/`openResolve`/`submitResolve`/`resolveManualReview`); (b) a positive check that the existing manual-review QUEUE retains its resolve affordance (`onClick={() => openResolve(it)}` + `void submitResolve()`), so stabilization cannot silently drop it.
  - Replaced the spacing-sensitive `recordId` negatives (`>{r.recordId}`/`title={r.recordId}`) with a robust single-use check: `r.recordId` appears EXACTLY ONCE and that use is `key={r.recordId}` — proving recordId stays an internal React key and never reaches a visible cell/title. Hash/serialized internals (`serializeReversalRejectionRecord`/`observedDocumentUpdatedAt`) remain asserted absent.
  - Added a `GUARD` test + documentation comment for the in-memory store concurrent-write artifact: the in-memory double commits a readwrite txn by REPLACING the whole store map, so concurrently-started txns lose distinct-key writes (last-commit-wins) — a property of the TEST DOUBLE only (real IndexedDB serializes readwrite txns per store; production unaffected). The guard pins the safe sequential contract (serialized writes to distinct keys both persist) that the newest-first read-path test depends on.
  - All other existing assertions (gate reuse, loader gating, read-only via `listReversalRejections`, no write API, Thai disclaimer, queue path intact) preserved unchanged.
- `docs/operator-runbook-durable-rejection-panel.md` (NEW) — plain-Thai, operator-friendly runbook for Manager/Admin: what the panel is; where it appears (Manual Review Ops, Manager/Admin only); what a row means; what "local-device only" means; what it is NOT (not central audit, not server-synced, not stock truth, not a queue item needing resolution); what operators should do (read the reason, watch repeats, report to admin/owner, do not "close" rows); what not to do; and the known limitation that clearing local browser/PWA storage can remove historical records.

### What is NOT in this slice

No production source change (`ManualReviewOpsPage.tsx` and all offline/runtime/store/catch-site files untouched — forbidden-area diff EMPTY); no in-memory/IndexedDB store behavior or schema change (no `DB_VERSION` bump); no UI behavior/layout/polish change; no POS cashier UX / cart / checkout / stock-mutation change; no server resolver / Firestore-rules change; no route/nav change; no new feature; safety coverage preserved or strengthened (net +3 tests).

### Verification

- Focused: `manualReviewOps` 24 passed; `recordEvidenceRejection`/`reversalRejectionLog`/`reversalLocalStore`/`offlineReversalQueue` 75 passed.
- Full web `npx vitest run` → **492 passed (29 files)** (was 489; +3); `npx tsc -b` → clean; `functions resolveReversal` → 43 passed (server unchanged).
- `git diff --check` clean; forbidden-area diff EMPTY (incl. `ManualReviewOpsPage.tsx`); `git diff --stat` = 1 modified test file + 1 new docs file; `stash@{0}` present and untouched.

### Closure

7C-A + 7C-D1 are **CLOSED / COMMITTED** — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`. Codex: PASS WITH NOTES. Accepted notes: remaining source-level tests still rely on stable semantic markers (acceptable; materially better than exact whole-page button counts); CRLF warnings accepted; zero production code mutated.

### Final test evidence

```
npx.cmd vitest run manualReviewOps → PASS, 24 tests
npx.cmd vitest run → PASS, 492 tests / 29 files
npx.cmd tsc -b → PASS
Forbidden diff → EMPTY (incl. ManualReviewOpsPage.tsx)
stash@{0} → present and untouched
```

---

## Phase 7B-H7-G — Manual Review Ops Durable Rejection Panel

**Status:** CLOSED / COMMITTED — `86a628e feat(pos): add read-only manual review ops durable rejection panel`
**Authorization:** Gemini / Tech Lead / CEO — Option B APPROVED WITH NOTES (Codex PASS WITH NOTES; row key updated to `record.recordId`; `Context.md` stale wording corrected).
**Goal:** Surface the durable rejection logs (H7-A model, H7-C store, written by H7-E/H7-F) in the existing Manual Review Ops page as a LOCAL READ-ONLY forensic panel. It must not become an action queue; the existing manual-review queue behavior is unchanged.

### What was delivered

- `src/pages/ManualReviewOpsPage.tsx` (MOD) — adds a read-only durable-rejection panel below the existing manual-review queue:
  - Imports `listReversalRejections` (read API) and the `ReversalRejectionRecord` type. NO write API (`recordEvidenceRejection`/`recordReversalRejection`) imported or called.
  - Independent panel state (`rejections`/`rejectionsLoading`/`rejectionsError`) + a `refreshRejections` `useCallback` that is gated on the SAME `canResolve` flag (`if (!canResolve) → setRejections([])`) and reads ONLY `listReversalRejections(store)` against the EXISTING memoized `createIndexedDbReversalStore`. The existing `refresh`/queue state is untouched.
  - New section titled `บันทึกการปฏิเสธหลักฐาน (อุปกรณ์นี้)` with a count badge, an `info` Alert disclaimer (`...เฉพาะเครื่องนี้เท่านั้น ไม่ได้ซิงก์ขึ้นเซิร์ฟเวอร์ ไม่ใช่ audit log กลาง และไม่ต้องปิดงานจากรายการนี้ (อ่านอย่างเดียว)`), and loading/error/empty states matching the queue pattern.
  - Read-only table columns: เวลา (`r.createdAt`), ประเภท (`r.sourceType` badge), เอกสาร (`r.sourceId`), สาขา (`r.branchId`), รหัส (`r.evidenceCode`), เหตุผล (`r.evidenceMessage`), ผู้ทำรายการ (`r.staffId ?? '—'`). Row key is `r.recordId` (internal React rendering only; NOT displayed to the user). `recordId`/hashes/raw payloads/qty-cost/`observedDocumentUpdatedAt` are NOT rendered in cells. NO action column / NO buttons in the panel.
- `src/lib/pos/offline/manualReviewOps.test.ts` (MOD, +11 tests → 21 total) — `H7-G: ... read path` (records via `recordEvidenceRejection`, reads back newest-first through the shared store; empty store → empty list) + `H7-G: ManualReviewOpsPage.tsx ... (source-level)` `?raw` assertions (reads only `listReversalRejections(store)` + `refreshRejections`; introduces NO `recordEvidenceRejection`/`recordReversalRejection`; reuses the `canViewManualReviewOps` gate + early not-authorized return; loader gated + clears data for non-authorized; `<Button` count unchanged at 3; only the safe H7-A fields displayed; `recordId`/`serializeReversalRejectionRecord`/`observedDocumentUpdatedAt` NOT exposed; local-device disclaimer present; existing queue `listQueue`/`resolveManualReview`/`buildManualReviewResolvePayload` path intact).

### What is NOT in this slice

No catch-site change (`ReceivingEditPage.tsx`/`TransferHistoryPage.tsx`/`AdminTransferPage.tsx` untouched); no helper/model/log/store/schema change (`recordEvidenceRejection.ts`/`reversalRejectionRecord.ts`/`reversalRejectionLog.ts`/`reversalLocalStore.ts` untouched; no `DB_VERSION` bump; no index added); no display-label helper added to the offline layer; no resolve/delete/retry/sync/export/queue/stock/server action; no new route/nav; no separate Admin page; no server resolver/Firestore-rules change; no validation/fail-closed change; no transfer/receiving write-path change; no server-sync/central-audit architecture.

### Verification

- Focused: `manualReviewOps` 21 passed; `reversalRejectionLog`/`recordEvidenceRejection`/`reversalLocalStore`/`offlineReversalQueue` 75 passed.
- Full web `npx vitest run` → **489 passed (29 files)** (was 478 at H7-F; +11 H7-G tests); `npx tsc -b` → clean; `functions resolveReversal` → 43 passed (server unchanged).
- Forbidden-area diff EMPTY; `git diff --stat` = 2 code files (`ManualReviewOpsPage.tsx`, `manualReviewOps.test.ts`); `stash@{0}` present and untouched.

### Closure

H7-G is **CLOSED / COMMITTED** — `86a628e feat(pos): add read-only manual review ops durable rejection panel`. Codex: PASS WITH NOTES. Notes resolved before commit: stale `Context.md:151` future-work wording corrected; durable rejection panel React row key updated to internal `r.recordId`. **Phase 7B-H series is CLOSED / COMMITTED.**

### Final test evidence (H7-G commit)

```
npx.cmd vitest run manualReviewOps → PASS, 21 tests
npx.cmd vitest run → PASS, 489 tests / 29 files
npx.cmd tsc -b → PASS
Forbidden diff → EMPTY
git diff --check → clean, known CRLF warnings only
post-commit git status --short → clean
stash@{0} → present and untouched
```

---

## Phase 7B-H7-F — Transfer Pair Catch-site Integration

**Status:** CLOSED / COMMITTED — `872575a feat(pos): log transfer reversal evidence rejections`
**Authorization:** Gemini / Tech Lead / CEO — Option B APPROVED WITH NOTES.
**Goal:** Wire BOTH transfer fail-closed evidence rejection catch sites to the durable local rejection log, reusing the proven H7-E `recordEvidenceRejection` helper. The current `setToast` operator feedback and `busy`-cleanup behavior are unchanged.

### What was delivered

- `src/pages/inventory/TransferHistoryPage.tsx` (MOD) — imports `createIndexedDbReversalStore` + `recordEvidenceRejection`; one `const rejectionLogStore = useMemo(() => createIndexedDbReversalStore(), [])`; in `handleCancel`'s `TransferReversalEvidenceError` branch only, computes `evidenceMessage`/`message` (toast text unchanged), `setToast(message)`, then dispatches un-awaited `recordEvidenceRejection(rejectionLogStore, { sourceType:'transfer', sourceId: cancelTarget.id, branchId: cancelTarget.fromBranchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt) })`; `rejectionLogStore` added to the `useCallback` deps. Non-evidence `else` branch and `finally { setBusy(false) }` unchanged.
- `src/pages/admin/AdminTransferPage.tsx` (MOD) — identical wiring in its `handleCancel` `TransferReversalEvidenceError` branch; `rejectionLogStore` added to that `useCallback`'s deps. `editBranchTransfer` catch untouched.
- `src/lib/pos/offline/recordEvidenceRejection.test.ts` (MOD, +12 tests → 25 total) — `H7-F: simulated transfer caller path` (toast still set to the original message when logging fails; never throws) + parametric `describeTransferCatchSiteSource` source-level `?raw` assertions for BOTH pages (one memoized store; `recordEvidenceRejection(` called exactly once ⇒ non-evidence branch does not log; `sourceType: 'transfer'`; `branchId: cancelTarget.fromBranchId`; not awaited; `setToast(message)` preserved).

### Execution order (enforced, both pages)

Detect `TransferReversalEvidenceError` → compute operator message → `setToast(message)` → dispatch fire-and-forget log → existing `finally { setBusy(false) }` runs unchanged. The helper is synchronous/void/fully-guarded, so it cannot block, delay, swallow, or alter the toast/busy-cleanup behavior. Non-evidence errors are NOT logged.

### Field mapping (identical both pages)

`sourceType:'transfer'`, `sourceId: cancelTarget.id`, `branchId: cancelTarget.fromBranchId` (transfer ORIGIN — not the auth branch; identical on both surfaces), `evidenceCode: err.code`, `evidenceMessage` (the already-computed friendly toast message), `staffId: user.id`, `observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)`. `evidenceSource` omitted (unresolved at the catch site).

### What is NOT in this slice

No `ReceivingEditPage.tsx` change; no helper/model/log/store/schema change (`recordEvidenceRejection.ts`/`reversalRejectionRecord.ts`/`reversalRejectionLog.ts`/`reversalLocalStore.ts` untouched; no `DB_VERSION` bump); no Admin/Ops surfacing; no Manual Review Ops UI; no server resolver/Firestore-rules change; no validation/fail-closed/thrown-error change; no F1/G1/transfer evidence message-text change; no transfer/receiving write-path change.

### Files changed (code)

```
src/pages/inventory/TransferHistoryPage.tsx          (MOD — useMemo store + 1 helper call in the evidence-error branch)
src/pages/admin/AdminTransferPage.tsx                (MOD — useMemo store + 1 helper call in the evidence-error branch)
src/lib/pos/offline/recordEvidenceRejection.test.ts  (MOD — +12 H7-F tests; 25 file total)
```

### Evidence

- `npx vitest run recordEvidenceRejection` → **25 passed** (13 H7-E + 12 H7-F)
- `npx vitest run reversalRejectionRecord reversalRejectionLog reversalLocalStore offlineReversalQueue manualReviewOps` → **80 passed** (regression green)
- Full web `npx vitest run` → **478 passed** (29 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean (benign CRLF only); forbidden-area diff EMPTY (`ReceivingEditPage`, helper/model/log/store, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

Unlike Receiving (which re-throws), both Transfer catch sites surface the rejection via `setToast(...)` and continue into `finally { setBusy(false) }`; logging stays an un-awaited, fully-guarded side effect inside the `TransferReversalEvidenceError` branch only — placing it elsewhere, awaiting it, logging the non-evidence branch, or using the auth branch id instead of `cancelTarget.fromBranchId` could corrupt forensic records or subtly alter operator feedback.

### Closure

H7-F is **CLOSED / COMMITTED** — `872575a feat(pos): log transfer reversal evidence rejections`. Approved: Gemini / Tech Lead / CEO Option B APPROVED WITH NOTES. The durable rejection log is now active for both Receiving and Transfer. Admin/Ops surfacing remains future work. Next step: read-only strategic planning for Admin/Ops Surfacing.

---

## Phase 7B-H7-E — Receiving-only Catch-site Integration

**Status:** CLOSED / COMMITTED — `ad1ff61 feat(pos): log receiving reversal evidence rejections`
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED (receiving-only; Claude Opus 4.8 / High). H7-D design audit recommended receiving-first.
**Goal:** Wire ONLY the receiving fail-closed evidence rejection catch site to the durable local rejection log — the first production caller of the H7-A/H7-C substrate. The current throw-to-banner UX is unchanged.

### What was delivered

- `src/lib/pos/offline/recordEvidenceRejection.ts` (NEW) — bridge helper `recordEvidenceRejection(store, input): void`. Returns `void` (not a Promise); builds via H7-A `buildReversalRejectionRecord`, dispatches via H7-C `recordReversalRejection`; **both** the build (which can throw fail-closed) and the async dispatch are guarded, and the async promise carries `.catch(() => {})` — never throws into the caller, no unhandled rejection. `evidenceSource` omitted (not resolved at the throw). Touches only the `rejections` store via the log API.
- `src/lib/pos/offline/recordEvidenceRejection.test.ts` (NEW, 13 tests) — record construction (receiving + transfer-shaped), persistence, `evidenceSource` omitted, returns void, async-failure swallowed, build-failure swallowed, no unhandled rejection, simulated receiving caller still throws the F1/G1 message on logging failure, and source-level `?raw` assertions on `ReceivingEditPage`.
- `src/pages/ReceivingEditPage.tsx` (MOD) — imports `createIndexedDbReversalStore` + `recordEvidenceRejection`; one `const rejectionLogStore = useMemo(() => createIndexedDbReversalStore(), [])`; in the `ReceivingReversalEvidenceError` branch only, computes the existing message, dispatches `recordEvidenceRejection({ sourceType:'receiving', sourceId: id, branchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt })`, then `throw new Error(message)` exactly as before. Non-evidence errors still `throw err` unchanged.

### Execution order (enforced)

Detect `ReceivingReversalEvidenceError` → compute operator message → dispatch fire-and-forget log → throw `new Error(message)`. The helper is synchronous/void/fully-guarded, so it cannot block, delay, swallow, or alter the throw-to-banner behavior.

### What is NOT in this slice

No transfer catch-site integration (`TransferHistoryPage`/`AdminTransferPage` untouched), no Admin/Ops surfacing, no Manual Review Ops UI, no offline store schema change (`reversalLocalStore.ts`/`reversalRejectionLog.ts` untouched), no server resolver/Firestore-rules change, no validation/fail-closed/thrown-error change, no F1/G1 message-text change, no receiving/transfer write-path change.

### Files changed (code)

```
src/lib/pos/offline/recordEvidenceRejection.ts        (NEW — void bridge helper)
src/lib/pos/offline/recordEvidenceRejection.test.ts   (NEW — 13 tests incl. source-level)
src/pages/ReceivingEditPage.tsx                        (MOD — useMemo store + 1 helper call in the evidence-error branch)
```

### Evidence

- `npx vitest run recordEvidenceRejection` → **13 passed**
- `npx vitest run reversalRejectionRecord reversalRejectionLog reversalLocalStore offlineReversalQueue manualReviewOps` → **80 passed** (regression green)
- Full web `npx vitest run` → **466 passed** (29 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; forbidden-area diff EMPTY (transfer pages, offline store/log, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

H7-E is the first production caller of the durable rejection log; if the helper could throw, returned a dropped Promise, or were placed before message determination, the forensic log could disrupt the receiving fail-closed banner path it is meant to observe — the `void`/synchronous/fully-guarded contract and the after-message placement are what prevent that.

---

## Phase 7B-H7-C — Durable Rejection Log Store Wiring (latent)

**Status:** **CLOSED / COMMITTED** — `76b7451 feat(pos): add latent durable reversal rejection log store`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED. H7-B design reviewed by Codex: PASS WITH NOTES.
**Goal:** Implement the latent durable rejection-log substrate per the H7-B design — IndexedDB store + in-memory parity + write/list APIs + tests. **No production caller; 100% latent.**

### What was delivered

- `src/lib/pos/offline/reversalLocalStore.ts` (MOD) — additive only: `'rejections'` added to `ReversalStoreName` + `REVERSAL_STORES`; **`DB_VERSION` 1 → 2**; in-memory `data` gains `rejections: new Map()`. `transact`/`openDb`/`onupgradeneeded`/`dump`/abort logic and the four existing stores (`intents`/`stock`/`ledger`/`markers`) are otherwise unchanged. The `onupgradeneeded` loop creates only missing stores, so the v1→v2 upgrade is data-preserving.
- `src/lib/pos/offline/reversalRejectionLog.ts` (NEW) — focused, latent, no UI imports. `recordReversalRejection(store, record)` → `'recorded' | 'duplicate' | 'unavailable' | 'failed'`, **best-effort and NEVER throws**; keys the H7-A `ReversalRejectionRecord` out-of-line by `recordId` (content-addressed → idempotent overwrite; distinct `createdAt` → distinct row). `listReversalRejections(store, filter?)` → newest-first by `createdAt`, optional `sourceType`/`branchId` filters, read-only. Touches ONLY the `rejections` store — no stock/ledger/intents/markers mutation, no queue-state control reads.
- `src/lib/pos/offline/reversalRejectionLog.test.ts` (NEW, 15 tests) + `src/lib/pos/offline/reversalLocalStore.migration.test.ts` (NEW, 3 tests).

### Codex H7-B notes carried forward

- `duplicate` vs `recorded` not over-specified for cross-tab races (content-addressed key → identical record re-`put`s over itself either way).
- `unavailable` vs `failed` is a best-effort hint only; callers must treat any non-`recorded`/`duplicate` identically.
- The "caller still completes F1/G1 on logging failure" case is a small wrapper unit test — **no real catch-site wiring**.

### What is NOT in this slice

No catch-site integration, no UI/Manual Review Ops surfacing, no server resolver/Firestore-rules change, no validation/fail-closed/thrown-error change, no transfer/receiving write-path change. No production caller imports the new API.

### Files changed (code)

```
src/lib/pos/offline/reversalLocalStore.ts                 (MOD — rejections store + DB_VERSION 1→2 + in-memory parity)
src/lib/pos/offline/reversalRejectionLog.ts               (NEW — recordReversalRejection + listReversalRejections)
src/lib/pos/offline/reversalRejectionLog.test.ts          (NEW — 15 tests)
src/lib/pos/offline/reversalLocalStore.migration.test.ts  (NEW — 3 migration tests)
```

### Evidence

- `npx vitest run reversalRejectionLog reversalLocalStore` → **19 passed** (2 files)
- `npx vitest run reversalRejectionRecord offlineReversalQueue manualReviewOps` → **61 passed** (regression green)
- Full web `npx vitest run` → **453 passed** (28 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean (benign CRLF only); forbidden-area diff EMPTY (UI pages/components, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

H7-C is the first edit to the protected offline/IndexedDB layer and the first DB schema-version bump; even with additive migration and best-effort logging, any accidental throw or coupling to stock/ledger/intent transactions could disturb the live reversal queue.

---

## Phase 7B-H7-A — Pure Latent Reversal Rejection Record

**Status:** **CLOSED / COMMITTED** — `749e6e6 feat(pos): add latent reversal rejection record model`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Goal:** Define + test the record model ONLY for a future durable local rejection log. F1/G1 made fail-closed transfer/receiving evidence rejections *visible*, but they are thrown BEFORE any offline intent is created, so they leave no durable forensic trail. **No live runtime behavior changes; 100% latent.**

### Audit findings (gate before implementation)

- Rejection catch sites (untouched): `TransferHistoryPage.tsx:166`, `AdminTransferPage.tsx:184`, `ReceivingEditPage.tsx:229`. At each, the data on hand at the throw is: source doc id, branch (transfer origin / receiving branch), `staffId` (`user.id`), `observedDocumentUpdatedAt` (already ISO via `toObservedDocumentUpdatedAtIso`), and `err.code`. `evidenceSource` is generally NOT resolved at throw time → modeled optional.
- Error types: `ReceivingReversalEvidenceError` (17 codes), `TransferReversalEvidenceError` (26 codes), each with `.code`. Message helpers `get{Transfer,Receiving}ReversalEvidenceMessage(code)` are pure/display-only.
- A pure inventory-domain file is sufficient; **`src/lib/pos/offline` does NOT need touching** (no scope expansion requested). Model lives outside the offline layer and imports nothing from it.

### What was delivered (pure latent only)

- `src/lib/inventory/reversalRejectionRecord.ts` (NEW) — self-contained, no I/O, no offline imports:
  - Types `ReversalRejectionSourceType` (`'transfer' | 'receiving'`), `ReversalRejectionRecord`, `ReversalRejectionRecordInput`, error `ReversalRejectionRecordError`.
  - `buildReversalRejectionRecord(input)` — normalizes/validates required identity fields fail-closed, omits absent optionals, derives a deterministic content-addressed `recordId`.
  - `createReversalRejectionRecordId(input)` — deterministic `rej_<16hex>` id (FNV-1a-style, dependency-free); matches the builder's embedded id.
  - `serializeReversalRejectionRecord(record)` — canonical, key-ordered, stable JSON; omits absent optionals.
- `src/lib/inventory/reversalRejectionRecord.test.ts` (NEW) — 20 tests (construction both source types, required-field validation, optional omission, no over-collection, unknown-code safety, deterministic id, stable serialization, sourceType separation, JSON round-trip).

### Record fields (minimal; no over-collection)

`recordId`, `sourceType`, `sourceId`, `branchId`, `evidenceCode` (raw string — unknown-code safe), `evidenceMessage` (caller passes the already-computed friendly message → no coupling to the code unions), `evidenceSource?`, `staffId?`, `observedDocumentUpdatedAt?`, `createdAt` (input, so the helpers stay pure/deterministic). **Excluded:** raw evidence payloads, item/lot/qty/cost lines, reason/note free-text, actor role, device fingerprint.

### What is NOT in this slice

No persistence wiring, no IndexedDB/localStorage/Firestore/network/queue write, no catch-site/UI change, no `src/lib/pos/offline` change, no server resolver/rules change, no transfer/receiving write-path change, no validation/fail-closed/thrown-error change.

### Files changed (code)

```
src/lib/inventory/reversalRejectionRecord.ts        (NEW — pure builder + serializer + id + types)
src/lib/inventory/reversalRejectionRecord.test.ts   (NEW — 20 tests)
```

### Evidence

- `npx vitest run reversalRejectionRecord` → **20 passed**
- `npx vitest run reversalCoordinator` → **111 passed** (regression green)
- Full web `npx vitest run` → **434 passed** (26 files); `npx tsc -b` → clean
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed**; `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; only the two new untracked files; `stash@{0}` untouched; no diff under `src/lib/pos/offline`, server resolver, Firestore rules, transfer write-path, or UI pages/components.

### Hidden risk

H7-A defines the durable rejection record model, but actual persistence wiring remains a future separately authorized slice; wiring it too early would risk coupling a new write path to the protected offline/IndexedDB layer.

---

## Phase 7B-H6-G1 — Receiving Evidence Rejection Visibility & Void Error Handling

**Status:** **CLOSED / COMMITTED** — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Scope:** UI/error-visibility only — the receiving symmetric counterpart of H6-F1. **No validation, fail-closed policy, receiving evidence validator behavior, offline queue schema/IndexedDB/`src/lib/pos/offline`, server resolver, or transfer behavior change.** The thrown `ReceivingReversalEvidenceError` (type, `code`, generic `message`) is UNCHANGED.

### Audit findings (gate before implementation)

- `ReceivingEditPage.handleVoid` calls `executeReceivingReversal` and previously had **no try/catch**, BUT its caller `ReceivingForm.handleVoidConfirm` already wraps `onVoid` in try/catch and shows `err.message` in the `rcv-error-banner` (dialog stays open). So receiving rejections were **caught and shown — but only via the single generic `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE` for all 17 codes** (the specific code was lost). This is the same message-granularity gap F1 fixed for transfers, NOT a true unhandled rejection.
- `AdminReceivingPage` voids via the **legacy `cancelReceiving`** path (no `executeReceivingReversal`, no `ReceivingReversalEvidenceError`) — needs no parity. Authorized file list is therefore sufficient; **no scope expansion required**.
- Fix kept entirely within `ReceivingEditPage.tsx`: `handleVoid` now catches `ReceivingReversalEvidenceError` and re-throws a friendly Thai message + raw code to `ReceivingForm`'s existing banner; non-evidence errors re-throw unchanged. No edit to `ReceivingForm.tsx`.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`: new exhaustive `Record<ReceivingReversalEvidenceCode, string>` (`RECEIVING_REVERSAL_EVIDENCE_MESSAGES`) + pure `getReceivingReversalEvidenceMessage(code): string` (unknown code → `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE`). Mirrors the F1 transfer helper. Thrown error/validation unchanged.
- `src/pages/ReceivingEditPage.tsx`: `handleVoid` wrapped in try/catch — `ReceivingReversalEvidenceError` re-thrown as `Error(getReceivingReversalEvidenceMessage(code) + " (รหัส: <code>)")` so the existing void-dialog banner shows the specific reason; all other errors re-thrown unchanged (not swallowed). Success/navigation/manual-review wording, validation order, authority gating, and the form's busy/`finally` cleanup all unchanged.
- `src/lib/inventory/reversalCoordinator.test.ts`: +4 H6-G1 tests (every code non-empty Thai; unknown→generic fallback; `header_total_qty_mismatch` specific; thrown error message unchanged).

### What is NOT in this slice

No change to receiving validation / `resolveReceivingReversalEffects` / `validateReceivingHeaderEvidence` / `executeReceivingReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, offline queue schema / IndexedDB / `src/lib/pos/offline`, the server resolver, transfer behavior, `transferCrud`/`transferDevMock`/`transferTypes`, `ReceivingForm.tsx`, `AdminReceivingPage`, `cancelReceiving`. No durable local rejection log (future separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ receiving message map + getReceivingReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-G1 tests; 111 file total)
src/pages/ReceivingEditPage.tsx                 (handleVoid try/catch: evidence-error display only)
```

### Evidence

- `npx vitest run reversalCoordinator` → **111 passed** (+4 H6-G1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **414 passed** (25 files); `npx tsc -b` → clean
- `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

G1 improves receiving void rejection visibility, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-F1 — Transfer Reversal Evidence Rejection Visibility

**Status:** **CLOSED / COMMITTED** — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Scope:** UI/display-only visibility for the H6-E2-C fail-closed rejections. **No validation, fail-closed policy, offline queue schema/behavior, IndexedDB store, server resolver, or transfer write-path change.** The thrown `TransferReversalEvidenceError` (type, `code`, generic `message`) is UNCHANGED — F1 only makes the already-computed reason legible.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`:
  - New exhaustive `Record<TransferReversalEvidenceCode, string>` (`TRANSFER_REVERSAL_EVIDENCE_MESSAGES`) — one friendly Thai message per code (TS build fails if a code is unmapped).
  - New pure `getTransferReversalEvidenceMessage(code): string` — returns the mapped message; an unknown/unexpected code falls back to the existing `TRANSFER_EVIDENCE_INCOMPLETE_MESSAGE`.
- `src/pages/inventory/TransferHistoryPage.tsx` & `src/pages/admin/AdminTransferPage.tsx`: the cancel-handler `catch` now, **only when** the caught error `instanceof TransferReversalEvidenceError`, surfaces `getTransferReversalEvidenceMessage(err.code)` with the raw code as secondary detail (`(รหัส: <code>)`). All other errors keep the existing generic fallback. Control flow, `finally` busy-cleanup, branch gating, modal/route behavior, success flow all unchanged. (Admin's separate `editBranchTransfer` catch is untouched.)
- `src/pages/ManualReviewOpsPage.tsx`: new read-only "แหล่งหลักฐาน" column rendering a **page-local** `getEvidenceSourceLabel(source)` (`header_snapshot`→หลักฐานจากหัวเอกสาร, `legacy_subcollection`→รายการย่อยเดิม, absent/unknown→ไม่ระบุ) over the existing `it.evidenceSource` intent field. The label helper is defined inside the page module — **no runtime helper added to `src/lib/pos/offline`** (Codex blocker fix). No query/schema/store/mutation change.

### What is NOT in this slice

No change to `validateTransferHeaderEvidence` / `resolveTransferReversalEffects` / `executeTransferReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, the offline queue schema or IndexedDB stores, **any `src/lib/pos/offline` runtime code**, the server resolver, the H6-E2-B write path, transfer creation, receiving, `cancelBranchTransfer`/`editBranchTransfer`. No durable local rejection log (a future, separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ message map + getTransferReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-F1 message-map tests; 107 file total)
src/pages/inventory/TransferHistoryPage.tsx     (catch: evidence-error display only)
src/pages/admin/AdminTransferPage.tsx           (cancel catch: evidence-error display only)
src/pages/ManualReviewOpsPage.tsx               (+ page-local getEvidenceSourceLabel + read-only evidenceSource column)
```

### Codex blocker fix

Codex returned FAIL: the first cut added a runtime helper (`getEvidenceSourceLabel`) + a test to `src/lib/pos/offline/manualReviewOps.ts(.test.ts)`, which was strictly out of scope (`src/lib/pos/offline` runtime). Fix: both offline files reverted to **no diff**; the label mapping now lives **page-local** in `ManualReviewOpsPage.tsx`. Removing the 3 offline-helper tests dropped the full web count 413 → **410**.

### Evidence

- `npx vitest run reversalCoordinator` → **107 passed** (+4 H6-F1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **410 passed** (25 files); `npx tsc -b` → clean
- `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

H6-F1 improves operator visibility for local pre-queue rejection reasons, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-E2-C — Transfer Evidence Coordinator Validation

**Status:** **CLOSED / COMMITTED** — `fe3ff44 feat(pos): validate transfer reversal header evidence`.
**Authorization:** CEO Option A — APPROVED.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`:
  - `TransferReversalInput` gains `transferHeaderEvidence?: unknown` (UNTRUSTED at the boundary — never typed as `TransferReversalEvidence`).
  - `TransferReversalOutcome` gains `evidenceSource: ReversalEvidenceSource` (mirrors receiving).
  - `TransferReversalEvidenceCode` extended with 15 `header_*` codes.
  - `assertTransferReversalInput` split into `assertTransferReversalHeaderFields` (transferId/branches/staff/reason — runs on BOTH paths) + `assertTransferReversalItems` (legacy path only); the original retained as a composed wrapper.
  - new `validateTransferHeaderEvidence(raw, fromBranchId, toBranchId): OriginalStockEffect[]` — untrusted-boundary type-guards → version/source/branch checks → per-effect validity + direction-bound branch → checksums (`itemCount`/`totalQtyBase`, the latter with an explicit `Number.isFinite` guard) + dual-branch balance, all against the RAW entries; projects dest_gain→`+qty@to` and source_loss→`-qty@from` (lotId audit-only). Self-consistent; does NOT consult the item subcollection.
  - **Codex blocker fix:** `totalQtyBase` checksum now rejects non-finite values (`NaN`/±Infinity) — previously `typeof NaN === 'number'` + `Math.abs(NaN) > EPSILON === false` let a `NaN` total slip through. +3 regression tests.
  - new `resolveTransferReversalEffects(input)` — Case 1/2 header present (validate-or-throw, no fallback) → `header_snapshot`; Case 3/4 header absent → legacy item gate → `legacy_subcollection`.
  - `executeTransferReversal` now runs header-field gate → `resolveTransferReversalEffects` → sets `evidenceSource` on `CreateReversalInput` and the outcome.
- `src/pages/inventory/TransferHistoryPage.tsx` & `src/pages/admin/AdminTransferPage.tsx`: pass `transferHeaderEvidence: cancelTarget.reversalEvidence` (data argument only — no route/gating/modal change).
- `src/lib/inventory/reversalCoordinator.test.ts`: new `describe('H6-E2-C: …')` — 24 tests (valid preferred incl. empty-items, absent-falls-back, legacy-reversible, full invalid-header matrix with no-fallback/no-write proof, mapping equivalence, single/multi-lot lotId, E2-B round-trip, source tagging, Staff rejected on header path, header-field validation on header path).

### What is NOT in this slice

No transfer write-path change (`transferCrud.ts`/`transferDevMock.ts`/`transferTypes.ts` untouched). No server resolver change (`functions/` untouched — it re-reads items and remains authoritative). No offline queue schema change (`evidenceSource` already existed, optional). No receiving/manual-review/POS change. No new enum value; no new files.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts       (+transferHeaderEvidence, validateTransferHeaderEvidence, resolveTransferReversalEffects, gate split, evidenceSource)
src/lib/inventory/reversalCoordinator.test.ts  (+27 H6-E2-C tests; 103 file total)
src/pages/inventory/TransferHistoryPage.tsx     (+transferHeaderEvidence arg)
src/pages/admin/AdminTransferPage.tsx           (+transferHeaderEvidence arg)
```

### Evidence

- `npx vitest run reversalCoordinator` → **103 passed**; `transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed**
- Full web `npx vitest run` → **406 passed** (25 files); `npx tsc -b` → clean
- `functions` `resolveReversal` → **43 passed** (server unchanged)
- `git diff --check` clean; `stash@{0}` untouched; forbidden-path diff EMPTY (write-path/server/offline schema).

### Hidden risk

H6-E2-C activates fail-closed header evidence preference, so malformed post-E2-B evidence will BLOCK local queue-first reversal (→ manual review) rather than silently falling back; this is intentional, and server authority remains unchanged.

---

## Phase 7B-H6-E2-B — Write Transfer Evidence Header at Completion

**Status:** **CLOSED / COMMITTED** — `82d3352 feat(pos): write transfer reversal evidence header on completion`.
**Authorization:** CEO Option A — APPROVED.

### What was delivered

- `src/lib/inventory/transferTypes.ts`: added `import type { TransferReversalEvidence }` and `reversalEvidence?: TransferReversalEvidence` as optional field on `InventoryTransfer` (absent on legacy docs).
- `src/lib/inventory/transferCrud.ts`: in `confirmBranchTransfer`, after `linePlans` are finalized (end of Phase 2) and before Phase 3 writes, builds `TransferReversalEvidenceInput` from `linePlans` (with FIFO `sourceLotDetails`), calls `buildTransferReversalEvidence` then `assertTransferReversalEvidenceCoversCompletion` fail-closed, and adds `reversalEvidence` to the Phase-3 `tx.set` atomically with the transfer header. Evidence `createdAt` is a client ISO string (`new Date().toISOString()`); header `createdAt`/`updatedAt` remain server timestamps.
- `src/lib/inventory/transferDevMock.ts`: `devConfirmBranchTransfer` mirrors the production path — builds the same evidence input from `savedItems`, calls builder + assertion, and writes `reversalEvidence` on the in-memory doc.
- `src/lib/inventory/transferCrud.test.ts`: 8 new H6-E2-B tests in `describe('H6-E2-B: write reversalEvidence at transfer completion', ...)`.

### What is NOT in this slice

No coordinator validation against the persisted evidence in this slice. `reversalCoordinator.ts`, UI pages, server resolver, offline queue, Firestore rules — all UNCHANGED in this slice. H6-E2-C (coordinator validation) is now also CLOSED / COMMITTED — `fe3ff44`.

### Files changed (code)

```
src/lib/inventory/transferTypes.ts       (+ reversalEvidence?: TransferReversalEvidence)
src/lib/inventory/transferCrud.ts        (evidence build + tx.set update in confirmBranchTransfer)
src/lib/inventory/transferDevMock.ts     (evidence build + doc update in devConfirmBranchTransfer)
src/lib/inventory/transferCrud.test.ts   (+8 H6-E2-B tests; 18 transferCrud total)
```

### Evidence

- `npx vitest run transferCrud` → **18 passed** (+8 H6-E2-B); `npx vitest run transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **379 passed** (25 files); `npx tsc -b` → clean
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-B persists the evidence snapshot at completion but does not yet validate it at reversal time — until H6-E2-C wires the coordinator to read and verify the header evidence before accepting a reversal, the snapshot is audit-only (not fail-closed on the reversal path).

---

## Phase 7B-H6-E2-A — Pure Transfer Evidence Builder + Dual-Branch Invariant

**Status:** **CLOSED / COMMITTED** — `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`.
**Authorization:** CEO Option A — APPROVED (pure evidence builder + invariant only).

### What was delivered

- New pure file `src/lib/inventory/transferReversalEvidence.ts`:
  - `TransferReversalEvidence` / `TransferReversalEvidenceEffect` / `TransferReversalEvidenceDirection` types.
  - `TransferReversalEvidenceInput` / `TransferReversalEvidenceItemInput` builder input types (decoupled from runtime transfer types).
  - `TransferReversalEvidenceError` (structured codes: builder + invariant).
  - `buildTransferReversalEvidence(input)` — validates input fail-closed; produces one `dest_gain` + one `source_loss` effect per item (both positive qty); derives `itemCount` and `totalQtyBase` from input; sorts effects deterministically by `productId|direction|branchId|lotId`. Source lot identity is audit-only (populated for single-lot; null for multi-lot — no over-rejection gate).
  - `assertTransferReversalEvidenceCoversCompletion(input, evidence)` — proves version/source, branch IDs, effect well-formedness, `itemCount` == `input.items.length`, `totalQtyBase` == sum(transferQty), and per-product dual-branch balance (dest_gain total == source_loss total == input qty for every product; extra products in effects also fail closed).
- New test file `src/lib/inventory/transferReversalEvidence.test.ts`: 41 tests (36 original + 5 branch-direction invariant tests from the Codex blocker fix) covering all 24 required specification cases plus the branch-direction binding cases.

### What is NOT in this slice

No runtime wiring. No header write. No coordinator validation. No evidence persistence. `transferCrud.ts`, `reversalCoordinator.ts`, `transferDevMock.ts`, UI, server resolver, offline queue — all UNCHANGED. H6-E2-B (header write at completion) and H6-E2-C (coordinator validation) are future slices.

### Files changed (code)

```
src/lib/inventory/transferReversalEvidence.ts       (NEW — pure builder + invariant)
src/lib/inventory/transferReversalEvidence.test.ts  (NEW — 41 tests)
```

### Evidence

- `npx vitest run transferReversalEvidence` → **41 passed**; `npx vitest run transferCrud` → **10 passed**; `npx vitest run reversalCoordinator` → **76 passed**; full web `npx vitest run` → **371 passed** (25 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (resolver UNCHANGED).
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-A proves the evidence math but remains latent; it does not yet protect live queue-first local correction until a later write/validation slice is authorized.

---

## Phase 7B-H6-E1 — Transfer `updatedAt` Stamping

**Status:** **CLOSED / COMMITTED** — `8a3d03f feat(pos): stamp updatedAt on transfer completion for stale-client protection`.
**Authorization:** CEO Option A — APPROVED (timestamp-only).

### What was delivered

- `confirmBranchTransfer` (`transferCrud.ts`) Phase-3 header `tx.set` now writes `updatedAt: now` alongside the existing `createdAt: now` (both `serverTimestamp()`); `updatedAt === createdAt` at inception is expected/acceptable.
- `devConfirmBranchTransfer` (`transferDevMock.ts`) mirrors the shape, writing `updatedAt: ts(now)` on the created doc.
- No other write path changed: `cancelBranchTransfer` already stamped `updatedAt`; `editBranchTransfer` creates a fresh transfer via `confirmBranchTransfer` (so edit-created docs inherit the stamp). `InventoryTransfer.updatedAt` was already optional — no type change.

### Why this closes the gap

Pre-E1, a freshly `completed` transfer had `createdAt` but no `updatedAt`, so the server `isClientObservationStale` saw `serverDoc.updatedAt == null` → not stale (doubly inert with the omitted client observation). With E1, new transfers carry `updatedAt`, so the H6-D2 capture `toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)` is populated AND the server has a baseline — activating the stale-client guard end-to-end. No page/coordinator/resolver edit was needed (H6-D2 was built forward-compatible).

### Legacy docs policy (accepted)

No backfill. Existing transfers without `updatedAt` stay fresh-by-default (guard fail-open); the server reversal mutation remains authoritative through the existing guards. New transfers get reliable `updatedAt`.

### Files changed (code)

```
src/lib/inventory/transferCrud.ts        (confirmBranchTransfer header: + updatedAt: now)
src/lib/inventory/transferDevMock.ts     (devConfirmBranchTransfer doc: + updatedAt: ts(now))
src/lib/inventory/transferCrud.test.ts   (+2 H6-E1 tests: production + dev/mock stamping)
```

### Evidence

- `npx vitest run transferCrud` → 10 passed; `npx vitest run reversalCoordinator` → 76 passed; full web `npx vitest run` → 330 passed (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → 43 passed (server resolver UNCHANGED; the transfer stale-guard regression already exists at `resolveReversal.test.ts` lines 454–468 and stays green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched (no UI, coordinator, resolver, or offline-queue diff).

### Out of scope (unchanged)

Transfer header evidence/checksum snapshot (future H6-E2), server resolver implementation, offline queue schema, Firestore rules, receiving behavior, H6-D2 UI route wiring/coordinator, `cancelBranchTransfer`/`editBranchTransfer` behavior, `sent→received` lifecycle refactor, legacy-doc backfill.

### Hidden risk

Legacy transfer docs without `updatedAt` remain fresh-by-default (stale-client guard inert for them), but new transfers now activate the guard end-to-end; additionally, a metadata-only `reportTransferDiscrepancy` writes a subcollection without advancing the header `updatedAt`, so a discrepancy report is not seen as a state advance by the guard (acceptable — it mutates no stock).

---

## Phase 7B-H6-D2 — UI Route Wiring & Legacy Path Retirement

**Status:** **CLOSED / COMMITTED** — `bb30881` `feat(pos): wire ui to queue-first transfer reversal and retire legacy path` (CEO Option B — APPROVED WITH NOTES).
**Authorization:** CEO Option A — APPROVED.

### Codex blocker fix (origin-branch authority gate)

Codex returned **FAIL**: `TransferHistoryPage` lists both outgoing (`fromBranchId`) and incoming (`toBranchId`) transfers, but the queue-first executor applies a local IndexedDB correction + queue write BEFORE server sync using `fromBranchId` as authority — so a destination-branch user could locally apply/queue a reversal they don't control. **Fix:** a pure fail-closed preflight `canBranchReverseTransfer(currentBranchId, fromBranchId)` (in `reversalCoordinator.ts`) gates BOTH the modal entry point (`onCancelTransfer` is only wired when active branch === origin) AND `handleCancel` (hard early-return before `executeTransferReversal`). `AdminTransferPage` is the global-admin surface (`hasBranchAccess` → `true` for `admin`), so it intentionally does NOT use the gate. New tests prove the helper's fail-closed behavior, the gated entry point, the guard-before-executor ordering, and that Admin stays ungated. Server resolver, offline-queue schema, and `transferCrud.ts` unchanged.

### What was delivered

- **D2-α prerequisite cleanup:**
  - Removed the now-stale `TRANSFER_REVERSAL_DEFERRED_NOTE` constant (and its tests/JSDoc references); it claimed completed transfers were not resolver-compatible, which H6-C (resolver activation) + H6-D1 (latent executor) made false.
  - Tightened `assertTransferReversalInput`: whitespace-only `productId` now fails closed as `missing_product_id`; trim-equal `fromBranchId`/`toBranchId` now fail closed as `same_branch`.
- **D2-β UI route wiring:**
  - `decideReversalRoute('transfer')` now returns `transfer_queue_first` (the `transfer_legacy_executor` route value is retired from `ReversalRoute`).
  - `TransferHistoryPage` + `AdminTransferPage` confirmed-cancel handlers now call `executeTransferReversal` queue-first, fetching transfer items fresh and building the payload (`transferId`, `fromBranchId`, `toBranchId`, items, `sourceLotDetails`, reason/note, `observedDocumentUpdatedAt` via `toObservedDocumentUpdatedAtIso`). Queue-first outcome wording mirrors the receiving reversal UX (manual-review / synced / queued-offline).
  - Legacy `cancelBranchTransfer` import + call removed from BOTH pages. `AdminTransferPage` keeps `editBranchTransfer` (and its internal `cancelBranchTransfer` step is untouched in `transferCrud.ts`).

### Timestamp handling (known limitation)

`observedDocumentUpdatedAt` is threaded WHEN the transfer doc has a convertible `updatedAt`, omitted otherwise. `confirmBranchTransfer` may not reliably stamp `updatedAt` at creation yet, so full stale-client protection for transfers is NOT claimed — that is the future **H6-E** hardening slice.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (route flip + whitespace tightening + stale-note removal + comment refresh)
src/lib/inventory/reversalCoordinator.test.ts   (route/validation tests + H6-D2 source-level mutual-exclusion tests)
src/pages/inventory/TransferHistoryPage.tsx     (queue-first migration; cancelBranchTransfer retired)
src/pages/admin/AdminTransferPage.tsx           (queue-first migration; cancelBranchTransfer retired, editBranchTransfer preserved)
```

### Evidence (post blocker fix)

- `npx vitest run reversalCoordinator` → 76 passed; full web `npx vitest run` → 328 passed (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → 43 passed (server resolver unchanged — regression green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

Server resolver, offline-queue schema, Firestore rules, receiving/POS/checkout/returns/RTV, `transferCrud.ts` (`cancelBranchTransfer`/`editBranchTransfer` behavior), transfer header evidence/checksum snapshot, `updatedAt` stamping at transfer completion, `sent→received` lifecycle refactor.

### Hidden risk

Page-component guarantees are proven by source-level import/call inspection (the pages carry a heavy Firebase/router/auth/modal harness), so a future refactor that re-introduces a legacy `cancelBranchTransfer` call through an alias or indirection could evade the regex guards without failing the suite.

---

## Phase 7B-H6-D1 — Transfer Queue-first Executor (LATENT)

**Status:** **IMPLEMENTED — AWAITING CODEX REVIEW** (not committed; not closed).
**Authorization:** CEO Option A — APPROVED (latent executor + tests only).

### What was delivered

- Latent `executeTransferReversal` in `reversalCoordinator.ts` mirroring `executeReceivingReversal`: fail-closed validation (`assertTransferReversalInput` + `TransferReversalEvidenceError`), dual-branch `buildTransferReversalEffects`, `observedDocumentUpdatedAt` threading, queue-first create + sync.
- Intent uses `sourceType:'transfer'`, `sourceId: transferId`, `branchId: fromBranchId` (origin — matches server authority). No offline-queue schema change.
- **Not wired into any UI (as of H6-D1; superseded by H6-D2).** At D1, `decideReversalRoute('transfer')` still returned the legacy route and the two transfer pages were untouched — capability was dead-but-tested. **H6-D2 has since flipped the route to `transfer_queue_first` and migrated both pages.**

### Dual-branch math (proven)

- Original effects: destination `+transferQty`, source `−transferQty`. Reversal engine negates → local correction destination `−qty`, source `+qty`; aggregated by product×branch.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (executeTransferReversal + builder + validation + types)
src/lib/inventory/reversalCoordinator.test.ts   (16 new H6-D1 tests)
```

### Evidence

- `npx vitest run reversalCoordinator` → 63 passed; full web `npx vitest run` → 315 passed (24 files); `npx tsc -b` → clean.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

UI route flip, transfer page migration, legacy `cancelBranchTransfer` retirement, server resolver, offline-queue schema, transfer evidence/checksum snapshot, `updatedAt`-at-completion, `sent→received` lifecycle refactor.

### Hidden risk

The executor is fully functional but unreferenced by production UI, so a future H6-D2 that forgets to also remove the legacy `cancelBranchTransfer` page calls could leave two live reversal paths for the same transfer.

---

## Phase 7B-H6-C — Server Resolver Activation + Tests

**Status:** **CLOSED / COMMITTED**
**Commit:** `68f46e2` — `feat(pos): activate server transfer reversal resolver` (CEO Option B — APPROVED WITH NOTES)
**Authorization:** CEO Option A — APPROVED (server resolver + tests only).

### What was delivered

- Activated the (previously dormant) transfer reversal resolver for the live model: `completed` is now the reversible state (H6-B Option A). Eligibility is **centralized** in `isTransferStatusReversible(status)` backed by the single-source-of-truth set `REVERSIBLE_TRANSFER_STATES = {'completed'}`; the resolver gate calls only that helper (no scattered `status === 'completed'` checks).
- `completed` is **eligible only to proceed into the existing strict downstream guards** — it is never unconditionally reversible. Guard ordering preserved: `source_document_not_found` → authority/PIN → H4 stale-client guard → `already_reversed` (cancelled/reversedBy) → eligibility gate → dest stock/lot sufficiency → dual-branch writes → intent/audit.
- No client/UI/offline-queue change. Resolver activation is **latent in production** until the future H6-D client wiring (no caller currently queues a `transfer_reversal`).

### Files changed (code)

```
functions/src/resolveReversal.ts        (centralized policy helper + gate + header comment)
functions/src/resolveReversal.test.ts   (transfer tests updated to live model + new coverage)
```

### Evidence

- `npm --prefix functions run build` → clean.
- `npx vitest run resolveReversal` → 43 passed; full functions suite `npx vitest run` → 112 passed (8 files).
- Receiving + H4 stale-guard tests remain green.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged by H6-C)

Client queue-first transfer reversal, `executeTransferReversal`, transfer UI/Admin routing, legacy `cancelBranchTransfer` retirement, transfer evidence/checksum snapshot, `updatedAt` stamping at completion, `sent→received` lifecycle refactor, Firestore rules, receiving paths.

### Hidden risk

H6-C flips the server gate so a `completed` transfer is now reversible server-side, but no client path queues a transfer reversal yet — so the activation is inert in production until H6-D, and any premature direct callable invocation would now execute a real dual-branch reversal under the guards.

---

## Phase 7B-H6-B — Transfer Reversal Architecture Decision

**Status:** **IN PROGRESS — docs-only, not yet committed.**
**Authorization:** CEO Option A — APPROVED. Docs-only architecture decision recording. No TypeScript implementation in H6-B.

### H6 Environment Audit Findings (read-only — point-in-time at the H6-B audit, SINCE SUPERSEDED by H6-C/H6-D1/H6-D2)

> These findings describe the state at the H6-B audit. **H6-C (committed `68f46e2`) activated the resolver for `completed` transfers under strict guards; H6-D1 (`4aa8065`) added the latent queue-first executor; H6-D2 wired the targeted UI surfaces.** The "dormant"/"cannot fire" rows below are historical, not current.

| Finding | Detail |
|---------|--------|
| Current Transfer state model | Two states only: `completed` \| `cancelled` |
| Live transfer creation | Transfers are created directly as `completed` (no intermediate `sent`/`received` steps in the current production path) |
| Existing server resolver transfer branch | Was dormant at the audit — gated on `sent`/`received` (states no live transfer carries). **H6-C has since activated it for `completed` transfers under strict guards.** |
| Impact | At the audit, the resolver transfer path could not fire end-to-end until the gate was updated. **H6-C updated the gate to admit `completed`; the path is now live server-side and wired in H6-D2.** |

### CEO Architecture Decision (Option A)

For the current Transfer model, **`completed` is approved as the reversible state** for future queue-first Transfer Reversal.

**Semantics clarification:**
- `completed` does NOT mean "always reversible."
- `completed` means "**eligible for reversal under strict server-authoritative guards**."
- The same guard stack (authority, stale-client, idempotency, already-reversed, stock/lot sufficiency) applies as for receiving reversals.

**Deferred:** A full `sent → received → completed` lifecycle refactor is explicitly out of scope for the H6 implementation track and must not be introduced unless separately authorized.

### Long-Term Risk Documentation

#### Technical Debt

Treating `completed` as reversible creates **controlled technical debt, not blocking debt**. It matches the current production data model exactly. Forcing a broad transfer lifecycle refactor now would be riskier and broader than the immediate problem warrants. The debt is bounded: if business requirements later introduce a multi-step workflow, only the reversible-state policy needs to change — not the resolver logic everywhere.

#### Future Scalability

If a future `sent → received → completed` workflow is introduced, the resolver remains adaptable **if and only if** H6-C centralizes reversible-state eligibility in one helper/policy (e.g. `isTransferReversible(transfer)`) and tests both accepted and rejected states against that helper. A single centralized change then covers all call sites.

#### Mitigation Pattern (H6-C must follow)

| Requirement | Rule |
|-------------|------|
| Reversible-state check | Centralized helper — do NOT scatter `status === 'completed'` checks across resolver code |
| Semantics | `completed` = "eligible under guard," never "reversible unconditionally" |
| Server authority | Final mutation always server-authoritative |
| Stock/lot sufficiency | Destination stock/lot sufficiency must be required before reversal |
| Cost preservation | Source lot restoration must preserve original cost and `receivedAt` evidence |
| Stale-client guard | Must remain active when client payload is wired (same H4/H5 pattern) |
| Idempotency | Already-reversed check mandatory |
| Lifecycle refactor | No transfer lifecycle refactor unless separately authorized |

### Next queued slice

**Phase 7B-H6-C: Server Resolver Activation + Tests — Planning Only.**
No code implementation until Tech Lead approves the H6-C execution plan.

---

## Phase 7B-D4 — Docs/Context Sync After H5 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `f61e94e` — `docs: sync phase 7b tracker after h5 receiving hardening closure`
Docs-only sync pass after Phase 7B-H5 was closed and committed (`4762d97`). Recorded H5 as CLOSED/COMMITTED, advanced the baseline to the H5 commit, recorded End-to-End Receiving Reversal Hardening as functionally complete, and queued H6. No source code or tests modified.

---

## Phase 7B-D3 — Docs/Context Sync After H4 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `fb4c3b0` — `docs: sync phase 7b tracker after h4 closure`

Docs-only sync pass after Phase 7B-H4 was closed and committed (`4da7757`). Recorded H4 as CLOSED/COMMITTED, advanced the baseline to the H4 commit, and queued H5. No source code or tests modified. D3 is no longer active.

---

## Phase 7B-H5 — Wire Client Observation Timestamp Payload

**Status:** **CLOSED / COMMITTED**
**Commit:** `4762d97` — `feat(pos): wire client observation timestamp for reversals`
**Authorization:** Option A — APPROVED (receiving-only). CEO Option B — APPROVED WITH NOTES (closure).
**Milestone:** End-to-End Receiving Reversal Hardening is functionally complete. H4 (server-side stale-client guard) and H5 (client/offline timestamp payload wiring) together protect the Receiving reversal flow end-to-end.

### What was delivered summary

Wired `clientObservedDocumentUpdatedAt` into the offline/client resolver payload so Phase 7B-H4's server-side stale-client guard is active end-to-end for the **live receiving reversal flow**.

### What was delivered (receiving-only payload wiring — committed)

- The receiving void page (`ReceivingEditPage.handleVoid`) captures the loaded receiving doc's `updatedAt`, converts it defensively to an ISO 8601 string (`toObservedDocumentUpdatedAtIso`), and passes it through `ReceivingReversalInput`.
- The value is persisted on the durable offline intent as the optional **internal** field `observedDocumentUpdatedAt` (ISO 8601), so a later sync forwards the same observation.
- At the sync boundary, `toResolveRequest` maps it to the **server wire** field `clientObservedDocumentUpdatedAt`, **omitting** it entirely when unavailable.
- No server resolver change (H4 guard already shipped in `4da7757`).

### Backward compatibility

- All new fields optional. Legacy queued intents (pre-H5) carry no `observedDocumentUpdatedAt` ⇒ `toResolveRequest` omits `clientObservedDocumentUpdatedAt` ⇒ H4 guard stays inert (fresh) for them. No migration required.
- Missing / malformed / unconvertible `updatedAt` ⇒ field omitted (never `''`, never `null` on the wire).

### Idempotency

- The observed timestamp is **not** part of `deriveReversalIds` (intent id / idempotency key / localMutationId) and is excluded from the server payload hash by H4's design. Tests prove two intents differing only by `observedDocumentUpdatedAt` derive identical ids.

### Files changed

```
src/pages/ReceivingEditPage.tsx                    (capture + convert at void)
src/lib/inventory/reversalCoordinator.ts           (input field + toObservedDocumentUpdatedAtIso + thread-through)
src/lib/pos/offline/offlineReversalTypes.ts        (CreateReversalInput + OfflineReversalIntent fields)
src/lib/pos/offline/offlineReversalLogic.ts        (persist on intent)
src/lib/pos/offline/syncOfflineReversals.ts        (wire field + emit in toResolveRequest)
src/lib/pos/offline/offlineReversalQueue.test.ts   (3 new H5 tests)
src/lib/pos/offline/offlineReversalLogic.test.ts   (3 new H5 tests)
src/lib/inventory/reversalCoordinator.test.ts      (8 new H5 tests)
```

### Evidence

- `npx vitest run` (web) → 298 passed (24 files).
- Server resolver `functions: npx vitest run resolveReversal` → 39 passed (**unchanged**).
- `npx tsc -b` (web) → clean; `npm --prefix functions run build` → clean.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged by H5)

- Transfer reversal wiring (out of scope for H5; at that time it routed to the legacy executor and the resolver transfer path was dormant — since changed by H6-C activation, H6-D1 executor, and H6-D2 UI wiring).
- Manual-review resolution (local-only; never calls the server).
- Global Admin UI; multi-device/server-broadcast propagation.
- POS/cart/checkout/returns/RTV; Firestore rules; server resolver logic.

### Hidden risk

The observation is captured at void time from the page's already-loaded receiving doc; if that in-memory copy is staler than Firestore at the moment of voiding, the guard could reject a reversal the operator believes is current — surfaced via the existing manual-review path, not silent data loss.

---

## Phase 7B-H4 — Resolver Hardening / Stale Client Guard

**Status:** **CLOSED / COMMITTED**
**Commit:** `4da7757` — `feat(pos): harden resolver against stale client observations`
**Authorization:** Option B — APPROVED WITH NOTES (CEO)

### What was delivered

- Server-authoritative stale-client guard in `functions/src/resolveReversal.ts`. The resolver now rejects a reversal whose client-observed document version (`clientObservedDocumentUpdatedAt`) is older than the live server document `updatedAt`.
- New structured reject code `stale_client_observation` (status `rejected`). Mutation-free: zero stock, zero lot, no reversal/manual-review state advance, no audit/intent-ledger write.
- Guard placed AFTER authority (branch + Staff PIN) and BEFORE every status check and write in both `resolveReceivingReversal` and `resolveTransferReversal`.
- Conservative & deterministic: absent observation ⇒ not stale (legacy callers unaffected); no comparable server `updatedAt` ⇒ not stale; strict `server > observed` ⇒ stale (equal instants are fresh, so retries are safe).

### Files changed

```
functions/src/resolveReversal.ts        (guard + helpers + reject code)
functions/src/resolveReversal.test.ts   (11 new H4 tests)
```

### Evidence

- `npx vitest run resolveReversal` → 39 passed.
- Full functions suite `npx vitest run` → 108 passed (8 files).
- `npm run build` (tsc) → clean.
- `git diff --check` → clean; post-commit working tree **clean**; `stash@{0}` untouched.

### Hidden risk (accepted — primary H5 requirement)

The guard only fires when the client actually sends `clientObservedDocumentUpdatedAt`; until the offline-queue client is wired to populate it (out of this slice's scope), real-world staleness is not yet detected end-to-end. **Accepted by CEO (Option B) as a non-blocking known risk.** Wiring `clientObservedDocumentUpdatedAt` into the client/offline resolver payload is the primary Phase 7B-H5 requirement.

---

## Phase 7B-H3 — Manual Review Operations UI

**Status:** **CLOSED / COMMITTED**
**Codex:** PASS WITH NOTES / no required fixes / no blockers
**Commit:** `4d69143` — `feat(pos): add manual review ops UI`

> LOCAL/device-visible queue UI only. NOT a global Firestore admin dashboard. No global Firestore queries, no stock mutation, no Firestore reconciliation (that remains an external manual admin process outside the app).

### What was delivered

- Read-only view of THIS DEVICE's `manual_review_required` intents (via `listQueue(store, ['manual_review_required'])`).
- Manager/Admin-only resolve action (`resolveManualReview` from H2) with required `reasonCode` + optional `note`.
- Authority gating: `canViewManualReviewOps` delegates to H2's `isOfflineReversalAuthoritySupported` (Manager/Admin only; Staff sees not-authorized state).
- Unit/integration tests: `manualReviewOps.test.ts` (10 passed). Full web unit suite: 284 passed (24 files). `tsc -b --noEmit`: clean.

### Architectural boundaries

- **Local/device-only:** reads the IndexedDB reversal queue on THIS device only; not a cross-device or global scan.
- **No Firestore reconciliation:** Firestore reconciliation remains an external manual admin process outside the app.
- **No stock mutation:** `resolveManualReview` leaves the internal stock counter untouched.
- **Staff blocked:** Manager/Admin only; Staff cannot see or invoke the resolution action.

---

## Phase 7B-D1 — Project Context and Task Tracking Docs

**Status:** **CLOSED / COMMITTED**
**Commit:** `dacccd1` — `docs: add project context and task tracker`

| File | Purpose |
|------|---------|
| `Context.md` | Twinpet POS Project Context & System Rules |
| `Task.md` | This checkpoint tracker |

---

## Phase 7B-H2 — Manual Review Operational Guard

**Status:** **CLOSED / COMMITTED**
**Codex:** PASS WITH NOTES / Required Fixes: None
**Tech Lead:** APPROVED / COMMIT AUTHORIZED
**Commit:** `8b48513` — `feat(pos): add manual review resolution state`

---

## Checkpoint goal (H2)

When a Manager/Admin reconciles Firestore stock but a device still has a `manual_review_required` offline intent, the POS overlay keeps showing a **ghost delta**. H2 adds a **local-only** transition to `manual_review_resolved` so that device stops overlaying — without rolling back the local correction or touching server state.

---

## What is done (this checkpoint)

| Item | State |
|------|-------|
| New status `manual_review_resolved` + `manualReviewResolution` audit block | Done |
| Pure helpers: eligibility, guard, build (`offlineReversalLogic.ts`) | Done |
| `resolveManualReview()` orchestration (`offlineReversalQueue.ts`) | Done |
| Overlay excludes `manual_review_resolved` (doc comment updated) | Done |
| Tests: `manualReviewResolution.test.ts` (15), overlay (19), queue (28), logic (16) | Green |
| Full web unit suite | 274 passed (23 files) |
| Playwright `pos-safety.spec.ts` | 2 passed |
| `resolveReversal.test.ts` (server) | 29 passed — **unchanged** |

### Approved H2 semantics (do not reinterpret)

- **Local stock counter NOT touched**; `localCorrection.reversed` stays `false`.
- **Outcomes:** `resolved | already_resolved | not_found | not_eligible`; throws only for authority / missing actor / missing reason.
- **Eligibility:** only `manual_review_required` with `applied && !reversed`. `server_rejected` is **not** resolvable.
- **Idempotent:** second call → `already_resolved`, metadata preserved.
- **Multi-device propagation:** deferred (per-device only).

---

## What is NOT in scope (H2 / D1)

- Admin UI for manual-review resolution
- Server / rules changes (`resolveReversal.ts` unchanged)
- `stash@{0}` / Flowbite migration
- Transfer-logic refactor
- Completed-transfer queue-first reversal
- Multi-device broadcast of resolution

---

## D-track context (7B-3D — foundation, not H2 scope)

Already on mainline before H2:

| Track | Delivered |
|-------|-----------|
| **7B-3D-2** | Server `resolveReversal` callable |
| **7B-3D-3** | Offline reversal queue + IndexedDB correction |
| **Post-commit integration** | Receiving/Transfer/POS wired + `reversalStockOverlay` |
| **7B-H1** | Receiving `reversalEvidence` header snapshot |

H2 sits on this stack; it does not replace or modify the server resolver.

---

## Open actions (D1 checkpoint)

| # | Action | Owner | Status |
|---|--------|-------|--------|
| 1 | Codex review of `8b48513` (H2 commit) | Codex | **Done** — PASS WITH NOTES |
| 2 | Paranoid Checklist pass on H2 diff | Codex | **Done** |
| 3 | Tech Lead go/no-go for H2 | Gemini | **Done** — APPROVED |
| 4 | Commit `Context.md` + `Task.md` (docs-only) | Developer | **Ready** |
| 5 | Tech Lead decides next implementation track | Gemini | **Done** — H3 (Manual Review Ops UI) implemented |

---

## Files in H2 scope (reference)

```
src/lib/pos/offline/offlineReversalTypes.ts
src/lib/pos/offline/offlineReversalLogic.ts
src/lib/pos/offline/offlineReversalQueue.ts
src/lib/pos/offline/reversalStockOverlay.ts          (doc comment only)
src/lib/pos/offline/manualReviewResolution.test.ts   (NEW)
src/lib/pos/offline/reversalStockOverlay.test.ts
```

---

## Forbidden touch list (all agents)

- `functions/**` (especially `resolveReversal.ts`)
- `firestore.rules`
- `Android/**`
- `.claude/settings.local.json`
- Settings / UOM files in `stash@{0}`
- `rp.md` (personal scratchpad — not part of project commits)
- `docs/reports/latest-report.md` (unless explicitly tasked to update)

---

## H2 closeout (recorded)

- Codex: **PASS WITH NOTES** — no required fixes.
- Tech Lead: **APPROVED** — commit authorized.
- Deferred (not H2 blockers): Admin UI for manual-review resolution; multi-device propagation; completed-transfer queue-first reversal.
