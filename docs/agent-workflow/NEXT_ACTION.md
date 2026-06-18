# Next Action

## Current State

Phase **7C-UI-06-ENHANCEMENT-DISCOUNT-MODAL** is in the **Codex blocker fix** cycle (built on the Part A hotfix commit `1a68983`). AGY review was **PASS**; Codex returned **REQUEST CHANGES** with two blockers, both now fixed by the Developer:

- Blocker 1 (hygiene): trailing whitespace on `docs/reports/latest-agy-review.md:8` removed; `git diff --check` PASS.
- Blocker 2 (app logic): `ItemDiscountModal` preview now computes via the shared `getLineTotal` path (no divergent second implementation of the discount arithmetic).

Codex already confirmed the cart math, type coverage, tests, and that forbidden areas were untouched. This fix changed no cart math, no `getLineTotal`, no `useCart.ts`, no `POSPage.tsx`.

Checks (rerun after the fix):
- `tsc -b`: exit 0.
- `vitest run src/hooks/pos/useCart.contract.test.ts`: 82 passed.
- `vitest run` (full): 734 passed (32 files).
- `git diff --check`: PASS.
- Staged: none. Committed: none.

## What Happens Next

**Next owner: Codex Reviewer (focused re-review).**

Do not route to Principal Engineer until Codex returns PASS or PASS WITH NOTES. If Codex finds further blockers, route back to the Developer.

---

## Codex Focused Re-Review Prompt (ready to copy)

```
TO: Codex Reviewer
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Focused re-review after REQUEST CHANGES fix, read-only, no staging, no commit

PHASE: 7C-UI-06-ENHANCEMENT-DISCOUNT-MODAL (Codex focused re-review)

PRIOR CODEX VERDICT: REQUEST CHANGES (two blockers).

FIXES APPLIED BY DEVELOPER:
1. Blocker 1 (hygiene): removed trailing whitespace on docs/reports/latest-agy-review.md line 8.
   git diff --check now PASS.
2. Blocker 2 (app logic): src/components/pos/ItemDiscountModal.tsx no longer re-implements the
   discount arithmetic for the preview. It now builds a candidate line
   `{ ...line, discount: { type: mode, val: num } }` and computes the preview via the shared
   getLineTotal(previewLine). The local `base` variable and per-mode if/else were removed.

UNCHANGED (accepted previously):
- src/lib/pos/cartUtils.ts getLineTotal math (base - val*qty, clamp, roundMoney).
- src/lib/pos/types.ts disc_per_unit type; IDP_LABELS / TAB_LABELS coverage.
- src/hooks/pos/useCart.contract.test.ts per-unit tests (still pass, 82 total).
- src/hooks/pos/useCart.ts and src/pages/POSPage.tsx untouched.

VERIFY:
1. git diff --check passes.
2. ItemDiscountModal preview uses the shared getLineTotal; no divergent discount arithmetic remains
   and no second roundMoney path.
3. Preview results are numerically identical to before for all four modes (regression safe).
4. All prior app-scope confirmations still hold; no forbidden files; nothing staged.

RUN AND REPORT:
git status --short
git diff --name-only
git diff --stat
git diff --check
git diff --cached --name-only

OUTPUT: PASS / PASS WITH NOTES / REQUEST CHANGES. Do not stage or commit.
If PASS / PASS WITH NOTES, route to Principal Engineer Reviewer / Workflow Coordinator.
If REQUEST CHANGES, route back to the Developer.
```

---

## Review Chain (remaining)

```
Developer Agent (just fixed Codex blockers)
  -> Codex Reviewer (focused re-review -- now)
    -> Principal Engineer Reviewer / Workflow Coordinator (coordination + abnormality checks)
      -> Tech Lead / CEO authorizes scope closure and commit
        -> CEO Physical UAT
```

## Important Reminders

- Logic exception is narrow: cart math unlocked ONLY for the per-unit discount.
- Do not stage or commit the enhancement until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Modified Files in Package (enhancement, unstaged)

- src/lib/pos/types.ts
- src/lib/pos/cartUtils.ts
- src/components/pos/ItemDiscountModal.tsx
- src/pages/POSPage.css
- src/hooks/pos/useCart.contract.test.ts
- docs/agent-workflow/STATE.md
- docs/agent-workflow/CURRENT_PACKET.md
- docs/agent-workflow/NEXT_ACTION.md
- docs/reports/latest-developer-report.md

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
