# Agent Workflow -- State Board

This file is the single source of truth for the current state of the multi-agent handoff workflow.
Updated by whichever agent or human currently owns the task.

---

## Master Plan

**`docs/agent-workflow/UI_MASTER_PLAN.md`** is the explicit Phase 7C POS UI source of truth (9-point plan + future backlog). UI-01 through UI-06 are **DONE**. UI-06 final commit: `ab7eceb fix(pos): stabilize discount modal draft state`, CEO Physical UAT PASS.

## Current Phase

**7C-UI-07-CART-SUMMARY-DISCOVERY** -- read-only cart summary UX/UI discovery and proposed styling plan. No implementation.

## Current Owner

**Developer Agent** -- read-only discovery and proposed styling plan (docs/report only).

## Latest Verdict

**DISCOVERY COMPLETE / READY FOR AGY UX REVIEW** -- the POS Cart Summary (subtotal, bill discount, fee, grand total, item count, checkout button) was inspected read-only in `src/pages/POSPage.tsx` and `src/pages/POSPage.css`. Findings and a proposed visual/CSS-only styling plan are recorded in `docs/reports/latest-developer-report.md`. No app code, CSS, cart math, or checkout/payment logic was modified. Note: there is NO VAT/tax line in the summary; `fee` is a payment-method surcharge, not tax.

## Mode

Read-only cart summary UX/UI discovery. Source of truth = this STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md. agentchattr is advisory transport only and authorizes nothing.

## Scope

POS Cart Summary only. Read-only analysis of: subtotal, item discounts (reflected in subtotal), bill discount, fee, grand total, payment readiness, cashier readability, spacing, contrast, typography, responsive behavior, touch/iPad ergonomics.

### Files allowed (this phase)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Boundaries (this phase -- NOT to be modified)

- No implementation: no app code, no CSS.
- No cart math (`cartUtils.ts`, `getLineTotal`, `calcCartTotals`), no `useCart.ts`.
- No checkout/payment logic, no `PaymentModal` behavior.
- No stock/inventory/FIFO, no Firebase/functions/rules, no Android/Capacitor.
- No package.json, lockfiles, tooling configs, `.claude/`.
- No UI-08, no UI-09.
- No staging, no commit, no `git add`.

---

## Agentchattr Rules of Engagement (Official, still in force)

1. agentchattr is an advisory communication hub and transport layer only -- not a decision maker, does not replace workflow docs, does not authorize commits or implementation.
2. STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md remain the ultimate source of truth; if chat and docs disagree, docs win.
3. Tech Lead / CEO authorization through standard workflow is required for all implementation, staging, and commits.
4. Role separation: Tech Lead / CEO = decision owner; Claude = Developer Agent; ChatGPT = Principal Engineer Reviewer / Workflow Coordinator; AGY = Senior QA / UX Lead; Codex = Reviewer Agent; agentchattr = transport only.
5. Safety prohibitions: no skip-permissions, no bypass, no yolo, no auto-approve, no stash access.

---

## Preflight

- Working tree was **clean** before this phase started.
- HEAD at start: `9738b9a docs(workflow): record pilot-3b results and codify agentchattr rules`.
- Staging area was **empty**.
- `stash@{0}` present and untouched.

## Baseline (closed work)

- **UI-01 through UI-06** -- DONE. Final UI-06 commit: `ab7eceb`.
- **TOOLING-AGENTCHATTR PILOT-0/2/3B** -- discovery `c3dbc46`, API test `050a452`, Pilot-3B + rules `9738b9a`.

## Staging / Commit status

- Staged: **no**.
- Committed: **no**. No commit authorized for this discovery phase.

---

## Pipeline Status (per UI_MASTER_PLAN.md)

| Item | Status |
|---|---|
| UI-01 Main POS Layout | DONE |
| UI-02 Search & Scanner Input | DONE |
| UI-03 Categories & Quick Menu | DONE |
| UI-04 Product Grid Cards | DONE -- `06bc831`, CEO Physical UAT PASS |
| UI-05 Cart Container | DONE |
| UI-06 Cart Item Rows | DONE -- final `ab7eceb`, CEO Physical UAT PASS |
| UI-07 Cart Summary | DISCOVERY in progress (read-only; implementation NOT authorized) |
| UI-08 Action Buttons | PENDING (NOT started -- not authorized) |
| UI-09 Checkout Button (F12) | PENDING (NOT started -- not authorized) |
| UI-10 Manager PIN Authorization Overlay | FUTURE BACKLOG (not authorized) |

## Next Owner

**AGY / Senior QA & UX Lead** -- UX review of the proposed cart summary styling plan; then Principal Engineer Reviewer / Workflow Coordinator; then Tech Lead / CEO implementation decision.

## Next Action

See `NEXT_ACTION.md`. AGY reviews the proposed styling plan; on PASS / PASS WITH NOTES, route to Principal Engineer, then Tech Lead / CEO to authorize (or not) a UI-07 implementation phase.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |

## Stop Condition

After the Developer discovery report, stop. No staging, no commit, no `git add`. No implementation. No UI-08/UI-09. Wait for AGY UX review, then Principal Engineer review, then Tech Lead / CEO implementation authorization.

---

## Stash

`stash@{0}` -- pre-existing unrelated WIP stash. **Do not touch.** (Only `git stash list` used; untouched.)

---

## Fallback

If this file-based workflow causes friction or confusion, revert to the previous manual routing workflow. The old process remains valid and available at all times.
