# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan). UI-04 = Product Grid Cards is **DONE** (committed `06bc831`, CEO Physical UAT PASS). UI-05 = Cart Container is **DONE**. UI-06 = Cart Item Rows was committed at **`630b742`**, but **CEO Physical UAT FAILED** on three discount/numpad UI issues -- now addressed by this hotfix.

## Current Phase

**7C-UI-06-HOTFIX-DISCOUNT-UI** -- authorized hotfix for three UAT-failed issues (discount badge display, item-discount modal numpad wiring, bill-discount numpad touch/focus race). No staging, no commit.

## Current Owner

**Developer Agent** -- fixing Codex REQUEST CHANGES blockers (docs/hygiene only). After fix, next owner is Codex Reviewer for re-review.

## Latest Verdict

**CODEX REQUEST CHANGES (docs/hygiene blockers)** -- AGY review: PASS. Codex confirmed app hotfix scope is safe but found docs/hygiene blockers: trailing whitespace in AGY report, documentation evidence mismatch (git diff --check claim vs actual), stale handoff routing. Developer is applying fixes. No app code changed during fix cycle.

## UAT failed origin

CEO Physical UAT on `630b742` failed on: (1) cramped/overflowing discount badge that omitted the amount, (2) item discount modal input not opening the custom numpad, (3) bill discount numpad flashing and closing instantly on iPad/touch.

## Scope

Three discount/numpad UI hotfixes only. Permission extends to the bill-discount trigger area strictly for the numpad race fix (NOT UI-07). Forbidden: cart/discount/total math, checkout/payment, stock/inventory, FIFO, `useCart`, `cartUtils`, Cart Summary restructure, UI-07/UI-08/UI-09, PaymentModal redesign, Firebase/Android/`.claude/`/scripts/tooling.

### Files changed (this hotfix)

- `src/pages/POSPage.tsx` (discount badge display)
- `src/pages/POSPage.css` (discount badge readability)
- `src/components/pos/ItemDiscountModal.tsx` (numpad wiring)
- `src/components/pos/NumpadDialog.tsx` (backdrop dismiss race fix)
- `docs/agent-workflow/STATE.md`, `docs/agent-workflow/CURRENT_PACKET.md`, `docs/agent-workflow/NEXT_ACTION.md`, `docs/reports/latest-developer-report.md`

### Files forbidden (this phase)

- `src/hooks/pos/useCart.ts`, `src/hooks/pos/useCart.contract.test.ts`
- `src/lib/pos/cartUtils.ts`
- checkout / payment logic files
- stock / inventory / FIFO logic files
- Firebase / functions / rules
- Android / Capacitor
- `.claude/`
- scripts, tooling configs

---

## Preflight

- Working tree was **clean** before this hotfix started.
- HEAD at start: `630b742 style(pos): polish cart item row readability`.
- Staging area was **empty**.
- `stash@{0}` present and untouched.

## Baseline (closed work)

- **7C-UI-04-PRODUCT-GRID-CARDS** -- closed, committed at `06bc831`, **CEO Physical UAT: PASS**.
- **7C-UI-05-CART-CONTAINER** -- DONE per prior work.
- **7C-UI-06-CART-ITEM-ROWS-IMPLEMENTATION** -- committed `630b742`, CEO Physical UAT FAILED (this hotfix addresses it).

## Staging / Commit status

- Staged: **no**.
- Committed: **no**.
- Modified: four app files plus five docs (including `docs/reports/latest-agy-review.md` from the AGY review step).

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE -- committed `06bc831`, CEO Physical UAT PASS |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | COMMITTED `630b742`; UAT FAILED -> HOTFIX implemented, AGY PASS, Codex REQUEST CHANGES (fixing docs blockers) |
| UI-07 Cart Summary | PENDING (NOT started -- not authorized) |
| UI-08 Action Buttons | PENDING (NOT started -- not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started -- not authorized) |

## Next Owner

**Codex Reviewer** (after Developer completes docs/hygiene fix). Do not route to Principal Engineer until Codex returns PASS or PASS WITH NOTES.

## Next Action

See `NEXT_ACTION.md`. Developer fixes docs/hygiene blockers from Codex REQUEST CHANGES, then Codex re-reviews the full package.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Developer fixes docs/hygiene blockers only. No app code changes during fix. No staging, no commit, no `git add .`, no scripts, no installs, no tooling. Forbidden files untouched. UI-07/UI-08/UI-09 not started. After fix, wait for Codex re-review.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
