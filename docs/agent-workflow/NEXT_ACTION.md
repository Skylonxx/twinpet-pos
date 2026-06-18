# Next Action

## Current State

Developer Agent has completed the **7C-LOCAL-COORDINATOR-PILOT-1A** docs-only contract refinement: the 5 dry-run safety rules from the PILOT-1 simulation are now formalized in `LOCAL_COORDINATOR_CONTRACT.md` (section 9) and `LOCAL_COORDINATOR_PILOT.md` (section 7), with `STATE.md` and `CURRENT_PACKET.md` updated to track the phase. No app code, tests, scripts, installs, or tool integration. `UI_MASTER_PLAN.md` is untouched. Nothing is staged or committed. The Local Coordinator remains advisory-only; the existing governance chain remains the absolute source of truth.

**Next owner: Principal Engineer Reviewer / Workflow Coordinator** — review the 5 added safety rules for authority creep and governance integrity.

## What Happens Next

1. Human operator reads this file, `CURRENT_PACKET.md`, the two refined Local Coordinator docs, and the current diff.
2. Human operator sends the Principal Engineer Reviewer / Workflow Coordinator the review prompt below.
3. Principal Engineer returns a verdict (PASS / PASS WITH NOTES / FAIL).
4. If FAIL or PASS WITH NOTES requiring changes, return to Developer for doc revision.
5. If PASS, route to Tech Lead / CEO (through Principal Engineer) for a keep / revise / discard decision on the pilot. No integration, no commit, no scope expansion until then.

Do NOT route to Codex, stage, commit, or integrate any tool until the Principal Engineer review passes.

---

## Copy-Paste Prompt - Principal Engineer Reviewer / Workflow Coordinator (DO THIS NEXT)

```
TO: Principal Engineer Reviewer / Workflow Coordinator
MODEL: best available reviewer model for this run
REASONING: Medium
ROLE: Principal Engineer Reviewer / Workflow Coordinator
ROLE FILE: docs/ai-roles/tech-lead.md
MODE: Docs-only governance review of the Local Coordinator safety-rule refinement, no edits, no staging, no commit

PHASE: 7C-LOCAL-COORDINATOR-PILOT-1A
SCOPE: verify the 5 dry-run safety rules added to the Local Coordinator pilot docs

Inputs:
- docs/agent-workflow/LOCAL_COORDINATOR_CONTRACT.md (section 9 - the 5 rules)
- docs/agent-workflow/LOCAL_COORDINATOR_PILOT.md (section 7 - the 5 rules summary)
- docs/agent-workflow/CURRENT_PACKET.md (active packet)
- docs/agent-workflow/STATE.md (state board)
- the current working-tree diff (git diff)

REVIEW MUST VERIFY:
1. All 5 rules are present and correctly stated:
   - Rule 1 - Tool output beats report claims.
   - Rule 2 - Untracked files require explicit authorization.
   - Rule 3 - Stale handoff state blocks routing.
   - Rule 4 - Codex PASS is not commit authorization.
   - Rule 5 - ASCII-only reporting.
2. The Local Coordinator remains advisory only (owns no decision, artifact, or authorization).
3. No authority creep was introduced by the new rules.
4. No direct Tech Lead bypass was introduced (escalation to Tech Lead / CEO still flows only
   through the Principal Engineer).
5. No staging, commit, or tooling permissions were introduced anywhere in the rules.
6. The ASCII-only reporting rule is present and enforceable, and is scoped to generated
   reports only (not a ban on existing Thai documentation).
7. The existing governance chain remains the absolute source of truth, with the safety
   invariant intact (existing chain + Tech Lead / CEO wins on any conflict).

Also verify boundary hygiene:
- Only the 5 authorized docs changed; no app code/tests/scripts/installs; UI_MASTER_PLAN.md
  untouched; docs/reports untouched; nothing staged; nothing committed; stash@{0} untouched.

RUN AND REPORT:
git status --short
git diff --name-only
git diff --stat
git diff --check
git diff --cached --name-only

Produce a verdict (PASS / PASS WITH NOTES / FAIL) with specific findings.
Do not stage or commit. Do not integrate any tool. Do not start any UI master-plan item.
If the pilot needs a keep / revise / discard decision, escalate to Tech Lead / CEO - do not decide scope yourself.
```

---

## Important Reminders

- Principal Engineer first - do NOT route to Codex, stage, commit, or integrate any tool until this review passes.
- UI_MASTER_PLAN.md is the Phase 7C source of truth and is untouched - no UI master-plan work (UI-05/06/07/08/09) is authorized.
- This phase is docs-only: no app code, no tests, no scripts, no installs, no tool integration.
- The existing governance chain remains the absolute source of truth; the Local Coordinator is advisory-only and overrides nothing.
- Do not stage or commit until Tech Lead / CEO authorizes exact commands.
- stash@{0} is pre-existing unrelated WIP - do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
