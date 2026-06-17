# Next Action

## Current State

Developer Agent has (Part 1) created the Phase 7C source of truth `docs/agent-workflow/UI_MASTER_PLAN.md`, and (Part 3) completed **7C-UI-03-CATEGORY-DROPDOWN**: the full-screen category **modal overlay was removed** and replaced with a clean anchored **dropdown** under the "ค้นหาหมวดหมู่ ▾" trigger (inline search preserved; selection routes through the shared `selectCategory` and closes the dropdown; outside-click + Escape dismiss; scan-box refocus on close). Changes are **not staged and not committed**. Because this is a UI-facing change, **AGY review is REQUIRED before Codex** — route to **Senior QA & UX Lead / AGY first**.

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md` (and the master plan `UI_MASTER_PLAN.md`).
2. **Human operator** sends **AGY** the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff** for visual/UX validation of the dropdown.
3. **AGY** validates the dropdown (no modal remains, premium/minimal, usable, functional icons preserved, no regression).
4. If **AGY FAIL** → return to Developer / Principal Engineer Reviewer for remediation.
5. If **AGY PASS / PASS WITH NOTES** → route to **Codex Reviewer** for code/scope/keyboard review.
6. After Codex PASS → Principal Engineer Reviewer / Tech Lead for closure memo + exact staging/commit commands.

**Do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.**

---

## Copy-Paste Instructions for Human Operator

### Step 1 — Send to Senior QA & UX Lead / AGY (DO THIS NEXT)

Paste the following to AGY:

```
TO: Senior QA & UX Lead / AGY
MODEL: Gemini / best available UX review model for this run
REASONING: High
ROLE: Senior QA & UX Lead
ROLE FILE: docs/ai-roles/ux-lead.md
MODE: Visual UX validation, category dropdown review, Impeccable Style review, no app edits, no staging, no commit

PHASE: 7C-UI-03-CATEGORY-DROPDOWN
SCOPE: visual / UX validation (before Codex)

Inputs:
- docs/agent-workflow/UI_MASTER_PLAN.md (Phase 7C source of truth)
- docs/agent-workflow/CURRENT_PACKET.md (active packet)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

AGY review MUST verify:
- Category modal overlay is gone.
- Category dropdown appears directly below the "ค้นหาหมวดหมู่ ▾" trigger button.
- Dropdown is clean, minimalist, and premium.
- Dropdown list is usable with many categories (scrolls, doesn't obstruct the cart).
- Inline search, if present, is compact and useful.
- Category / product / main-navigation functional icons are preserved.
- Cart items, summary, action buttons, checkout/F12 are untouched.
- Scanner / focus behavior does not feel regressed.
- No broad redesign or scope creep.

Note: the dropdown is `position: fixed`, anchored to the trigger's measured box (so the cat-bar's
horizontal-scroll overflow never clips it); outside-click + Escape close it; selection refocuses
the scan box. Category filtering/sync from prior phases is unchanged.

Produce verdict in docs/reports/latest-agy-review.md.

Do not stage or commit.
Do not start UI-04 (or any later master-plan item).
Do not route to Codex yourself — return the verdict to the human operator.
```

### Step 2 — Send to Codex Reviewer (ONLY after AGY PASS / PASS WITH NOTES)

```
TO: Codex Reviewer
MODEL: GPT-5.5 / best available Codex reviewer model for this run
REASONING: High
ROLE: Reviewer Agent
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Review only, no edits, no staging, no commit

PHASE: 7C-UI-03-CATEGORY-DROPDOWN
SCOPE: code / scope / keyboard-contract review

Verify:
- The full-screen category modal overlay (`.pos-category-overlay/modal/grid/cell`) is fully
  removed; replaced by an anchored `.pos-cat-dd` dropdown (fixed-position, measured anchor,
  inline search, scrollable list).
- Selection routes through selectCategoryFromDropdown → selectCategory (clears Quick Menu) →
  closeCatDropdown (refocus); Escape + outside-click dismiss; F12/blocking-modal + Escape wiring
  updated (catModalOpen→catDropdownOpen, closeCatModal→closeCatDropdown).
- Category filtering/sync, `.pos-cat-bar` horizontal scroll, and focus recovery preserved; cart
  rows/summary/action buttons/checkout/F12 untouched; functional icons untouched.
- Only POSPage.tsx / POSPage.css / POSPage.keyboard-contract.test.ts changed (+ workflow/report
  docs + new UI_MASTER_PLAN.md); no cart math / useCart.ts / cartUtils.ts / checkout / stock /
  Toast / Firebase change.
- tsc clean; POSPage.keyboard-contract.test.ts (145) + full vitest (712) green.

Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route results to Principal Engineer Reviewer / Tech Lead

After AGY PASS → Codex PASS, paste both verdicts to the Principal Engineer Reviewer / Tech Lead for a closure memo and exact staging/commit commands.

---

## Important Reminders

- **AGY first** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.
- **`UI_MASTER_PLAN.md` is the Phase 7C source of truth** — no work beyond UI-03 is authorized.
- Do **not** reintroduce a category modal overlay; do **not** touch cart rows/summary/action buttons/checkout/F12 or functional icons / Select Customer button.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
