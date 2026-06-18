# Local Coordinator Pilot — 7C-LOCAL-COORDINATOR-PILOT-0

**Status:** docs-only design pilot. No tool integration, no installs, no app code.
**Authority:** advisory-only. The existing governance chain remains the absolute source of truth.

---

## 1. Purpose

This is a small test system to evaluate whether a **Local Coordinator** helper layer can reduce repetitive workflow-hygiene errors **without replacing** existing governance.

Recent phases repeatedly lost time to mechanical, catchable mistakes: trailing whitespace in reports, a report claiming "`git diff --check` clean" while a reviewer found otherwise, a path typo, a modified-but-unlisted file, an untracked test file that needed explicit inclusion, and a commit authorization that had to be held after a Physical UAT failure. None of these are judgment calls — they are checklist items. The pilot asks: can a thin advisory helper run that checklist over the workflow docs and reported tool output, and route each flag to the correct existing role, so the human and the senior reviewers spend their attention on real risk instead?

The Local Coordinator **never decides**. It reads, summarizes, flags, and recommends. Every recommendation lands on an existing role (Developer, AGY, Codex, Principal Engineer, Tech Lead / CEO) that retains full authority.

## 2. Non-goals

The Local Coordinator does **NOT**:

- replace the **Principal Engineer Reviewer / Workflow Coordinator** (final workflow gate + abnormality checks);
- replace the **Tech Lead / CEO** (scope closure, commit authorization, Physical UAT);
- replace **Codex** (code / tests / scope / hygiene / package review);
- replace **AGY / Senior QA & UX Lead** (UI/UX review, Physical-UAT-related visual validation);
- replace the **Developer** (implementation);
- authorize commits or scope;
- stage or commit anything;
- install tools or integrate any CLI (no `agentchattr`, no Codex CLI, no automation runners);
- modify app code, tests, Firebase/functions/rules, Android/Capacitor, `.claude/`, or scripts.

## 3. Pilot scope

**Docs-only, planning-only, no tool integration.** This phase produces exactly two design artifacts plus workflow-doc updates:

- `LOCAL_COORDINATOR_PILOT.md` (this file) — purpose, non-goals, scope, historical scenarios, pass/fail criteria, dry-run workflow.
- `LOCAL_COORDINATOR_CONTRACT.md` — the role contract (authority, responsibilities, prohibitions, escalation, handoff format, safety invariant).
- `STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md` — updated to track this phase and route to the Principal Engineer.

No executable component is built. The "dry run" in §6 is a manual, read-only exercise over existing docs — not a script and not a tool.

## 4. UI-04 historical test scenarios

These are real events from the recent UI-04 work, used to validate the Local Coordinator checklist against history. For each, the expected Local Coordinator behavior is the advisory flag + routing it should have produced.

| # | Historical event | Checklist item exercised | Expected Local Coordinator behavior |
|---|---|---|---|
| 1 | Trailing whitespace in `docs/reports/latest-agy-review.md` | Report hygiene / trailing whitespace | Flag "trailing whitespace in a touched report"; recommend Developer fix via UTF-8-preserving edit + re-run `git diff --check` before handoff. |
| 2 | Developer/report claimed `git diff --check` clean while Codex later found a failure | Evidence hygiene mismatch (report vs tool output) | Flag "report claim conflicts with tool output"; recommend Codex narrow re-check + escalate evidence mismatch to Principal Engineer. |
| 3 | Path typo: `src/lib/settingsings/types.ts` vs correct `src/lib/settings/types.ts` | Suspicious / typo path | Flag "path not found / likely typo"; recommend Developer correct the path before any handoff or commit prompt. |
| 4 | Modified-but-unlisted `src/lib/settings/settingsNav.ts` | File / package mismatch (changed but not in declared package) | Flag "changed file missing from declared package"; recommend Developer reconcile the file list or justify the change. |
| 5 | Untracked `src/pages/POSPage.product-card.test.ts` needing explicit inclusion | Untracked file needs explicit authorization | Flag "untracked file present; confirm it belongs to this package and is explicitly listed" before commit prompt. |
| 6 | Prior Tech Lead commit authorization superseded after Physical UAT failed | Commit-authorization correctness | Flag "prior commit authorization is HELD/superseded after UAT failure"; remind no commit until fresh Tech Lead / CEO authorization. |
| 7 | UI review must go to AGY before Codex | Next-owner routing (UI changes) | For UI/visual changes, recommend AGY review **before** Codex; flag if routing skips AGY. |
| 8 | No commit until Tech Lead authorization | Commit-authorization gate | Remind that no commit happens without explicit Tech Lead / CEO authorization; flag any premature commit prompt. |
| 9 | Stop-after-commit before CEO UAT | Handoff completeness / stop condition | Confirm the stop condition includes "stop and hand to CEO for Physical UAT after commit"; flag if missing. |

> These mappings are evaluation fixtures only. They describe what the helper *would have surfaced*; they do not re-open or re-judge the closed UI-04 work (committed `06bc831`, Physical UAT PASS).

## 5. Pilot pass/fail criteria

### PASS examples (the helper behaving correctly — advisory only)

- Local Coordinator identifies a file / package mismatch **before** a commit prompt reaches the Developer.
- Local Coordinator flags a missing or suspicious path.
- Local Coordinator flags staged files when the staging area should be empty.
- Local Coordinator routes a UI functional/visual check to **AGY before Codex**.
- Local Coordinator reminds that **Tech Lead / CEO commit authorization is required** before any commit.
- Local Coordinator detects a missing STATE CARD field or wrong next-owner and recommends the correction to the owning role.

### FAIL examples (the helper exceeding its authority — disqualifying)

- Local Coordinator **gives commit authorization**.
- Local Coordinator **stages files** (or runs `git add` / `git commit`).
- Local Coordinator **changes app code** (or tests/scripts).
- Local Coordinator **overrides** the Principal Engineer or Tech Lead.
- Local Coordinator **starts UI-06** (or any UI master-plan item).
- Local Coordinator **creates scripts or installs tools**.

Any single FAIL behavior means the pilot design is unsafe and must be revised or discarded.

## 6. Proposed dry-run workflow

A simulated, **read-only** dry run using existing report files only — no script, no tool, no writes to app files, no staging, no commit:

1. Read `docs/agent-workflow/STATE.md`.
2. Read `docs/agent-workflow/CURRENT_PACKET.md`.
3. Read `docs/agent-workflow/NEXT_ACTION.md`.
4. Read the latest developer / AGY / Codex reports **if available** (`docs/reports/latest-developer-report.md`, `latest-agy-review.md`, `latest-codex-review.md`).
5. Produce a single **"Local Coordinator Observation"** text output (the handoff format defined in `LOCAL_COORDINATOR_CONTRACT.md` §6) summarizing state, package status, hygiene status, authority status, risk flags, and recommended routing.
6. **Do not** write app files. **Do not** stage. **Do not** commit.

The dry-run output is advisory text only. It is handed to the human operator / the relevant existing role, which retains all authority.

---

## Relationship to existing governance

The existing chain — Developer → AGY → Codex → Principal Engineer / Workflow Coordinator → Tech Lead / CEO → CEO Physical UAT — is unchanged and remains the source of truth. The Local Coordinator is a thin advisory pre-check that sits beside this chain and feeds it cleaner inputs. See `LOCAL_COORDINATOR_CONTRACT.md` for the binding role contract and the safety invariant.
