# Current Work Packet

## Phase

**7C-UI-02-HOTFIX-FOCUS-EDGE** — Comprehensive POS Focus Recovery Edge Hotfix

## Goal

**ZERO focus drops.** No matter what the cashier clicks on the POS interface, once the action resolves the cursor must return to the barcode/search input (`searchInputRef`) — UNLESS a modal/dialog/popover must temporarily own focus, in which case focus returns when it closes/resolves. Behavioral cashier-flow hotfix only; **not** UI-03, **not** visual polish.

## CEO Physical UAT Issue Summary

Comprehensive Physical UAT found additional interactive POS controls that steal browser focus and fail to return it to the scanner input after the action resolves — breaking continuous scanning. This is a continuation of the scanner focus-recovery hotfix line (`42ff3ed`), extending coverage to the cart-line and bill-level controls plus the cash/shift/clear-cart modals.

## Focus Recovery Targets (all 9 mandatory)

1. **Cash In / Cash Out** — focus recovery on modal close / action resolution.
2. **Close Shift** — focus recovery on modal close / action resolution.
3. **Clear Cart** — focus recovery after post-action / confirm close (confirm AND cancel).
4. **Remove Line Item** — focus recovery after the trash button action and line unmount.
5. **Quantity Increment (＋)** — cart-line plus button; focus recovery immediately after the state update (rAF / `setTimeout(…,0)` to survive re-render).
6. **Quantity Decrement (−)** — cart-line minus button; focus recovery immediately after the state update (rAF / `setTimeout(…,0)` to survive re-render).
7. **Add/Edit Fee** — focus recovery on submit / action resolution or modal/popover close.
8. **Discount Baht** — focus recovery on submit / action resolution or modal/popover close.
9. **Discount Percent** — focus recovery on submit / action resolution or modal/popover close.

**Critical rules:** for state-updating buttons (＋/−, fee, ฿/%), refocus after the state change via the shared rAF-deferred helper. For dialog/popover actions, refocus only when the dialog/popover closes or the submit is confirmed — never steal focus while a modal owns it. Preserve UOM modal focus ownership until close/select, Payment modal focus, the ProductPicker multi-UOM sequencing fix (`42ff3ed`), scanner source paths, Ctrl+F, auto-focus, and F12.

## Status

**In Progress** — Developer implementation complete; awaiting Codex Reviewer.

---

## Scope

### Authorized implementation files

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.keyboard-contract.test.ts` (focus-contract tests)

### Authorized workflow / report files

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- `src/pages/POSPage.css` (no style change this phase — CSS untouched)
- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment logic, stock matrix, seed data
- Toast files
- Firebase / functions / rules
- Android / Capacitor artifacts
- `.claude/`
- No new scripts, no new dependencies
- No UI-03+ work

---

## Role Sequence

```
Developer Agent          — ROLE FILE: docs/ai-roles/developer.md
  → Codex Reviewer       — ROLE FILE: docs/ai-roles/reviewer.md
    → Tech Lead / CEO    — ROLE FILE: docs/ai-roles/tech-lead.md
```

**AGY:** Bypassed for this phase — this is a behavioral focus hotfix, not visual UI polish. (May be requested explicitly by Tech Lead/CEO or Principal Engineer.)
AGY ROLE FILE (if needed): `docs/ai-roles/ux-lead.md`

### Required Handoff Header Format

Every handoff prompt must include these exact lines:

```
TO:
MODEL:
REASONING:
ROLE:
ROLE FILE:
MODE:
```

## Decision Rules

1. **Developer** completes implementation and writes `docs/reports/latest-developer-report.md`.
2. **Developer** updates `docs/agent-workflow/NEXT_ACTION.md` to route to Codex.
3. **If unauthorized files are changed** → STOP and report.
4. **If tests fail** → STOP and report.
5. **If Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
6. **If Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo.
7. **No commit** until Tech Lead / CEO authorizes the exact staging and commit commands.

---

## Report Requirements

Every agent must produce a report in its corresponding `docs/reports/latest-*-report.md` file. Every report must end with a STATE CARD block.

## STATE CARD Requirement

Every report must end with this exact block, filled in:

```
STATE CARD
Phase:
Current owner:
Verdict:
Files changed:
Tests/checks:
Staged:
Committed:
Required fixes:
Next owner:
Next action:
Stop condition:
```

---

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
