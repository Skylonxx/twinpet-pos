# Current Work Packet

## Phase

**7C-UI-03-CATEGORY-DROPDOWN** — Categories & Quick Menu Dropdown Conversion

## Master Plan

Source of truth: **`docs/agent-workflow/UI_MASTER_PLAN.md`**. This packet is item **3 (UI-03: หมวดหมู่สินค้าและเมนูด่วน — CURRENT)**. No work beyond UI-03 is authorized by this packet.

## Goal

Replace the category selection **modal overlay** with a clean, minimalist **dropdown** anchored to the "ค้นหาหมวดหมู่ ▾" button — preserving existing category filtering/sync behavior and not blocking the cashier flow with an overlay. **AGY visual review is required before Codex.**

## Implementation Directives (A / B / C)

**A — Destroy the Modal.** Completely remove the full-screen/centered category-selection modal overlay. No overlay for category selection; it must not block cashier flow.

**B — Implement Dropdown.** Convert the "ค้นหาหมวดหมู่ ▾" button into a dropdown shown directly below it, containing the category options. Include a small inline search inside the dropdown (preserve existing category-search behavior). Close cleanly after selection; don't disrupt scanner focus more than necessary; preserve category filtering/sync.

**C — Style.** Match the Flowbite / Clean / Impeccable POS aesthetic — premium, subtle background/border/hover/spacing/radius/shadow. Avoid heavy modal-like styling, broad redesign, and clutter.

## Strict Non-Goals

Do NOT touch: Cart item rows (UI-06), Cart Summary (UI-07), Action Buttons (UI-08), Checkout/F12 (UI-09), checkout/payment logic, cart math, stock logic. Do NOT alter product-card layout beyond what's strictly required to keep the dropdown placement. Do NOT touch category/product/main-navigation functional icons. Do NOT reintroduce a modal overlay for categories.

## AGY Review Requirement (MANDATORY before Codex)

AGY must verify: no category modal overlay remains; the dropdown appears directly below the "ค้นหาหมวดหมู่ ▾" trigger; it feels minimalist/clean/premium (spacing, border, hover, background polished); inline search (if present) is compact/useful; category/product/main-navigation functional icons are preserved; cart items/summary/action buttons/checkout were not visually altered; scanner/focus flow is not regressed; and no broad redesign.

## Status

**In Progress** — Developer implementation complete; **awaiting AGY visual/UX review (before Codex)**.

---

## Scope

### Authorized implementation files (app)

- `src/pages/POSPage.tsx` — category dropdown state + UI (modal removed)
- `src/pages/POSPage.css` — dropdown styling (modal overlay CSS removed)
- `src/pages/POSPage.keyboard-contract.test.ts` — category-picker contract tests updated (modal→dropdown)
- Do NOT broaden beyond the category dropdown conversion.

### Authorized workflow / report files

- `docs/agent-workflow/UI_MASTER_PLAN.md`
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- **Cart item rows (UI-06), Cart Summary (UI-07), Action Buttons (UI-08), Checkout/F12 (UI-09)** — reserved; do NOT touch
- **Functional icons** in Category Tabs, Product Cards, Product Grid, Main Navigation — do NOT touch
- **Select Customer button styling / dashed border** — do NOT touch; do NOT reintroduce a category modal overlay
- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment business logic, stock matrix, seed data
- Toast files; Firebase / functions / rules; Android / Capacitor; `.claude/`
- No new scripts, no new dependencies; no UI-04/06/07/08/09 work

### Preservation note

The category selection UI changed from modal overlay → anchored dropdown only. Category filtering/sync (`visibleCategories`, `usePosSyncSignal`, the catalog-wide refresh), the `.pos-cat-bar` horizontal scroll, and all focus-recovery handlers are preserved; the dropdown still routes selection through `selectCategory` (clears the Quick Menu) and refocuses the scan box on close. Cart rows, summary, action buttons, checkout/F12, and the macro layout are untouched.

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
5. **AGY reviews UX/visuals first** (Impeccable Style + no visual regression).
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
