# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan). UI-04 = Product Grid Cards is **DONE** (`06bc831`, CEO Physical UAT PASS). UI-05 = Cart Container is **DONE**. UI-06 = Cart Item Rows was committed at `630b742`; its UAT-failed discount/numpad issues were fixed and committed at **`1a68983`**. This enhancement extends the UI-06 item discount modal.

## Current Phase

**7C-UI-06-ENHANCEMENT-DISCOUNT-MODAL** -- item discount modal UI scaling plus a new "Discount per unit" (ส่วนลดต่อหน่วย) option. Tech Lead / CEO granted a narrow logic exception to add the per-unit discount calculation. No staging, no commit of the enhancement.

## Current Owner

**Developer Agent** -- fixing Codex REQUEST CHANGES blockers (one app-logic, one hygiene). After fix, next owner is Codex Reviewer for focused re-review.

## Latest Verdict

**CODEX REQUEST CHANGES -- both blockers fixed (pending Codex re-review)**. Codex confirmed the cart math, type coverage, tests, AGY precondition, and untouched forbidden areas, then raised two blockers, now resolved:
- Blocker 1 (hygiene): trailing whitespace on `docs/reports/latest-agy-review.md:8` removed; `git diff --check` PASS.
- Blocker 2 (app logic): `ItemDiscountModal` preview no longer re-implements discount arithmetic -- it now computes via the shared `getLineTotal` path, so preview and the real cart line total cannot drift (same formula, clamp, and roundMoney).

No cart math / `getLineTotal` / `useCart.ts` / `POSPage.tsx` change in this fix cycle. TypeScript build PASS (`tsc -b`, exit 0). Contract tests PASS (82). Full Vitest suite PASS (734, 32 files). `git diff --check` PASS. Staging empty. No commit.

Enhancement baseline (unchanged): modal scaling (280px -> 360px) + the "Discount per unit" tab (ลด/หน่วย; field label ส่วนลดต่อหน่วย) + per-unit math in `getLineTotal` (row discount = amount x quantity, clamped at 0).

## Baseline

- Part A hotfix committed at **`1a68983`** (`fix(pos): repair discount badge and numpad touch behavior`); working tree was clean immediately after.
- Part B enhancement built on top of `1a68983`, unstaged.

## Scope

Item discount modal scaling + "Discount per unit" option and its math only. **Logic exception (narrow):** cart math/logic may be modified strictly for the per-unit discount -- exercised in `src/lib/pos/cartUtils.ts` (`getLineTotal`, `IDP_LABELS`) and `src/lib/pos/types.ts` (the new `disc_per_unit` type). `useCart.ts` needed no change (its `setLineDiscount` stores `{type, val}` generically). No unrelated cart math.

### Files changed (this enhancement, unstaged)

- `src/lib/pos/types.ts` -- add `disc_per_unit` to `ItemDiscountType`.
- `src/lib/pos/cartUtils.ts` -- per-unit branch in `getLineTotal`; `IDP_LABELS` entry.
- `src/components/pos/ItemDiscountModal.tsx` -- new tab, preview calc, compact tab labels.
- `src/pages/POSPage.css` -- item discount modal scaling (idp-scoped selectors only).
- `src/hooks/pos/useCart.contract.test.ts` -- per-unit discount math coverage.
- docs: `STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `latest-developer-report.md`.

### Files forbidden (this phase)

- checkout / payment flow (beyond the existing computed line-discount display path)
- stock / inventory / FIFO logic
- Firebase / functions / rules
- Android / Capacitor
- `.claude/`
- scripts, tooling configs
- UI-07 / UI-08 / UI-09

---

## Staging / Commit status

- Hotfix (Part A): **committed** at `1a68983`.
- Enhancement (Part B): **Staged: no. Committed: no.**

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE -- `06bc831`, CEO Physical UAT PASS |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | Committed `630b742`; hotfix `1a68983`; ENHANCEMENT (discount modal) -- AGY PASS, Codex REQUEST CHANGES (both blockers fixed, pending Codex re-review) |
| UI-07 Cart Summary | PENDING (NOT started -- not authorized) |
| UI-08 Action Buttons | PENDING (NOT started -- not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started -- not authorized) |

## Next Owner

**Codex Reviewer** -- focused re-review of the two blocker fixes. Do not route to Principal Engineer until Codex returns PASS or PASS WITH NOTES.

## Next Action

See `NEXT_ACTION.md`. Codex re-reviews: (1) `git diff --check` PASS, (2) `ItemDiscountModal` preview now uses the shared `getLineTotal` with no divergent arithmetic, (3) all prior app-scope confirmations still hold.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Codex blockers fixed. Do not stage or commit. No `git add`. Do not route to Principal Engineer until Codex re-review passes. Forbidden files untouched. UI-07/UI-08/UI-09 not started. Wait for Codex focused re-review.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
