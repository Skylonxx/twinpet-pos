# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan). UI-04 = Product Grid Cards is **DONE** (`06bc831`, CEO Physical UAT PASS). UI-05 = Cart Container is **DONE**. UI-06 = Cart Item Rows was committed at `630b742`; its UAT-failed discount/numpad issues were fixed and committed at **`1a68983`**. This enhancement extends the UI-06 item discount modal.

## Current Phase

**7C-UI-06-HOTFIX-MODAL-REDESIGN** -- ItemDiscountModal draft-vs-saved state contract and footer UX redesign, after CEO UAT failed again on the modal's state behavior and footer proportions. No staging, no commit.

## Current Owner

**Developer Agent** -- redesign implementation complete, handing off to AGY.

## Latest Verdict

**REDESIGN IMPLEMENTATION COMPLETED (pending AGY review)** -- in `src/components/pos/ItemDiscountModal.tsx` + footer CSS in `src/pages/POSPage.css`:
- Draft vs saved contract: `mode`/`value` are a local draft; the cart line is mutated ONLY by Save (`onSave` via `handleSave`). Tab switch and Clear edit the draft only; Cancel discards it; saved state is unchanged unless Save is pressed.
- Clear ("ล้างส่วนลด") is now a DRAFT edit -- the prior immediate `onSave('none', 0)` mutation was removed; preview returns to base. Clear then Cancel keeps the original; Clear then Save removes it.
- Tab switch clears draft input + closes numpad; no auto-apply; saved state untouched.
- Footer redesign: standard dialog footer -- subtle ghost Clear (left) + Cancel (outline) and Save (primary) grouped (right), balanced proportions.
- Price Override RBAC preserved (manager/admin only; default-deny; open-effect + save guard). Preview still via shared `getLineTotal`.

No cart math / `getLineTotal` / `useCart.ts` / `cartUtils.ts` / `types.ts` / `POSPage.tsx` change. No Manager PIN (future backlog UI-10). TypeScript build PASS (`tsc -b`, exit 0). Targeted tests PASS (242: useCart.contract + keyboard-contract + product-card). Full Vitest suite PASS (734, 32 files). `git diff --check` PASS. Staging empty. No commit.

## Supersession

The prior `7C-UI-06-HOTFIX-MODAL-UX-RBAC` package reached Codex PASS but was NOT committed; it is superseded by the new CEO UAT failure and these redesign fixes (layered on the same uncommitted working tree). `docs/reports/latest-agy-review.md` is marked superseded; a fresh AGY review is pending.

## Baseline

- HEAD `77837ca` (manager PIN backlog). Working tree already carried the prior uncommitted RBAC package; preflight matched, staging empty, `stash@{0}` untouched.

## Scope

ItemDiscountModal draft-vs-saved state + Clear (draft-only) + tab reset + footer redesign; Price Override RBAC preserved. Role source: existing `useAuth` (`user.role: UserRole`); no parallel auth source, no session/login change. App files touched: `ItemDiscountModal.tsx` and `POSPage.css` (minimal footer classes, strictly necessary for layout).

### Files changed (this phase, unstaged)

- `src/components/pos/ItemDiscountModal.tsx` -- draft-vs-saved state, draft-only Clear, tab reset, footer redesign (RBAC preserved).
- `src/pages/POSPage.css` -- new standard dialog footer classes (`.pos-idp-footer`, `.pos-idp-clear`, `.pos-idp-btn*`).
- docs: `STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `latest-developer-report.md`, `latest-agy-review.md` (superseded marker).

### Files forbidden (this phase)

- `src/hooks/pos/useCart.ts`, `src/lib/pos/cartUtils.ts`, `src/hooks/pos/useCart.contract.test.ts`, `src/lib/pos/types.ts`, `src/pages/POSPage.tsx`
- checkout / payment, stock / inventory, FIFO
- Firebase / functions / rules
- Android / Capacitor
- `.claude/`, scripts, tooling configs
- `UI_MASTER_PLAN.md`, Manager PIN Overlay (future backlog UI-10)
- UI-07 / UI-08 / UI-09

---

## Staging / Commit status

- Prior work committed: per-unit enhancement at `85b3a31` (and earlier `1a68983`, `630b742`).
- This hotfix: **Staged: no. Committed: no.**

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE -- `06bc831`, CEO Physical UAT PASS |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | Committed `630b742`; hotfix `1a68983`; per-unit enhancement `85b3a31`; MODAL REDESIGN hotfix in progress (draft-state + footer; RBAC preserved; pending AGY review) |
| UI-07 Cart Summary | PENDING (NOT started -- not authorized) |
| UI-08 Action Buttons | PENDING (NOT started -- not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started -- not authorized) |
| UI-10 Manager PIN Authorization Overlay | FUTURE BACKLOG (not authorized) |

## Next Owner

**AGY / Senior QA & UX Lead** -- heavily re-review footer proportions/spacing/hierarchy, tab UX, saved-state preservation, and RBAC visibility. AGY review must occur before Codex.

## Next Action

See `NEXT_ACTION.md`. AGY verifies the redesigned footer, tab-switch draft clearing, that switching tabs + Cancel preserves the saved discount, and that staff cannot access Price Override (manager/admin can); on PASS / PASS WITH NOTES, route to Codex.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Redesign implementation complete. Do not stage or commit. No `git add`. Do not route to Codex before AGY. Prior RBAC package's Codex PASS is superseded and must not be committed. Forbidden files untouched. No Manager PIN implementation. UI-07/UI-08/UI-09 not started. Wait for AGY visual / UX review.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
