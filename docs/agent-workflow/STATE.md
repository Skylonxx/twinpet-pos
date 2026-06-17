# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Current Phase

**7C-UI-03-POLISH** — Glowing Refresh Button, Cancel-Path Focus Recovery, and Border Polish.

## Current Owner

**Developer Agent** (implementation complete) → handoff to **Senior QA & UX Lead / AGY**

## Latest Verdict

**In Progress** — Developer implementation complete; **AGY visual/UX review required before Codex**.

---

## Preflight

- Working tree was **clean** before start.
- HEAD at start: `023cc8d fix(pos): recover scanner focus across cashier actions` (the committed 7C-UI-02-HOTFIX-FOCUS-EDGE).
- `stash@{0}` present and untouched.

## Scope

### Files in scope (this phase)

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.css`
- `src/pages/POSPage.keyboard-contract.test.ts`
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Files changed so far

- `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, `src/pages/POSPage.keyboard-contract.test.ts` (modified, unstaged)
- Workflow/report files above (modified, unstaged)

No staging. No commit.

### What changed (directives A / B / C)

- **A — Glowing Refresh button (replaces banner):** removed the standalone `.pos-sync-banner` (it mounted above the topbar and shifted the layout). The pending-update urgency now toggles `pos-action-link--update` on the always-present Refresh button — a soft amber tint + a glow that pulses via `box-shadow` only (zero layout shift); it clears when the refresh resolves. Update detection/refresh behavior unchanged.
- **B — Cancel-path focus:** `HoldBillNoteModal.onClose` and `SuspendedBillsListModal.onClose` now `focusSearch()` (confirm/restore paths already refocus). Modal-owned focus is never stolen while open.
- **C — Border polish (CSS only):** category pills use a crisp 1px edge with `box-sizing:border-box` (active pill border matches its fill instead of `transparent`); the Select Customer dashed border refined to an even 1px dash. No size/layout change.

### Tests / checks run

- `git diff --check` — clean
- `git diff -- src/pages/POSPage.css` — scoped to UI-03 (banner removal + glow + border polish)
- `npx.cmd tsc -b` — PASS
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **142 passed** (was 137; +5 UI-03 tests)
- `npx.cmd vitest run` — **709 passed (31 files)**

### Staging / Commit status

Nothing staged. Nothing committed. No authorization yet.

---

## Pipeline Status

| Item | Status |
|---|---|
| UI-01 Animation | Closed / committed (`3b6b8ed`) |
| UI-02 Search & Barcode styling | Closed / committed (`bb9b1ad`) |
| UI-02 Focus Hotfix | Closed / committed (`42ff3ed`) |
| UI-02 Focus Hotfix EDGE | Closed / committed (`023cc8d`) |
| UI-03 Polish | **In Progress** — Developer done, **awaiting AGY visual review** |
| UI-04+ | **Unauthorized** — do not start |
| Old manual workflow | Available as fallback at any time |

## Next Owner

**Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — mandatory visual/UX review BEFORE Codex (this phase has visual polish).

## Next Action

Human operator routes the current packet, `docs/reports/latest-developer-report.md`, and the current diff to **AGY first** (see NEXT_ACTION.md). Codex only after AGY PASS / PASS WITH NOTES.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

Developer stops after implementation + report. No staging, no commit, **no Codex until AGY review passes**, no UI-04. Wait for AGY visual validation.

---

## Latest Commit Baseline

```
023cc8d fix(pos): recover scanner focus across cashier actions
42ff3ed fix(pos): restore scanner focus after cashier actions
bb9b1ad style(pos): refine search and barcode action bar
```

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
