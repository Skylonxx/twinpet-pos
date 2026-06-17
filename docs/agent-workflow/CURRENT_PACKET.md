# Current Work Packet

## Phase

**7C-UI-04-SYNC-AND-MACRO-LAYOUT** — Category Sync and Product/Grid–Cart Macro Layout Polish

## Goal

Fix the macro layout relationship between the left product/category area and the right cart panel, add category update sync detection/render, and make category tabs horizontally scrollable — while preserving UI-03 focus recovery and the Select Customer button styling (dashed border NOT to be touched). **AGY visual review is required before Codex.**

## CEO Physical UAT Issue Summary

The prior UAT interpretation is cancelled — **the Select Customer dashed border is acceptable and must NOT be touched.** The actual issues are: (1) macro layout alignment + gap between the left Product/Grid area and the right Cart panel (jagged top edges; the gap exposes an ugly light-gray background, making the panels feel disconnected); (2) category sync blindspot — the update listener detects product changes but category changes don't render; (3) category tabs must scroll horizontally so new categories don't break/wrap the layout.

## Implementation Directives (A / B / C)

**A — Macro Layout: Grid vs Cart Alignment & Gap.** Align the top boundaries of the left Category/Product-Grid area and the right Cart container perfectly. Make the gap between the two panels look intentional, seamless, and premium (no exposed-gray sliver); the cart may keep a subtle floating/elevated feel but spacing must make architectural sense. Scoped to POS macro layout. **Do NOT touch or restyle the Select Customer button dashed border.**

**B — Category Sync Blindspot.** Ensure POS update detection covers category updates: when a category is added/modified in admin state, the Refresh button must glow like with product changes, and clicking Refresh must fetch and render the new/updated categories. Preserve existing product update detection and the UI-03 glowing-refresh behavior.

**C — Horizontal Scroll for Category Tabs.** Ensure the category tab container scrolls horizontally when many categories exist (`overflow-x-auto` + scrollbar-hide or equivalent), so added categories never wrap/break the layout. Keep tab interactions + active state intact.

## AGY Review Requirement (MANDATORY before Codex)

AGY must verify: the Category/Product-Grid top edge aligns with the Cart top edge; the left/right panel gap looks intentional and premium (no ugly/disconnected exposed background); cart elevation/shadow still feels premium; the Select Customer button was NOT altered; category horizontal scroll feels clean (not broken/cheap); no visual regression from UI-03; and no focus-recovery regression is visible in cashier flow.

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

- **Select Customer button styling / dashed border** (acceptable as-is — do NOT touch)
- `useCart.ts` (default forbidden), `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment business logic, stock matrix, seed data
- Toast files (unless directly proven necessary for update detection — default: do not touch)
- Firebase / functions / rules
- Android / Capacitor artifacts
- `.claude/`
- No new scripts, no new dependencies
- No UI-05+ work; do not break UI-03 focus recovery

### Authorized data/subscription helper note

The packet authorizes a POS data/subscription helper file responsible for the product/category update listener if POSPage does not own it. In practice **no such file needed changing**: the listener (`usePosSyncSignal`) reads the branch's catalog-wide `sync_state.lastForceUpdate` bell, which already fires for category broadcasts; `refreshInventory` (`usePosInventory` → `getInventorySnapshot`) already re-fetches categories. The POS-side gap was the category *render* (tabs derived from product categories only) — fixed in `POSPage.tsx`.

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
