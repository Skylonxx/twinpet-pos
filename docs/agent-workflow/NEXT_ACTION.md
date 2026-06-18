# Next Action

## Current State

Developer Agent has drafted the **7C-LOCAL-COORDINATOR-PILOT-0** docs-only pilot: a design for a Local Coordinator / Deputy Workflow Helper advisory layer. Five docs were authored/updated (`STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `LOCAL_COORDINATOR_PILOT.md`, `LOCAL_COORDINATOR_CONTRACT.md`). **No app code, tests, scripts, installs, or tool integration.** `UI_MASTER_PLAN.md` is untouched. Nothing is staged or committed. The existing governance chain remains the absolute source of truth; the Local Coordinator is advisory-only.

**Principal Engineer Reviewer / Workflow Coordinator governance review: PASS WITH NOTES.**

**Next owner: Codex Reviewer** — narrow docs/package/governance hygiene re-check after handoff correction.

## What Happens Next

1. **Human operator** reads this file, `CURRENT_PACKET.md`, `LOCAL_COORDINATOR_PILOT.md`, and `LOCAL_COORDINATOR_CONTRACT.md`, plus the current diff.
2. **Human operator** sends the **Codex Reviewer** the docs handoff re-check prompt below.
3. **Codex Reviewer** returns a hygiene verdict (PASS / REQUEST CHANGES).
4. If **REQUEST CHANGES** → return to Developer for doc revision.
5. If **PASS** → route to **Tech Lead / CEO** (through Principal Engineer) for a keep / revise / discard decision on the pilot. No integration, no commit, no scope expansion until then.

---

## Copy-Paste Prompt — Codex Reviewer (DO THIS NEXT)

```
TO: Codex Reviewer
MODEL: GPT-5.5 / best available Codex reviewer model for this run
REASONING: Low-Medium
ROLE: Reviewer Agent
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Narrow docs handoff re-check only, no edits, no staging, no commit

PHASE: 7C-LOCAL-COORDINATOR-PILOT-0
SCOPE: Verify NEXT_ACTION.md handoff correction after Principal Engineer PASS WITH NOTES

CONTEXT:
Principal Engineer governance review returned PASS WITH NOTES.
Developer Agent corrected stale NEXT_ACTION.md and STATE.md handoff routing
(previously pointed to Principal Engineer; now correctly routes to Codex Reviewer).

VERIFY:
1. NEXT_ACTION.md correctly reflects Principal Engineer PASS WITH NOTES.
2. NEXT_ACTION.md now routes to Codex Reviewer, not back to Principal Engineer.
3. No stale "Do NOT route to Codex" instruction remains.
4. Only authorized docs are touched (NEXT_ACTION.md, STATE.md).
5. LOCAL_COORDINATOR_CONTRACT.md and LOCAL_COORDINATOR_PILOT.md remain present/untracked
   if not staged.
6. No app/source/test/script/Firebase/Android/.claude files are touched.
7. UI_MASTER_PLAN.md remains untouched.
8. git diff --check passes.
9. Staging area remains empty.
10. No commit occurred.

RUN AND REPORT:
git status --short
git diff --name-only
git diff --stat
git diff --check
git diff --cached --name-only

Produce a verdict (PASS / REQUEST CHANGES) with specific findings.
Do not stage or commit. Do not integrate any tool. Do not start any UI master-plan item.
```

---

## Important Reminders

- **Principal Engineer governance review: PASS WITH NOTES** — that gate is satisfied.
- **`UI_MASTER_PLAN.md` is the Phase 7C source of truth and is untouched** — no UI master-plan work (UI-05/06/07/08/09) is authorized.
- This pilot is **docs-only**: no app code, no tests, no scripts, no installs, no tool integration.
- The **existing governance chain remains the absolute source of truth**; the Local Coordinator is advisory-only and overrides nothing.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
