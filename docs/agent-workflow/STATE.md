# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan). UI-04 = Product Grid Cards = CURRENT.

## Current Phase

**7C-UI-04-PRODUCT-GRID-CARDS** — integrate the existing POS display preferences (usePOSPreferences) with a new Settings section so cashier/admin can control product-card stock visibility, product-name font size, and price font size.

## Current Owner

**Developer Agent** (UAT bug fix complete) → handoff to **Senior QA & UX Lead / AGY**

## Latest Verdict

**UAT Failed / Bug Fix In Progress** — physical UAT failed (Settings controls visible but product cards did not dynamically update); the settings→product-card state wiring has been fixed and re-verified. **AGY visual/functional re-validation required before Codex.** The prior UI-04 commit authorization is **HELD / superseded** until this fix passes AGY and Codex again.

## Required fixes (UAT)

Settings controls were visible but non-functional — the Product Name font size, Price font size, and Stock visibility controls did not dynamically update the Product Grid Cards. **Root cause:** `usePOSPreferences` backed every consumer with its own `useState` copy and read localStorage only once on mount, so the Settings editor and the POS grid held independent states — an edit never reached the mounted POS cards. **Fix:** the preferences are now a single module-level reactive store consumed via `useSyncExternalStore`, so an edit re-renders every consumer immediately. Status: **fixed + verified by tests; awaiting AGY**.

---

## Preflight

- Working tree was **clean** before start.
- HEAD at start: `3b3b909 feat(pos): replace category modal with dropdown`.
- `stash@{0}` present and untouched.

## Scope

### Files changed (app)

- `src/hooks/pos/usePOSPreferences.ts` — **UAT fix:** converted the per-instance `useState` hook into a single module-level reactive store consumed via `useSyncExternalStore`, so the Settings editor and the POS grid now share ONE source of truth and edits re-render the cards immediately (also adds a `storage` event for cross-tab sync). Public API, the `twinpet_pos_prefs` localStorage key, validation, and defaults (`showStock` `true`, `productNameFontSize`/`priceFontSize` `'normal'`) are unchanged — same fields/setters, no new persistence layer or settings architecture. Exposes an internal `posPreferencesStore` for the node-env reactivity test.
- `src/lib/settings/settingsNav.ts` — added a `pos-display` nav item (section `posDisplay`, scope `branch`) to the "ตั้งค่าสาขา & POS" group.
- `src/lib/settings/types.ts` — added `'posDisplay'` to the `SettingsSection` union.
- `src/pages/SettingsPage.tsx` — new "การแสดงผลสินค้า (POS)" section: a stock-visibility toggle + two independent small/normal/large size pickers, wired directly to `usePOSPreferences` setters (immediate persist, mirroring the existing void-password immediate-save pattern). Added a `SizePicker` helper reusing the existing `stg-notif-chip` chip style.
- `src/pages/POSPage.tsx` — consumes `showStock` / `productNameFontSize` / `priceFontSize`; applies `pos-name-*` / `pos-price-*` classes on `.pos-page`; renders the stock span only when `showStock` is on.
- `src/pages/POSPage.css` — added `--pos-name-scale` / `--pos-price-scale` variables + `pos-name-*` / `pos-price-*` classes; product-name and price font-sizes now multiply by their independent scale on top of the existing global scale. Defaults (×1) preserve the current presentation exactly.
- `src/pages/POSPage.product-card.test.ts` — source-contract test for the UI-04 wiring (preference defaults/validation, POSPage consumption + conditional stock, Settings section wiring), **plus new runtime reactivity tests** that exercise the shared `posPreferencesStore` directly (single shared snapshot, subscriber notification, both-direction stock toggle, independent name/price scales, invalid-input rejection, no-op no-notify) and a structural guard locking the `useSyncExternalStore` single-source-of-truth fix.

### Files created / updated (workflow + report)

- `docs/agent-workflow/UI_MASTER_PLAN.md`, `STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `docs/reports/latest-developer-report.md`

No staging. No commit.

### Tests / checks run

- `git diff --check` — clean (only benign LF→CRLF notices)
- `npx.cmd tsc -b` — PASS
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **145 passed**
- `npx.cmd vitest run src/pages/POSPage.product-card.test.ts` — **15 passed**
- `npx.cmd vitest run` — **727 passed (32 files)**

### Staging / Commit status

Nothing staged. Nothing committed. No authorization yet.

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | **CURRENT (RE-OPENED)** — UAT failed (cards did not react to settings); wiring fixed, awaiting AGY re-validation |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | PENDING |
| UI-07 Cart Summary | PENDING |
| UI-08 Action Buttons | PENDING |
| UI-09 Checkout Button (F12) | PENDING |

## Next Owner

**Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — mandatory visual/UX review BEFORE Codex.

## Next Action

Human operator routes the current packet, `docs/reports/latest-developer-report.md`, and the current diff to **AGY first** (see NEXT_ACTION.md). Codex only after AGY PASS / PASS WITH NOTES.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Developer stops after the bug fix + report. No staging, no commit, **no Codex until AGY review passes**, no UI-06/07/08/09. The prior commit authorization remains **HELD / superseded**. Wait for AGY visual/functional re-validation.

---

## Latest Commit Baseline

```
3b3b909 feat(pos): replace category modal with dropdown
d13a9a1 style(pos): restore modal header icons and simplify buttons
521961f style(pos): refine seamless split cart layout
```

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
