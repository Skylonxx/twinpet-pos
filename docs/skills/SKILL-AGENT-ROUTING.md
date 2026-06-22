# SKILL: Agent Routing

This project uses a coordinated multi-agent workflow. AI roles must be explicitly loaded and respected.

## Topology

### Outside agentchattr (upstream, manually controlled by user)

- **Khun Chat:** Human Operator / Product Owner. The user. Not an agentchattr runtime identity.
- **Gemini:** Tech Lead / CEO decision owner. Upstream decision gate. Decides scope, authorizes phases, closes phases, owns merge/production/live-execution decisions. Not an agentchattr runtime identity.
- **ChatGPT:** Architecture Engineer. Upstream architecture role. Analyzes architecture, produces plans/context/constraints/task briefs. The user manually passes ChatGPT output into agentchattr. Not the internal runtime coordinator.

### Inside agentchattr (internal workflow agents)

- **codex_coordinator** (Codex #1): Principal Engineer Reviewer / Workflow Coordinator. Receives ChatGPT briefs through the user, breaks work into phases, dispatches to claude_developer/codex_reviewer/agy_ui_lead. MUST be separate from codex_reviewer.
- **claude_developer** (Claude): Developer / Implementer. Implements code, fixes, tests, reports.
- **codex_reviewer** (Codex #2): Reviewer / Principal Engineer Reviewer. Independently reviews diffs, tests, safety, evidence, scope. MUST be separate from codex_coordinator.
- **agy_ui_lead** (AGY): UI Lead / UX QA Lead. UI/UX-only. Not a generic developer or unrestricted reviewer.

### Internal safety gate

- **codex_safe**: Internal Safety Gate / Boundary Guard. NOT a workflow persona. NOT a replacement for codex_reviewer or Gemini. Its BLOCK is binding and cannot be overridden by codex_coordinator.

Full authority table: `docs/agent-workflow/AUTHORITY_MATRIX.md`.

## Workflow direction

- ChatGPT (Architecture Engineer) produces briefs; the user manually relays them into agentchattr.
- codex_coordinator (Codex #1) receives briefs, dispatches work to claude_developer, codex_reviewer, codex_safe, and agy_ui_lead.
- codex_coordinator collates results for upstream relay. ChatGPT fixes prompt/workflow directly, or escalates authority matters to Gemini → Khun Chat.

## Routing Rules

- If a prompt is addressed to another role (`TO: [Agent]`), DO NOT execute it without explicit confirmation.
- Skills supplement AI roles; they do not replace roles.
- Antigravity is not a permanent replacement for Claude; Claude remains the primary builder when active.
- agentchattr is transport only — it does not decide or authorize anything.
- Tech Lead / CEO directives ALWAYS override generic skill wording.
- codex_coordinator and codex_reviewer MUST be separate identities.
- codex_safe is a safety gate, not a workflow persona.
- dryrun/claude-relay-live-1 is an evidence branch — must never be merged to main.
- main remains dormant unless a future Gemini gate explicitly authorizes integration.
- Production Claude remains relay-ineligible unless a separate Gemini-approved production activation gate explicitly authorizes it. Dry-run identities such as claude_dryrun must not be merged or promoted to main.
