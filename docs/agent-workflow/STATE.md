# Agent Workflow — State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Current Phase

**7C-UI-05-MACRO-LAYOUT-PERFECTION** — Seamless Split Macro Layout Perfection (Option 1 trial).

## Current Owner

**Developer Agent** (implementation complete) → handoff to **Senior QA & UX Lead / AGY**

## Latest Verdict

**In Progress** — Developer implementation complete; **AGY visual/UX review required before Codex**.

---

## Preflight

- UI-04 was **committed first** (authorized): `b04f303 feat(pos): sync categories and refine cashier macro layout`.
- Working tree was **clean** after the UI-04 commit, before UI-05 started.
- `stash@{0}` present and untouched.

## Scope

### Files in scope (this phase)

- `src/pages/POSPage.css`
- `src/pages/POSPage.tsx` (only if a divider hook were needed — NOT needed; unchanged)
- `src/pages/POSPage.keyboard-contract.test.ts` (only if a stable assertion were needed — not changed; CSS-only)
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Files changed so far (UI-05)

- `src/pages/POSPage.css` (modified, unstaged) — `.pos-cart` Seamless Split only
- Workflow/report files above (modified, unstaged)

No staging. No commit.

### What changed (Seamless Split — CSS only)

`.pos-cart`: removed the UI-04 gray gutter (`margin`), the drop-shadow (`box-shadow`), the rounded corners (`border-radius`), and the 4-side `border`; added a single `border-left: 1px solid var(--g200)` as the only seam. `margin: 0` makes the cart a full-height flush right-hand zone that aligns top/bottom with the product area. Result: no exposed gray gap, no competing shadow into the grid, one clean 1px vertical divider, unified surface. Category horizontal scroll, category sync, and all focus-recovery logic are untouched.

### Tests / checks run

- `git diff --check` — clean
- `git diff -- src/pages/POSPage.css | grep cust-pick` — **empty (Select Customer untouched)**
- `npx.cmd tsc -b` — PASS
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **145 passed** (unchanged — CSS-only)
- `npx.cmd vitest run` — **712 passed (31 files)**

### Staging / Commit status

UI-05: nothing staged, nothing committed. (UI-04 was committed at `b04f303` under explicit authorization.)

---

## Pipeline Status

| Item | Status |
|---|---|
| UI-01 Animation | Closed / committed (`3b6b8ed`) |
| UI-02 Search & Barcode styling | Closed / committed (`bb9b1ad`) |
| UI-02 Focus Hotfix + EDGE | Closed / committed (`42ff3ed`, `023cc8d`) |
| UI-03 Polish | Closed / committed (`ce49a82`) |
| UI-04 Sync & Macro Layout | Closed / committed (`b04f303`) |
| UI-05 Seamless Split | **In Progress** — Developer done, **awaiting AGY visual review** |
| UI-06+ | **Unauthorized** — do not start |
| Old manual workflow | Available as fallback at any time |

## Next Owner

**Senior QA & UX Lead / AGY** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — mandatory visual/UX review BEFORE Codex (Seamless Split + Impeccable Style).

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

Developer stops after implementation + report. No staging of UI-05, no commit of UI-05, **no Codex until AGY review passes**, no UI-06. Wait for AGY visual validation.

---

## Latest Commit Baseline

```
b04f303 feat(pos): sync categories and refine cashier macro layout
ce49a82 style(pos): polish refresh update state and focus recovery
023cc8d fix(pos): recover scanner focus across cashier actions
```

## Stash

`stash@{0}` — pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times. Option 2 (alternative to the Seamless Split) is NOT authorized in this phase.
