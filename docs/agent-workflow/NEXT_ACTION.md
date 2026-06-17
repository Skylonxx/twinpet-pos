# Next Action

## Current State

Developer Agent has completed the **7C-UI-03-POLISH** implementation: (A) removed the layout-shifting Manager-Update banner and moved its urgency onto a premium glow on the existing Refresh button; (B) added focus recovery on the Hold-Bill and Suspended-Bills cancel/close paths; (C) refined the Category Tab and Select Customer button border edges. Changes are **not staged and not committed**. Because this phase includes **visual UI polish, AGY review is REQUIRED before Codex** — the work routes to **Senior QA & UX Lead / AGY first**.

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md`.
2. **Human operator** sends **AGY** the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff** for visual/UX validation.
3. **AGY** validates Impeccable Style + zero layout shift + no visual regression.
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
MODE: Visual UX validation, Impeccable Style review, no app edits, no staging, no commit

PHASE: 7C-UI-03-POLISH
SCOPE: visual / UX validation (before Codex)

Inputs:
- docs/agent-workflow/CURRENT_PACKET.md (active packet — directives A/B/C)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

AGY review MUST verify:
- Glowing Refresh button is premium, noticeable, and NOT cheap / blinding / distracting.
- Update-state toggle causes ZERO layout shift (the glow pulses via box-shadow only; no element
  is mounted/unmounted; the button label/icon/footprint are unchanged).
- No standalone yellow Manager-Update banner remains.
- Select Customer button dashed border looks balanced and premium.
- Category Tabs do not show a double-border / overlap; active tab edge is clean.
- Hold Bill and Suspended Bills cancel/close focus recovery feels correct in cashier flow.
- No visual regression to the UI-02 layout (search/action bar, cart, footer).

Note: border polish is visual-only and best judged on screen — the contract tests assert the
behavioral parts (banner removed, glow class toggles, cancel-path refocus) but not pixel edges.

Produce verdict in docs/reports/latest-agy-review.md.

Do not stage or commit.
Do not start UI-04.
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

PHASE: 7C-UI-03-POLISH
SCOPE: code / scope / keyboard-contract review

Verify:
- Banner removed; pending update toggles `pos-action-link--update` on the existing Refresh button
  (no element insertion → zero layout shift); update detection/refresh behavior unchanged.
- Hold-Bill + Suspended-Bills onClose refocus the scan box; modal-owned focus not stolen.
- Border polish scoped to POSPage.css (category pills + Select Customer); no size/layout change.
- Only authorized files changed; no cart math / useCart.ts / cartUtils.ts / checkout / stock / Toast change.
- tsc clean; POSPage.keyboard-contract.test.ts (142) + full vitest (709) green.

Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route results to Principal Engineer Reviewer / Tech Lead

After AGY PASS → Codex PASS, paste both verdicts to the Principal Engineer Reviewer / Tech Lead for a closure memo and exact staging/commit commands.

---

## Important Reminders

- **AGY first** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- Do **not** start UI-04 or any unrelated phase.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
