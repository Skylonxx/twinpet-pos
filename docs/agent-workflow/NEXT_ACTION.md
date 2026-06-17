# Next Action

## Current State

Developer Agent has completed the **7C-UI-04-SYNC-AND-MACRO-LAYOUT** implementation: (A) aligned the product/grid area top edge with the cart panel and turned the inter-panel gap into a single intentional gutter (CSS); (B) sourced the category tabs from the categories collection too, so newly-added categories render after a Refresh (the update bell already glows catalog-wide); (C) made the category tab bar robustly horizontally scrollable. **The Select Customer dashed border was NOT touched.** Changes are **not staged and not committed**. Because this phase includes visual UI/macro-layout polish, **AGY review is REQUIRED before Codex** — the work routes to **Senior QA & UX Lead / AGY first**.

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md`.
2. **Human operator** sends **AGY** the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff** for visual/UX + macro-layout validation.
3. **AGY** validates alignment, gap/premium feel, horizontal scroll, no regression, and that Select Customer is unaltered.
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
MODE: Visual UX validation, macro layout alignment review, Impeccable Style review, no app edits, no staging, no commit

PHASE: 7C-UI-04-SYNC-AND-MACRO-LAYOUT
SCOPE: visual / UX + macro-layout validation (before Codex)

Inputs:
- docs/agent-workflow/CURRENT_PACKET.md (active packet — directives A/B/C)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

AGY review MUST verify:
- Category/Product-Grid top edge and Cart top edge are aligned (the 64px category bar lines up
  with the 64px customer/Select bar; no jagged top).
- The gap between the left and right panels looks intentional and premium (one consistent gutter).
- The exposed background no longer looks ugly/disconnected.
- Cart elevation/shadow still feels premium.
- The Select Customer button was NOT altered (dashed border unchanged).
- Category tabs horizontal scroll feels clean (not broken/cheap) with many categories.
- No visual regression from UI-03.
- No focus-recovery regression is visible during cashier flow.

Notes for AGY:
- Macro layout (A) and horizontal scroll (C) are CSS-only — best judged on screen.
- Category sync (B): the update bell is catalog-wide (glows for category broadcasts); the tabs now
  render categories from the collection so a NEW category appears after Refresh. (The admin-side
  broadcast on category edits is a backend trigger outside this POS packet.)

Produce verdict in docs/reports/latest-agy-review.md.

Do not stage or commit.
Do not start UI-05.
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

PHASE: 7C-UI-04-SYNC-AND-MACRO-LAYOUT
SCOPE: code / scope / keyboard-contract review

Verify:
- A: `.pos-cart` top aligns with the category bar; consistent gutter; Select Customer dashed border
  untouched; no cart-math/structure change.
- B: `visibleCategories` merges product categories + the categories collection (deduped,
  branch-gated); update bell + refresh are catalog-wide; product detection preserved.
- C: `.pos-cat-bar` scrolls horizontally without wrapping/pushing the cart.
- UI-03 focus recovery + glow intact; Ctrl+F / F12 / scanner / UOM / Payment / numpad unchanged.
- Only authorized files changed; no cart math / useCart.ts / cartUtils.ts / checkout / stock / Toast / Firebase change.
- tsc clean; POSPage.keyboard-contract.test.ts (145) + full vitest (712) green.

Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route results to Principal Engineer Reviewer / Tech Lead

After AGY PASS → Codex PASS, paste both verdicts to the Principal Engineer Reviewer / Tech Lead for a closure memo and exact staging/commit commands.

---

## Important Reminders

- **AGY first** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.
- Do **not** touch the Select Customer button / dashed border.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- Do **not** start UI-05; do **not** break UI-03 focus recovery.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
