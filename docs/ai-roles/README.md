# AI Roles — Twinpet POS

Central location for AI agent roles. Any agent should load the correct role file before acting.

**Project root instructions:** `AGENTS.md` (always read first).

---

## Quick start

Tell the agent which role to assume:

```
Read docs/ai-roles/<role>.md and act as that role for this task.
```

---

## Topology overview

### Outside agentchattr (upstream, manually controlled by user)

These roles operate **outside** the agentchattr runtime. The user manually relays their output into agentchattr when needed.

- **Khun Chat** — Human Operator / Product Owner. The user. Not an agentchattr runtime identity.
- **Gemini** — Tech Lead / CEO decision owner. Upstream decision gate. Not an agentchattr runtime identity.
- **ChatGPT** — Architecture Engineer. Upstream architecture role. Not an agentchattr runtime identity.

### Inside agentchattr (internal workflow agents)

- **codex_coordinator** (Codex #1) — Principal Engineer Reviewer / Workflow Coordinator.
- **claude_developer** (Claude) — Developer / Implementer.
- **codex_reviewer** (Codex #2) — Reviewer / Principal Engineer Reviewer.
- **agy_ui_lead** (AGY) — UI Lead / UX QA Lead. UI/UX-only.

### Internal safety gate

- **codex_safe** — Internal Safety Gate / Boundary Guard. Not a workflow persona. Not a replacement for codex_reviewer or Gemini. Its BLOCK is binding.

> **codex_coordinator and codex_reviewer MUST be separate identities.** They must never be the same agent instance in the same workflow. codex_coordinator coordinates the swarm; codex_reviewer independently reviews diffs and evidence.

> **Production Claude ineligibility:** Production Claude remains relay-ineligible unless a separate Gemini-approved production activation gate explicitly authorizes it. Dry-run identities such as `claude_dryrun` must not be merged or promoted to main.

---

## Roles

| File | Identity / Agent | Loads when |
|------|------------------|------------|
| [system-architect.md](./system-architect.md) | ChatGPT / `chatgpt`, Architecture Engineer (outside agentchattr) | Analyzing architecture, producing plans/constraints/task briefs, escalation memos |
| [workflow-coordinator.md](./workflow-coordinator.md) | Codex #1 / `codex_coordinator`, Principal Engineer Reviewer / Workflow Coordinator (inside agentchattr) | Coordinating the in-swarm game, dispatching to claude_developer/codex_reviewer/agy_ui_lead, collating reports |
| [reviewer.md](./reviewer.md) | Codex #2 / `codex_reviewer`, Reviewer / Principal Engineer Reviewer (inside agentchattr) | Independently reviewing a diff/report (Paranoid Checklist, verdict) |
| [safety-reviewer.md](./safety-reviewer.md) | `codex_safe`, Internal Safety Gate / Boundary Guard (inside agentchattr) | Checking hard safety/boundary violations; may BLOCK |
| [developer.md](./developer.md) | Claude / `claude_developer`, Developer / Implementer (inside agentchattr) | Implementing code, tests, reports |
| [ux-lead.md](./ux-lead.md) | AGY / `agy_ui_lead`, UI Lead / UX QA Lead (inside agentchattr) | Impeccable.style UI/UX review only; may REJECT |
| [tech-lead.md](./tech-lead.md) | Gemini, Tech Lead / CEO decision owner (outside agentchattr) | Scope decisions, risk acceptance, go/no-go, merge/production/live-execution authorization |
| [environment-auditor.md](./environment-auditor.md) | Antigravity, Firebase / deploy audit | Phase 3 Gate 2, pre-deploy safety checks |
| [ui-implementer.md](./ui-implementer.md) | Isolated UI work | Route-only pages, conflict-free UI steps |

---

## Examples

**claude_developer — implementation task:**
> Read `docs/ai-roles/developer.md` and act as that role. Implement Track B Step 2 per the approved proposal.

**codex_reviewer — independent review pass:**
> Read `docs/ai-roles/reviewer.md` and act as that role. Review the staged diff and latest report.

**Scope decision before work (Gemini):**
> Read `docs/ai-roles/tech-lead.md` and act as that role. Decide whether Phase 3 Gate 2 is GO.

**Pre-deploy environment audit:**
> Read `docs/ai-roles/environment-auditor.md` for Phase 3 Gate 2. Audit only — no deploy.

**Isolated admin UI:**
> Read `docs/ai-roles/ui-implementer.md`. List files before implementation; route-only; no stash.

**Antigravity — environment audit (Phase 3 Gate 2):**
> `TO: Antigravity` — Read `docs/ai-roles/environment-auditor.md` and act as that role. Audit only; no deploy or delete.

**Antigravity — temporarily replacing Claude:**
> `TO: Antigravity` — Read `docs/ai-roles/developer.md` and act as that role. Same constraints as Claude: no deploy/delete unless explicitly approved, no `stash@{0}`, no Flowbite migration, no unrelated changes.

---

## Antigravity

No separate `antigravity.md` — reuse existing roles:

| Task | Role file | Constraints |
|------|-----------|-------------|
| Firebase / deploy / env audit | `environment-auditor.md` | Audit-only; no deploy; no `functions:delete` unless approved |
| Temporarily replacing Claude | `developer.md` | Approved scope only; update `latest-report.md` when required |

Antigravity must follow the same hard restrictions as every other agent. A `TO: Antigravity` header is required before acting.

---

## Prompt routing (`TO:` headers)

Execute **only** when the prompt is addressed to the **active** agent. See `AGENTS.md` for the full rule.

| Header | Identity | Default role |
|--------|----------|--------------|
| `TO: ChatGPT` | `chatgpt` (outside agentchattr) | system-architect (architecture, plans, task briefs) |
| `TO: Cursor Agent` | — | developer (unless task says reviewer/audit) |
| `TO: Codex Coordinator` | `codex_coordinator` (Codex #1, inside) | workflow-coordinator (swarm coordination) |
| `TO: Codex Reviewer` | `codex_reviewer` (Codex #2, inside) | reviewer (independent review pass) |
| `TO: CodexSafe` | `codex_safe` (inside, safety gate) | safety-reviewer (boundary guard) |
| `TO: Claude` | `claude_developer` (inside) | developer |
| `TO: AGY` | `agy_ui_lead` (inside) | ux-lead (UI/UX review only) |
| `TO: Gemini` | — (outside agentchattr) | tech-lead |
| `TO: Antigravity` | — | `environment-auditor.md` or `developer.md` (per task) |

Naming a role file alone is **not** permission to execute. If a prompt targets another agent, ask for confirmation.

---

## Related docs

- `AGENTS.md` — project-wide rules and default reviewer stance
- `docs/reports/latest-report.md` — rolling implementation state
- `docs/reviews/baseline-risk-review.md` — architecture risk baseline
- `.cursor/rules/reviewer.md` — Cursor rule pointer to reviewer role
