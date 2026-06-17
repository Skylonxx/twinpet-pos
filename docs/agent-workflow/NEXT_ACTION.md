# Next Action

## Current State

Codex returned **FAIL** on the first pass (`docs/reports/latest-codex-review.md`): confirming a multi-UOM product via the Select picker could refocus the scan box behind the opening UomModal. Developer Agent has applied the **targeted focus-sequencing fix** and added the missing combined-path contract test. Changes are **not staged and not committed**. The work is routed **back to Codex Reviewer for re-review**. **AGY is bypassed** for this phase (behavioral focus hotfix, not visual polish).

## What Happens Next

1. **Human operator** reads the updated Developer report at `docs/reports/latest-developer-report.md` and the prior Codex FAIL at `docs/reports/latest-codex-review.md`.
2. **Human operator** sends Codex the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, the prior Codex review, and the **current diff** for re-review.
3. **Codex Reviewer** re-reviews the focus-sequencing fix, scope, and keyboard-contract preservation.
4. If **Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator for remediation.
5. If **Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo + exact staging/commit commands.

---

## Copy-Paste Instructions for Human Operator

### Step 1 — Send to Codex Reviewer for RE-REVIEW (DO THIS NEXT)

Paste the following to Codex:

```
TO: Codex Reviewer
MODEL: GPT-5.5 / best available Codex reviewer model for this run
REASONING: High
ROLE: Reviewer Agent
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Review only, no edits, no staging, no commit

PHASE: 7C-UI-02-HOTFIX-FOCUS (RE-REVIEW after FAIL)
SCOPE: behavior / code / keyboard-contract review

Inputs:
- docs/agent-workflow/CURRENT_PACKET.md (active packet)
- docs/reports/latest-developer-report.md (updated developer report)
- docs/reports/latest-codex-review.md (your prior FAIL)
- the current working-tree diff (git diff)

Confirm the prior FAIL blocker is resolved:
- ProductPicker confirm of a multi-UOM product no longer refocuses the scan box behind
  UomModal: onConfirm computes `willOpenUom`, threads `skipFocus` into each onProductClick,
  and records `pickerWillOpenUomRef`; onClose refocuses ONLY when the flag is false.
- A single-UOM add inside a UOM-opening picker batch is also suppressed (skipFocus).
- A plain cancel / standard (no-UOM) confirm STILL refocuses the scan box.
- UomModal owns focus until its own select/close.

Also re-confirm the unchanged guarantees:
- Standard card add, category tabs, Refresh, Sort-modal close still refocus.
- Direct multi-UOM card click never refocuses.
- Payment modal, Ctrl+F, auto-focus, F12, scanner logic all preserved.
- Only authorized files changed; POSPage.css untouched; no cart/checkout/stock change.
- tsc clean; POSPage.keyboard-contract.test.ts (128) + full vitest (695) green.
- New contract test covers the combined ProductPicker-confirm + multi-UOM path.

Produce verdict in docs/reports/latest-codex-review.md.

Do not stage or commit.
Do not start UI-03.
Do not route to AGY unless explicitly requested.
```

### Step 2 — Route Codex result back to Principal Engineer Reviewer / Tech Lead

Paste the Codex verdict to the Principal Engineer Reviewer / Workflow Coordinator for a Tech Lead closure memo and exact staging/commit commands.

---

## Important Reminders

- Send to **Codex Reviewer** (GPT-5.5 / best available) with **ROLE FILE: docs/ai-roles/reviewer.md** for re-review of the FAIL fix.
- Do **not** route to AGY unless Tech Lead/CEO or Principal Engineer explicitly requests it.
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- Do **not** start UI-03 or any other phase.
- Do **not** change `POSPage.css` or any cart/checkout/stock code.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
