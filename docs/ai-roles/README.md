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

## Roles

| File | Agent / use case | Loads when |
|------|------------------|------------|
| [system-architect.md](./system-architect.md) | ChatGPT, System Architect / Principal Workflow Architect (outside agentchattr) | Designing workflow/phases, directing Codex, reviewing swarm reports, escalation memos |
| [workflow-coordinator.md](./workflow-coordinator.md) | Codex, Principal Engineer Reviewer / Workflow Coordinator (inside agentchattr) | Coordinating the in-swarm game (Claude, CodexSafe, AGY), collating reports to ChatGPT |
| [reviewer.md](./reviewer.md) | Codex, review checklist facet | Reviewing a diff/report (Paranoid Checklist, verdict) |
| [safety-reviewer.md](./safety-reviewer.md) | CodexSafe, Safety Reviewer / Boundary Reviewer | Checking hard safety/boundary violations; may BLOCK |
| [developer.md](./developer.md) | Claude, Cursor Agent, Antigravity (when replacing Claude), primary implementer | Implementing code, tests, reports |
| [ux-lead.md](./ux-lead.md) | AGY, UI Lead / UX Reviewer (Senior QA) | Impeccable.style UI/UX review; may REJECT |
| [tech-lead.md](./tech-lead.md) | Gemini, Tech Lead / CEO decision owner | Scope decisions, risk acceptance, go/no-go |
| [environment-auditor.md](./environment-auditor.md) | Antigravity, Firebase / deploy audit | Phase 3 Gate 2, pre-deploy safety checks |
| [ui-implementer.md](./ui-implementer.md) | Isolated UI work | Route-only pages, conflict-free UI steps |

> **Codex has two facets.** [`workflow-coordinator.md`](./workflow-coordinator.md) is *how Codex runs the in-agentchattr swarm and reports upward*; [`reviewer.md`](./reviewer.md) is *how Codex judges a specific change* (Paranoid Checklist → APPROVE / REQUEST CHANGES / BLOCK). Load the coordinator file for swarm orchestration, the reviewer file for a review pass. Neither grants commit or product-decision authority — see [`../agent-workflow/AUTHORITY_MATRIX.md`](../agent-workflow/AUTHORITY_MATRIX.md).

---

## Examples

**Replace Claude as implementer:**
> Read `docs/ai-roles/developer.md` and act as that role. Implement Track B Step 2 per the approved proposal.

**Codex review pass:**
> Read `docs/ai-roles/reviewer.md` and act as that role. Review the staged diff and latest report.

**Scope decision before work:**
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

| Header | Default role |
|--------|--------------|
| `TO: ChatGPT` | system-architect (workflow design, escalation) |
| `TO: Cursor Agent` | developer (unless task says reviewer/audit) |
| `TO: Codex` | workflow-coordinator inside agentchattr; reviewer for a review pass |
| `TO: CodexSafe` | safety-reviewer |
| `TO: Claude` | developer |
| `TO: AGY` | ux-lead (UI/UX review) |
| `TO: Gemini` | tech-lead |
| `TO: Antigravity` | `environment-auditor.md` or `developer.md` (per task) |

Naming a role file alone is **not** permission to execute. If a prompt targets another agent, ask for confirmation.

---

## Related docs

- `AGENTS.md` — project-wide rules and default reviewer stance
- `docs/reports/latest-report.md` — rolling implementation state
- `docs/reviews/baseline-risk-review.md` — architecture risk baseline
- `.cursor/rules/reviewer.md` — Cursor rule pointer to reviewer role
