# Current Work Packet

## Phase

**TOOLING-AGENTCHATTR-PILOT-0** -- docs-only tooling discovery. Evaluate agentchattr for potential use as a Local Coordinator tool.

## What this packet is

A read-only discovery and report on agentchattr. No tool is installed or executed. The deliverable is a developer report documenting what agentchattr is, how it could fit the Twinpet multi-agent workflow, a safe pilot proposal, risk analysis, and a recommendation.

## Baseline

HEAD: `ab7eceb fix(pos): stabilize discount modal draft state`. Working tree clean. Staging empty. `stash@{0}` present and untouched.

## Scope

- Read-only research on agentchattr (public GitHub, web search).
- UI-06 closure marker update in UI_MASTER_PLAN.md.
- Workflow docs update (STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md).
- Discovery report in latest-developer-report.md.
- No install, no execution, no app code, no tests, no scripts, no package/lockfile changes.

## Authorized files

- `docs/agent-workflow/UI_MASTER_PLAN.md` (UI-06 closure marker only)
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

## Strictly forbidden

- package.json, lockfiles
- scripts/*, tooling configs
- src/* (all app code and tests)
- functions/*, firestore rules
- Android / Capacitor
- .claude/
- docs/ai-roles/*
- UI-07 / UI-08 / UI-09 implementation
- npm install / pnpm install / yarn add
- npx agentchattr / agentchattr
- Any installer or setup command
- staging, commit, git add

## Review protocol

1. Developer produces the discovery report (this packet).
2. Principal Engineer Reviewer / Workflow Coordinator reviews governance risk, fit, and pilot safety.
3. Tech Lead / CEO decides whether to authorize TOOLING-AGENTCHATTR-PILOT-1 (install and controlled test).

## Stop condition

After the discovery report, stop. No install, no execution, no staging, no commit. Wait for Principal Engineer review and Tech Lead / CEO decision.

---

## STATE CARD Requirement

Every report for this phase must end with a filled STATE CARD block:

```
STATE CARD
Phase:
Current owner:
Verdict:
Files changed:
Files inspected:
Research performed:
Tests/checks:
Staged:
Committed:
Required fixes:
Next owner:
Next action:
Stop condition:
```

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
