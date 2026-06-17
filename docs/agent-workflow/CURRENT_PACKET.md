# Current Work Packet

## Phase

**7C-UI-03-POLISH** — Glowing Refresh Button, Cancel-Path Focus Recovery, and Border Polish

## Goal

Eliminate layout shift from the update notification, restore focus on cancel paths, and polish visual border edges — while preserving all cashier keyboard/scanner contracts. This phase is UI-03 polish + behavioral focus refinement; **AGY visual review is required before Codex.**

## CEO Physical UAT Issue Summary

Ongoing Physical UAT found: (1) the standalone yellow Manager-Update banner violently shifts the layout when it appears/disappears; (2) focus loss on the Hold-Bill and Suspended-Bills cancel/close paths; (3) border overlap / unrefined edges on the Select Customer button and the Category Tabs.

## Implementation Directives (A / B / C)

**A — Glowing Button replaces the Notification Banner.** Remove the standalone yellow Manager-Update banner completely; reserve no layout space. When an update is detected, transform the existing Refresh / อัปเดตข้อมูลหน้าจอ button (top action bar) to be visually urgent but premium — soft amber/yellow (or soft red) with a subtle pulse/glow via existing CSS conventions. Once clicked/refreshed or the update state resolves, the button returns to standard styling. **The update-state toggle must produce ZERO layout shift.**

**B — Focus Recovery on Cancel Paths.** Bind the existing scanner-focus helper to the Hold-Bill (พักบิล) and Suspended-Bills (บิลที่พักไว้) modal `onClose` / cancel paths so focus returns to `searchInputRef` on close/cancel. Never steal focus while the modal is open. Preserve scanner, Ctrl+F, F12, UOM, Payment, ProductPicker, discount/numpad focus ownership.

**C — Border Overlap & Unrefined Edges.** Fix the active Category Tab double-bottom border / overlap (`-mb-px` or equivalent if appropriate) and refine the Select Customer dashed border so both look balanced and premium. Keep changes local and scoped — no broad redesign.

## AGY Review Requirement (MANDATORY before Codex)

AGY must enforce Impeccable Style and verify: the glowing Refresh button is noticeable but premium (not cheap/blinding/distracting); toggling the update state causes ZERO layout shift; the Select Customer button and Category Tabs look balanced/refined; and there are no cashier-flow visual regressions.

## Status

**In Progress** — Developer implementation complete; **awaiting AGY visual/UX review (before Codex)**.

---

## Scope

### Authorized implementation files

- `src/pages/POSPage.tsx`
- `src/pages/POSPage.css`
- `src/pages/POSPage.keyboard-contract.test.ts` (focus/keyboard tests if needed)

### Authorized workflow / report files

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment business logic, stock matrix, seed data
- Toast files (unless directly part of existing update-banner logic and absolutely required — default: do not touch)
- Firebase / functions / rules
- Android / Capacitor artifacts
- `.claude/`
- No new scripts, no new dependencies
- No UI-04+ work

---

## Role Sequence

```
Developer Agent              — ROLE FILE: docs/ai-roles/developer.md
  → Senior QA & UX Lead/AGY  — ROLE FILE: docs/ai-roles/ux-lead.md
    → Codex Reviewer         — ROLE FILE: docs/ai-roles/reviewer.md
      → Tech Lead / CEO      — ROLE FILE: docs/ai-roles/tech-lead.md
```

**AGY:** **REQUIRED for this phase (before Codex)** — this phase includes visual UI polish, so AGY visual/UX validation gates the handoff to Codex.
AGY ROLE FILE: `docs/ai-roles/ux-lead.md`

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
2. **Developer** updates `docs/agent-workflow/NEXT_ACTION.md` to route to **AGY first** (visual review), not Codex.
3. **If unauthorized files are changed** → STOP and report.
4. **If tests fail** → STOP and report.
5. **AGY reviews UX/visuals first** (Impeccable Style + zero layout shift + no visual regression).
6. **If AGY FAIL** → return to Developer / Principal Engineer Reviewer for remediation.
7. **If AGY PASS / PASS WITH NOTES** → route to **Codex Reviewer** for code/scope/keyboard review.
8. **If Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
9. **If Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo.
10. **No commit** until Tech Lead / CEO authorizes the exact staging and commit commands.

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
