# Authority Matrix

Single source of truth for **who decides what** and **when to escalate** in the Twinpet multi-agent workflow. If any other doc conflicts with this table on authority, this file and the live workflow docs (`STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`) win; resolve the conflict explicitly with Khun Chat / Gemini.

Read `AGENTS.md` first. Role detail files live in [`docs/ai-roles/`](../ai-roles/).

---

## 1. Hierarchy at a glance

```
Khun Chat — CEO / Product Owner / Final Decision Owner
      ▲
Gemini — Tech Lead / CEO decision owner (architecture, phase gate, commit, risk)
      ▲
ChatGPT — System Architect / Principal Workflow Architect   (outside agentchattr)
      ▲
Codex — Principal Engineer Reviewer / Workflow Coordinator  (inside agentchattr)
      ├── Claude    — Developer / Implementer
      ├── CodexSafe — Safety Reviewer / Boundary Reviewer
      └── AGY       — UI Lead / UX Reviewer
```

ChatGPT directs Codex from outside the swarm. Codex coordinates Claude, CodexSafe, and AGY inside agentchattr and reports back to ChatGPT. ChatGPT fixes workflow/prompt/report issues directly and escalates authority matters up to Gemini, then Khun Chat.

---

## 2. Authority table

| Role | Authority level | Can decide locally? | Reports to | Must escalate when |
|---|---|---|---|---|
| **Khun Chat** (CEO / Product Owner) | Final | Anything | — (top) | Never escalates; owns final closure |
| **Gemini** (Tech Lead) | Decision gate | Architecture, phase gate, commit approval, risk acceptance | Khun Chat | Product-ownership / business-priority calls needing CEO |
| **ChatGPT** (System Architect) | Workflow authority | Workflow/phase structure, prompts, report-format fixes, escalation memos | Gemini → Khun Chat | Architecture, product, phase gate, commit, final closure |
| **Codex** (Workflow Coordinator) | Coordination only | Read-only routing, report collation, no-op dry-run sequencing | ChatGPT | Architecture, product, phase, commit — any authority matter |
| **Claude** (Developer) | Execution only | Implementation details within authorized scope | Codex | Scope ambiguity, any decision beyond the packet |
| **CodexSafe** (Safety Reviewer) | Block-only | May **BLOCK** on safety/boundary violation | Codex | Cannot authorize anything; block is its only lever |
| **AGY** (UI/UX Reviewer) | Reject-only | May **REJECT** UI failing Impeccable.style | Codex | Cannot authorize commits; reject is its only lever |

---

## 3. Prohibited decisions per role

- **ChatGPT MUST NOT** authorize commits, product decisions, or phase gates alone; MUST NOT replace Khun Chat / Gemini; MUST NOT call the swarm production-ready.
- **Codex MUST NOT** authorize commits, make product/architecture/phase decisions, accept risk, or override a CodexSafe BLOCK.
- **Claude MUST NOT** expand scope, self-approve risk, or act on prompts addressed to another agent.
- **CodexSafe MUST NOT** authorize commits or accept risk (block-only).
- **AGY MUST NOT** authorize commits or business logic (reject-only on UI/UX).
- **No agent** may touch `stash@{0}`, use unsafe flags, approve `Target:*`, use paid-API fallback, or run `git add .`. See [`SKILL-SAFETY-BOUNDARY-REVIEW.md`](../skills/SKILL-SAFETY-BOUNDARY-REVIEW.md).

---

## 4. Escalation examples

| Situation | Who decides locally | Who escalates | Final authority |
|---|---|---|---|
| Reorder dry-run turns | Codex | — | Codex |
| Fix a malformed report prompt | ChatGPT | — | ChatGPT |
| Choose between two CSS-only layouts | Claude proposes, AGY judges UI | Codex → ChatGPT if design impact | ChatGPT / Gemini |
| Approve a new phase (e.g. UI-08) | nobody | ChatGPT → Gemini | Gemini, then Khun Chat |
| Authorize a commit | nobody | ChatGPT → Gemini | Gemini / Khun Chat (explicit message) |
| Safety violation found | CodexSafe BLOCKs | Codex → ChatGPT | Resolve violation or Gemini/Khun Chat decision |
| Business-rule / pricing change | nobody | ChatGPT → Gemini → Khun Chat | Khun Chat |

---

## 5. Dry-run stop protocol

During an autonomous swarm dry-run (see [`SKILL-AUTONOMOUS-SWARM-DRY-RUN.md`](../skills/SKILL-AUTONOMOUS-SWARM-DRY-RUN.md)), Codex MUST halt and report to ChatGPT when:

1. A loop or drift is detected (repeat without new info, scope creep).
2. CodexSafe returns **BLOCKED**.
3. Any role requests an unsafe flag, broad permission, `Target:*`, or paid-API fallback.
4. A write is attempted in a no-write dry-run.
5. A required decision exceeds Codex's local authority.

ChatGPT then fixes what is procedural, or escalates to Gemini / Khun Chat for authority matters. A dry-run never authorizes real writes, commits, or live autonomous operation.

---

## 6. Standing reminders

- agentchattr is **transport only** — it does not decide or authorize anything.
- Workflow docs (`STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`) are the live source of truth; if chat and docs disagree, docs win.
- Only an explicit Khun Chat / Gemini authorization authorizes staging and commit.
