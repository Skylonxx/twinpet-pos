# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Current Phase

**7C-UI-04-SYNC-AND-MACRO-LAYOUT** — Category Sync and Product/Grid–Cart Macro Layout Polish.

## Current Owner

**Developer Agent** (implementation complete) → handoff to **Senior QA & UX Lead / AGY**

## Latest Verdict

**In Progress** — Developer implementation complete; **AGY visual/UX review required before Codex**.

---

## Preflight

- Working tree was **clean** before start.
- HEAD at start: `ce49a82 style(pos): polish refresh update state and focus recovery`.
- `stash@{0}` present and untouched.

## Scope

### Files in scope (this phase)

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.css`
- `src/pages/POSPage.keyboard-contract.test.ts`
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Files changed so far

- `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, `src/pages/POSPage.keyboard-contract.test.ts` (modified, unstaged)
- Workflow/report files above (modified, unstaged)

No staging. No commit.

### What changed (directives A / B / C)

- **A — Macro layout (CSS):** `.pos-cart` top margin set to `0` so its top edge + the 64px customer/Select bar align perfectly with the 64px category bar on the left (no jagged top); left/right/bottom 8px form one consistent intentional gutter on the g50 surface; border + shadow keep the premium floating feel. **Select Customer dashed border NOT touched.**
- **B — Category sync (TSX):** the category tab list is now sourced from BOTH product categories AND the categories collection (`richCategories`), deduped + branch-gated — so a newly-added category renders after a Refresh (the old tabs derived from products only). The update bell (`lastForceUpdate`) is catalog-wide and already glows/refreshes for category broadcasts; `refreshInventory()` already re-fetches categories. (Admin-side broadcast-on-category-edit is the backend trigger, outside POS scope.)
- **C — Horizontal scroll (CSS):** `.pos-cat-bar` made robustly scrollable (`flex-wrap: nowrap` + `overflow-x: auto` + `scrollbar-width: none`, webkit scrollbar already hidden); parent `min-width: 0` means many tabs scroll instead of pushing the cart.

### Tests / checks run

- `git diff --check` — clean
- `git diff -- src/pages/POSPage.css | grep cust-pick` — **empty (Select Customer untouched)**
- `npx.cmd tsc -b` — PASS
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **145 passed** (was 142; +3 UI-04 tests)
- `npx.cmd vitest run` — **712 passed (31 files)**

### Staging / Commit status

Nothing staged. Nothing committed. No authorization yet.

---

## Pipeline Status

| Item | Status |
|---|---|
| UI-01 Animation | Closed / committed (`3b6b8ed`) |
| UI-02 Search & Barcode styling | Closed / committed (`bb9b1ad`) |
| UI-02 Focus Hotfix + EDGE | Closed / committed (`42ff3ed`, `023cc8d`) |
| UI-03 Polish | Closed / committed (`ce49a82`) |
| UI-04 Sync & Macro Layout | **In Progress** — Developer done, **awaiting AGY visual review** |
| UI-05+ | **Unauthorized** — do not start |
| Old manual workflow | Available as fallback at any time |

## Next Owner

**Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — mandatory visual/UX review BEFORE Codex (macro layout alignment + Impeccable Style).

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

Developer stops after implementation + report. No staging, no commit, **no Codex until AGY review passes**, no UI-05. Wait for AGY visual validation.

---

## Latest Commit Baseline

```
ce49a82 style(pos): polish refresh update state and focus recovery
023cc8d fix(pos): recover scanner focus across cashier actions
42ff3ed fix(pos): restore scanner focus after cashier actions
```

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
