# Phase 7C-C1-0 — CSS Namespace Isolation Audit (read-only)

> **Status:** Read-only audit deliverable. No CSS/selector/class edits were made. No implementation performed from these findings.
> **Authorization:** Tech Lead / CEO — Option C (parallel with 7C-C2 TSX-only polish).
> **Baseline:** HEAD `99836c1`; `stash@{0}` present and untouched.

## Purpose

Map CSS namespace ownership and coupling across Admin / Inventory / Report screens so future visual-consistency polish can be sequenced **without** the documented prefix-collision failure mode (the historical `sup-`→`asup-` fix) and without rippling into protected or write-path pages.

## Method (read-only)

- `import '...css'` map across `src/pages/**/*.tsx`.
- Prefix-definition scan (`^\.<prefix>-`) across `src/pages/**/*.css`.
- Write-indicator scan (`setDoc`/`updateDoc`/`deleteDoc`/`writeBatch`/`runTransaction`/`DANGER`/`FACTORY_RESET`/`HARD_DELETE`…) to flag write-path consumers.

## Key structural finding

Coupling in this codebase is driven primarily by **shared stylesheet imports**, not only by accidental prefix collisions. Admin pages routinely `import` a sibling page's `.css` (e.g. `AdminDashboardPage` imports `../DashboardPage.css`). Therefore editing one stylesheet — or adding a same-prefix rule — **restyles every page that imports it**. Several shared stylesheets are imported by **protected (H7-F)** or **write-path** pages, which raises the stakes well beyond cosmetics.

## Global / shared layer (highest blast radius)

| File | Role | Consumers | Risk |
|------|------|-----------|------|
| `src/index.css` | Global: Tailwind + flowbite plugin + `@theme` design tokens (primary palette, fonts) + layout-critical `html/body/#root` | Entire app | **Critical** — any `@theme`/global edit ripples app-wide |
| `src/styles/variables.css` | Design tokens (`--p600`, `--success`, `--text-muted`, `--g50`, …) referenced via `var(--…)` and `bg-[var(--…)]` everywhere | Entire app | **Critical** — token change is global |
| `src/App.css` | Empty (reserved) | — | None |

## Per-namespace map

| Namespace | Defined in | Consumed by (TSX) | Sharing / collision risk | Recommendation |
|-----------|-----------|-------------------|--------------------------|----------------|
| `dash-` | `DashboardPage.css` | `DashboardPage` (own); **`AdminDashboardPage`** (imports `../DashboardPage.css`, no own CSS) | **Shared across 2 pages.** Editing `dash-*` restyles both. AdminDashboard is 100% `dash-` + inline styles. | If AdminDashboard needs divergent polish, fork an `adash-` prefix + dedicated stylesheet (mirror the `sup-`→`asup-` fix). Until then, treat `dash-` as shared/locked. |
| `sr-` | `StockReportPage.css` **and** `AllBranchesStockOverview.css` (extends `sr-*`) | `StockReportPage` (own); **`AllBranchesStockOverview`** (imports `../StockReportPage.css` + own); `AdminStockReportPage` (indirect via children) | **Shared across ≥2 pages AND extended in a second file** → highest accidental-collision surface among report styles. | Consolidate `sr-` ownership; if AllBranches needs divergence, move its additions to a dedicated `absr-`/`abso-` prefix instead of extending `sr-`. |
| `asr-` / `asr-bsel-` | `AdminStockReportPage.css` | `AdminStockReportPage` (own); **`AsrBranchSelector`** (`asr-bsel-*`, no own CSS) | Admin-exclusive family (low external collision), but `AsrBranchSelector` depends on `AdminStockReportPage.css`. | Keep as a cohesive ASR family; if the selector grows, give it its own `asrbsel-` stylesheet. Low priority. |
| `asup-` | `AdminSupplierManagementPage.css` | `AdminSupplierManagementPage` (also imports `../CustomerPage.css`) | The historical de-collision of `sup-`. Now also coupled to `CustomerPage.css`. | Already isolated (good). Watch the `CustomerPage.css` coupling separately. |
| `sup-` | `SupplierPage.css` | `SupplierPage` | Historical collision with AdminSupplier — **already resolved** via `asup-`. | No action; keep. |
| `sh-` | `SalesHistoryPage.css` | `SalesHistoryPage` (direct); **transitively every importer of `ReceivingHistoryPage.css`** — which `@import`s `SalesHistoryPage.css` — i.e. `ReceivingHistoryPage`, `AdminReceivingPage`, **`AdminTransferPage` (PROTECTED H7-F)**, **`TransferHistoryPage` (PROTECTED H7-F)** | **NOT isolated — shared / H7-F adjacent.** `ReceivingHistoryPage.css:1` does `@import './SalesHistoryPage.css';`, so `sh-*` rules are pulled into the receiving-history bundle that **both protected transfer/reversal pages** load. Editing `sh-*` can visually regress H7-F surfaces. | **Do NOT touch `SalesHistoryPage.css` (or `ReceivingHistoryPage.css`) in broad polish.** Treat `sh-*` as protected via indirect H7-F coupling; any cleanup must be a dedicated isolation pass with H7-F reviewer gates. |
| `inv-adj-` | `InventoryAdjustmentPage.css` | `InventoryAdjustmentPage`; **`AdminTransferCreatePage`** (imports `../inventory/InventoryAdjustmentPage.css`); **`BranchTransferPage`** (imports `./InventoryAdjustmentPage.css`) | **Shared across 3 WRITE-PATH pages** (stock adjustment + 2 transfer-create flows). | **Do NOT touch during polish.** Any `inv-adj-` edit restyles three stock/transfer write-path forms. Requires per-page fork + write-path-aware review before any change. |
| `ss-` | `SortingSettingsPage.css` | `SortingSettingsPage`; **`QuickMenuSettingsPage`** (imports `./SortingSettingsPage.css`); **`src/components/pos/SortingSettingsModal.tsx`** (imports `../../pages/admin/SortingSettingsPage.css`) | **NOT settings-only — shared with POS-embedded UI.** A POS component consumes `ss-*`, so `ss-*` edits can affect POS-adjacent / POS-embedded UI, not just the two settings pages. | Treat `ss-*` as POS-adjacent. Decouple `qm-` from `ss-` carefully, and **any `ss-*` cleanup must account for `SortingSettingsModal.tsx` and POS-embedded UI behavior** (verify in the POS surface, not just settings). |
| `qm-` | `QuickMenuSettingsPage.css` | `QuickMenuSettingsPage` (layered on top of `ss-`) | Layered prefix; depends on `ss-` import. | Keep `qm-` as the page-exclusive layer; plan to decouple from `ss-`. |

## Shared stylesheets imported by protected / write-path pages (escalated risk)

| Shared stylesheet | Imported by | Why escalated |
|-------------------|-------------|---------------|
| `ReceivingHistoryPage.css` | `ReceivingHistoryPage`, **`AdminTransferPage` (PROTECTED H7-F)**, `AdminReceivingPage`, **`TransferHistoryPage` (PROTECTED H7-F)** | A single stylesheet underpins **both** protected transfer/reversal pages — any edit can visually regress H7-F surfaces. **Highest coupling risk.** It also `@import`s `SalesHistoryPage.css` (see next row), so `sh-*` rules ride into the same protected bundle. |
| `SalesHistoryPage.css` (`sh-*`) | `SalesHistoryPage` (direct); **transitively** `ReceivingHistoryPage`, `AdminReceivingPage`, **`AdminTransferPage` (PROTECTED H7-F)**, **`TransferHistoryPage` (PROTECTED H7-F)** via `ReceivingHistoryPage.css:1 @import './SalesHistoryPage.css';` | **NOT isolated.** `sh-*` reaches both protected H7-F surfaces through the `@import` chain → editing it can regress transfer/reversal UI. Protected-adjacent. |
| `InventoryAdjustmentPage.css` | `InventoryAdjustmentPage`, `AdminTransferCreatePage`, `BranchTransferPage` | Three write-path/form pages share `inv-adj-`. |
| `SortingSettingsPage.css` (`ss-*`) | `SortingSettingsPage`, `QuickMenuSettingsPage`, **`src/components/pos/SortingSettingsModal.tsx` (POS-embedded)** | A POS component consumes `ss-*`; edits can affect POS-adjacent UI, not just settings pages. |
| `ReceivingPage.css` | `ReceivingEditPage`, `AdminReceivingPage` | Receiving write-path coupling. |
| `ProductCRUDPage.css` | `ProductCRUDPage`, `AdminProductManagementPage` | Product CRUD coupling. |
| `CustomerPage.css` | `CustomerPage`, `AdminSupplierManagementPage` | Cross-domain reuse (customer styles in supplier admin). |
| `StaffManagementPage.css` | `StaffManagementPage`, `AdminStaffManagementPage` | Staff coupling. |
| `SettingsPage.css` | `SettingsPage`, `TierManagementPage` | Settings coupling. |

## Safe-to-isolate vs migration-required

- **Safe / low effort (single consumer):** `sup-` (Supplier), `asup-` (already isolated). These can be polished independently with minimal collision risk. *(`sh-` was previously listed here — REMOVED; see below.)*
- **Migration-required before CSS-level polish (multi-consumer / shared imports):** `dash-`, `sr-`, `inv-adj-`, `ss-`/`qm-`, and the shared stylesheets above — each needs a per-page prefix fork (new prefix + dedicated stylesheet, consumer re-pointed) before its visuals can change without rippling. Note `ss-`/`qm-` migration must also account for the **POS-embedded** consumer `SortingSettingsModal.tsx`.
- **Do-not-touch without write-path / protected review:** `inv-adj-` (3 write paths); `ReceivingHistoryPage.css` (2 protected H7-F pages); and **`sh-` / `SalesHistoryPage.css`** — protected-**adjacent** because `ReceivingHistoryPage.css` `@import`s it, so `sh-*` reaches both protected H7-F transfer/reversal pages. Any `sh-*` cleanup requires a dedicated isolation pass with H7-F reviewer gates.

## Recommended future sequencing (for separate authorization — NOT executed here)

1. **Isolation pass A (low risk):** fork `adash-` from `dash-` for AdminDashboard, and an `abso-`/`absr-` prefix for AllBranchesStockOverview's `sr-` additions, so the two read-only admin dashboards can be polished without touching the non-admin originals.
2. **Isolation pass B:** decouple `qm-` from `ss-` **while verifying the POS-embedded consumer `src/components/pos/SortingSettingsModal.tsx`** (any `ss-*` change must be checked in the POS surface, not just the settings pages); isolate the Admin↔non-admin CSS-import pairs (Product, Staff, Supplier/Customer, Settings/Tier) so admin polish never restyles the operator page.
3. **Quarantine:** leave `inv-adj-`, `ReceivingHistoryPage.css`, **and `sh-` / `SalesHistoryPage.css`** untouched until a dedicated, write-path-aware / H7-F-aware slice is authorized with explicit catch-site and write-path safeguards. (`SalesHistoryPage.css` is `@import`ed by `ReceivingHistoryPage.css`, which both protected H7-F pages load.)
4. **Global tokens (`index.css`/`variables.css`):** defer entirely until the parked Flowbite-migration `stash@{0}` is resolved; a token change is the single highest-ripple action in the app.
5. Only **after** the relevant isolation pass should CSS-level visual-consistency polish proceed, per page, each Codex-reviewed.

## Implication for Phase 7C-C2 (TSX-only polish)

The three C2 targets are dominated by legacy CSS:

- **`AdminDashboardPage`** — 100% `dash-` (shared) + inline styles + chart.js; **no safe Tailwind-utility surface** (utilities beside `dash-` would risk the warned density/wrap/overflow regressions and only the shared layout governs spacing).
- **`AdminStockReportPage`** — a thin `asr-` wrapper that delegates to children; **no standalone visual surface** to polish TSX-only.
- **`AllBranchesStockOverview`** — metric/chart areas are `sr-` (shared/locked); only its low-stock **table region is already Flowbite + Tailwind** and is already consistent.

Conclusion: under the strict TSX-only / Tailwind-utility-only / no-CSS / no-`dash-`-`sr-`-`asr-` constraints, there is **no safe, non-regressive, non-churn polish surface** on these three pages today. Meaningful visual consistency for them requires Isolation pass A (above) first.
