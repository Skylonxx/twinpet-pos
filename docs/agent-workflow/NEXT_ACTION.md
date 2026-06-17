# Next Action

## Current State

**Emergency patch** `7C-UI-06-FIX-ICON-RESTORE-AND-BUTTON-PURGE` — Developer Agent has (A) restored the modal header icons (Cash In/Out swap, Close-Shift padlock, Z-Report clipboard, Open-Shift clock — by reverting the 4 modal files to the UI-05 HEAD) and (B) removed the decorative button icons (✅ on บันทึก / เปิดกะ / ตกลง, 🔒 on ปิดกะ, 🖨️ on print) so button labels are text-only and centered. This **supersedes** the prior UI-06 header-purge package (which must NOT be committed). Changes are **not staged and not committed**. **AGY review is REQUIRED before Codex** — route to **Senior QA & UX Lead / AGY first**.

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md`.
2. **Human operator** sends **AGY** the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff** for visual/UX validation.
3. **AGY** validates restored header icons + text-only buttons + preserved functional icons.
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
MODE: Visual UX validation, emergency modal header/button icon review, no app edits, no staging, no commit

PHASE: 7C-UI-06-FIX-ICON-RESTORE-AND-BUTTON-PURGE
SCOPE: visual / UX validation (before Codex)

Inputs:
- docs/agent-workflow/CURRENT_PACKET.md (active packet)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

AGY review MUST verify:
- Modal Header Icons are restored and help contextual communication.
- Header icons do not feel noisy or decorative in a bad way.
- Button decorative icons are removed.
- Button labels remain centered.
- Buttons look minimal, clean, intentional, and premium.
- No awkward empty spacing remains inside buttons.
- Modal screens feel more usable and balanced than the prior icon-purged-header version.
- Navigation icons are untouched.
- Category Tab icons are untouched.
- Product Card / Product Grid functional icons are untouched.
- No focus, modal behavior, scanner, keyboard, or checkout regression is visible.
- No broad redesign was introduced.

Note: the net app diff is only the button-emoji removals — the header icons were restored by
reverting the 4 modal files to the UI-05 HEAD, so the headers are byte-identical to the prior
working design. Button handlers / disabled / loading states are unchanged.

Produce verdict in docs/reports/latest-agy-review.md.

Do not stage or commit.
Do not start UI-07.
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

PHASE: 7C-UI-06-FIX-ICON-RESTORE-AND-BUTTON-PURGE
SCOPE: code / scope / keyboard-contract review

Verify:
- Header icons restored (ShiftModals: clock/report/lock; CashTransactionModal: swap) — the modal
  files match the UI-05 HEAD for the headers (no net diff there).
- Net app diff = ONLY decorative button-emoji removals (✅ บันทึก/เปิดกะ/ตกลง, 🔒 ปิดกะ, 🖨️ print →
  text-only); button text stays centered (no icon slot, inline emoji removed).
- Button click handlers, disabled/loading states, variants, keyboard behavior unchanged; modal
  open/close/focus unchanged.
- Only the 2 modal TSX files changed (+ workflow/report docs); CSS files match HEAD; no cart math /
  useCart.ts / cartUtils.ts / checkout / stock / Toast / Firebase / POSPage change; functional
  nav/category/product icons untouched.
- tsc clean; POSPage.keyboard-contract.test.ts (145) + full vitest (712) green.

Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route results to Principal Engineer Reviewer / Tech Lead

After AGY PASS → Codex PASS, paste both verdicts to the Principal Engineer Reviewer / Tech Lead for a closure memo and exact staging/commit commands.

---

## Important Reminders

- **AGY first** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.
- **Do NOT commit the old UI-06 header-purge package** — it is superseded by this patch.
- Do **not** touch functional icons (nav / category tabs / product cards / product grid) or the Select Customer button.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- Do **not** start UI-07.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
