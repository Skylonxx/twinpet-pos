# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Current Phase

**7C-UI-02-HOTFIX-FOCUS** — Aggressive Scanner Focus Hotfix (restore scanner-first focus after standard card / category / top-bar action clicks).

## Current Owner

**Developer Agent** (Codex-FAIL blocker fix complete) → handoff back to **Codex Reviewer** for re-review

## Latest Verdict

**In Progress (re-review)** — Codex returned **FAIL** on the first pass (picker confirm + multi-UOM could refocus the scan box behind UomModal). Developer has applied the targeted focus-sequencing fix; awaiting Codex re-review.

---

## Scope

### Files in scope (this phase)

- `src/pages/POSPage.tsx` — focus-restoration calls only
- `src/pages/POSPage.keyboard-contract.test.ts` — focus-contract tests
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Files changed so far

- `src/pages/POSPage.tsx` (modified, unstaged)
- `src/pages/POSPage.keyboard-contract.test.ts` (modified, unstaged)
- Workflow/report files above (modified, unstaged)

**`src/pages/POSPage.css` — NOT touched** (no style change this phase). No staging. No commit.

### Codex FAIL blocker — RESOLVED

- **Blocker:** confirming a multi-UOM product via the Select picker enqueued it (→ UomModal) but the picker `onClose` unconditionally called `focusSearch()`, focusing the scan box behind the opening UOM modal.
- **Fix (POSPage.tsx):** a `pickerWillOpenUomRef` flag — the picker `onConfirm` resolves the selection, computes `willOpenUom = resolved.some(multi-UOM)`, threads `skipFocus: willOpenUom` into each `onProductClick`, and records the flag; `onClose` refocuses only when the flag is false, then resets it. `onProductClick` gained an optional `{ skipFocus }` so a single-UOM add in a UOM-opening batch is also suppressed. A plain cancel/standard confirm still refocuses.
- **Tests:** added the combined ProductPicker-confirm + multi-UOM contract test (the gap Codex flagged) and updated the picker close/confirm assertions.

### Tests / checks run (post-fix)

- `git status --short` — only authorized files dirty
- `git diff --name-only` — `POSPage.tsx`, `POSPage.keyboard-contract.test.ts` (+ workflow/report docs)
- `git diff --check` — clean
- `git diff -- src/pages/POSPage.css` — **empty (untouched)**
- `npx.cmd tsc -b` — PASS
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **128 passed**
- `npx.cmd vitest run` — **695 passed (31 files)**

### Staging status

Nothing staged. No staging authorized.

### Commit status

Nothing committed for this phase. No commit authorized.

---

## Pipeline Status

| Item | Status |
|---|---|
| UI-01 Animation | Closed / committed / UAT passed (`3b6b8ed`) |
| UI-02 Search & Barcode styling | Closed / committed (`bb9b1ad`) |
| UI-02 Focus Hotfix | **In Progress (re-review)** — Codex FAIL blocker fixed, awaiting Codex re-review |
| UI-03+ | **Unauthorized** — do not start |
| Automation scripts | None exist — not authorized |
| Old manual workflow | Available as fallback at any time |

## Next Owner

**Codex Reviewer** (ROLE FILE: `docs/ai-roles/reviewer.md`) — behavior / code / keyboard-contract review (AGY bypassed: this is a behavioral focus hotfix, not visual polish).

## Next Action

Human operator routes the current packet, `docs/reports/latest-developer-report.md`, the prior `docs/reports/latest-codex-review.md` (FAIL), and the current diff to Codex Reviewer for **re-review** of the focus-sequencing fix, using ROLE FILE: `docs/ai-roles/reviewer.md`. Do not route to AGY unless Tech Lead/CEO or Principal Engineer explicitly requests it.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |

## Stop Condition

Developer stops after implementation + report. No staging, no commit, no UI-03+, no CSS style changes, no cart/checkout/stock work. Wait for Codex review.

---

## Latest Commit Baseline

```
bb9b1ad style(pos): refine search and barcode action bar
08946cc docs(workflow): initialize file-based agent handoff
3b6b8ed style(pos): add bump flash feedback for rescanned cart items
```

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
