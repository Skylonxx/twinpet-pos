# Developer Report

## Phase

**7C-UI-03-POLISH** — Glowing Refresh Button, Cancel-Path Focus Recovery, and Border Polish

## 1. Summary

Three scoped UI-03 changes from ongoing Physical UAT: (A) removed the standalone yellow Manager-Update banner that violently shifted the layout and moved its urgency onto a premium amber glow on the always-present Refresh button (zero layout shift); (B) added scanner-focus recovery to the Hold-Bill and Suspended-Bills cancel/close paths; (C) refined the Category Tab and Select Customer button border edges. All cashier keyboard/scanner contracts preserved. **AGY visual review is required before Codex.**

## 2. Preflight Status and HEAD Confirmation

- `git status --short` before start: **clean** ✅
- `git log --oneline -5` top commit: `023cc8d fix(pos): recover scanner focus across cashier actions` — the committed **7C-UI-02-HOTFIX-FOCUS-EDGE** ✅
- `stash@{0}` present and untouched ✅
- Did not start UI-03 on top of an uncommitted previous phase.

## 3. Files Changed

| File | Action | Description |
|---|---|---|
| `src/pages/POSPage.tsx` | Modified | Removed the `pos-sync-banner` block; Refresh button gets conditional `pos-action-link--update` class + contextual title; Hold-Bill & Suspended-Bills `onClose` refocus. |
| `src/pages/POSPage.css` | Modified | Removed dead `.pos-sync-banner*` rules (kept `@keyframes pos-sync-pulse` — used by SyncIndicator); added `.pos-action-link--update` amber glow + `@keyframes pos-update-glow`; refined category-pill and Select-Customer borders. |
| `src/pages/POSPage.keyboard-contract.test.ts` | Modified | Added `7C-UI-03-POLISH` describe block (5 tests); renamed a stale test that mentioned the removed banner. |

`useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, checkout/payment, stock matrix, seed, Toast, Firebase, Android, `.claude/` — untouched.

## 4. CURRENT_PACKET.md Update Confirmation

`docs/agent-workflow/CURRENT_PACKET.md` updated for `7C-UI-03-POLISH` with the goal, CEO UAT issue summary, **all three directives A/B/C**, the AGY review requirement (mandatory before Codex), the role sequence (Developer → AGY → Codex → Tech Lead/CEO), and explicit role files. ✅

## 5. Implementation Details (A / B / C)

### A — Glowing button replaces the banner
- **POSPage.tsx:** deleted the `{updateBanner && (<button className="pos-sync-banner">…)}` block (it mounted above `<header>`, pushing the whole page down/up on toggle). The Refresh button's `className` is now `` `pos-action-link${updateBanner ? ' pos-action-link--update' : ''}` `` and its `title` switches to the manager-update message when pending. The **label, icon, and DOM structure are unchanged**, so nothing reflows — only a class + tooltip toggle.
- **POSPage.css:** removed `.pos-sync-banner`, `:hover`, `:disabled`, `.pos-sync-banner-cta`. Added `.pos-action-link--update` (soft amber tint `#fff8e6` / border `#f0b429` / text `#7a4b00`) with a `pos-update-glow` animation that pulses **`box-shadow` only** (`0 0 0 4px rgba(240,180,41,0.28)` at the midpoint) — outside layout, so zero shift. A matching amber hover and `:disabled { animation: none }` are included. `@keyframes pos-sync-pulse` was **kept** (still used by `.pos-sync-indicator--pending`). The glow clears automatically when `updateBanner` flips to false (on refresh).
- **Update detection/refresh behavior unchanged** — `handleManualRefresh` still acknowledges the signal (`setUpdateBanner(false)` → `refreshInventory()`), and the auto-sync `useEffect` is untouched.

### B — Focus recovery on cancel paths
- `HoldBillNoteModal.onClose` and `SuspendedBillsListModal.onClose` now call `focusSearch()` after closing. The confirm/restore paths (`handleHoldConfirm`, `handleRestoreBill`) already refocus, and the Escape handler already covers both — this closes the remaining backdrop/×/cancel gap. Focus is only restored **on close**, never while the modal is open.

### C — Border overlap & unrefined edges (CSS only)
- **Category Tabs:** `.pos-cat-pill` border `0.5px → 1px` with `box-sizing: border-box` (crisp edge; sub-pixel `0.5px` renders as a doubled/uneven hairline on HiDPI). `.pos-cat-pill.on` border-color `transparent → var(--p600)` so the active pill has a defined edge matching its fill instead of letting the background bleed at the border (the "overlap" look). Footprint (120×48) is identical → no row shift.
- **Select Customer:** `.pos-cust-pick` dashed border `0.5px → 1px` with `box-sizing: border-box` (even, premium dash) + a calm color transition; hover still goes solid. `min-height` unchanged.

## 6. Focus Recovery Notes

- Hold-Bill and Suspended-Bills now refocus `searchInputRef` on close/cancel (via the existing rAF-deferred `focusSearch()`), matching every other modal-close path.
- No focus is taken while a modal is open. UOM modal ownership (2 `focusSearch()` in its region), Payment modal, ProductPicker multi-UOM sequencing (`42ff3ed`), discount/bill numpad, Ctrl+F, auto-focus, F12, and scanner paths are all unchanged (full suite green).

## 7. Layout-Shift Prevention Notes

- The only update indicator is now a **class toggle** on an element that is always rendered — no conditional mount/unmount, no reserved space.
- The glow animates **`box-shadow`** (paints outside the box, no reflow) and the amber tint is a color change only. Button height/width/border-width/label are constant → **zero layout shift** on update-state toggle.
- The category/customer border refinements use `box-sizing: border-box`, so bumping `0.5px → 1px` does not change element footprints.

## 8. Visual Polish Notes (for AGY)

- Amber glow is intentionally soft (single eased pulse, ~1.9s, low-alpha box-shadow) — premium, noticeable, not blinding/blinking. AGY to confirm the amber reads as "manager update" urgency without alarm.
- Category active-tab edge and the Select Customer dashed border are best judged on screen; the border directives ("double-bottom border", exact dash weight) are interpreted conservatively here and **explicitly deferred to AGY visual validation** per the packet. If AGY wants a different active-tab treatment (e.g. a true `-mb-px` connected-tab look), that is a quick follow-up.

## 9. Tests / Checks Run

| Check | Result |
|---|---|
| `git status --short` | `M POSPage.tsx`, `M POSPage.css`, `M POSPage.keyboard-contract.test.ts` (+ workflow/report docs) |
| `git diff --name-only` | the three app files (+ workflow/report docs) |
| `git diff --stat` | `POSPage.css | 78`, `POSPage.keyboard-contract.test.ts | 42`, `POSPage.tsx | 37` |
| `git diff --check` | clean |
| `npx.cmd tsc -b` | PASS |
| `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` | **142 passed** (was 137; +5 UI-03 tests) |
| `npx.cmd vitest run` | **709 passed (31 files)** |

### New tests (describe `7C-UI-03-POLISH`, 5 tests)
A: banner element/class gone + no `{updateBanner && (` mount; pending update toggles the `pos-action-link--update` class on the existing button; refresh clears the flag. B: Hold-Bill and Suspended-Bills `onClose` refocus the scan box. (Border polish is visual-only → deferred to AGY, not asserted.)

## 10. Boundary Confirmation

- [x] No cart math change; `useCart.ts` / `useCart.contract.test.ts` / `cartUtils.ts` untouched
- [x] Checkout / payment business logic untouched; stock matrix untouched; seed data untouched
- [x] Toast files untouched (the banner was POSPage-local, not a Toast file)
- [x] Firebase / functions / rules untouched; Android / Capacitor untouched; `.claude/` untouched
- [x] `POSPage.css` changes scoped to UI-03 polish only (banner removal + glow + border edges)
- [x] No scripts created; no new dependencies; no UI-04 work
- [x] Only authorized files changed
- [x] No staging, no commit; `stash@{0}` untouched (only `git stash list` used)

## 11. Hidden Risks / Notes

- **Glow on a disabled button:** during an in-flight refresh `updateBanner` is already false (acknowledged), so the glow is gone; `.pos-action-link--update:disabled { animation: none }` is added as a belt-and-braces guard.
- **`@keyframes pos-sync-pulse` retained** because `.pos-sync-indicator--pending` (SyncIndicator) still uses it — only the banner's own rules were removed.
- **Category-tab "double border" is interpreted, not pixel-verified** (no screenshot). The change is conservative (crisp 1px + defined active edge, no size change); AGY visual validation is the gate.
- Node-env source-level tests cover the behavioral parts (banner removed, class toggles, refocus); pixel/edge polish relies on AGY.

## 12. Next Owner and Next Action

**Next owner: Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`). Human operator sends AGY the current packet, this report, and the current `git diff` for visual/UX validation (Impeccable Style + zero layout shift + no regression). **Codex only after AGY PASS / PASS WITH NOTES.** Do not stage or commit. Do not start UI-04.

---

STATE CARD
Phase: 7C-UI-03-POLISH
Current owner: Developer (complete) → Senior QA & UX Lead / AGY
Verdict: In Progress — Developer implementation complete, awaiting AGY visual/UX review (before Codex)
Files changed: src/pages/POSPage.tsx; src/pages/POSPage.css; src/pages/POSPage.keyboard-contract.test.ts; docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md
Tests/checks: git diff --check clean; tsc -b PASS; POSPage.keyboard-contract 142 passed; full vitest 709 passed
Staged: None
Committed: None
Required fixes: None
Next owner: Senior QA & UX Lead / AGY (ROLE FILE: docs/ai-roles/ux-lead.md)
Next action: Human operator sends AGY the current packet + this report + current diff for visual validation; Codex only after AGY PASS / PASS WITH NOTES
Stop condition: No staging, no commit, no Codex until AGY passes, no UI-04; stash@{0} untouched; wait for AGY visual validation
