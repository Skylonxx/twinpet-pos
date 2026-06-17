# Developer Report

## Phase

**7C-UI-04-SYNC-AND-MACRO-LAYOUT** — Category Sync and Product/Grid–Cart Macro Layout Polish

## 1. Summary

Three scoped changes per the corrected directive: (A) aligned the left product/grid area's top edge with the right cart panel and turned the inter-panel gap into one intentional, premium gutter (CSS); (B) closed the category-sync render blindspot — category tabs are now sourced from the categories collection too, so a newly-added category renders after a Refresh (the update bell already glows catalog-wide); (C) made the category tab bar robustly horizontally scrollable. The **Select Customer dashed border was NOT touched** (now explicitly acceptable). UI-03 focus recovery and all keyboard/scanner contracts preserved. **AGY visual review required before Codex.**

## 2. Preflight Status and HEAD Confirmation

- `git status --short` before start: **clean** ✅
- `git log --oneline -5` top commit: `ce49a82 style(pos): polish refresh update state and focus recovery` ✅ (matches expected baseline)
- `stash@{0}` present and untouched ✅
- Did not start UI-04 on top of uncommitted work.

## 3. Files Changed

| File | Action | Description |
|---|---|---|
| `src/pages/POSPage.tsx` | Modified | `visibleCategories` memo now merges product categories + the categories collection (`richCategories`), deduped + branch-gated (B). |
| `src/pages/POSPage.css` | Modified | `.pos-cart` top margin → 0 (aligns with category bar) + consistent gutter (A); `.pos-cat-bar` robust horizontal scroll (`flex-wrap: nowrap` + `scrollbar-width: none`) (C). |
| `src/pages/POSPage.keyboard-contract.test.ts` | Modified | Added `7C-UI-04-SYNC-AND-MACRO-LAYOUT` describe block (3 tests). |

`useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, checkout/payment, stock matrix, seed, Toast, Firebase, Android, `.claude/` — untouched. **Select Customer button (`.pos-cust-pick`) untouched** (verified `git diff` has no `cust-pick` hunk).

## 4. CURRENT_PACKET.md Update Confirmation

`docs/agent-workflow/CURRENT_PACKET.md` updated for `7C-UI-04-SYNC-AND-MACRO-LAYOUT` with the goal, corrected CEO UAT summary (Select Customer border NOT to be touched), **all three directives A/B/C**, the AGY review requirement (mandatory before Codex), role sequence (Developer → AGY → Codex → Tech Lead/CEO), explicit role files, and a note on the authorized data/subscription helper (none needed changing). ✅

## 5. Implementation Details (A / B / C)

### A — Macro layout: Grid vs Cart alignment & gap (CSS)
The cart (`.pos-cart`) had `margin: 8px 8px 8px 0` → its top sat 8px below the left category bar (jagged top) and the left edge touched the product area (no clean seam). Changed to `margin: 0 8px 8px 8px`:
- **Top = 0** → the cart's top edge (and its 64px `.pos-cust-bar` / Select-Customer header) aligns **exactly** with the 64px `.pos-cat-bar` on the left. Top boundaries now line up; because both header bars are 64px, their bottoms align too.
- **Left/right/bottom = 8px** → one consistent gutter of the g50 surface frames the cart, so the gap reads as an intentional seam between two architectural zones (not an exposed sliver). The cart keeps its `border` + `box-shadow` + `border-radius`, so the premium floating feel is intact.

### B — Category sync blindspot (TSX)
- **Detection (already correct, documented):** `usePosSyncSignal` reads the branch's catalog-wide `sync_state.lastForceUpdate` bell. This is generic — it fires for ANY admin broadcast (product OR category), so the Refresh glow / auto-refresh already covers category changes. `handleManualRefresh` → `refreshInventory()` → `getInventorySnapshot()` already re-fetches the categories collection. No listener change was needed (changing a correct generic listener would be redundant/risky).
- **Render (the actual POS-side gap — fixed):** `visibleCategories` was derived from product categories only, so a category **added** in admin (with no products yet) never appeared as a tab even after a refresh. The memo now builds the tab list from **both** the product category strings **and** `richCategories` (the categories collection), deduped by the canonical filter key, then still applies `getVisibleCategories` (branch visibility) + `sortCategories` (branch order). So new/modified categories render after a Refresh; hidden categories stay hidden.
- **Out of POS scope (documented):** if the admin category editor does not call `broadcastInventoryUpdate` after a category edit, that admin-side write is the backend trigger and is outside this packet's authorized files.

### C — Horizontal scroll for category tabs (CSS)
`.pos-cat-bar` already had `overflow-x: auto` + a hidden webkit scrollbar. Hardened it: added `flex-wrap: nowrap` (tabs never wrap), `scrollbar-width: none` (Firefox parity). Combined with each pill's `flex-shrink: 0` and the parent `.pos-product-area { min-width: 0 }`, many categories scroll **inside the bar** and never push or break the cart panel. Tab interactions + active state unchanged.

## 6. Macro Layout Alignment Notes

Top edges now align by construction (cart `margin-top: 0` against the product area's top). The 64px category bar (left) and the 64px customer/Select bar (right) share the same top and bottom Y. The remaining 8px gutter is uniform on left/right/bottom; the floating bottom (cart 8px short of the row bottom) is the intended elevated feel. Visual judgment of "premium gutter" is deferred to AGY.

## 7. Category Sync Listener Notes

The POS uses one catalog-wide bell (`lastForceUpdate`) — it does not (and need not) distinguish product vs category. The glow + refresh already react to category broadcasts. The fix was on the render side (tabs now include collection categories). No duplicate listeners introduced; no new subscriptions; no memory-leak surface added (the single existing `onSnapshot` in `usePosSyncSignal` is unchanged).

## 8. Category Tab Horizontal-Scroll Notes

`flex-wrap: nowrap` + `overflow-x: auto` + `scrollbar-width: none` (+ existing webkit hide) on `.pos-cat-bar`, with `flex-shrink: 0` pills and a `min-width: 0` parent, guarantee horizontal scrolling without wrapping or layout break as categories grow.

## 9. Focus Recovery Preservation Notes

No focus logic touched. The UI-03 Hold-Bill / Suspended-Bills `onClose` refocus, the cart-control `runAndRefocus` paths, UOM/Payment/ProductPicker/numpad focus ownership, Ctrl+F, auto-focus, F12, and scanner paths are all unchanged — the full keyboard-contract suite (145) is green.

## 10. Tests / Checks Run

| Check | Result |
|---|---|
| `git status --short` | the 3 app files (+ workflow/report docs) |
| `git diff --name-only` | `POSPage.tsx`, `POSPage.css`, `POSPage.keyboard-contract.test.ts` (+ docs) |
| `git diff --stat` | `POSPage.css | 13`, `POSPage.keyboard-contract.test.ts | 37`, `POSPage.tsx | 32` |
| `git diff --check` | clean |
| `git diff -- POSPage.css \| grep cust-pick` | empty (Select Customer untouched) |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | **145 passed** (was 142; +3 UI-04 tests) |
| `npx.cmd vitest run` | **712 passed (31 files)** |

### New tests (describe `7C-UI-04-SYNC-AND-MACRO-LAYOUT`, 3 tests)
B: the `visibleCategories` memo merges product categories + `richCategories` (deduped, branch-gated); the update bell is catalog-wide (glow + refresh fire for category or product changes). C: the category bar still renders `visibleCategories.map` (usable with many categories). A and C are CSS-only → visual validation deferred to AGY.

## 11. Boundary Confirmation

- [x] Select Customer button styling / dashed border **NOT touched**
- [x] No cart math change; `useCart.ts` / `useCart.contract.test.ts` / `cartUtils.ts` untouched
- [x] Checkout / payment business logic untouched; stock matrix untouched; seed data untouched
- [x] Toast files untouched; Firebase / functions / rules untouched; Android / Capacitor untouched; `.claude/` untouched
- [x] No scripts created; no new dependencies; no UI-05 work
- [x] UI-03 focus recovery preserved (full suite green)
- [x] Only authorized files changed
- [x] No staging, no commit; `stash@{0}` untouched (only `git stash list` used)

## 12. Hidden Risks / Notes

- **B render-merge surfaces collection categories:** categories that exist in the collection and are branch-visible now appear as tabs even with zero products (intended — so new categories show). They are still gated by `getVisibleCategories` (branch `isVisibleInPos`), so hidden categories stay hidden. If admin has stale/branch-visible empty categories, they would now appear — AGY/Tech Lead to confirm this is desired (it is the directive's "render new categories").
- **Admin broadcast on category edit is out of scope:** the POS glows only when the admin rings the bell. If the admin category editor doesn't call `broadcastInventoryUpdate`, that backend trigger is a separate (non-POS) fix — flagged for Tech Lead.
- **A is a one-line margin change** — low risk, but the "premium gutter" look is a visual judgment for AGY (node tests can't assert pixels).

## 13. Next Owner and Next Action

**Next owner: Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`). Human operator sends AGY the current packet, this report, and the current `git diff` for visual/macro-layout validation. **Codex only after AGY PASS / PASS WITH NOTES.** Do not stage or commit. Do not start UI-05.

---

STATE CARD
Phase: 7C-UI-04-SYNC-AND-MACRO-LAYOUT
Current owner: Developer (complete) → Senior QA & UX Lead / AGY
Verdict: In Progress — Developer implementation complete, awaiting AGY visual/UX review (before Codex)
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.css; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md
Tests/checks: git diff --check clean; Select Customer untouched; tsc -b PASS; POSPage.keyboard-contract 145 passed; full vitest 712 passed
Staged: None
Committed: None
Required fixes: None
Next owner: Senior QA & UX Lead / AGY (ROLE FILE: docs/ai-roles/ux-lead.md)
Next action: Human operator sends AGY the current packet + this report + current diff for visual/macro-layout validation; Codex only after AGY PASS / PASS WITH NOTES
Stop condition: No staging, no commit, no Codex until AGY passes, no UI-05; Select Customer border untouched; stash@{0} untouched; wait for AGY visual validation
