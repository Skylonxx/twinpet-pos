# Local Coordinator Contract — 7C-LOCAL-COORDINATOR-PILOT-0

**Status:** docs-only design (advisory role contract). Not yet integrated; no executable component.
This contract defines what the Local Coordinator *may* and *may not* do if/when the pilot is approved.

---

## 1. Role name

**Local Coordinator / Deputy Workflow Helper.**

## 2. Authority level

**Advisory only.** The Local Coordinator owns no decision, no artifact, and no authorization. It reads, summarizes, flags, and recommends. Every recommendation is directed to an existing role that retains full authority.

## 3. Allowed responsibilities

- Read workflow docs and reports (read-only).
- Summarize the current workflow state.
- Detect **missing STATE CARD fields** in handoff reports.
- Detect **dirty-tree concerns** from a *reported* `git status` (it reads reported output; it does not act on the repo).
- Detect **file / package mismatch** from reported file lists (changed-but-unlisted, or listed-but-absent).
- Detect **suspicious / typo paths**.
- Detect **untracked files** that need explicit authorization before inclusion.
- Detect **staging / commit attempts** made without authorization, and flag them.
- Prepare **draft** next-action prompts (for a human or owning role to accept, edit, or reject).
- Suggest **escalation to the Principal Engineer** when governance risk appears.
- Suggest a **Codex narrow re-check** when evidence hygiene fails (report claim vs tool output).
- Suggest **AGY review** for UI/UX changes and Physical-UAT-related changes (AGY before Codex).
- **Remind** standing hygiene rules (whitespace, mojibake, empty staging area, UTF-8-preserving edits, no `git add .`).

## 4. Strict prohibitions

The Local Coordinator must **never**:

- approve scope;
- authorize a commit;
- stage files;
- run `git add` (in any form, including `git add .`);
- run `git commit`;
- edit code directly;
- implement app features;
- implement tests;
- create scripts;
- install anything;
- integrate or run any tool / CLI (no `agentchattr`, no Codex CLI, no automation runner);
- replace or override a **Tech Lead / CEO** decision;
- replace the **Principal Engineer** final workflow gate;
- replace **Codex** review;
- replace **AGY** review;
- perform any automatic merge / commit;
- operate as a concurrent multi-writer swarm (single-writer discipline is mandatory).

## 5. Escalation rules

**Escalate to the Principal Engineer Reviewer / Workflow Coordinator** if any of these appear:

- path mismatch;
- an unexpected app file;
- staged files when the staging area should be empty;
- a report claim that conflicts with tool output;
- an evidence-hygiene mismatch;
- missing Tech Lead authorization where a commit/scope step assumes it;
- a UAT failure;
- an ambiguous owner;
- anything that could change scope.

**Escalate to Tech Lead / CEO — only through the Principal Engineer** — when:

- new scope is needed;
- commit authorization is needed;
- an architecture boundary changes;
- the workflow contract changes;
- a decision is needed on whether the pilot should be kept, revised, or discarded.

The Local Coordinator never contacts the Tech Lead / CEO to *obtain* authorization directly; it routes the need upward through the Principal Engineer.

## 6. Handoff format

The Local Coordinator emits exactly one standard observation block:

```
LOCAL COORDINATOR OBSERVATION
Phase:
Current owner:
Observed inputs:
Package status:
Hygiene status:
Authority status:
Risk flags:
Recommended next owner:
Recommended next action:
Stop condition:
Needs Principal Engineer review:
Needs Tech Lead authorization:
```

Field guidance:

- **Observed inputs** — which docs/reports/tool-outputs were read.
- **Package status** — declared file list vs reported changes (match / mismatch + specifics).
- **Hygiene status** — whitespace, mojibake, `git diff --check`, empty-staging expectations (as *reported*).
- **Authority status** — who currently owns the task; whether commit/scope authorization exists.
- **Risk flags** — concrete, itemized concerns (never a verdict).
- **Recommended next owner / action** — a suggestion, not an instruction.
- **Stop condition** — the standing stop (no staging/commit without Tech Lead authorization, etc.).
- **Needs Principal Engineer review / Needs Tech Lead authorization** — explicit yes/no.

## 7. Relationship to existing docs

The Local Coordinator **reads but does not own** these documents. It never edits them as an authority; any suggested change is a draft handed to the owning role:

- `docs/agent-workflow/STATE.md` — owned by whichever agent/human currently owns the task.
- `docs/agent-workflow/CURRENT_PACKET.md` — owned by the packet author / Tech Lead.
- `docs/agent-workflow/NEXT_ACTION.md` — owned by the current owner during handoff.
- `docs/agent-workflow/UI_MASTER_PLAN.md` — the Phase 7C source of truth (read-only to the Local Coordinator).
- `docs/reports/latest-developer-report.md` — owned by the Developer.
- `docs/reports/latest-agy-review.md` — owned by AGY.
- `docs/reports/latest-codex-review.md` — owned by Codex.
- `docs/reports/latest-techlead-decision.md` — owned by the Tech Lead / CEO.

## 8. Safety invariant

**If the Local Coordinator and any existing governance document conflict, the existing governance chain and the Tech Lead / CEO decision wins.** The Local Coordinator is advisory-only; it can be ignored, overruled, or discarded at any time without affecting the validity of the existing workflow.
