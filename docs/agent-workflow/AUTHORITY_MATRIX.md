# Authority Matrix

Single source of truth for **who decides what** and **when to escalate** in the Twinpet multi-agent workflow. If any other doc conflicts with this table on authority, this file and the live workflow docs (`STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`) win; resolve the conflict explicitly with Khun Chat / Gemini.

Read `AGENTS.md` first. Role detail files live in [`docs/ai-roles/`](../ai-roles/).

---

## 1. Hierarchy at a glance

```
Khun Chat — Human Operator / Product Owner (not an agentchattr runtime identity)
      ▲
Gemini — Tech Lead / CEO decision owner                    (outside agentchattr)
      ▲
ChatGPT — Architecture Engineer                            (outside agentchattr)
      ▲  (user manually relays briefs into agentchattr)
codex_coordinator (Codex #1) — Workflow Coordinator        (inside agentchattr)
      ├── claude_developer  — Developer / Implementer
      ├── codex_reviewer (Codex #2) — Independent Reviewer
      ├── codex_safe     — Internal Safety Gate / Boundary Guard (NOT a workflow persona)
      └── agy_ui_lead    — UI Lead / UX QA Lead (UI/UX-only)
```

**Outside agentchattr:** Khun Chat (human), Gemini (decision gate), ChatGPT (architecture). These are upstream roles manually controlled by the user.

**Inside agentchattr:** Four internal workflow agents (`codex_coordinator`, `claude_developer`, `codex_reviewer`, `agy_ui_lead`) + one internal safety gate (`codex_safe`).

**Two-Codex rule:** `codex_coordinator` (Codex #1) and `codex_reviewer` (Codex #2) MUST be separate identities in the same workflow.

---

## 2. Authority table

| Role | Identity | Authority level | Can decide locally? | Reports to | Must escalate when |
|---|---|---|---|---|---|
| **Khun Chat** (Human Operator / Product Owner) | — (human, outside) | Final | Anything | — (top) | Never escalates; owns final closure |
| **Gemini** (Tech Lead) | — (outside agentchattr) | Decision gate | Architecture, phase gate, commit approval, risk acceptance, merge/production/live-execution | Khun Chat | Product-ownership / business-priority calls needing CEO |
| **ChatGPT** (Architecture Engineer) | `chatgpt` (outside agentchattr) | Architecture authority | Plans, constraints, task briefs, report-format fixes, escalation memos | Gemini → Khun Chat | Architecture, product, phase gate, commit, final closure |
| **codex_coordinator** (Codex #1, Workflow Coordinator) | `codex_coordinator` (inside) | Coordination only | Read-only routing, report collation, no-op dry-run sequencing | ChatGPT | Architecture, product, phase, commit — any authority matter |
| **codex_reviewer** (Codex #2, Independent Reviewer) | `codex_reviewer` (inside) | Review-only | May APPROVE / REQUEST CHANGES / BLOCK on code, evidence, scope | codex_coordinator | Cannot authorize commits; verdict is its only lever |
| **claude_developer** (Developer) | `claude_developer` (inside) | Execution only | Implementation details within authorized scope | codex_coordinator | Scope ambiguity, any decision beyond the packet |
| **codex_safe** (Internal Safety Gate) | `codex_safe` (inside) | Block-only | May **BLOCK** on safety/boundary violation | codex_coordinator | Cannot authorize anything; block is its only lever |
| **agy_ui_lead** (UI/UX QA Lead) | `agy_ui_lead` (inside) | Reject-only | May **REJECT** UI failing Impeccable.style | codex_coordinator | Cannot authorize commits; reject is its only lever (UI/UX-only) |

---

## 3. Prohibited decisions per role

- **ChatGPT MUST NOT** authorize commits, product decisions, or phase gates alone; MUST NOT replace Khun Chat / Gemini; MUST NOT call the swarm production-ready; MUST NOT act as internal runtime coordinator.
- **codex_coordinator MUST NOT** authorize commits, make product/architecture/phase decisions, accept risk, or override a `codex_safe` BLOCK. MUST NOT act as independent reviewer (that is `codex_reviewer`).
- **codex_reviewer MUST NOT** authorize commits or coordinate the swarm (that is `codex_coordinator`). MUST be a separate identity from `codex_coordinator`.
- **claude_developer MUST NOT** expand scope, self-approve risk, self-authorize commit/merge/live-execution/production activation, or act on prompts addressed to another agent.
- **codex_safe MUST NOT** authorize commits or accept risk (block-only). Is NOT a replacement for `codex_reviewer` or Gemini. Is NOT a workflow persona.
- **agy_ui_lead MUST NOT** authorize commits or business logic (reject-only on UI/UX). Is UI/UX-only — not a generic developer or unrestricted reviewer.
- **No agent** may touch `stash@{0}`, use unsafe flags, approve `Target:*`, use paid-API fallback, or run `git add .`. See [`SKILL-SAFETY-BOUNDARY-REVIEW.md`](../skills/SKILL-SAFETY-BOUNDARY-REVIEW.md).

---

## 4. Escalation examples

| Situation | Who decides locally | Who escalates | Final authority |
|---|---|---|---|
| Reorder dry-run turns | codex_coordinator | — | codex_coordinator |
| Fix a malformed report prompt | ChatGPT | — | ChatGPT |
| Choose between two CSS-only layouts | claude_developer proposes, agy_ui_lead judges UI | codex_coordinator → ChatGPT if design impact | ChatGPT / Gemini |
| Approve a new phase (e.g. UI-08) | nobody | ChatGPT → Gemini | Gemini, then Khun Chat |
| Authorize a commit | nobody | ChatGPT → Gemini | Gemini / Khun Chat (explicit message) |
| Safety violation found | codex_safe BLOCKs | codex_coordinator → ChatGPT | Resolve violation or Gemini/Khun Chat decision |
| Business-rule / pricing change | nobody | ChatGPT → Gemini → Khun Chat | Khun Chat |

---

## 5. Dry-run stop protocol

During an autonomous swarm dry-run (see [`SKILL-AUTONOMOUS-SWARM-DRY-RUN.md`](../skills/SKILL-AUTONOMOUS-SWARM-DRY-RUN.md)), `codex_coordinator` MUST halt and report when:

1. A loop or drift is detected (repeat without new info, scope creep).
2. `codex_safe` returns **BLOCKED**.
3. Any role requests an unsafe flag, broad permission, `Target:*`, or paid-API fallback.
4. A write is attempted in a no-write dry-run.
5. A required decision exceeds `codex_coordinator`'s local authority.

ChatGPT then fixes what is procedural, or escalates to Gemini / Khun Chat for authority matters. A dry-run never authorizes real writes, commits, or live autonomous operation.

---

## 6. Branch / main dormant warnings and production-Claude ineligibility

- **`dryrun/claude-relay-live-1`** is an evidence branch and **must never be merged to main**.
- **`main`** remains dormant unless a future Gemini gate explicitly authorizes a safe integration.
- **Production Claude remains relay-ineligible** unless a separate Gemini-approved production activation gate explicitly authorizes it. Dry-run identities such as `claude_dryrun` must not be merged or promoted to main.

---

## 7. Standing reminders

- agentchattr is **transport only** — it does not decide or authorize anything.
- Workflow docs (`STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`) are the live source of truth; if chat and docs disagree, docs win.
- Only an explicit Khun Chat / Gemini authorization authorizes staging and commit.
- `codex_coordinator` and `codex_reviewer` MUST be separate identities.
- `codex_safe` is a safety gate, not a workflow persona.
