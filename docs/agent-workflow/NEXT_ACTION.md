# Next Action

## Current State

Phase **TOOLING-AGENTCHATTR-PILOT-0** is **complete** (docs-only discovery). The Developer produced a discovery report on agentchattr covering: what it is, problem fit, workflow integration, safe pilot model, risk analysis, and recommendation. No tool was installed or executed. UI-06 is marked DONE in the master plan.

## What Happens Next

**Next owner: Principal Engineer Reviewer / Workflow Coordinator.**

Principal Engineer reviews the discovery report for governance risk, fit assessment, and pilot safety. After Principal Engineer review, route to Tech Lead / CEO for the install/pilot decision.

---

## Principal Engineer Review Prompt (ready to copy)

```
TO: Principal Engineer Reviewer / Workflow Coordinator
MODEL: best available reviewer model for this run
REASONING: Medium
ROLE: Principal Engineer Reviewer / Workflow Coordinator
ROLE FILE: docs/ai-roles/tech-lead.md
MODE: Governance review of tooling discovery report, no edits, no staging, no commit

PHASE: TOOLING-AGENTCHATTR-PILOT-0

Inputs:
- docs/reports/latest-developer-report.md (agentchattr discovery report)
- docs/agent-workflow/CURRENT_PACKET.md
- docs/agent-workflow/STATE.md

REVIEW MUST VERIFY:
1. The discovery report accurately describes agentchattr capabilities and limitations.
2. The proposed pilot model does not grant agentchattr any authority beyond advisory.
3. No install or execution occurred during discovery.
4. Risk analysis covers: package contamination, config sprawl, role confusion, stale state,
   accidental auto-execution, security/token/privacy, Windows path, Thai/UTF-8, and .claude policy.
5. The recommendation is well-reasoned and conservative.
6. The pilot proposal (if recommended) preserves the existing governance chain:
   Developer -> AGY -> Codex -> Principal Engineer -> Tech Lead / CEO.
7. No app code, tests, scripts, tooling configs, Firebase, Android, or .claude files were touched.

Produce a verdict (PASS / PASS WITH NOTES / FAIL) with specific findings.
Do not install or execute agentchattr. Do not stage or commit.
```

---

## Tech Lead / CEO Decision Prompt (use ONLY after Principal Engineer PASS / PASS WITH NOTES)

```
TO: Tech Lead / CEO
MODEL: best available model for this run
REASONING: Medium
ROLE: Tech Lead / CEO
ROLE FILE: docs/ai-roles/tech-lead.md
MODE: Decision on tooling pilot authorization

PHASE: TOOLING-AGENTCHATTR-PILOT-0 (closure decision)

PRECONDITION: Principal Engineer review PASS or PASS WITH NOTES.

INPUTS:
- docs/reports/latest-developer-report.md (agentchattr discovery report)
- Principal Engineer review verdict and findings

DECISION REQUIRED:
Choose one:

Option A -- Authorize TOOLING-AGENTCHATTR-PILOT-1 (controlled install + isolated test).
  Scope: install agentchattr in a dev-only context, run a controlled single-agent test,
  verify it works on Windows with the existing Claude Code setup, and report results.
  No production use. No app code access. No automatic commits. Reversible.

Option B -- Authorize TOOLING-AGENTCHATTR-PILOT-1 with conditions.
  Specify additional constraints or a narrower scope.

Option C -- Do not pilot yet.
  Park the discovery report and resume UI-07 or another priority.

Option D -- Discard.
  The tooling does not fit. Archive the report and move on.

Do not install or execute agentchattr until this decision is made.
```

---

## Review Chain

```
Developer Agent (discovery complete)
  -> Principal Engineer Reviewer / Workflow Coordinator (governance review)
    -> Tech Lead / CEO (install/pilot authorization decision)
```

## Important Reminders

- No tool was installed or executed during discovery.
- The existing governance chain remains the absolute source of truth.
- Do not install agentchattr until Tech Lead / CEO authorizes.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
