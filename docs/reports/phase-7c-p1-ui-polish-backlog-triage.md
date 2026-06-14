# Phase 7C-P1 UI Polish Backlog Triage and Slice Plan

## Executive Summary

Phase 7C-P1 is a **read-only planning slice**: no runtime, CSS, or test files were touched. It triages the Tech Lead / CEO UI Polish backlog (UI-01 … UI-08) plus one correctness bug (LOGIC-01) on top of the now-stabilized POS keyboard / scanner / numpad suite (committed at `ca0d5d8`).

Key findings:

- **LOGIC-01 is the only correctness/data-loss bug in the set** — selecting several multi-UOM products in the Product Picker silently drops all but the last, because `uomProduct` is a **single state slot** in `POSPage.tsx` that each `onProductClick` overwrites. It is *not* UI polish; it touches the stabilized modal/Escape/F12 contracts and must be its own strictly-reviewed slice.
- **UI-08 carries the highest UI risk and an unresolved ambiguity** — the Offline tag + Sync control currently live in the **POSPage** topbar, but the "Branch name row" named in the request lives in the **global AppShell header**. The relocation either (a) hoists POS-only sync state up into the shell (cross-cutting) or (b) is a POSPage-local restructure. Also, there is no single control literally named "Sync"; the closest is the manual-refresh link. Both need CEO clarification before implementation.
- **The trivial, isolated, high-business-value items are UI-04 (default route → `/pos`) and UI-03 (POS as a top-level menu item).** They are the safest first slices.
- **UI-01, UI-07 are mostly CSS-local**; the main trap is the **shared flowbite Table theme** (UI-01) and the POS category grid (UI-07).
- **UI-02 and UI-03 both edit `AppShell.tsx` sidebar markup** → sequence them; do not parallelize.
- **UI-05/06** introduce a new device-local LocalStorage preference + a settings control + live font scaling on the POS product grid (touch-target/layout risk).

Recommended sequencing prioritizes business correctness (LOGIC-01) and tiny isolated wins first, defers the cross-component / ambiguous UI-08 to last, and keeps every slice in its own commit with mandatory Codex review.

## Current Baseline

- **HEAD:** `ca0d5d8 fix(pos): refine discount numpad clear action`
- **Working tree:** clean at phase start.
- **Stash:** `stash@{0}: On main: WIP: Batches 1-3 ...` — present, untouched (read-only `git stash list` only).
- **Recent lineage:** `ca0d5d8` ← `bc0fcf9` (D4-D1) ← `1a239b4` (D4-D) ← `0c7e924` (E1 LAN) ← `0c0a624` (UAT-pause sync) ← `6f0f4c7` (D4-C-4 Escape).

## Final UAT Acceptance Summary

Tech Lead / CEO confirmed **Final Touch UAT for Phase 7C-D4-D2 PASSED and is ACCEPTED**. The physical POS keyboard, hardware-scanner, and touch-numpad suite (D4-A, D4-C-1..4, D4-D, D4-D1, D4-D2) is marked **successful and stable**. The strategic pivot stands: web-based iOS/iPad Safari focus workarounds remain dropped; hardware-scanner focus is deferred to the Native App / Capacitor wrapper phase. This stable suite is the regression surface every P1 slice must protect.

## Backlog Inventory

| ID | Title | Class | Risk |
|----|-------|-------|------|
| LOGIC-01 | Product Picker multi-UOM selection state overwrite | Logic / data-loss | **High** |
| UI-01 | Sales History table header nested border-radius | CSS polish | Low–Medium |
| UI-02 | Move hamburger / sidebar toggle to the right side | Layout | Medium |
| UI-03 | Extract "POS"/"ขาย" to a top-level primary menu item | Navigation | Medium |
| UI-04 | Default post-login landing route → `/pos` | Routing | Low (logic) / Medium (workflow) |
| UI-05/06 | Dynamic font-size adjusters for POS Product Name & Price (device LocalStorage) | Feature + CSS | Medium |
| UI-07 | Redesign POS Category Search Modal to a searchable List View | CSS / markup | Low–Medium |
| UI-08 | Relocate Offline tag + Sync button to top-right header; rename to `🔄 ซิงค์ข้อมูล` | Layout / cross-component | **High** |

## LOGIC-01 Analysis

- **Problem statement:** In the Product Picker (`components/products/ProductPickerDialog.tsx`) the cashier multi-selects products (a `Set<string>` of product ids) and confirms. `POSPage.tsx`'s `onConfirm` (lines ~1127-1132) loops the selection and calls `onProductClick(product)` for each. `onProductClick` (lines 351-360) does: if a product has `uomOptions.length > 1` → `setUomProduct(product)`; else `cart.addToCart(...)`. Because `uomProduct` is a **single state value** (`const [uomProduct, setUomProduct] = useState<PosProduct | null>(null)`, line 112), looping over multiple multi-UOM products calls `setUomProduct` repeatedly within one render pass — **only the last multi-UOM product survives**; all earlier ones are silently dropped (never prompted, never added). Single-UOM products in the same batch are added fine.
- **Likely affected files:** `src/pages/POSPage.tsx` (state shape + `onProductClick` + picker `onConfirm`), `src/components/pos/UomModal.tsx` (sequential prompting), `src/pages/POSPage.keyboard-contract.test.ts` (because `uomProduct` participates in `hasBlockingModalOpen` and `closeTopModalOnEscape`). Possibly `components/products/ProductPickerDialog.tsx` only if the contract of `onConfirm` changes (prefer NOT to change it).
- **Likely CSS classes / style areas:** None required. This is pure logic; no CSS coupling.
- **Risk level:** **High** (silent data loss + touches the just-stabilized modal/keyboard contracts).
- **Runtime behavior risk:** High — fix introduces a **queue** of pending UOM products (e.g. `uomQueue: PosProduct[]`) prompted one at a time; this changes modal open/close flow that F12 suppression and Escape close depend on.
- **CSS contamination risk:** None.
- **Business logic risk:** High in the sense that the *current* behavior loses sales lines; the fix must guarantee every selected multi-UOM product is eventually prompted and that cancel/Escape on one item does not abort the rest (define the cancel semantics explicitly).
- **Keyboard/scanner/numpad regression risk:** **High** — `uomProduct` is enumerated in `hasBlockingModalOpen` (F12 guard) and has a branch in `closeTopModalOnEscape` (Escape close, single-close priority chain). A queue must keep those contracts intact (blocking while any item is queued; Escape closes/cancels the current item deterministically without firing a Red write path).
- **Recommended slice name:** `7C-P1-L1 — Product Picker multi-UOM queue fix`.
- **Recommended validation:** new unit/contract coverage for the queue (multi multi-UOM selection prompts each in turn; mixed single/multi batch adds singles + queues multis; Escape/cancel on one item advances or aborts per defined semantics; `uomProduct`/queue still in F12 + Escape contracts); full `vitest run`; `tsc -b`; physical UAT of multi-select add-to-cart.
- **Codex review mandatory:** **Yes — stricter than UI-only slices** (logic + contract surface).
- **Isolate from other backlog items:** **Yes, absolutely.** Never bundle with UI polish.

## UI-01 Analysis

- **Problem statement:** Nested border-radius on the Sales History table header — the rounded, `overflow:hidden` `.sh-card` (SalesHistoryPage.css lines ~257-265) wraps a `.sh-table-scroll` (line ~291) containing a shared flowbite `Table` whose head has its own rounding, producing a visible nested/clipped corner.
- **Likely affected files:** `src/pages/SalesHistoryPage.css` (preferred — local override on `.sh-card` / `.sh-table-scroll` / inner table head). **Avoid** `src/components/ui/theme.ts` (shared flowbite table theme) unless unavoidable.
- **Likely CSS classes / style areas:** `.sh-card`, `.sh-table-scroll`, the flowbite `Table`/`TableHead` head radius slot.
- **Risk level:** Low–Medium.
- **Runtime behavior risk:** None.
- **CSS contamination risk:** **Medium IF the shared table theme is edited** — `Table`/`TableHeadCell` from `../ui` are reused by the Product Picker and other report tables; a theme-level radius change would regress all of them. Keep the fix scoped to `SalesHistoryPage.css`.
- **Business logic risk:** None.
- **Keyboard/scanner/numpad regression risk:** None (not on the POS page).
- **Recommended slice name:** `7C-P1-U1 — Sales History header radius`.
- **Recommended validation:** visual check on Sales History (desktop + terminal widths); confirm Product Picker and other tables visually unchanged (proves no shared-theme leak).
- **Codex review mandatory:** Yes (lightweight).
- **Isolate:** Yes (independent, trivial).

## UI-02 Analysis

- **Problem statement:** Move the hamburger / sidebar toggle to the right side of the sidebar.
- **Likely affected files:** `src/components/AppShell.tsx` (the head block, lines ~93-121, hamburger `<button>` with `ti-menu-2` + logo row).
- **Likely CSS classes / style areas:** Inline Tailwind utilities on the head flex row (`flex min-h-[44px] items-center gap-2 px-1`); button utility classes. Collapsed state currently shows only the icon rail (`Sidebar collapsed={!open}`), so right-alignment must still look correct in the narrow collapsed rail.
- **Risk level:** Medium.
- **Runtime behavior risk:** Low — `toggleSidebar` logic unchanged; only placement/order.
- **CSS contamination risk:** Low (utilities are local to AppShell head).
- **Business logic risk:** None.
- **Keyboard/scanner/numpad regression risk:** None directly; but **keyboard-accessibility / focus order** of the toggle changes (it gains/loses position in tab order) — preserve `aria-label`, `aria-expanded`, `title`.
- **Responsive/mobile risk:** Medium — collapsed icon-rail width is tight; a right-aligned toggle in a 1-icon-wide rail needs care.
- **Recommended slice name:** `7C-P1-U2 — Sidebar toggle right-align`.
- **Recommended validation:** open/close in both expanded and collapsed states, desktop + terminal; keyboard tab to the toggle and activate.
- **Codex review mandatory:** Yes.
- **Isolate:** Yes, but **sequence with UI-03** (same file/region) — do not run in parallel.

## UI-03 Analysis

- **Problem statement:** Extract "ขาย" (`/pos`) out of the `การขาย` accordion dropdown and render it as a **top-level primary** sidebar item.
- **Likely affected files:** `src/config/navigation.ts` (currently `/pos` is `NAV_CATEGORIES[0].items[0]`, lines 24-27) and `src/components/AppShell.tsx` (sidebar renders **only** `NAV_CATEGORIES` via `SidebarCollapse` accordions, lines 123-147 — there is **no existing render path for a flat top-level item**).
- **Likely CSS classes / style areas:** A new top-level `NavSidebarItem` rendered outside `SidebarCollapse`; reuse `NavSidebarItem`/flowbite `SidebarItem` styling.
- **Risk level:** Medium.
- **Runtime behavior risk:** Medium — must add a primary-item render branch without breaking `activeCategoryId()` / `isNavItemActive()` and the page-title lookup (`ALL_NAV_ITEMS` derives from `NAV_CATEGORIES`; if `/pos` moves out of categories, ensure `ALL_NAV_ITEMS` still includes it so page-title + active state resolve).
- **Active state implications:** `isNavItemActive('/pos', pathname)` is the default `pathname === path` case — fine; ensure the new top-level item uses it.
- **Permissions/role visibility:** No per-role filtering exists in the current nav config (all items shown to all roles); no permission gating to preserve, but confirm with CEO whether POS should be role-gated.
- **Whether dropdown behavior is shared:** The accordion is generic over `NAV_CATEGORIES`; pulling one item out must not leave an empty/odd `การขาย` group (it still has `ประวัติขาย`). Decide whether `การขาย` remains as a category with only Sales-History or is also restructured.
- **Recommended slice name:** `7C-P1-U3 — POS top-level nav item`.
- **Recommended validation:** POS reachable as a top-level item; active highlight correct on `/pos`; page title still resolves; `การขาย` group still sensible; other categories unaffected.
- **Codex review mandatory:** Yes.
- **Isolate:** Yes, but **pair/sequence with UI-02 and UI-04** (navigation cluster; separate commits).

## UI-04 Analysis

- **Problem statement:** Change the default post-login landing route from `/dashboard` to `/pos`.
- **Likely affected files:** `src/App.tsx` (line 62 `"/" → /dashboard`; line 118 `"*" → /dashboard`) and `src/components/GuestRoute.tsx` (line 25 non-admin authenticated redirect → `/dashboard`). Global Admins are intentionally routed to `/admin` (GuestRoute line 22-24, PosShellRoute line 11-13) — **leave admin routing unchanged** unless CEO says otherwise.
- **Likely CSS classes / style areas:** None.
- **Risk level:** Low (logic) but Medium (workflow).
- **Runtime behavior risk:** Low — `<Navigate>` target swap.
- **Impact on users without an active shift:** **Important** — `/pos` (POSPage) opens with no active shift → the OpenShiftModal flow engages immediately. Confirm this is the desired first-screen for cashiers; managers/back-office who expected `/dashboard` first will now land on POS.
- **Impact on dashboard-first workflows:** Anyone relying on dashboard as home must navigate manually; confirm acceptable.
- **Test expectations:** Update/confirm any redirect tests; assert non-admin authenticated user lands on `/pos`, admin still `/admin`.
- **Recommended slice name:** `7C-P1-U4 — Default landing route /pos`.
- **Recommended validation:** login as non-admin → lands `/pos`; admin → `/admin`; deep-link unknown path → decide `/pos` vs `/dashboard`; invalid branch still logs out to `/login` (PosShellRoute guard).
- **Codex review mandatory:** Yes (small but auth/routing).
- **Isolate:** Yes; part of the navigation cluster with UI-03.

## UI-05 and UI-06 Analysis

- **Problem statement:** Add independent dynamic font-size adjusters for the POS **Product Name** and **Price**, saved separately to device LocalStorage.
- **Likely affected files:** `src/pages/POSPage.tsx` (product card render: `.pos-prod-name` line 827, `.pos-prod-price` line 829), `src/pages/POSPage.css` (font-size rules for those classes), a **new device-local store module** (e.g. `src/lib/pos/posDisplayPrefs.ts` modeled on the existing `localStorage` patterns in `lib/pos/deviceId.ts` / `posDeviceRegistry.ts`), and a **settings/control surface** (candidates: a new control inside the existing `SortingSettingsModal`, a small POS display-settings popover in the topbar, or a settings page entry).
- **Likely CSS classes / style areas:** `.pos-prod-name`, `.pos-prod-price`, `.pos-prod-info`, `.pos-prod-bottom`, `.pos-prod-card` (card height / wrapping / touch-target interplay). Live scaling likely via CSS custom properties (e.g. `--pos-name-size`, `--pos-price-size`) set inline from the stored prefs.
- **LocalStorage keys:** two independent keys (e.g. `twinpet.pos.fontScale.name`, `twinpet.pos.fontScale.price`). **No Firebase persistence, no cross-device sync** (per spec).
- **Default values / min-max:** define explicit defaults (current sizes) and clamped min/max to protect layout and touch targets; reject out-of-range.
- **Risk level:** Medium.
- **Runtime behavior risk:** Low–Medium (new state/effect; must not interfere with the product grid render path used by the stabilized scan-add flow).
- **CSS contamination risk:** Medium — larger fonts can overflow the card, break the price/stock row, or shrink effective touch targets; verify wrapping/ellipsis behavior.
- **Business logic risk:** None (display-only).
- **Keyboard/scanner/numpad regression risk:** Low — does not touch the search input, scan handler, or numpad; but it edits the POS page, so re-run the keyboard-contract suite to prove no drift.
- **Recommended slice name:** `7C-P1-U5 — POS product-grid font-size prefs` (covers UI-05 + UI-06 together; they are paired by spec).
- **Recommended validation:** adjust each size independently; persists across reload (same device); does not sync across devices; layout/touch-target sanity at min and max; keyboard-contract suite green.
- **Codex review mandatory:** Yes.
- **Isolate:** Yes (UI-05 and UI-06 implemented together as one paired slice).

## UI-07 Analysis

- **Problem statement:** Redesign the POS Category Search Modal from large buttons to a clean, searchable **List View**.
- **Likely affected files:** `src/pages/POSPage.tsx` (category modal markup, lines 1215-1274 — `.pos-category-overlay` / `.pos-category-modal` / `.pos-category-grid` / `.pos-category-cell`) and `src/pages/POSPage.css` (those classes). **It already has a search input** (`.pos-picker-search`, lines 1233-1240) and live filtering (lines 1254-1270), so this is primarily a **grid-of-buttons → list rows** restructure (CSS-heavy, light markup).
- **Likely CSS classes / style areas:** `.pos-category-grid` → list container; `.pos-category-cell` → list row; keep `.active` selected styling and the `ทั้งหมด` (All) row.
- **Risk level:** Low–Medium.
- **Runtime behavior risk:** Low — selection handlers (`setActiveCategory` + `closeCatModal`) unchanged; only presentation.
- **CSS contamination risk:** Low–Medium — `pos-category-*` classes are POS-namespaced; keep changes within them. (Heed the project's CSS-namespace memory: do not collide prefixes.)
- **Business logic risk:** None (category filtering logic untouched).
- **Keyboard/scanner/numpad regression risk:** Low — the modal already participates in `closeCatModal`/focus-return and `catModalOpen` is in the F12 blocking predicate; preserve those. The modal's own search input (`autoFocus`) must not steal/break POS scan focus on close (existing `closeCatModal` returns focus).
- **Responsive risk:** Medium — list rows must remain touch-friendly on the terminal.
- **Recommended slice name:** `7C-P1-U7 — Category modal list view`.
- **Recommended validation:** search-filter still works; All + category selection still filters the grid; focus returns to POS search on close; F12 still suppressed while open; touch sizing on terminal.
- **Codex review mandatory:** Yes.
- **Isolate:** Yes (POS-local; keep separate from UI-05/06 even though both touch POSPage).

## UI-08 Analysis

- **Problem statement:** Relocate the **Offline status tag** and **Sync button** to the top-right header (same row as the Branch name) to maximize the search-bar flex-grow space; rename the Sync button to `🔄 ซิงค์ข้อมูล`. The Sort button stays put.
- **Current locations:**
  - Offline tag: POSPage topbar — the `fromCache` flowbite `Badge` "ออฟไลน์ (ใช้ข้อมูลในเครื่อง)" inside `.pos-search-group` (POSPage.tsx lines 686-690).
  - Sync indicator: `<SyncIndicator branchId={branchId} />` in `.pos-search-group` (line 685) — this is an **automatic** pending-count indicator, not a button.
  - The closest thing to a manual "Sync button" is the **"อัปเดตข้อมูลหน้าจอ"** refresh link (`handleManualRefresh`, lines 672-684). **Ambiguity: which control is "the Sync button" to rename to `🔄 ซิงค์ข้อมูล`?** Needs CEO confirmation.
  - The "Branch name row" (`สาขา{branchDisplay}`) is in the **global `AppShell` header** (AppShell.tsx lines 184-199), NOT in the POSPage topbar.
- **Structural ambiguity (key hidden risk):** The search bar lives in **POSPage**; the Branch-name row lives in **AppShell**. Honoring "same row as Branch name" literally means **hoisting POS-only sync/offline state into the shell header** — a cross-component coupling (SyncIndicator needs `branchId`; offline `fromCache` is POS data state). The alternative interpretation is a **POSPage-local** top-right cluster. These are materially different blast radii. **Do not implement until the CEO picks an interpretation.**
- **Likely affected files:** `src/pages/POSPage.tsx` + `src/pages/POSPage.css` (POSPage-local interpretation), **and/or** `src/components/AppShell.tsx` + lifting `SyncIndicator`/offline state (shell interpretation).
- **Likely CSS classes / style areas:** `.pos-topbar`, `.pos-search-group`, `.pos-topbar-search` (flex-grow), `.pos-sync-indicator*`; AppShell header utilities.
- **Risk level:** **High** (cross-component + ambiguity).
- **Runtime behavior risk:** Medium–High — moving `SyncIndicator` must not change its bounded listener semantics; offline `Badge` depends on `fromCache && products.length > 0`.
- **CSS contamination risk:** Medium — search-bar flex-grow rebalancing can shift the whole topbar; AppShell header is shared by every page (a shell change affects all routes).
- **Business logic risk:** Offline/sync **behavior must not change** — display/placement only.
- **Status visibility risk on small screens:** Medium — crowding the Branch-name row on the terminal may truncate the offline tag/sync count; verify.
- **Keyboard/scanner/numpad regression risk:** Low for behavior, but it edits the POS topbar around the search input — re-run the keyboard-contract suite.
- **Recommended slice name:** `7C-P1-U8 — Offline/Sync header relocation` (blocked on CEO clarification).
- **Recommended validation:** offline tag appears only when `fromCache`; sync indicator counts unchanged; search bar visibly wider; Sort button unmoved; terminal-width visibility; keyboard-contract suite green.
- **Codex review mandatory:** Yes (and design sign-off first).
- **Isolate:** Yes; **do last**, and after UI-02/UI-03 if it touches AppShell (same header/sidebar surface).

## File / CSS Risk Map

| Item | Primary runtime file(s) | Primary CSS | Shared-surface hazard |
|------|------------------------|-------------|-----------------------|
| LOGIC-01 | `POSPage.tsx`, `pos/UomModal.tsx` | — | **Keyboard/Escape/F12 contracts** (`POSPage.keyboard-contract.test.ts`) |
| UI-01 | `SalesHistoryPage.tsx` (markup minimal) | `SalesHistoryPage.css` | **`components/ui/theme.ts`** shared flowbite Table (avoid) |
| UI-02 | `AppShell.tsx` | inline Tailwind | AppShell shared by all routes |
| UI-03 | `config/navigation.ts`, `AppShell.tsx` | inline Tailwind | `ALL_NAV_ITEMS` / active-state derivation; AppShell shared |
| UI-04 | `App.tsx`, `GuestRoute.tsx` | — | Auth/redirect for all users |
| UI-05/06 | `POSPage.tsx`, new `lib/pos/posDisplayPrefs.ts`, settings control | `POSPage.css` (`.pos-prod-*`) | POS product grid (near stabilized scan-add) |
| UI-07 | `POSPage.tsx` (category modal) | `POSPage.css` (`.pos-category-*`) | POS namespace; modal focus/F12 contract |
| UI-08 | `POSPage.tsx` and/or `AppShell.tsx`, `SyncIndicator.tsx` | `POSPage.css` (`.pos-topbar`, `.pos-sync-*`), AppShell header | **Cross-component**; AppShell shared by all routes |

## Cross-slice Dependency Map

- **Navigation cluster — UI-04 + UI-03** (and partly UI-02): landing route + promoting POS to top-level are conceptually linked; keep as separate commits but plan together.
- **AppShell sidebar contention — UI-02 ↔ UI-03**: both edit the sidebar head/structure; serialize to avoid merge churn and conflicting layout assumptions.
- **AppShell header contention — UI-08 (shell interpretation) ↔ UI-02/UI-03**: if UI-08 hoists sync/offline into the shell header, it overlaps the same surface as the sidebar/header work; do UI-08 after the nav items settle.
- **POSPage contention — UI-05/06 ↔ UI-07 ↔ UI-08(POS interpretation)**: all edit `POSPage.tsx`/`POSPage.css`; serialize and re-run the keyboard-contract suite after each.
- **Contract surface — LOGIC-01** shares `POSPage.keyboard-contract.test.ts` with the stabilized suite; do it in isolation so any contract churn is attributable.
- **Shared table theme — UI-01** must avoid `components/ui/theme.ts` to prevent coupling with Product Picker / report tables.

## Recommended Priority Order

The authorized list order (UI-01…UI-08) is **not** the recommended implementation order. Recommended order, by safety / blast-radius / business value / UAT ease, with LOGIC-01 deliberately placed:

1. **LOGIC-01** (`7C-P1-L1`) — only correctness/data-loss bug; do first, in isolation, with the strictest Codex review, while the modal contracts are fresh. *(If the multi-select picker→cart path is not yet used in production, it may instead immediately follow UI-04; but it must never be bundled with UI polish.)*
2. **UI-04** (`7C-P1-U4`) — tiny, isolated routing change; high cashier value (land on POS); trivial UAT.
3. **UI-03** (`7C-P1-U3`) — POS as top-level nav; complements UI-04; contained to nav config + AppShell.
4. **UI-02** (`7C-P1-U2`) — sidebar toggle relocation; same AppShell region as UI-03, so right after it.
5. **UI-01** (`7C-P1-U1`) — isolated Sales-History CSS; no POS exposure; quick win.
6. **UI-07** (`7C-P1-U7`) — POS category modal to list view; POS-local CSS; moderate.
7. **UI-05/06** (`7C-P1-U5`) — POS font-size prefs + LocalStorage + settings control; layout/touch-target care.
8. **UI-08** (`7C-P1-U8`) — **last**; highest risk + unresolved ambiguity (shell vs POS-local; which control is "Sync"); requires CEO clarification and design sign-off before coding.

## Slice-by-slice Implementation Plan

Each slice is its own branch-less working set → tests → Codex review → Tech Lead closure → single commit. No two slices share a commit.

1. **7C-P1-L1 — Product Picker multi-UOM queue fix**
   - Replace the single `uomProduct` slot with a pending **queue** (`uomQueue: PosProduct[]`) or equivalent; `onProductClick`/picker `onConfirm` enqueue multi-UOM products and add single-UOM directly; UomModal prompts the head of the queue, advancing on select/cancel with explicitly defined cancel semantics.
   - Keep `uomProduct`/queue in `hasBlockingModalOpen` (F12) and `closeTopModalOnEscape` (Escape single-close, no Red write).
   - Tests: queue behavior + preserved keyboard contracts; full `vitest run`; `tsc -b`.

2. **7C-P1-U4 — Default landing route /pos**
   - Swap `<Navigate>` targets in `App.tsx` (lines 62, 118) and `GuestRoute.tsx` (line 25) for non-admins; leave admin → `/admin`. Decide `*` fallback (`/pos` vs `/dashboard`).

3. **7C-P1-U3 — POS top-level nav item**
   - Add a flat top-level render path in `AppShell.tsx`; adjust `config/navigation.ts` so `/pos` is primary while `ALL_NAV_ITEMS`/active-state still resolve; keep `การขาย` group coherent.

4. **7C-P1-U2 — Sidebar toggle right-align**
   - Reposition the hamburger button within the AppShell head row for both expanded and collapsed states; preserve `aria-*`/title and keyboard activation.

5. **7C-P1-U1 — Sales History header radius**
   - Local `SalesHistoryPage.css` fix on `.sh-card`/`.sh-table-scroll`/inner table head; verify Product Picker + report tables unchanged (no shared-theme edit).

6. **7C-P1-U7 — Category modal list view**
   - Restructure `.pos-category-grid`/`.pos-category-cell` to list rows in POSPage + POSPage.css; keep search filter, All row, selection, focus-return, F12 suppression.

7. **7C-P1-U5 — POS product-grid font-size prefs (UI-05 + UI-06)**
   - New `lib/pos/posDisplayPrefs.ts` (two independent LocalStorage keys, defaults, clamped min/max); settings control; live scale via CSS vars on `.pos-prod-name`/`.pos-prod-price`; verify layout/touch targets; keyboard-contract suite green.

8. **7C-P1-U8 — Offline/Sync header relocation** *(blocked)*
   - After CEO confirms (a) shell-header vs POS-local placement and (b) which control is the "Sync button". Then relocate offline `Badge` + sync control, widen search flex-grow, rename to `🔄 ซิงค์ข้อมูล`, keep Sort in place, preserve sync/offline behavior; re-run keyboard-contract suite.

## Forbidden Areas

This planning phase modified only: `Context.md`, `Task.md`, `docs/reports/phase-7c-p1-ui-polish-backlog-triage.md`. No implementation was performed. For the implementation phases that follow, each slice must continue to avoid out-of-scope writes (checkout/payment/cart write-paths, UOM **scan routing** in `findByScanCode`, offline queue/IndexedDB, manual-review/evidence, Firebase rules/Functions, LAN/emulator config, Android/Capacitor, `.claude/`, and `stash`). LOGIC-01 may touch UOM **add-to-cart prompting** but must not alter UOM **scan routing** or pricing.

## Test / Build Strategy

- Every slice: `npx.cmd tsc -b` clean + `npx.cmd vitest run` green, plus the targeted `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` whenever the slice edits `POSPage.tsx`/`AppShell` POS surfaces (UI-02, UI-03, UI-05/06, UI-07, UI-08, LOGIC-01).
- LOGIC-01: add explicit queue/contract coverage; treat the keyboard-contract suite as a regression gate for the stabilized POS suite.
- UI-01: rely on visual verification (no test infra for CSS radius) + a manual check that shared tables are unaffected.
- UI-04: assert redirect targets (non-admin → `/pos`, admin → `/admin`).
- UI-05/06: verify persistence and the no-cross-device-sync requirement.

## Codex Review Strategy

- **Mandatory Codex GPT-5.5 High review on every slice** before Tech Lead closure/commit (consistent with the D4 cadence).
- **LOGIC-01 gets the strictest review** (logic + modal/keyboard contracts + data-loss semantics).
- **UI-08 requires design sign-off + ambiguity resolution before code**, then standard review.
- UI-01/UI-02/UI-03/UI-04/UI-07 are lighter UI reviews focused on scope containment and shared-surface safety.

## Risk Assessment

- **High:** LOGIC-01 (data loss + contract surface), UI-08 (cross-component + ambiguity).
- **Medium:** UI-02, UI-03 (shared AppShell), UI-05/06 (layout/touch + new persistence).
- **Low–Medium:** UI-01 (shared table theme trap), UI-07 (POS modal CSS).
- **Low:** UI-04 (mechanical, but workflow-affecting).

## Hidden Risks

1. **LOGIC-01 cancel semantics:** define whether Escape/cancel on one queued UOM item aborts only that item or the whole batch; ambiguity here can re-introduce silent drops.
2. **UI-08 location ambiguity:** "same row as Branch name" maps to the **global AppShell header**, not the POS topbar — easy to mis-scope into a cross-component change.
3. **UI-08 "Sync button" identity:** there is no control literally named "Sync"; the auto `SyncIndicator` vs the manual "อัปเดตข้อมูลหน้าจอ" refresh link must be disambiguated before renaming to `🔄 ซิงค์ข้อมูล`.
4. **UI-01 shared theme leak:** editing `components/ui/theme.ts` would silently restyle the Product Picker and every report table.
5. **UI-03 nav derivation:** `ALL_NAV_ITEMS` and active-state/page-title all derive from `NAV_CATEGORIES`; moving `/pos` out can break the page title or active highlight if not kept in the derived set.
6. **UI-04 shift workflow:** landing non-admins on `/pos` triggers the open-shift flow first; back-office users lose dashboard-first.
7. **UI-05/06 touch targets:** large font scales can shrink effective tap areas / overflow cards on the terminal.
8. **POSPage contention:** UI-05/06, UI-07, and UI-08(POS interpretation) all edit POSPage; serialize and re-gate the keyboard-contract suite each time.
9. **CSS namespace collisions:** per the project's CSS-namespace memory, keep new classes uniquely prefixed (POS = `pos-`, Sales History = `sh-`) to avoid global-bundle prefix collisions.

## Final Recommendation

Proceed in the recommended order: **LOGIC-01 first (isolated, strict review)**, then the trivial navigation/routing wins (UI-04, UI-03, UI-02), then isolated CSS (UI-01, UI-07), then the POS font-size feature (UI-05/06), and finally the high-risk, ambiguity-blocked UI-08. Keep each slice in its own commit with mandatory Codex review, re-run the keyboard-contract suite on every POS-touching slice, resolve the UI-08 interpretation/"Sync button" identity with the CEO before coding it, and never bundle LOGIC-01 with UI polish. No implementation is authorized by this plan — Phase 7C-P1 is planning-only and must pass Codex review before any slice begins.
