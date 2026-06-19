# Tooling MCP Multi-Agent Routing Skill

Status: VERIFIED BASELINE  
Project: Twinpet POS  
Scope: Local tooling only  
Primary users: Environment Auditor, Tooling Implementer, Reviewer, Tech Lead  
Primary role consumer: Claude as Environment Auditor / Tooling Implementer  
Review consumers: ChatGPT, Gemini, Codex  
Last updated: 2026-06-19

---

## 1. Purpose

This Skill defines the mandatory operating rules for any agent working on Twinpet POS local tooling, including:

- agentchattr
- MCP routing
- Claude launcher/config behavior
- Codex safe exec-mode routing
- AGY / Antigravity launcher and routing behavior
- multi-agent relay safety
- model pinning
- evidence discipline
- repository isolation

This Skill is a safety and workflow source-of-truth. It must be injected into any future tooling prompt before modifying agentchattr, MCP, launcher, wrapper, or multi-agent routing behavior.

This Skill is not a product implementation guide. It must not be used to authorize POS UI, Firebase, inventory, checkout, or application code changes.

---

## 2. Directory and Workspace Constraints

### 2.1 Twinpet repository

Twinpet repo path:

```text
C:\Users\Narachat\twinpet-pos
```

Any operation that needs to inspect the Twinpet repository must explicitly change directory using:

```powershell
cd /d C:\Users\Narachat\twinpet-pos
```

Do not assume the current working directory is the Twinpet repository.

### 2.2 agentchattr tooling repository

agentchattr tooling path:

```text
C:\tools\agentchattr\repo
```

Known launcher paths:

```text
C:\tools\agentchattr\repo\windows\start_codex.bat
C:\tools\agentchattr\repo\windows\start_agy.bat
```

Forbidden launcher:

```text
C:\tools\agentchattr\repo\windows\start_codex_bypass.bat
```

### 2.3 Scratch directory

All safe headless agent execution must use the scratch directory unless a phase explicitly authorizes otherwise:

```text
C:\tools\agentchattr-scratch
```

Codex SAFE-EXEC-2 live validation confirmed Codex cwd:

```text
C:\tools\agentchattr-scratch
```

Agents must not perform tooling experiments from inside the Twinpet repository unless that exact repo operation is explicitly authorized.

---

## 3. Mandatory Repository Safety Checks

Before any tooling work that could touch the repo or prove repo isolation, run:

```powershell
cd /d C:\Users\Narachat\twinpet-pos
git status --short
git rev-parse --short HEAD
git stash list
```

Expected baseline during this tooling phase:

```text
HEAD: 886340b
working tree: clean, except explicitly authorized docs-only changes
stash@{0}: present and untouched
```

After any tooling patch or validation, run the same post-check.

A report must clearly state:

* working tree result
* HEAD result
* stash@{0} presence
* whether Twinpet repo files were modified
* whether any files outside the authorized scope were modified

If stash@{0} is missing or changed, stop and escalate.

---

## 4. Tooling Phase Boundary

During tooling phases, these are out of scope unless separately authorized:

* UI-08
* UI-09
* POS application code
* POS UI components
* Firebase/functions code
* inventory logic
* checkout logic
* tests unrelated to tooling
* Android/Capacitor artifacts
* production business logic

Tooling phases may inspect or modify only explicitly authorized tooling or docs paths.

---

## 5. Forbidden Flags and Unsafe Modes Matrix

These items are forbidden in all Twinpet tooling workflows. Any experiment requiring them must be moved outside Twinpet tooling, outside the Twinpet repo, and governed by a separate non-Twinpet policy.

| Tool        | Forbidden item                               | Reason                                         |
| ----------- | -------------------------------------------- | ---------------------------------------------- |
| Codex       | `--dangerously-bypass-approvals-and-sandbox` | disables approvals/sandbox                     |
| Codex       | `--yolo`                                     | unsafe auto-approval style                     |
| Codex       | `--full-auto`                                | unsafe auto-approval style for this workflow   |
| Codex       | `danger-full-access`                         | removes sandbox boundary                       |
| Claude      | `--skip-permissions`                         | bypasses safety approvals                      |
| AGY         | `--dangerously-skip-permissions`             | auto-approves tools                            |
| AGY         | broad MCP `Target: *` approval               | grants unbounded MCP access                    |
| agentchattr | `start_codex_bypass.bat`                     | unsafe launcher                                |
| Any         | bypass / full-access / auto-approve flags    | violates tooling safety posture                |
| Any         | persistent broad MCP allow rules             | unsafe, especially if written to settings.json |

Do not select any permission prompt option that persists broad MCP approval to settings.

If a terminal shows:

```text
Action: mcp
Target: *
```

Do not approve it. Deny or stop and escalate.

---

## 6. Codex Safe-Exec Protocol

### 6.1 Status

Codex SAFE-EXEC-2 is verified:

```text
FULL PASS / LIVE VALIDATED
```

Codex responded through agentchattr:

```text
CODEX_ROUTING_OK
My cwd is C:\tools\agentchattr-scratch and I did not touch the Twinpet repo.
```

### 6.2 Why Codex TUI input failed on Windows

Codex TUI-style terminal input on Windows was unreliable because of conhost / VT input behavior. Focus and terminal control sequences such as:

```text
ESC[I
ESC[O
```

can interfere with injected input. This can cause dropped or malformed text, requiring manual Enter or causing agentchattr relay failure.

Therefore, Codex must not rely on TUI keystroke injection for basic routing.

### 6.3 Safe Codex execution blueprint

Use headless direct-payload + wrapper-relay.

Safe Codex launcher:

```text
C:\tools\agentchattr\repo\windows\start_codex.bat
```

Safe Codex args:

```text
--sandbox read-only
--skip-git-repo-check
--ephemeral
```

Required execution characteristics:

* use scratch cwd:

  ```text
  C:\tools\agentchattr-scratch
  ```
* no Twinpet repo touch
* no TUI keystroke dependency
* no MCP chat_read for basic routing
* no dangerous bypass
* direct payload embedded into prompt
* capture model output
* relay back to agentchattr via wrapper `/api/send`
* use the agent's own instance token
* no manual Enter required

### 6.4 Codex direct-payload prompt principles

A safe Codex prompt should:

* contain the actual mention payload
* tell Codex not to use MCP tools
* tell Codex to output only reply text
* avoid instructing Codex to browse chat via MCP
* avoid vague instructions such as “take appropriate action”

---

## 7. AGY / Antigravity Current Verified State

### 7.1 Model pinning

AGY model pinning is verified working at launcher level.

Modified file:

```text
C:\tools\agentchattr\repo\windows\start_agy.bat
```

Pinned launcher line:

```batch
python wrapper.py agy -- --model "Gemini 3.1 Pro (High)"
```

This model pinning line should be kept.

AGY logs confirmed selected model propagation:

```text
Propagating selected model override to backend: label="Gemini 3.1 Pro (High)"
```

### 7.2 AGY live routing failure

AGY automated live routing is not closed.

Observed prompt:

```text
Action: mcp
Target: *
```

The operator correctly denied broad MCP permission.

After the permission flow ended, AGY exited or ended without relaying a response back to agentchattr.

Conclusion:

```text
AGY model pinning: CLOSED / WORKING
AGY automated routing: NOT CLOSED / STRATEGY DECISION REQUIRED
```

### 7.3 AGY TUI/MCP route is unsafe for no-manual-input routing

AGY TUI mode can trigger:

* MCP permission prompts
* broad MCP requests
* autonomous task/subagent behavior
* no-response termination after denial
* manual terminal interaction

Therefore, AGY must not be counted as a fully automated participant until a non-interactive response capture path is proven.

### 7.4 AGY print mode current evidence

Tested commands included:

```bash
agy --print "Reply with exactly one word: HELLO" --print-timeout 30s
agy -p "Reply with exactly one word: HELLO"
agy --model "Gemini 3.1 Pro (High)" --sandbox --print "Reply with exactly: AGY_PRINT_TEST" --print-timeout 30s
```

Observed:

```text
exit code: 0
stdout: zero bytes
stderr: zero bytes
```

Logs showed:

* keyring authentication worked
* Google OAuth worked
* selected model propagated
* backend streamGenerateContent responses were received
* output appears stored in AGY brain/conversation database instead of stdout/stderr

Conclusion:

AGY `--print` is not yet a reliable direct replacement for Codex exec mode on this Windows setup.

### 7.5 AGY current recommended posture

Until further authorization:

* keep model pinning launcher line
* do not approve broad MCP `Target: *`
* use AGY only as semi-manual QA participant
* investigate print-mode output read-only before any patch
* consider API-agent fallback only after Tech Lead approval

---

## 8. AGY Routing Options

### Option 1 — AGY `--print` + Brain DB Read

Run AGY `--print`, then read newest response from AGY brain/conversation SQLite database and relay via `/api/send`.

Status:

```text
Not recommended initially
```

Reason:

* high complexity
* private schema coupling
* fragile across AGY versions
* brain pollution
* polling required

### Option 2 — AGY Print Mode Output Investigation

Read-only investigation into why AGY `--print` gets backend responses but writes no stdout/stderr.

Status:

```text
Recommended next investigation
```

Allowed checks may include:

* `cmd.exe /c "agy --print test"`
* output redirection to file
* `agy --version`
* `agy changelog`
* alternate flag order
* `--prompt` vs `--print`
* `--log-file`
* terminal/ConPTY rendering behavior
* AGY update availability

No patch should be applied during investigation unless separately authorized.

### Option 3 — TUI Mode with Constrained Prompt

Rewrite AGY TUI injection to use embedded payload and avoid MCP instruction.

Status:

```text
High risk fallback only
```

Reason:

* AGY brain remains active
* subagent spawning risk remains
* relay path unresolved if MCP is skipped
* no strong sandbox equivalent

### Option 4 — Wrapper Direct-Payload + Forced TUI Capture

Read AGY terminal output from Windows console buffer and relay it.

Status:

```text
Not recommended
```

Reason:

* very high implementation complexity
* fragile screen scraping
* output panes may not be plain text
* high maintenance burden

### Option 5 — AGY-like API Agent

Bypass AGY CLI and configure an API-based QA/UX participant using Gemini API.

Status:

```text
Recommended fallback if Option 2 fails
```

Pros:

* deterministic request-response
* no AGY TUI
* no brain/subagent loop
* no MCP permission prompt
* easy relay

Cons:

* not literally AGY CLI
* requires API key and exact model ID
* loses AGY CLI context/tool awareness

### Option 6 — Semi-Manual AGY QA Participant

Keep AGY model-pinned but use human copy/paste until non-interactive strategy is proven.

Status:

```text
Recommended interim mode
```

Reason:

* zero implementation
* zero automation risk
* avoids broad MCP approval
* lets AGY remain available under human supervision

---

## 9. Claude Code Tooling Rules

Claude Code may be used as Environment Auditor or Tooling Implementer.

Mandatory rules:

* follow the exact prompt scope
* run repo safety pre-check before touching repo docs
* modify only authorized files
* never broaden into POS app work
* never start UI-08/UI-09 during tooling phase
* never persist unsafe permissions without explicit authorization
* preserve `.claude/` hygiene and do not contaminate repo with local-only settings

Claude-specific config claims must be verified from actual local files, official docs, or `claude --help` output before being added to any permanent Skill.

Do not import unverified Claude settings schema from speculative documents.

---

## 10. agentchattr Rules

### 10.1 Basic routing principle

For safe automated participants, basic routing should prefer:

```text
direct-payload + wrapper-relay
```

Do not require MCP chat_read for basic routing if the wrapper already has the mention payload.

### 10.2 Relay principle

Preferred flow:

```text
mention payload
→ wrapper builds deterministic direct prompt
→ agent runs headless or safe non-interactive mode
→ wrapper captures output
→ wrapper relays output to /api/send using the agent's own instance token
```

### 10.3 Identity principle

Agents must not impersonate other agents.

Each relay must use that agent's own token or instance identity.

### 10.4 Prompt discipline

Avoid generic prompts such as:

```text
use mcp to read #general - you're mentioned, take appropriate action and respond
```

This phrase is unsafe for AGY because it triggers broad MCP routing and autonomous behavior.

Prefer deterministic direct-payload prompts.

---

## 11. Evidence Discipline

Permanent Skill content must come from one of these sources:

1. live validation report
2. local CLI `--help` or equivalent output
3. actual local config file inspection
4. official documentation
5. Tech Lead / CEO authorization memo

Speculative or simulated documentation may be used only as a checklist, not as fact.

If a document labels itself simulated, raw, draft, or hypothetical, do not copy its claims into verified sections unless independently confirmed.

Every report should separate:

```text
Verified
Hypothesis
Unverified
Rejected
```

Never overclaim live validation.

If live validation failed, record it as failed even if a partial patch worked.

---

## 12. Reporting Rules

Long reports must be exported to:

```text
C:\Users\Narachat\Desktop\Ai-Report
```

Chat responses should remain short and include only:

* status
* report path
* next decision needed

For repo docs changes, include:

* exact file modified
* exact lines or sections changed
* git status
* HEAD
* stash@{0}
* whether app code was untouched

---

## 13. Rollback Rules

Every tooling patch must include rollback steps.

For launcher patches:

* identify exact file
* identify exact line before/after
* state how to revert
* state whether service restart is needed

For wrapper patches:

* create backup first unless using git-tracked docs-only changes
* change minimal functions only
* no unrelated refactor
* no app code

For config patches:

* do not write secrets
* do not persist broad allow rules
* document before/after
* confirm no unsafe permissions introduced

---

## 14. Current Tooling Phase State

As of this Skill baseline:

```text
Codex SAFE-EXEC-2: CLOSED / FULL PASS / LIVE VALIDATED
AGY model pinning: CLOSED / WORKING
AGY automated routing: NOT CLOSED / STRATEGY DECISION REQUIRED
AGY interim mode: SEMI-MANUAL ONLY
Twinpet repo baseline: HEAD 886340b
stash@{0}: present and untouched
UI-08/UI-09: NOT STARTED IN THIS TOOLING CHAT
```

---

## 15. Required Prompt Injection for Future Tooling Agents

Any future tooling prompt should include this Skill and the following hard reminder:

```text
You are operating under Tooling MCP Multi-Agent Routing Skill rules.
Do not touch Twinpet POS app code.
Do not start UI-08/UI-09.
Use C:\tools\agentchattr-scratch for safe tooling execution.
Use cd /d C:\Users\Narachat\twinpet-pos only for explicit repo checks or authorized docs-only updates.
Do not use unsafe flags.
Do not approve broad MCP Target: *.
Preserve HEAD and stash@{0}.
Separate verified facts from hypotheses.
```

---

## 16. Hidden Risk Register

1. AGY print mode receives backend responses but emits no stdout/stderr on current Windows setup.
2. AGY TUI mode may spawn tasks/subagents or request broad MCP even for simple routing.
3. Broad MCP approval can silently expand the blast radius if persisted to settings.
4. Copying unverified simulated docs into a Skill can create false confidence.
5. Tooling patches outside git may not have normal repo rollback unless explicit backups are made.
6. agentchattr wrapper behavior may differ by Windows console/TUI mode.
7. Model display names and API model IDs may differ.

---

## 17. Final Rule

When in doubt, choose:

```text
read-only investigation
no broad permissions
no unsafe flags
no Twinpet app touch
short report with exact path
Tech Lead decision before patch
```
