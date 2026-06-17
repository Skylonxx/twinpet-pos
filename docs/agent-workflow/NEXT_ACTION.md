# Next Action

## Current State

UI-04 was committed (authorized) at `b04f303 feat(pos): sync categories and refine cashier macro layout`. Developer Agent then completed the **7C-UI-05-MACRO-LAYOUT-PERFECTION** implementation (Option 1: The Seamless Split) on a clean tree: `.pos-cart` is now a flush, full-height right-hand zone with no gray gap, no drop-shadow, no rounded card border — just one clean 1px `border-left` divider between the grid and the cart. **CSS-only.** UI-05 changes are **not staged and not committed**. Because this phase is visual macro-layout polish, **AGY review is REQUIRED before Codex** — the work routes to **Senior QA & UX Lead / AGY first**.

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md`.
2. **Human operator** sends **AGY** the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff** for visual/UX validation of the Seamless Split.
3. **AGY** validates premium feel, removed gap, clean inner edge, the single divider, unified surface, and no regression.
4. If **AGY FAIL** → return to Developer / Principal Engineer Reviewer for remediation (Option 2 still NOT authorized).
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
MODE: Visual UX validation, Seamless Split macro layout review, Impeccable Style review, no app edits, no staging, no commit

PHASE: 7C-UI-05-MACRO-LAYOUT-PERFECTION
SCOPE: visual / UX validation (before Codex)

Inputs:
- docs/agent-workflow/CURRENT_PACKET.md (active packet — Seamless Split directive)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

AGY review MUST verify:
- The Seamless Split feels premium and intentional.
- The gray gap no longer creates visual tension (it is removed/neutralized).
- The inner cart edge no longer has messy shadow overlap into the grid.
- One clean 1px divider separates grid and cart (subtle, straight, no double border).
- Product/Grid and Cart feel architecturally unified (two zones in one designed system).
- Category horizontal scroll (UI-04) remains clean.
- Focus recovery behavior (UI-03/UI-04) is not visually or functionally regressed.
- The Select Customer button styling was NOT touched.
- No broad redesign / no cheap visual effect.

Note: the change is CSS-only on `.pos-cart` (removed margin/shadow/radius/4-side border;
added `border-left: 1px solid var(--g200)`), so it is best judged on screen. Option 2 is NOT
in scope — review Option 1 (the Seamless Split) only.

Produce verdict in docs/reports/latest-agy-review.md.

Do not stage or commit.
Do not start UI-06.
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

PHASE: 7C-UI-05-MACRO-LAYOUT-PERFECTION
SCOPE: code / scope / keyboard-contract review

Verify:
- `.pos-cart` Seamless Split: no margin/shadow/radius/4-side border; single `border-left`
  divider; full-height flush zone; no competing border on the product area (no double seam).
- CSS-only — no TSX change; UI-04 category sync + `.pos-cat-bar` horizontal scroll intact;
  UI-03/UI-04 focus recovery + glow intact; Select Customer dashed border untouched.
- Only `src/pages/POSPage.css` changed (+ workflow/report docs); no cart math / useCart.ts /
  cartUtils.ts / checkout / stock / Toast / Firebase change.
- tsc clean; POSPage.keyboard-contract.test.ts (145) + full vitest (712) green.

Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route results to Principal Engineer Reviewer / Tech Lead

After AGY PASS → Codex PASS, paste both verdicts to the Principal Engineer Reviewer / Tech Lead for a closure memo and exact staging/commit commands.

---

## Important Reminders

- **AGY first** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.
- **Option 2 is NOT authorized** — Option 1 (Seamless Split) only.
- Do **not** touch the Select Customer button / dashed border.
- Do **not** stage or commit UI-05 until Tech Lead / CEO authorizes exact commands.
- Do **not** start UI-06; do **not** break UI-03/UI-04 focus recovery, category sync, or scroll.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
