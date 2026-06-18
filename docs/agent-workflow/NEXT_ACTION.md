# Next Action

## Current State

Phase **TOOLING-AGENTCHATTR-PILOT-2** external scratch single-agent connection test is in progress. The Developer is running a controlled test with one Claude agent in an external scratch workspace (C:\tools\agentchattr-scratch). No Twinpet repo access from the agent. No unsafe launchers.

## What Happens Next

**After Developer terminal report, next owner: Principal Engineer Reviewer / Workflow Coordinator.**

No commit is authorized for PILOT-2. The terminal report is the deliverable.

Post-test Twinpet repo verification should show only these 3 authorized workflow docs modified:
- docs/agent-workflow/STATE.md
- docs/agent-workflow/CURRENT_PACKET.md
- docs/agent-workflow/NEXT_ACTION.md

No other files should be modified. Staging area must be empty.

---

## Principal Engineer Review Prompt (ready to copy)

```
TO: Principal Engineer Reviewer / Workflow Coordinator
MODEL: best available reviewer model for this run
REASONING: Medium
ROLE: Principal Engineer Reviewer / Workflow Coordinator
ROLE FILE: docs/ai-roles/tech-lead.md
MODE: Governance review of PILOT-2 terminal report, no edits, no staging, no commit

PHASE: TOOLING-AGENTCHATTR-PILOT-2

REVIEW MUST VERIFY:
1. The test used only the safe launcher (start_claude.bat), not skip-permissions/bypass/yolo.
2. The agent workspace was external scratch (C:\tools\agentchattr-scratch), not Twinpet.
3. Only harmless test messages were sent.
4. No file edits were requested or performed.
5. No real Twinpet workflow routing occurred.
6. Post-test Twinpet repo verification shows only the 3 authorized docs modified.
7. No app code, package.json, lockfile, scripts, src, functions, Firebase, Android, .claude,
   or UI-07/08/09 files were touched.
8. stash@{0} remains untouched.
9. No staging, no commit occurred.

RUN AND VERIFY:
git status --short
git diff --name-only
git diff --cached --name-only
git log --oneline -5
git stash list

Produce a verdict (PASS / PASS WITH NOTES / FAIL) with specific findings.
Do not stage or commit.
```

---

## Important Reminders

- No commit is authorized for PILOT-2.
- The existing governance chain remains the absolute source of truth.
- agentchattr is not authorized for real Twinpet workflow routing.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
