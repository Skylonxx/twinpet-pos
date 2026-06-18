# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan + future backlog). UI-01 through UI-07 are **DONE**. UI-07 final commit: `style(pos): polish cart summary layout and resolve responsive constraints`, CEO Physical UAT PASS.

## Current Phase

**7C-UI-07-CART-SUMMARY-IMPLEMENTATION** -- CLOSED. CEO Physical UAT PASS (3rd attempt). Committed.

## Current Owner

**Tech Lead / CEO** -- decide next steps (UI-08 authorization or other direction).

## Latest Verdict

**UI-07 CEO Physical UAT PASS** -- cart summary visual polish committed. Label/value contrast improved, touch targets enlarged, explicit +/- cues for discount/fee, grand total prominence increased, responsive label constraints resolved (flex-shrink: 0, min-width: 80px, nowrap on labels; gap: 10px between label and controls; fee chips flex-wrap). All controls visible, no overflow, no awkward wrapping.

## Mode

Idle. No active implementation. Waiting for CEO directive.

---

## Agentchattr Rules of Engagement (Official, still in force)

1. agentchattr is an advisory communication hub and transport layer only -- not a decision maker, does not replace workflow docs, does not authorize commits or implementation.
2. STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md remain the ultimate source of truth; if chat and docs disagree, docs win.
3. Tech Lead / CEO authorization through standard workflow is required for all implementation, staging, and commits.
4. Role separation: Tech Lead / CEO = decision owner; Claude = Developer Agent; ChatGPT = Principal Engineer Reviewer / Workflow Coordinator; AGY = Senior QA / UX Lead; Codex = Reviewer Agent; agentchattr = transport only.
5. Safety prohibitions: no skip-permissions, no bypass, no yolo, no auto-approve, no stash access.

---

## Baseline (closed work)

- **UI-01 through UI-07** -- DONE.
- **UI-07** -- discovery committed at `84c2e22`; implementation + CEO UAT revision committed in this package.
- **TOOLING-AGENTCHATTR PILOT-0/2/3B** -- discovery `c3dbc46`, API test `050a452`, Pilot-3B + rules `9738b9a`.

## Staging / Commit status

- UI-07: **committed** (7-file package: 3 workflow docs, 2 reports, POSPage.tsx, POSPage.css).

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE -- `06bc831`, CEO Physical UAT PASS |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | DONE -- final `ab7eceb`, CEO Physical UAT PASS |
| UI-07 Cart Summary | DONE -- CEO Physical UAT PASS |
| UI-08 Action Buttons | PENDING (NOT started -- not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started -- not authorized) |
| UI-10 Manager PIN Authorization Overlay | FUTURE BACKLOG (not authorized) |

## Next Owner

**Tech Lead / CEO** -- decide next steps.

## Next Action

See `NEXT_ACTION.md`. Waiting for CEO directive. UI-08 (Action Buttons) is the next item in the master plan but requires separate authorization.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

HARD STOP. UI-07 committed. Do not implement UI-08 or UI-09 without separate Tech Lead / CEO authorization.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
