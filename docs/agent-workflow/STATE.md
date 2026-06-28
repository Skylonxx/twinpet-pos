# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** and **`docs/UI_MASTER_PLAN.md`** track Phase 7C POS UI scope. UI-01 through UI-09-B are **DONE**. UI-09-C is the next candidate (planning/audit only).

## Repository Baseline

| Field | Value |
|-------|-------|
| HEAD | `f0c783c docs: close ui-09-b checkout button uat` |
| UI-09-B implementation | `baca4fe style(pos): polish checkout button hierarchy` |
| Branch | `main` aligned with `origin/main` |

## Current Phase

**TWINPET-POS-UI-09-C-PAYMENT-MODAL-PLANNING-GATE** — planning/audit only. **NOT authorized for implementation.**

## Current Owner

**Tech Lead / CEO (Gemini)** — authorize UI-09-C read-only planning/audit when ready.

## Latest Verdict

**UI-09-B CLOSED / PASSED UAT** — checkout button visual polish (`baca4fe`); closure docs committed (`f0c783c`). Owner physical UAT: **เทสแล้วผ่านครับ**.

## Mode

Idle. No active implementation. Waiting for UI-09-C planning authorization.

---

## Agentchattr Rules of Engagement (Official, still in force)

1. agentchattr is an advisory communication hub and transport layer only — not a decision maker, does not replace workflow docs, does not authorize commits or implementation.
2. `docs/STATE.md`, `docs/agent-workflow/STATE.md`, `CURRENT_PACKET.md`, and `NEXT_ACTION.md` remain authoritative; if chat and docs disagree, docs win.
3. Tech Lead / CEO (Gemini) and Owner (Narachat) authorization through standard workflow is required for all implementation, staging, and commits.
4. Role separation (see `AUTHORITY_MATRIX.md`):
   - **Outside agentchattr:** Khun Chat / Owner = Human Operator / Product Owner; Gemini = Tech Lead / CEO decision owner; ChatGPT = Architecture Engineer / workflow coordinator.
   - **Inside agentchattr:** codex_coordinator = Workflow Coordinator; claude_developer = Developer; codex_reviewer = Independent Reviewer; agy_ui_lead = UI/UX-only; codex_safe = Safety Gate (not a workflow persona).
   - codex_coordinator and codex_reviewer MUST be separate identities. agentchattr = transport only.
5. Naming a role file alone is **not** permission; prompts must explicitly address the role (`TO:` header).
6. Safety prohibitions: no skip-permissions, no bypass, no yolo, no auto-approve, no stash apply/pop/drop.

---

## Baseline (closed work)

- **UI-01 through UI-09-B** — DONE (UI-09-B visual-only checkout button polish).
- **UI-08** — CLOSED / PASSED UAT (`873997e`).
- **UI-09-A** — CLOSED read-only checkout boundary audit.
- **agentchattr coordinator_loop tooling** — pushed separately; transport only for Twinpet.

## Staging / Commit status

- UI-09-B closure docs: **committed** at `f0c783c`.
- Tracker reconcile (this phase): docs-only, unstaged until authorized.

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | DONE |
| UI-07 Cart Summary | DONE |
| UI-08 Action Buttons | DONE — CLOSED / PASSED UAT (`873997e`) |
| UI-09-A Checkout boundary audit | DONE — read-only, closed |
| UI-09-B Checkout Button Visual Polish | DONE — CLOSED / PASSED UAT (`baca4fe`, closure `f0c783c`) |
| UI-09-C Payment Modal / Payment Flow | NEXT CANDIDATE — planning/audit only; **NOT authorized for implementation** |
| UI-10 Manager PIN Authorization Overlay | FUTURE BACKLOG |

## Next Owner

**Tech Lead / CEO (Gemini)** — UI-09-C planning authorization.

## Next Action

See `NEXT_ACTION.md`. UI-09-C read-only planning/audit is the next gate; no implementation authorized.

## Role File Reference

Each role is listed separately — no blended cells. Full authority table: `docs/agent-workflow/AUTHORITY_MATRIX.md`.

### Outside agentchattr (upstream, manually controlled by user)

| Agent | Role | Role File |
|---|---|---|
| Khun Chat / Owner (Narachat) | Human Operator / Product Owner | — (human; top of chain) |
| Gemini | Tech Lead / CEO decision owner | `docs/ai-roles/tech-lead.md` |
| ChatGPT | Architecture Engineer / workflow coordinator | `docs/ai-roles/system-architect.md` |

### Inside agentchattr (internal workflow agents)

| Identity | Role | Role File |
|---|---|---|
| codex_coordinator (Codex #1) | Workflow Coordinator | `docs/ai-roles/workflow-coordinator.md` |
| claude_developer (Claude) | Developer / Implementer | `docs/ai-roles/developer.md` |
| codex_reviewer (Codex #2) | Independent Reviewer | `docs/ai-roles/reviewer.md` |
| agy_ui_lead (AGY) | UI Lead / UX QA Lead (UI/UX-only) | `docs/ai-roles/ux-lead.md` |

### Internal safety gate

| Identity | Role | Role File |
|---|---|---|
| codex_safe | Internal Safety Gate / Boundary Guard | `docs/ai-roles/safety-reviewer.md` |

## Stop Condition

**Planning gate only.** UI-09-B is closed. Do **not** implement UI-09-C without separate Gemini authorization. PaymentModal and payment/checkout write paths are hard red zones.

---

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` read-only is allowed.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
