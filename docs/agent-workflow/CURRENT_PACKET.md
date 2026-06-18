# Current Work Packet

## Phase

**TOOLING-AGENTCHATTR-PILOT-2** -- external scratch single-agent connection test.

## What this packet is

A controlled test of agentchattr with one Claude agent connected in an external scratch workspace (C:\tools\agentchattr-scratch). The agent must NOT have access to the Twinpet repo. Only harmless test messages are sent. No unsafe launchers used.

## Baseline

HEAD: `c3dbc46 docs(workflow): add agentchattr discovery report`. Working tree clean before docs update. Staging empty. `stash@{0}` present and untouched.

## Scope

- Start agentchattr server at C:\tools\agentchattr\repo.
- Connect one Claude agent using start_claude.bat (safe launcher only).
- Agent workspace must be C:\tools\agentchattr-scratch (external scratch, not Twinpet).
- Send harmless test messages only.
- Record whether agent connects, messages deliver, responses received.
- Stop server and verify Twinpet repo untouched.

## Authorized Twinpet files (this phase)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`

## Strictly forbidden

- package.json, lockfiles
- scripts/*, tooling configs
- src/* (all app code and tests)
- functions/*, firestore rules
- Android / Capacitor
- .claude/
- docs/reports/*
- docs/ai-roles/*
- UI_MASTER_PLAN.md
- UI-07 / UI-08 / UI-09
- start_claude_skip-permissions.bat
- any bypass/yolo/auto-approve launcher
- staging, commit, git add
- real Twinpet workflow routing via agentchattr

## Stop condition

After the test and terminal report, stop. No staging, no commit. Wait for Principal Engineer review and Tech Lead / CEO decision.

---

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
