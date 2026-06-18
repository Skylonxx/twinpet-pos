# Latest Developer Report

## Phase

TOOLING-AGENTCHATTR-PILOT-0 -- docs-only agentchattr discovery and evaluation.

## 1. Summary

This report evaluates agentchattr as a potential Local Coordinator tool for the Twinpet multi-agent workflow. The evaluation is based on read-only research (public GitHub repository and web search). No tool was installed or executed. UI-06 is marked DONE in the master plan (CEO Physical UAT PASS on `ab7eceb`).

## 2. What is agentchattr?

Source: https://github.com/bcurts/agentchattr

agentchattr is a free, local chat platform where AI coding agents can tag each other, communicate, and coordinate with a human operator. It is not an npm package -- it is a standalone Python-based application with a web UI.

Key characteristics:

- Multi-agent chat: multiple AI agent instances (Claude, Codex, Gemini, Copilot, etc.) can be connected to a shared chat room where they tag each other with @mentions.
- Local only: runs entirely on the local machine. No cloud service, no external API beyond what the agents themselves use.
- Agent routing via @mentions: messages addressed to @claude or @codex are routed to the appropriate agent instance. The system uses queue files for triggers.
- Auto-registration: each agent instance auto-registers with its own identity, color, and status pill. Multiple instances of the same provider get sequential names (claude, claude-2, claude-3).
- Renameable instances: status pills can be renamed (e.g. "claude-2" to "code-review") and all existing messages update to reflect the new name.
- Cross-platform: Windows uses Win32 WriteConsoleInput for keystroke injection; Mac/Linux uses tmux send-keys. The chat server and web UI are Python + browser.
- Python stack: FastAPI + uvicorn for the server, with MCP support. Dependencies listed in requirements.txt. Auto-creates a virtual environment on first launch.
- Not an npm package: standalone Python app, not integrated into Node.js toolchains.

## 3. What problem would it solve for Twinpet?

The Twinpet workflow currently uses a manual file-based handoff system:

- Developer writes code and updates STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md.
- Human operator copy-pastes prompts to route work to AGY, Codex, Principal Engineer, or Tech Lead.
- Each handoff requires the human to read NEXT_ACTION.md, copy the prompt, switch to the correct agent context, and paste.
- Common errors: stale NEXT_ACTION routing (Rule 3), package file mismatches, forgotten AGY-before-Codex ordering, git diff --check failures carried across reviews.

agentchattr could potentially help with:

- Structured agent-to-agent routing: instead of copy-paste, the human types @agy or @codex in the chat to route the next review prompt.
- Reducing stale handoff state: if the routing is visible in a shared chat log, stale state is easier to spot.
- Preserving the review chain: the @mention routing could enforce Developer -> AGY -> Codex -> Principal Engineer -> Tech Lead ordering.
- Audit trail: chat history provides a natural log of who received what prompt and when.
- Reducing context-switch friction: the human operator stays in one interface instead of switching between agent sessions.

## 4. How it could fit into the current workflow

Current chain: Developer -> AGY -> Codex -> Principal Engineer -> Tech Lead / CEO

Potential agentchattr roles:

- As a LOCAL COORDINATOR chat room: the human operator and all agent instances share a chat. The Local Coordinator contract (docs/agent-workflow/LOCAL_COORDINATOR_CONTRACT.md) defines an advisory-only helper. agentchattr could serve as the communication medium for that helper -- flagging issues in the chat, suggesting routing, and letting the human decide.

- As a HANDOFF QUEUE: instead of the human reading NEXT_ACTION.md and copy-pasting, the Developer agent posts a handoff message (@agy please review...) in the chat, and the human confirms or redirects.

- As a STATE ROUTER: the system could display the current workflow state (phase, owner, verdict) as a persistent status, reducing the chance of stale routing.

- As a REVIEW PROMPT CARRIER: pre-formatted review prompts (currently in NEXT_ACTION.md) could be posted as chat messages, ready for the human to forward with @mention.

- As an AUDIT TRAIL HELPER: the chat log captures the full sequence of handoffs, reviews, and decisions in one place.

What it would NOT replace:

- The file-based workflow docs (STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md) remain the source of truth.
- Tech Lead / CEO authorization still flows through the existing governance chain.
- The Local Coordinator contract's advisory-only status is unchanged.
- agentchattr would not have commit, staging, or scope authority.

## 5. Safe pilot model

Proposed TOOLING-AGENTCHATTR-PILOT-1 (if authorized):

Isolation constraints:
- Install in a separate directory or virtual environment, not inside the twinpet-pos project tree.
- No modifications to package.json, lockfiles, or node_modules.
- No app code access from agentchattr.
- No automatic commits or staging from agentchattr.
- No agent instance can bypass Tech Lead / CEO approval.
- No tool can touch stash@{0}.
- agentchattr cannot write to docs/agent-workflow/* or docs/reports/*.
- The .gitignore and .claude ignore policies remain unchanged.

Reversibility:
- The Python virtual environment can be deleted to fully remove agentchattr.
- No project files are modified by the install.
- If the pilot fails, the manual file-based workflow continues unchanged.

Pilot scope:
- Install agentchattr in an isolated location.
- Launch a single Claude agent instance.
- Verify it works on Windows 11 with the existing Claude Code CLI.
- Send a test message and confirm routing works.
- Report results.
- Do not use it for real workflow routing until Tech Lead / CEO authorizes production use.

## 6. Risk analysis

Package/lockfile contamination:
- MEDIUM risk if installed inside the project directory. agentchattr is Python-based, so it would not directly modify package.json or node lockfiles. However, if installed carelessly inside the project tree, its Python venv, __pycache__, and config files could pollute the Git working tree.
- MITIGATION: install outside the project directory.

Config sprawl:
- LOW risk. agentchattr auto-creates config on first launch. If installed outside the project tree, no project config is affected.
- MITIGATION: install in a dedicated directory (e.g. ~/tools/agentchattr).

Role confusion:
- MEDIUM risk. If agent instances are renamed (e.g. "claude-2" to "coordinator"), users might mistake the tool's chat for authoritative governance decisions.
- MITIGATION: the Local Coordinator contract explicitly states advisory-only. Chat messages are suggestions, not approvals.

Stale state:
- LOW risk. agentchattr is a live chat -- messages are current. However, if the chat is used alongside the file-based workflow, the two could diverge.
- MITIGATION: the file-based workflow docs remain the source of truth. Chat is advisory only.

Accidental auto-execution:
- MEDIUM-HIGH risk. agentchattr can inject keystrokes into agent consoles (Win32 WriteConsoleInput on Windows). If misconfigured, it could send unintended commands to a running Claude Code session.
- MITIGATION: do not use auto-approve variants during the pilot. Require human confirmation for all agent interactions.

Security/token/privacy:
- LOW risk for local-only operation. agentchattr runs locally and does not send data to external services beyond what the agents themselves use. However, chat logs stored on disk could contain sensitive project context.
- MITIGATION: do not store chat logs in the Git repository. Review what data agentchattr persists locally.

Windows shell/path:
- LOW-MEDIUM risk. The Windows wrapper uses Win32 WriteConsoleInput, which is platform-specific. Path handling differences (backslashes, spaces in paths) could cause issues.
- MITIGATION: test on the actual Windows 11 environment during the pilot before any production use.

Thai/UTF-8 Markdown corruption:
- LOW risk. agentchattr itself does not edit Markdown files. However, if chat messages containing Thai text are copy-pasted into docs, encoding issues could occur.
- MITIGATION: the existing Rule 5 (ASCII-only reporting) applies to any Local Coordinator output. Thai content in project docs is handled by existing UTF-8-preserving edit practices.

Interaction with existing .claude ignore policy:
- LOW risk. agentchattr is a separate Python application and does not interact with .claude/ configuration.
- MITIGATION: verify during the pilot that agentchattr does not create files inside .claude/.

## 7. Recommendation

**RECOMMEND PILOT WITH CONDITIONS**

agentchattr appears to be a reasonable fit for the Local Coordinator use case: it provides a structured multi-agent chat with @mention routing, local-only operation, and cross-platform support. It would not replace the existing governance chain or file-based workflow -- it would serve as an advisory communication layer.

Conditions for pilot authorization:

1. Install outside the twinpet-pos project directory (e.g. ~/tools/agentchattr or C:/tools/agentchattr).
2. Do not use auto-approve agent wrappers during the pilot.
3. Do not grant agentchattr write access to project files.
4. Do not use agentchattr for real workflow routing until a successful controlled test is completed and Tech Lead / CEO authorizes production use.
5. The file-based workflow (STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md) remains the source of truth throughout.
6. The Local Coordinator contract (advisory-only, no authority) remains binding.
7. If any risk materializes during the pilot, stop and revert to the manual workflow.

## 8. Proposed next phase if approved

**TOOLING-AGENTCHATTR-PILOT-1** -- controlled install and isolated test.

Scope:
- Install agentchattr in an isolated directory outside the project tree.
- Launch the chat server and a single Claude agent instance.
- Verify Windows 11 compatibility.
- Send a test handoff message and confirm routing.
- Report results (no real workflow routing yet).
- Reversible: delete the install directory to fully remove.

Do not start this phase until Tech Lead / CEO authorization is issued.

## 9. Files changed by this task

- docs/agent-workflow/UI_MASTER_PLAN.md -- UI-06 marker changed from [CURRENT] to [DONE].
- docs/agent-workflow/STATE.md -- phase, owner, scope, pipeline updated for TOOLING-AGENTCHATTR-PILOT-0.
- docs/agent-workflow/CURRENT_PACKET.md -- new packet for discovery phase.
- docs/agent-workflow/NEXT_ACTION.md -- routes to Principal Engineer, then Tech Lead / CEO.
- docs/reports/latest-developer-report.md -- this report.

## 10. Files inspected

- docs/agent-workflow/LOCAL_COORDINATOR_CONTRACT.md (the advisory-only contract).
- docs/agent-workflow/LOCAL_COORDINATOR_PILOT.md (pilot design and safety rules).
- docs/agent-workflow/UI_MASTER_PLAN.md (to update UI-06 marker).
- docs/agent-workflow/STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md (prior state).

## 11. Research performed

- Web search: "agentchattr CLI tool multi-agent workflow 2025 2026"
- Web search: "agentchattr npm package github agent chat routing"
- Web search: "site:github.com/bcurts/agentchattr features install setup requirements"
- Source: https://github.com/bcurts/agentchattr (public GitHub repository, read-only)

## 12. Boundary confirmation

- no install: confirmed
- no agentchattr run: confirmed
- no package.json: confirmed
- no lockfile: confirmed
- no scripts: confirmed
- no app code: confirmed
- no tests: confirmed
- no Firebase/functions/rules: confirmed
- no Android/Capacitor: confirmed
- no .claude: confirmed
- no UI-07/UI-08/UI-09: confirmed
- no staging: confirmed
- no commit: confirmed

## STATE CARD

```
STATE CARD
Phase: TOOLING-AGENTCHATTR-PILOT-0
Current owner: Developer Agent
Verdict: Discovery complete (pending Principal Engineer review)
Files changed: UI_MASTER_PLAN.md (UI-06 marker); STATE.md; CURRENT_PACKET.md; NEXT_ACTION.md; latest-developer-report.md
Files inspected: LOCAL_COORDINATOR_CONTRACT.md; LOCAL_COORDINATOR_PILOT.md; UI_MASTER_PLAN.md; STATE.md; CURRENT_PACKET.md; NEXT_ACTION.md
Research performed: web search (3 queries); GitHub repo review (bcurts/agentchattr)
Tests/checks: git diff --check (pending after edits)
Staged: no
Committed: no
Required fixes: none
Next owner: Principal Engineer Reviewer / Workflow Coordinator
Next action: Governance review of discovery report; then Tech Lead / CEO install/pilot decision
Stop condition: No install, no execution, no staging, no commit; wait for Principal Engineer review and Tech Lead / CEO decision
```
