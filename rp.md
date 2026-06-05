 Duplicate-key warning on /admin/transfers — FIXED ✅

  The actual root cause (not the branch filter)

  I investigated before patching, and the branch dropdown turned out to be a red herring — it renders only ["", "LDP-001"], no duplicates. Capturing the full React
  error revealed the duplicate key value was none.

  The real source: AdminTransferPage renders two modals as siblings, each using the "remount-on-target-change" key idiom with a shared fallback:
  <TransferCancelDialog key={cancelTarget?.id ?? 'none'} … />
  <TransferEditModal    key={editTarget?.id ?? 'none'} … />
  When the page is idle (both targets null) — i.e. on every initial load — both siblings get key="none", so React warns "two children with the same key: none" (×3
  across the mount + two async-load re-renders).

  The fix

  Type-prefixed the fallback keys so a collision is impossible, while preserving the remount-on-id-change behavior:
  key={`cancel-${cancelTarget?.id ?? 'none'}`}
  key={`edit-${editTarget?.id ?? 'none'}`}

  Scope check (per your request)

  - AdminTransferCreatePage and AdminReceivingPage: grep found zero ?? 'none' key patterns — they don't share this bug, nothing to change.
  - TransferHistoryPage: had the same fragile idiom (one cancelTarget?.id ?? 'none') but wasn't currently colliding (its only other modal sibling is unkeyed). I       
  hardened it to cancel-${…} anyway to prevent a latent regression if an edit modal is ever added.

  So the dedup approach you suggested wasn't needed — the branch list was never the problem.

  Verification

  - tsc -b clean, vite build green.
  - Headless console probe on both /admin/transfers and /inventory/transfer/history: dupKey=0, otherErrors=0 — console completely clean.
  - Throwaway probe scripts removed; dev server still running.

  Ready to move on to the UOM Searchable Dropdown feature whenever you are.

✻ Sautéed for 3m 57s · 1 shell still running