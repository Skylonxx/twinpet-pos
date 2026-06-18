# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan + future backlog). UI-01 through UI-06 are **DONE**. UI-06 final commit: `ab7eceb fix(pos): stabilize discount modal draft state`, CEO Physical UAT PASS.

## Current Phase

**TOOLING-AGENTCHATTR-PILOT-2** -- external scratch single-agent connection test. Controlled test of agentchattr with one Claude agent in an external scratch workspace (C:\tools\agentchattr-scratch). No Twinpet repo access from the agent. No unsafe launchers.

## Current Owner

**Developer Agent** -- running external connection test and reporting results.

## Latest Verdict

**PILOT-1 PASS WITH NOTES (closed)** -- server smoke test passed. Server starts on localhost:8300, MCP on 8200/8201, API responds. No agent was connected in PILOT-1. PILOT-2 authorized for a controlled single-agent connection test.

## Scope

External scratch single-agent connection test only. The agent must use C:\tools\agentchattr-scratch as its workspace, not the Twinpet repo. No unsafe launchers (no skip-permissions, no bypass, no yolo, no auto-approve). No file edits requested. No real workflow routing. Harmless test messages only.

### Files allowed (this phase)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`

### Files forbidden (this phase)

- package.json, lockfiles
- scripts/*, tooling configs
- src/* (all app code and tests)
- functions/*, firestore rules
- Android / Capacitor
- .claude/
- docs/reports/*
- docs/ai-roles/*
- docs/agent-workflow/UI_MASTER_PLAN.md
- UI-07 / UI-08 / UI-09 implementation

---

## Preflight

- Working tree was **clean** before this phase started.
- HEAD at start: `c3dbc46 docs(workflow): add agentchattr discovery report`.
- Staging area was **empty**.
- `stash@{0}` present and untouched.

## Baseline (closed work)

- **UI-01 through UI-06** -- DONE. Final UI-06 commit: `ab7eceb`.
- **TOOLING-AGENTCHATTR-PILOT-0** -- discovery report committed at `c3dbc46`.
- **TOOLING-AGENTCHATTR-PILOT-1** -- server smoke test PASS WITH NOTES (terminal report only, not committed separately).

## Staging / Commit status

- Staged: **no**.
- Committed: **no**. No commit authorized for PILOT-2.

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
| UI-07 Cart Summary | PENDING (NOT started -- not authorized) |
| UI-08 Action Buttons | PENDING (NOT started -- not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started -- not authorized) |
| UI-10 Manager PIN Authorization Overlay | FUTURE BACKLOG (not authorized) |

## Next Owner

**Principal Engineer Reviewer / Workflow Coordinator** -- review the PILOT-2 terminal report for safety and governance.

## Next Action

See `NEXT_ACTION.md`. Principal Engineer reviews, then Tech Lead / CEO decides next steps.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

After PILOT-2 terminal report, stop. No staging, no commit, no `git add`. No app code. No package/lockfile changes. No scripts. No UI-07/UI-08/UI-09. Wait for Principal Engineer review and Tech Lead / CEO decision.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
