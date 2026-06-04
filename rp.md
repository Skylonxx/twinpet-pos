 All 8 files migrated to Flowbite, build green, and screenshot-verified (0 runtime console errors). Executed in 3 cautious sub-chunks.

  What shipped

  4b-1 — pc-* group
  - ProductCRUDPage main list, ProductDrawer history (pc-hist-table), FifoBatchModal (pc-fifo-table) → Flowbite <Table>.
  - ⚠️ Critical shared-CSS save: AdminProductManagementPage (a 4f file) shares pc-table-scroll/pc-table/pc-sort-icon, so I kept all that CSS and only dropped the
  class from ProductCRUDPage's markup. Its table styling was descendant-scoped under .pc-table-scroll, so I swapped that wrapper for Tailwind (flex-1 min-h-0
  overflow-auto) — selected/checked rows, the flash animation (reusing the kept pc-fl keyframe), and right-alignment reimplemented via Tailwind.
  - Purged only batch-exclusive rules (.pc-hist-table, .pc-fifo-table) + dead .pc-tier-table (no consumer). Kept content helpers (pc-lot-*, pc-batch-cost-*,
  pc-h-in/out, pc-fifo-table-wrap).

  4b-2 — cm-tier-table
  - CategoryManagementModal + TierManagementModal → Flowbite; purged .cm-tier-table descendant rules, kept the bordered wrap + cm-tier-id/cm-tier-default-tag.     

  4b-3 — the pricing trio (your top concern)
  - TierPriceManagerDialog (tpmd-table) — the number input lives in a separate adjust sub-dialog, left fully untouched.
  - ProductPickerDialog (bare <table> under .pps-overlay) — purged the element-descendant rules that would've matched the Flowbite table; selected-row
  reimplemented as bg-[#f0fff8].
  - PriceLevelManager (stg-price-table) — inline value/onChange input cells preserved exactly.

  Visual verification (Read the PNGs, not node counts)

  ┌─────────────────────┬──────────────────────────────────────────────────────────────────────────┐
  │     Screenshot      │                                  Result                                  │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ /products list      │ ✅ sort arrows, badges, right-aligned prices, UOM sub-rows, stock badges │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ Product Picker      │ ✅ checkbox col, thumbnails, badges, footer                              │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ Tier Price grid     │ ✅ 5 tiers, working ปรับbuttons, drawer form bindings intact             │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ PriceLevelManager   │ ✅ inline name/desc inputs populated with data                           │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ TierManagementModal │ ✅ code badges + "ค่าเริ่มตtag                                           │
  ├─────────────────────┼──────────────────────────────────────────────────────────────────────────┤
  │ Drawer history      │ ✅ -1 rendered red (pc-h-out)                                            │
  └─────────────────────┴──────────────────────────────────────────────────────────────────────────┘

  One stumble: my CSS purge comment pc-lot-*/pc-batch-cost-* contained */ and closed the comment early (the same gotcha as 4a-1) — caught by the build, reworded,  
  green.

  Cleaned up: emulator + vite stopped, ports freed. Roadmap memory updated.

  Not yet authorized: 4c (Inventory/Transfers), 4d (Receiving/Reports/Dashboard), 4f (remaining Admin pages incl. AdminProductManagementPage — which still uses the
  pc-table CSS I deliberately preserved). Standing by for your next GO.

✻ Cogitated for 21m 24s
