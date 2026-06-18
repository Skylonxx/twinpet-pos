# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan). It is **untouched** by this phase. UI-04 = Product Grid Cards is **closed, committed (`06bc831`), and passed CEO Physical UAT**.

## Current Phase

**7C-LOCAL-COORDINATOR-PILOT-1A** — a supplemental, docs-only refinement that formally adds the 5 dry-run safety rules (from the PILOT-1 simulation) to the Local Coordinator pilot docs. This is an **addition, not a replacement** for the existing governance chain.

## Current Owner

**Developer Agent** — docs-only contract refinement.

## Latest Verdict

**Docs-only contract refinement in progress** — added the 5 dry-run safety rules to `LOCAL_COORDINATOR_CONTRACT.md` (section 9) and `LOCAL_COORDINATOR_PILOT.md` (section 7). Awaiting Principal Engineer Reviewer / Workflow Coordinator review. Local Coordinator remains advisory-only; existing governance chain remains the absolute source of truth.

## Scope

Add the 5 dry-run safety rules to the Local Coordinator docs. **Docs-only** (planning only); no app code, no scripts, no installs, no tooling.

### Files allowed (this phase)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/agent-workflow/LOCAL_COORDINATOR_PILOT.md`
- `docs/agent-workflow/LOCAL_COORDINATOR_CONTRACT.md`

### Files forbidden (this phase)

- app code
- UI components
- tests
- Firebase / functions / rules
- Android / Capacitor
- `.claude/`
- scripts (no creation), external tools / installs
- `docs/agent-workflow/UI_MASTER_PLAN.md`
- `docs/reports/*` (not authorized this phase)

---

## Preflight

- Working tree was **clean** before start.
- HEAD at start: `e5f3254 docs(workflow): add local coordinator pilot contract` (post-PILOT-0 contract commit).
- `stash@{0}` present and untouched.

## Baseline (closed work)

- **7C-UI-04-PRODUCT-GRID-CARDS** — closed, committed at `06bc831`, **CEO Physical UAT: PASS**, post-commit working tree clean.
- **7C-LOCAL-COORDINATOR-PILOT-0** — pilot contract docs committed at `e5f3254`.

## Staging / Commit status

Nothing staged. Nothing committed. No authorization sought (docs-only pilot).

---

## Pipeline Status (per UI_MASTER_PLAN.md — untouched this phase)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE — committed `06bc831`, CEO Physical UAT PASS |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | PENDING (NOT started — not authorized) |
| UI-07 Cart Summary | PENDING (NOT started — not authorized) |
| UI-08 Action Buttons | PENDING (NOT started — not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started — not authorized) |

> This pilot does **not** advance any UI master-plan item. UI-05 is already DONE per prior work; UI-06/07/08/09 remain unstarted and unauthorized.

## Next Owner

**Principal Engineer Reviewer / Workflow Coordinator** (ROLE FILE: `docs/ai-roles/tech-lead.md`) — review the 5 added safety rules for authority creep, Tech Lead bypass, staging/commit/tooling permissions, ASCII-rule enforceability, and source-of-truth integrity.

## Next Action

Human operator routes the `NEXT_ACTION.md` Principal Engineer prompt, the two refined Local Coordinator docs, and the current diff to the **Principal Engineer Reviewer / Workflow Coordinator** for review. No commit, no scope expansion, no Codex until that review passes.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Developer stops after the contract refinement + report. **No staging, no commit, no `git add .`**, no scripts, no installs, no tool integration. UI_MASTER_PLAN.md untouched. UI-05/06/07/08/09 not started. Wait for Principal Engineer Reviewer / Workflow Coordinator review.

---

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times. The Local Coordinator pilot is advisory-only and never overrides this fallback or the existing governance chain.
