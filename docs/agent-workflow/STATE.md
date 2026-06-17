# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Current Phase

**7C-UI-02-HOTFIX-FOCUS-EDGE** — Comprehensive POS Focus Recovery Edge Hotfix (zero focus drops: every non-modal POS control returns focus to the scan box; modals refocus on close/resolution).

## Current Owner

**Developer Agent** (implementation complete) → handoff to **Codex Reviewer**

## Latest Verdict

**In Progress** — Developer implementation complete; awaiting Codex behavior/code/keyboard-contract review.

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

### What changed (9 CEO focus-recovery targets)

A single shared `runAndRefocus(action)` helper (rAF-deferred) now backs the non-modal cart controls; modal close/resolution handlers refocus directly:

1. Cash In/Out — `CashTransactionModal` `onClose` + `handleCashTxRecorded` (success) refocus.
2. Close Shift — `CloseShiftModal` `onClose` refocuses (success already routes through `handleNewSale`).
3. Clear Cart — confirm `onConfirm` (existing) + `onCancel` (new) refocus.
4. Remove line — `runAndRefocus(() => cart.removeLine(...))`.
5. Qty + — `runAndRefocus(() => cart.changeQty(..., 1))`.
6. Qty − — `runAndRefocus(() => cart.changeQty(..., -1))`.
7. Fee chips — `runAndRefocus(() => cart.setFeeRate(rate))`.
8. Discount ฿ — `runAndRefocus(() => cart.setBillDiscPercent(false))`.
9. Discount % — `runAndRefocus(() => cart.setBillDiscPercent(true))`.

Modal-owned focus (UOM, Payment) and the ProductPicker multi-UOM sequencing fix from `42ff3ed` are preserved.

### Tests / checks run

- `git status --short` — only authorized files dirty
- `git diff --name-only` — `POSPage.tsx`, `POSPage.keyboard-contract.test.ts` (+ workflow/report docs)
- `git diff --check` — clean
- `git diff -- src/pages/POSPage.css` — **empty (untouched)**
- `npx.cmd tsc -b` — PASS
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **137 passed** (was 128; +9 edge tests)
- `npx.cmd vitest run` — **704 passed (31 files)**

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
| UI-02 Focus Hotfix | Closed / committed (`42ff3ed`) |
| UI-02 Focus Hotfix EDGE | **In Progress** — Developer done, awaiting Codex review |
| UI-03+ | **Unauthorized** — do not start |
| Automation scripts | None exist — not authorized |
| Old manual workflow | Available as fallback at any time |

## Next Owner

**Codex Reviewer** (ROLE FILE: `docs/ai-roles/reviewer.md`) — behavior / code / keyboard-contract review (AGY bypassed: this is behavioral focus recovery, not visual polish).

## Next Action

Human operator routes the current packet, `docs/reports/latest-developer-report.md`, and the current diff to Codex Reviewer using ROLE FILE: `docs/ai-roles/reviewer.md`. Do not route to AGY unless Tech Lead/CEO or Principal Engineer explicitly requests it.

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
42ff3ed fix(pos): restore scanner focus after cashier actions
bb9b1ad style(pos): refine search and barcode action bar
08946cc docs(workflow): initialize file-based agent handoff
```

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
