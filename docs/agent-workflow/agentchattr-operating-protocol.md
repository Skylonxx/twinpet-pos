# Agentchattr Operating Protocol

Version: 1.0
Phase: TOOLING-AGENTCHATTR-OPERATING-PROTOCOL-1
Status: Approved by Tech Lead / CEO

---

## 1. Purpose

agentchattr is the local multi-agent communication hub for the Twinpet POS project. It replaces manual copy-paste routing of task handoff prompts between agents. It is transport only -- it carries messages, it does not make decisions, authorize commits, or replace workflow docs.

## 2. Participant Names

### Outside agentchattr (upstream, manually controlled by user)

| Name | Role | Notes |
|---|---|---|
| user | Khun Chat — Human Operator / Product Owner (human) | web UI sender; not an agentchattr runtime identity |
| — | Gemini — Tech Lead / CEO decision owner | above/outside agentchattr; not a routine swarm participant |
| chatgpt | ChatGPT — Architecture Engineer | outside agentchattr; manually relayed by user |

### Inside agentchattr (internal workflow agents + safety gate)

| Name in agentchattr | Role | Base |
|---|---|---|
| codex_coordinator | Codex #1 — Principal Engineer Reviewer / Workflow Coordinator | manual relay or future integration |
| claude_developer | Claude — Developer / Implementer | claude |
| claude-2 (or claude-N) | Additional Claude instances if needed | claude |
| codex_reviewer | Codex #2 — Reviewer / Principal Engineer Reviewer | manual relay or future integration; MUST be separate from codex_coordinator |
| codex_safe | Internal Safety Gate / Boundary Guard | manual relay or future integration; NOT a workflow persona |
| agy_ui_lead | AGY — UI Lead / UX QA Lead (UI/UX-only) | store-relay exec or manual relay |

The "user" sender represents Khun Chat (Human Operator / Product Owner) typing directly in the agentchattr web UI. ChatGPT operates **outside** agentchattr and is relayed manually. Gemini (Tech Lead) sits **above/outside** agentchattr as the decision gate and is not a routine swarm participant. See `docs/agent-workflow/AUTHORITY_MATRIX.md` and `docs/ai-roles/` for full role detail.

### Hierarchy and direction (inside vs outside)

- **Khun Chat (Human Operator / Product Owner)** — the user; not an agentchattr runtime identity.
- **Gemini (Tech Lead)** — above/outside agentchattr; the decision gate for architecture, phase, commit, risk, merge, production, and live-execution. Reports to Khun Chat.
- **ChatGPT (Architecture Engineer)** — outside agentchattr; analyzes architecture, produces plans/constraints/task briefs. The user manually passes ChatGPT output into agentchattr. Escalates to Gemini when a decision or approval is needed.
- **codex_coordinator (Codex #1)** — inside agentchattr; receives briefs through the user, coordinates `claude_developer`, `codex_reviewer`, `codex_safe`, and `agy_ui_lead`. Reports swarm results for upstream relay. Cannot authorize commits or product decisions.
- **codex_reviewer (Codex #2)** — inside agentchattr; independently reviews diffs, tests, safety, evidence, and scope. MUST be a separate identity from codex_coordinator.
- **claude_developer / codex_safe / agy_ui_lead** — inside agentchattr; implement, safety-gate, and UI-review respectively.

## 3. Authority Rules

- agentchattr is transport only. It does not authorize anything.
- Tech Lead / CEO retains all phase authorization, commit authorization, and implementation authorization.
- Codex PASS does not authorize commit.
- AGY PASS does not authorize commit.
- Principal Engineer PASS does not authorize commit.
- Only an explicit Tech Lead / CEO authorization message authorizes staging and commit.
- Workflow docs (STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md) remain the ultimate source of truth.
- If chat messages and workflow docs disagree, docs win until Tech Lead / CEO resolves the conflict.

## 4. Standard Room Usage

- **general**: default channel for task routing, handoffs, and status updates.
- Additional channels may be created for specific phases if needed (e.g., "ui-08", "tooling").
- All routing messages should include the phase name for traceability.

## 5. Standard Routing Packet Format

When routing a task handoff via agentchattr, use this format:

```
TO: [recipient name]
PHASE: [phase name]
MODE: [implementation / review / docs-only / read-only]
TASK: [one-line summary]

[detailed instructions]

AUTHORIZED FILES: [list]
FORBIDDEN: [list]
STOP CONDITION: [when to stop]
```

The @mention (e.g., @claude) triggers delivery to the named agent.

## 6. Standard Report Format

When reporting results via agentchattr, use this format:

```
FROM: [sender name]
PHASE: [phase name]
VERDICT: [PASS / PASS WITH NOTES / FAIL / REQUEST CHANGES]
FILES CHANGED: [list]
CHECKS: [summary of git/test results]
NEXT OWNER: [who should act next]
STOP CONDITION: [current stop]
```

## 7. Repo Touch vs Read-Only vs Commit Rules

### Read-Only

- Agent inspects files, runs git status, runs tests.
- No file edits, no staging, no commit.
- Used for: reviews, audits, discovery.

### Repo Touch (Implementation)

- Agent edits authorized files only.
- No staging or commit without explicit Tech Lead / CEO authorization.
- Used for: implementation, hotfixes, docs updates.

### Commit

- Agent stages exactly the authorized files and commits with the exact authorized message.
- Requires explicit Tech Lead / CEO authorization.
- Post-commit verification required (git status clean, correct HEAD, stash untouched).

## 8. Critical CWD Rule

Live Claude agents started via agentchattr launch in:

```
C:\tools\agentchattr-scratch
```

This is the safe scratch workspace, NOT the Twinpet repo.

Every Repo Touch packet (implementation, docs update, commit) MUST begin with:

```
cd /d C:\Users\Narachat\twinpet-pos
```

before any file edit, git command, or test run.

Failure to change directory means the agent is operating in the scratch workspace and will not find or modify the correct files.

Read-Only packets that only inspect the Twinpet repo must also cd into it first.

## 9. Commit Authorization Rules

1. Only the Tech Lead / CEO can authorize a commit.
2. The authorization must specify:
   - exact files to stage
   - exact commit message
   - any forbidden files
3. The agent must run preflight checks before staging.
4. The agent must verify the staged package matches exactly before committing.
5. The agent must run post-commit verification.
6. If any check fails, STOP and report. Do not force the commit.

## 10. Safety Rules

### Forbidden launchers and modes

- start_claude_skip-permissions.bat is FORBIDDEN.
- --dangerously-skip-permissions is FORBIDDEN.
- bypass mode is FORBIDDEN.
- yolo mode is FORBIDDEN.
- auto-approve mode is FORBIDDEN.
- Any permission-disabling wrapper is FORBIDDEN.

### Forbidden actions

- git add . is FORBIDDEN.
- Touching stash@{0} is FORBIDDEN.
- Modifying package.json or lockfiles without explicit phase authorization is FORBIDDEN.
- Modifying agentchattr code, config, or settings from within a Twinpet task is FORBIDDEN.
- Real Twinpet workflow routing through agentchattr without this protocol is FORBIDDEN.
- Promoting or merging dry-run identities (e.g. claude_dryrun) to main is FORBIDDEN. Production Claude remains relay-ineligible unless a separate Gemini-approved production activation gate explicitly authorizes it.

### Required verifications

- Before every commit: preflight (git status, diff, log, stash list).
- After every commit: post-commit verification (git status clean, correct HEAD, stash untouched).
- git diff --check must PASS before staging.

## 11. Routing Examples

### Example 1: CEO routes implementation task to Claude

In agentchattr web UI, CEO types:

```
@claude
TO: Claude Developer Agent
PHASE: 7C-UI-08-ACTION-BUTTONS
MODE: Implementation
TASK: Implement action button visual polish per discovery plan.
AUTHORIZED FILES: src/pages/POSPage.tsx, src/pages/POSPage.css
FORBIDDEN: useCart.ts, cartUtils.ts, PaymentModal, checkout logic
STOP CONDITION: After implementation, stop. Do not stage or commit.
```

### Example 2: Claude reports implementation complete

Claude replies in agentchattr:

```
FROM: Claude Developer Agent
PHASE: 7C-UI-08-ACTION-BUTTONS
VERDICT: IMPLEMENTATION COMPLETE
FILES CHANGED: src/pages/POSPage.tsx, src/pages/POSPage.css
CHECKS: tsc PASS, vitest 242 PASS, git diff --check PASS
NEXT OWNER: AGY for UX review
STOP CONDITION: Waiting for AGY review. No staging, no commit.
```

### Example 3: CEO authorizes commit

```
@claude
PHASE: 7C-UI-08-ACTION-BUTTONS
AUTHORIZATION: commit approved.
STAGING: git add src/pages/POSPage.tsx src/pages/POSPage.css docs/agent-workflow/STATE.md docs/agent-workflow/CURRENT_PACKET.md docs/agent-workflow/NEXT_ACTION.md docs/reports/latest-developer-report.md docs/reports/latest-agy-review.md
COMMIT MESSAGE: style(pos): polish action button layout
```

## 12. Known Limitations

1. **10-second presence timeout**: agentchattr agents must heartbeat every 5 seconds. The interactive wrapper (start_claude.bat) handles this automatically. API-only registrations timeout quickly.

2. **Non-Claude agents require manual relay**: ChatGPT, AGY, and Codex do not have direct agentchattr integrations. The CEO must copy messages between agentchattr and those agents manually until integrations are built.

3. **Slot naming**: Multiple Claude instances register as claude, claude-2, claude-3, etc. The label field provides human-readable names but the sender in message history shows the slot name.

4. **No persistent agent state**: When a Claude agent disconnects and reconnects, it loses conversation context. The wrapper handles reconnection but the agent starts fresh.

5. **CWD limitation**: The agent starts in the scratch workspace. Every Twinpet operation requires an explicit cd command. Forgetting this silently operates on the wrong directory.

## 13. Fallback Rule

If agentchattr is unavailable mid-phase (server down, port conflict, agent cannot connect):

1. Revert immediately to the manual copy-paste workflow.
2. Mark the phase handoff as "FALLBACK: manual routing (agentchattr unavailable)".
3. Continue the phase using the standard workflow docs (STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md).
4. Do not block the phase waiting for agentchattr to recover.
5. The old manual workflow remains valid and available at all times.

---

## Summary

agentchattr is a convenience tool that reduces copy-paste overhead. It does not change who decides, who authorizes, or what the source of truth is. The governance chain, workflow docs, and safety rules remain exactly as they were before agentchattr was introduced.
