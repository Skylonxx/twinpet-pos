# Current Work Packet

## Phase

**7C-UI-05-MACRO-LAYOUT-PERFECTION** — Seamless Split Macro Layout Perfection (Option 1 trial)

## Goal

Implement **Option 1: The Seamless Split** to remove the remaining visual tension between the Product Grid and the Cart Panel — by unifying the main surface, removing the awkward gray gap, flattening competing inner shadows, and using one clean 1px vertical divider. Preserve UI-04 category sync + horizontal scroll and UI-03/UI-04 focus recovery; do NOT touch the Select Customer button. **AGY visual review is required before Codex.**

## CEO Physical UAT Issue Summary

After UI-04, the CEO identified remaining visual tension caused by: (1) the narrow gray gap between the Product Grid and the Cart Panel, and (2) competing shadows between the left product area and the right cart panel — the panels still read as two cards floating on gray rather than one designed surface. **Decision: trial Option 1 (The Seamless Split).** If Option 1 fails CEO Physical UAT, the team may later pivot to Option 2, but **Option 2 is NOT authorized in this phase.**

## Implementation Directives (Seamless Split — A / B / C / D)

**A — Remove the Gap.** Remove/neutralize the gray background gap between the left and right panels — not by random margins; the spacing must feel intentional.

**B — Unify the Background.** The main content area should feel like a single unified surface — Product Grid and Cart as two zones inside one designed system, not two unrelated cards floating on gray.

**C — Flatten the Inner Edge.** Remove the cart's floating drop-shadow (or at minimum the shadow casting into the left grid); prevent shadow overlap / muddy edge between the sections. The cart can keep premium presence, but the inner seam must be clean.

**D — Add a Subtle Divider.** One clean 1px vertical divider exactly between grid and cart (`border-l border-gray-200` or CSS equivalent). Subtle, straight, premium — no double borders, no heavy contrast, no clutter.

## Strict Non-Goals

Do not touch Select Customer button styling; do not alter category-sync behavior except to preserve UI-04; do not alter focus-recovery behavior except to preserve UI-03/UI-04; do not redesign the POS shell broadly; **do not introduce Option 2.**

## AGY Review Requirement (MANDATORY before Codex)

AGY must verify: the Seamless Split looks distinctly premium; the gray gap is removed/visually neutralized; Product Grid + Cart feel like one unified architectural surface; the cart inner edge no longer casts messy shadow into the grid; one subtle 1px vertical divider separates the zones without noise; category horizontal scroll (UI-04) remains intact; focus recovery (UI-03/UI-04) remains intact; and no broad redesign or cheap visual effect was introduced.

## Status

**In Progress** — Developer implementation complete; **awaiting AGY visual/UX review (before Codex)**.

---

## Scope

### Authorized implementation files

- `src/pages/POSPage.css`
- `src/pages/POSPage.tsx` — only if a className wrapper/divider hook is genuinely needed (it was NOT — CSS-only)
- `src/pages/POSPage.keyboard-contract.test.ts` — only if a stable class/hook assertion is required

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
- No UI-06+ work; do not break UI-03/UI-04 focus recovery, category sync, or horizontal scroll
- **Option 2 is NOT authorized** — implement Option 1 (Seamless Split) only

### Preservation note

UI-04 (category sync + horizontal scroll) and UI-03/UI-04 focus recovery must remain intact. The Seamless Split is CSS-only on `.pos-cart`, so the category listener (`usePosSyncSignal`), `visibleCategories` render-merge, `.pos-cat-bar` scroll, and every focus-recovery handler are untouched.

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
