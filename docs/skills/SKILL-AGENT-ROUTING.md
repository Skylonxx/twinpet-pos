# SKILL: Agent Routing

This project uses a coordinated multi-agent workflow. AI roles must be explicitly loaded and respected.

## Hierarchy (current)

- **Khun Chat:** CEO / Product Owner / Final Decision Owner.
- **Gemini:** Tech Lead / CEO decision owner (architecture, phase gate, commit, risk).
- **ChatGPT:** System Architect / Principal Workflow Architect — **outside** agentchattr. Designs workflow/phases, directs Codex, reviews swarm reports, escalates to Gemini.
- **Codex:** Principal Engineer Reviewer / Workflow Coordinator — **inside** agentchattr. Coordinates Claude, CodexSafe, and AGY; collates and reports to ChatGPT. (Review-checklist facet: `docs/ai-roles/reviewer.md`.)
- **CodexSafe:** Safety Reviewer / Boundary Reviewer. Checks hard safety/boundary violations; may BLOCK.
- **AGY:** UI Lead / UX Reviewer (Senior QA). Impeccable.style review; may REJECT UI.
- **Claude:** Developer / Implementer (when the user says Claude is active).
- **Antigravity:** Environment/config/audit/docs/special execution (when active).

> **Correction (was stale):** ChatGPT is **no longer** "Principal Engineer Reviewer / Workflow Coordinator." That title now belongs to **Codex** (inside agentchattr). ChatGPT is the **System Architect / Principal Workflow Architect** outside agentchattr.

## Workflow direction

- ChatGPT directs Codex from outside agentchattr.
- Codex controls the in-agentchattr swarm (Claude implements, CodexSafe checks safety, AGY reviews UI/UX).
- Codex summarizes results to ChatGPT. ChatGPT fixes prompt/workflow directly, or escalates authority matters to Gemini → Khun Chat.

Full authority table: `docs/agent-workflow/AUTHORITY_MATRIX.md`.

## Routing Rules

- If a prompt is addressed to another role (`TO: [Agent]`), DO NOT execute it without explicit confirmation.
- Skills supplement AI roles; they do not replace roles.
- Antigravity is not a permanent replacement for Claude; Claude remains the primary builder when active.
- agentchattr is transport only — it does not decide or authorize anything.
- Tech Lead / CEO directives ALWAYS override generic skill wording.
