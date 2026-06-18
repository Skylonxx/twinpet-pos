# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan + future backlog). UI-01 through UI-06 are **DONE**. UI-06 final commit: `ab7eceb fix(pos): stabilize discount modal draft state`, CEO Physical UAT PASS.

## Current Phase

**TOOLING-AGENTCHATTR-PILOT-3B-RESULT-RECORD + TOOLING-AGENTCHATTR-WORKFLOW-RULES-0** -- record CEO-confirmed Pilot-3B manual test results and codify agentchattr Rules of Engagement.

## Current Owner

**Developer Agent** -- recording results and codifying rules (docs-only).

## Latest Verdict

**PILOT-3B PASS (CEO manual test)** -- CEO manually verified the interactive wrapper path (start_claude.bat) in an external workspace. Basic TUI/Web UI communication confirmed. No unsafe launchers used. Twinpet repo untouched.

## Agentchattr Pilot History

| Pilot | Method | Result | Notes |
|---|---|---|---|
| PILOT-0 | Discovery report | PASS | Committed at c3dbc46 |
| PILOT-1 | Server smoke test | PASS WITH NOTES | Terminal report only |
| PILOT-2 | API registration + message | PASS WITH NOTES | Committed at 050a452 |
| PILOT-3 (AI-run) | Aborted | CORRECT ABORT | Non-interactive env cannot run TUI |
| PILOT-3B (CEO manual) | Interactive wrapper | PASS | CEO-verified, safe launcher only |

---

## Agentchattr Rules of Engagement (Official)

### 1. Role

- agentchattr is an advisory communication hub and transport layer only.
- agentchattr is not a decision maker.
- agentchattr does not replace workflow docs.
- agentchattr does not authorize commits or implementation.

### 2. Source of Truth

- STATE.md, CURRENT_PACKET.md, and NEXT_ACTION.md remain the ultimate source of truth.
- Chat messages are advisory and secondary.
- If chat and docs disagree, docs win until Tech Lead / CEO decides otherwise.

### 3. Authorization

- Tech Lead / CEO authorization through standard workflow is required for all implementation, staging, and commits.
- No autonomous commits.
- No autonomous staging.
- No bypass of AGY, Codex, Principal Engineer, or Tech Lead gates.

### 4. Role Separation

| Role | Assignment |
|---|---|
| Tech Lead / CEO | Decision owner |
| Claude | Developer Agent (unless explicitly reassigned) |
| ChatGPT | Principal Engineer Reviewer / Workflow Coordinator |
| AGY | Senior QA / UX Lead |
| Codex | Reviewer Agent |
| Local Coordinator | Advisory helper only |
| agentchattr | Communication transport (not a role with authority) |

### 5. Safety Prohibitions

- No start_claude_skip-permissions.bat.
- No skip-permissions mode.
- No bypass mode.
- No yolo mode.
- No auto-approve wrapper.
- No stash access.
- No package/lockfile/tooling config changes without explicit phase authorization.
- No app code changes without explicit phase authorization.

### 6. UI-07 Separation

- UI-07 must begin only after separate Tech Lead / CEO authorization.
- This commit does not authorize UI-07.

---

## Scope

Docs-only governance update. Record Pilot-3B results and codify agentchattr rules. No app code. No tooling execution.

### Files allowed (this phase)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Files forbidden (this phase)

- package.json, lockfiles
- scripts/*, tooling configs
- src/* (all app code and tests)
- functions/*, firestore rules
- Android / Capacitor
- .claude/
- docs/ai-roles/*
- docs/agent-workflow/UI_MASTER_PLAN.md
- UI-07 / UI-08 / UI-09 implementation

---

## Preflight

- Working tree had 3 modified docs from aborted Pilot-3 (authorized, expected).
- HEAD at start: `050a452 docs(workflow): record agentchattr pilot-2 api test results`.
- Staging area was **empty**.
- `stash@{0}` present and untouched.

## Baseline (closed work)

- **UI-01 through UI-06** -- DONE. Final UI-06 commit: `ab7eceb`.
- **TOOLING-AGENTCHATTR-PILOT-0** -- discovery report committed at `c3dbc46`.
- **TOOLING-AGENTCHATTR-PILOT-2** -- API test results committed at `050a452`.

## Staging / Commit status

- Staged: **yes** (4 authorized files).
- Committed: **yes**.

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

**Tech Lead / CEO** -- decide next steps (UI-07 authorization or other direction).

## Next Action

See `NEXT_ACTION.md`. Waiting for separate Tech Lead / CEO authorization for UI-07.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Stopped after commit. Do not initiate UI-07 without separate Tech Lead / CEO authorization.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
