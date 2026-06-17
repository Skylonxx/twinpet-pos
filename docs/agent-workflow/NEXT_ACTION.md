# Next Action

## Current State

Developer Agent has completed the **7C-UI-02-HOTFIX-FOCUS-EDGE** implementation: comprehensive focus recovery across all 9 CEO-flagged POS controls (Cash In/Out, Close Shift, Clear Cart, remove line, qty ＋/−, fee, discount ฿/%). Changes are **not staged and not committed**. The work is routed to **Codex Reviewer** for behavior/code/keyboard-contract review. **AGY is bypassed** for this phase (behavioral focus recovery, not visual polish).

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md`.
2. **Human operator** sends Codex the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff**.
3. **Codex Reviewer** reviews focus recovery (all 9 targets), scope, and keyboard-contract preservation.
4. If **Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator for remediation.
5. If **Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo + exact staging/commit commands.

---

## Copy-Paste Instructions for Human Operator

### Step 1 — Send to Codex Reviewer (DO THIS NEXT)

Paste the following to Codex:

```
TO: Codex Reviewer
MODEL: GPT-5.5 / best available Codex reviewer model for this run
REASONING: High
ROLE: Reviewer Agent
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Review only, no edits, no staging, no commit

PHASE: 7C-UI-02-HOTFIX-FOCUS-EDGE
SCOPE: behavior / code / keyboard-contract review

Inputs:
- docs/agent-workflow/CURRENT_PACKET.md (active packet — all 9 focus targets)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

Confirm ALL 9 focus-recovery targets return focus to the scan box (searchInputRef):
1. Cash In/Out — CashTransactionModal onClose + handleCashTxRecorded (success).
2. Close Shift — CloseShiftModal onClose (success via handleNewSale).
3. Clear Cart — DestructiveConfirmModal onConfirm (existing) AND onCancel (new).
4. Remove line — runAndRefocus(() => cart.removeLine(...)).
5. Qty + — runAndRefocus(() => cart.changeQty(..., 1)).
6. Qty - — runAndRefocus(() => cart.changeQty(..., -1)).
7. Fee chips — runAndRefocus(() => cart.setFeeRate(rate)).
8. Discount Baht (฿) — runAndRefocus(() => cart.setBillDiscPercent(false)).
9. Discount Percent (%) — runAndRefocus(() => cart.setBillDiscPercent(true)).

Confirm the shared rAF-deferred runAndRefocus(action) helper mutates THEN refocuses, and that
modal-owned focus is NOT stolen:
- UomModal still owns focus until select/close (unchanged; 2 focusSearch in its region).
- Payment modal focus behavior preserved.
- ProductPicker multi-UOM sequencing fix from 42ff3ed preserved.
- Scanner source paths, Ctrl+F, auto-focus, F12 preserved.
- No focus stolen from the bill-discount numpad while it is open (numpad keeps its own close/confirm refocus).

Scope / boundaries:
- Only authorized files changed (POSPage.tsx + POSPage.keyboard-contract.test.ts + workflow/report docs).
- POSPage.css UNTOUCHED; no cart math / useCart.ts / cartUtils.ts / checkout / stock / toast change.
- tsc clean; POSPage.keyboard-contract.test.ts (137) + full vitest (704) green.

Produce verdict in docs/reports/latest-codex-review.md.

Do not stage or commit.
Do not start UI-03.
Do not route to AGY unless explicitly requested.
```

### Step 2 — Route Codex result back to Principal Engineer Reviewer / Tech Lead

Paste the Codex verdict to the Principal Engineer Reviewer / Workflow Coordinator for a Tech Lead closure memo and exact staging/commit commands.

---

## Important Reminders

- Send to **Codex Reviewer** (GPT-5.5 / best available) with **ROLE FILE: docs/ai-roles/reviewer.md**.
- Do **not** route to AGY unless Tech Lead/CEO or Principal Engineer explicitly requests it.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- Do **not** start UI-03 or any other phase.
- Do **not** change `POSPage.css` or any cart/checkout/stock code.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
