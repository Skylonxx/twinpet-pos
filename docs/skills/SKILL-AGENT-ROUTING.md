# SKILL: Agent Routing

This project uses a coordinated multi-agent workflow. AI roles must be explicitly loaded and respected.

- **Gemini:** Tech Lead & decision owner.
- **ChatGPT:** Principal Engineer Reviewer & workflow coordinator.
- **Antigravity:** Environment/config/audit/docs/special execution (when active).
- **Claude:** Primary developer (when the user says Claude is active).
- **Codex:** Reviewer.

**Routing Rules:**
- If a prompt is addressed to another role (`TO: [Agent]`), DO NOT execute it without explicit confirmation.
- Skills supplement AI roles; they do not replace roles.
- Antigravity is not a permanent replacement for Claude; Claude remains the primary builder when active.
- Tech Lead / CEO directives ALWAYS override generic skill wording.
