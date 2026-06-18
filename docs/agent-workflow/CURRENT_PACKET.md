# Current Work Packet

## Phase

**7C-LOCAL-COORDINATOR-PILOT-1A** — Local Coordinator helper layer, **docs-only contract refinement**.

## What this packet is

A docs-only refinement of the Local Coordinator pilot that **formally captures the 5 dry-run safety rules** identified during the PILOT-1 manual dry-run simulation. The rules are added to `LOCAL_COORDINATOR_CONTRACT.md` (section 9) and `LOCAL_COORDINATOR_PILOT.md` (section 7).

- This is a **docs-only contract refinement.** No app code, no tests, no scripts, no installs, no tooling.
- **The old workflow remains the source of truth.** This pilot is an addition, not a replacement.
- **Local Coordinator is helper-only / advisory-only.** It **cannot** authorize scope, stage, commit, approve, or override any role.
- The 5 rules constrain advisory behavior only; they grant no new authority.
- No production integration yet. No UI work. `UI_MASTER_PLAN.md` is untouched. UI-05 is already DONE; UI-06/07/08/09 are not started and not authorized.

## The 5 dry-run safety rules captured by this packet

1. Tool output beats report claims (flag contradictions; never trust a report claim over actual tool output; route evidence conflicts to Developer + Codex narrow re-check, governance conflicts to Principal Engineer; do not resolve by authority).
2. Untracked files require explicit authorization (flag as package risk unless explicitly listed; always warn against git add .; never recommend broad staging).
3. Stale handoff state blocks routing (if NEXT_ACTION.md / STATE.md contradicts current owner/verdict/review state, flag and stop routing until corrected).
4. Codex PASS is not commit authorization (review verdict only; only Tech Lead / CEO authorizes staging/commit; flag any attempt to treat a Codex PASS as commit permission).
5. ASCII-only reporting (Local Coordinator and terminal-style reports must be ASCII-only to avoid mojibake; not a ban on existing Thai documentation).

## Existing workflow that MUST NOT be replaced

```
Developer Agent implements
  → AGY / Senior QA & UX Lead reviews UI/UX
    → Codex Reviewer reviews code, tests, scope, hygiene, package
      → Principal Engineer Reviewer / Workflow Coordinator: final coordination + abnormality checks
        → Tech Lead / CEO authorizes scope closure and commits
          → CEO performs Physical UAT
```

- No commit without Tech Lead / CEO authorization.
- No new scope without Tech Lead / CEO authorization.
- The Local Coordinator sits **beside** this chain as an advisory pre-check; it never sits above it.

## Goal of the pilot design

Design a small, low-risk helper that can flag:

1. report hygiene problems
2. trailing whitespace
3. path typos
4. file / package mismatches
5. unexpected staged files
6. missing handoff fields (STATE CARD)
7. wrong next-owner routing
8. commit-authorization mistakes

…and route each flag to the correct existing role (AGY for UI/UX & Physical-UAT concerns; Codex for code/test/hygiene re-checks; Principal Engineer for governance/abnormality; Tech Lead / CEO — through Principal Engineer — for scope/commit authorization).

## Authorized files (this packet)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/agent-workflow/LOCAL_COORDINATOR_PILOT.md`
- `docs/agent-workflow/LOCAL_COORDINATOR_CONTRACT.md`

## Strictly forbidden (this packet)

- No app code, no UI components, no tests.
- No Firebase / functions / rules; no Android / Capacitor; no `.claude/`.
- No scripts; no external tool installs; no `agentchattr`; no Codex CLI integration; no tool runs.
- No edits to `UI_MASTER_PLAN.md`.
- No `docs/reports/*` edits (report back in chat instead).
- No UI-05 / UI-06 / UI-07 / UI-08 / UI-09 work.
- No staging, no commit, no `git add .`.
- No replacing the existing workflow.

## Status

**Docs-only contract refinement in progress** — the 5 dry-run safety rules added to `LOCAL_COORDINATOR_CONTRACT.md` (section 9) and `LOCAL_COORDINATOR_PILOT.md` (section 7); awaiting **Principal Engineer Reviewer / Workflow Coordinator** review.

---

## Role Sequence (for this pilot)

```
Developer Agent                         — ROLE FILE: docs/ai-roles/developer.md
  → Principal Engineer Reviewer /       — ROLE FILE: docs/ai-roles/tech-lead.md
    Workflow Coordinator (governance review of the pilot)
      → Tech Lead / CEO (only if the pilot needs scope/keep/revise/discard decision)
```

**Note:** AGY and Codex are not in this pilot's drafting loop because this phase changes **no UI and no code** — it only drafts governance docs. Governance review by the Principal Engineer is the required next gate.

## Decision Rules

1. **Developer** drafts the pilot docs and reports in chat.
2. **Developer** updates `NEXT_ACTION.md` to route to the **Principal Engineer Reviewer / Workflow Coordinator** for governance-risk review.
3. **If any unauthorized file is touched** → STOP and report.
4. **If the working tree was dirty / HEAD wrong / unexpected files appeared at preflight** → STOP and report.
5. **Principal Engineer** reviews governance risk (overlap, authority boundaries, multi-writer risk, accidental staging/commit, scenario sufficiency, source-of-truth integrity).
6. **If Principal Engineer flags risk** → return to Developer for doc revision.
7. **If Principal Engineer PASS** → route to **Tech Lead / CEO** (through Principal Engineer) for keep / revise / discard decision on the pilot.
8. **No commit, no integration, no scope expansion** until Tech Lead / CEO authorizes exact next steps.

---

## STATE CARD Requirement

Every report for this phase must end with a filled STATE CARD block:

```
STATE CARD
Phase:
Current owner:
Verdict:
Files changed:
Tests/checks:
Staged:
Committed:
Required fixes:
Next owner:
Next action:
Stop condition:
```

---

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid. The Local Coordinator pilot never overrides it.
