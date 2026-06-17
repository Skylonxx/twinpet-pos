# Developer Report

## Phase

**7C-UI-03-CATEGORY-DROPDOWN** — Categories & Quick Menu Dropdown Conversion (Master Plan item 3)

## 1. Summary

Realigned with the 9-point Phase 7C UI Master Plan: created `docs/agent-workflow/UI_MASTER_PLAN.md` as the source of truth, set the workflow to UI-03, and converted the category selection experience from a **full-screen modal overlay** to a clean, minimalist **anchored dropdown** under the "ค้นหาหมวดหมู่ ▾" button. The modal is fully removed; the dropdown preserves the inline category search and all existing category filtering/sync behavior, closes on selection / outside-click / Escape, and refocuses the scan box. CSS + state are scoped to POSPage; no cart/checkout/stock/icon changes. **AGY visual review required before Codex.**

## 2. Preflight Status and HEAD Confirmation

- `git status --short` before start: **clean** ✅
- `git log --oneline -5` top: `d13a9a1 style(pos): restore modal header icons and simplify buttons` ✅
- `stash@{0}` present and untouched ✅
- Did not start UI-03 on top of uncommitted work.

## 3. UI_MASTER_PLAN.md Creation Confirmation

Created **`docs/agent-workflow/UI_MASTER_PLAN.md`** with the exact 9-point Phase 7C plan (UI-01 DONE, UI-02 DONE, UI-03 CURRENT, UI-04 PENDING, UI-05 DONE, UI-06–09 PENDING) and the Rules block (align future work; no skip/rename/broaden without Tech Lead/CEO; AGY before Codex for UI; no work beyond the current item). ✅

## 4. Files Changed

| File | Action | Description |
|---|---|---|
| `docs/agent-workflow/UI_MASTER_PLAN.md` | **NEW** | Phase 7C source of truth (9-point plan + rules). |
| `src/pages/POSPage.tsx` | Modified | Removed the category modal overlay; added anchored dropdown (state/handlers renamed modal→dropdown; new `openCatDropdown` measured anchor + outside-click effect); Escape + blocking-modal wiring updated. |
| `src/pages/POSPage.css` | Modified | Removed `.pos-category-overlay/modal/modal-hd/close/grid/cell`; added `.pos-cat-trigger-wrap` + `.pos-cat-dd*` dropdown rules + trigger `.on` state. |
| `src/pages/POSPage.keyboard-contract.test.ts` | Modified | Category-picker tests updated (modal→dropdown names/classes/markers) + a "modal overlay fully removed" assertion. |
| `docs/agent-workflow/STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `docs/reports/latest-developer-report.md` | Modified | Workflow + report. |

`useCart.ts` / `cartUtils.ts` / checkout / stock / Toast / Firebase / Android / `.claude/` and all cart-row/summary/action/checkout UI — untouched.

## 5. CURRENT_PACKET.md Update Confirmation

`docs/agent-workflow/CURRENT_PACKET.md` updated to `7C-UI-03-CATEGORY-DROPDOWN` with: the master-plan reference, the goal (modal→dropdown), directives A (destroy modal) / B (implement dropdown) / C (style), strict non-goals (reserved UI-06..09, no overlay reintroduction, functional icons + Select Customer untouched), the AGY-before-Codex requirement, role sequence, and role files. ✅

## 6. Category Modal Removal Summary

The `{catModalOpen && (<div className="pos-category-overlay" role="dialog" aria-modal="true">…)}` block (centered modal with dimmed backdrop, header, search, and a 4-col `.pos-category-grid` of cells) was deleted from the JSX, and its CSS (`.pos-category-overlay/modal/modal-hd/close/grid/cell`) removed. The page no longer renders any category overlay. (`grep` confirms the only remaining mentions are the test's negative assertions.)

## 7. Dropdown Implementation Summary

- **State:** `catModalOpen`→`catDropdownOpen`; new `catDropdownPos {top,left}` + `catTriggerRef` + `catDropdownWrapRef`. `catSearch` preserved.
- **Anchor:** `openCatDropdown()` measures the trigger via `getBoundingClientRect()` and sets a fixed anchor (`top: bottom+4, left`). The dropdown is `position: fixed`, so the `.pos-cat-bar` `overflow-x: auto` (which clips vertically) does **not** clip it.
- **Trigger:** the "ค้นหาหมวดหมู่ ▾" button toggles open/close (`catDropdownOpen ? closeCatDropdown() : openCatDropdown()`), with `aria-haspopup="listbox"` / `aria-expanded`, and an `.on` tint while open.
- **Selection:** items call `selectCategoryFromDropdown(id)` → `selectCategory(id)` (clears `activeQuickMenuId`, sets category, refocuses) → `closeCatDropdown()` (closes + refocuses). The UI-10-B "route through selectCategory" contract is preserved.
- **Dismissal:** outside-click (`document` mousedown vs the wrap ref) closes it; Escape closes it via the central `closeTopModalOnEscape` (slot 10, now `catDropdownOpen`→`closeCatDropdown`); it stays in `hasBlockingModalOpen` so F12 doesn't stack PaymentModal over an open dropdown.

## 8. Inline Search Behavior

The dropdown keeps the inline search input (`catSearch`): it filters `visibleCategories` by name (case-insensitive `includes`), and the ⭐ best-sellers item shows only when the search is empty — identical to the prior modal's search semantics. The input `autoFocus`es on open for fast keyboard filtering; `openCatDropdown` resets `catSearch` to empty each open.

## 9. Style / Impeccable Notes

`.pos-cat-dd` is a 280px fixed popover: white background, `1px var(--g200)` border, `10px` radius, soft layered shadow (`0 8px 24px rgba(38,33,92,.12)` + a faint ambient), `max-height: 60vh` with a scrollable list. The header holds the search (g50 input with an on-brand focus ring); items are left-aligned ghost rows with a calm `var(--p50)` hover and a `var(--p600)` active state. No dimmed backdrop, no modal chrome — minimal, premium, on-brand.

## 10. Preservation Notes

- **Cart items** — untouched (reserved UI-06).
- **Cart summary** — untouched (reserved UI-07).
- **Action buttons** — untouched (reserved UI-08).
- **Checkout / F12** — untouched (reserved UI-09); F12 still suppressed while the dropdown is open (predicate updated to `catDropdownOpen`).
- **Category / product / main-navigation functional icons** — untouched (⭐ pill, quick-menu glyphs, category pills, product cards, top-bar icons all unchanged).
- **Category filtering / sync** — `visibleCategories`, `usePosSyncSignal`, the catalog-wide refresh, and `.pos-cat-bar` horizontal scroll are unchanged.

## 11. Tests / Checks Run

| Check | Result |
|---|---|
| `git status --short` | POSPage.tsx/.css/test + new UI_MASTER_PLAN.md + workflow/report docs |
| `git diff --name-only` | the 3 app files (+ docs) |
| `git diff --stat` | `POSPage.tsx | 188`, `POSPage.keyboard-contract.test.ts | 92`, `POSPage.css | 110` |
| `git diff --check` | clean |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | **145 passed** |
| `npx.cmd vitest run` | **712 passed (31 files)** |

### Test updates
The category-picker contract tests were migrated from modal→dropdown: the blocking-modal predicate (`catModalOpen`→`catDropdownOpen`), the Escape order/closer set (`closeCatModal`→`closeCatDropdown`), the "All tab removed" + "offers ⭐ / routes through shared helper" + UI-10-B parity tests (`pos-category-grid`→`pos-cat-dd-list`, `selectCategoryFromOverlay`→`selectCategoryFromDropdown`), and the focus-return test now asserts the dropdown close-helper **and** that `pos-category-overlay`/`pos-category-modal` are fully removed. Intent preserved; no contract weakened.

## 12. Markdown Hygiene Confirmation

Trailing whitespace stripped from touched Markdown. **Note:** the suggested PowerShell `Get-Content`/`Set-Content -Encoding utf8` cleanup (PS 5.1) corrupted the UTF-8 Thai/em-dash characters in the 4 tracked report/workflow docs; this was detected immediately and the files were **rewritten via the editor (clean UTF-8)** to restore the Thai text. The authored content carries no trailing whitespace, so `git diff --check` → **clean** without re-running the lossy PowerShell step.

## 13. Boundary Confirmation

- [x] UI_MASTER_PLAN.md created; STATE.md phase = 7C-UI-03-CATEGORY-DROPDOWN; CURRENT_PACKET reflects master plan + UI-03; AGY required before Codex
- [x] Category modal overlay removed; dropdown implemented below the trigger; category selection + sync preserved
- [x] Cart item rows / summary / action buttons / checkout / F12 untouched; category/product/main-nav functional icons preserved; Select Customer untouched
- [x] No cart math change; `useCart.ts` / `useCart.contract.test.ts` / `cartUtils.ts` / checkout / stock / seed / Toast / Firebase / Android / `.claude/` untouched
- [x] No scripts; no new dependencies; no UI-04/06/07/08/09 work; no modal overlay reintroduced
- [x] No staging, no commit; `stash@{0}` untouched (only `git stash list` used)

## 14. Hidden Risks / Notes

- **Fixed-position anchor measured on open:** if the window is resized while the dropdown is open the anchor could drift; the dropdown is transient (closes on outside-click / Escape / select) and the POS layout is fixed-height (no page scroll), so this is low-risk. A resize/scroll-close listener is an easy follow-up if AGY wants it.
- **Dead CSS:** `.pos-picker-search` (formerly used only by the removed category modal) is now unused; left in place to keep the change narrow (harmless). Flagged for optional cleanup.
- **`catBar()` test region now includes the dropdown JSX** (it lives inside `.pos-cat-bar`); the ordering assertions still hold because the dropdown uses `selectCategoryFromDropdown` / `visibleCategories.filter(...).map` (distinct from the pill bar's `selectCategory` / `visibleCategories.map`).
- **Markdown encoding:** the lossy PS 5.1 hygiene one-liner should not be used on files containing Thai/UTF-8; editor-based writes are safe. (Documented above; files restored.)
- **CSS-driven visual** — the premium feel is a visual judgment for AGY (node tests can't assert pixels/shadows).

## 15. Next Owner and Next Action

**Next owner: Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`). Human operator sends AGY the master plan, current packet, this report, and the current `git diff` for visual validation of the dropdown. **Codex only after AGY PASS / PASS WITH NOTES.** Do not stage or commit. Do not start UI-04 or any later master-plan item.

---

STATE CARD
Phase: 7C-UI-03-CATEGORY-DROPDOWN
Current owner: Developer (complete) → Senior QA & UX Lead / AGY
Verdict: In Progress — Developer implementation complete, awaiting AGY visual/UX review (before Codex)
Files changed: docs/agent-workflow/UI_MASTER_PLAN.md (new); src/pages/POSPage.tsx; src/pages/POSPage.css; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md
Tests/checks: git diff --check clean; tsc -b PASS; POSPage.keyboard-contract 145 passed; full vitest 712 passed
Staged: None
Committed: None
Required fixes: None
Next owner: Senior QA & UX Lead / AGY (ROLE FILE: docs/ai-roles/ux-lead.md)
Next action: Human operator sends AGY the master plan + packet + this report + current diff for category-dropdown visual validation; Codex only after AGY PASS / PASS WITH NOTES
Stop condition: No staging, no commit, no Codex until AGY passes, no UI-04/06/07/08/09; no modal overlay reintroduced; functional icons + Select Customer untouched; stash@{0} untouched; wait for AGY visual validation
