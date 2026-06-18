# Next Action

## Current State

Phase **7C-UI-06-HOTFIX-DISCOUNT-UI** is in **Codex blocker fix** cycle. The Developer is fixing docs/hygiene issues identified by Codex REQUEST CHANGES. The app hotfix implementation is confirmed safe by Codex and is not being changed.

Review progress:

- AGY review: **PASS** (see `docs/reports/latest-agy-review.md`).
- Codex review: **REQUEST CHANGES** -- app hotfix scope confirmed safe, but docs/hygiene blockers found (trailing whitespace in AGY report, documentation evidence mismatch on git diff --check claim, stale handoff routing).
- Developer: fixing the docs/hygiene blockers (this cycle).

Checks (from implementation phase, unchanged):

- TypeScript build: `tsc -b` exit 0.
- Targeted POS tests: 235 passed (keyboard-contract, product-card, useCart.contract).
- Full Vitest unit suite: 727 passed (32 files).
- `git diff --check`: PASS (after trailing whitespace fix).
- Staged: none. Committed: none.

Files changed (app): `src/pages/POSPage.tsx`, `src/pages/POSPage.css`, `src/components/pos/ItemDiscountModal.tsx`, `src/components/pos/NumpadDialog.tsx`.

## What Happens Next

**Current owner: Developer Agent** -- fixing Codex REQUEST CHANGES blockers (docs/hygiene only).

**After fix, next owner: Codex Reviewer** -- focused re-review of the docs/hygiene fixes.

Do not route to Principal Engineer until Codex returns PASS or PASS WITH NOTES.

## Review Chain (remaining after Developer fix)

```
Developer Agent (now -- fixing Codex blockers)
  -> Codex Reviewer (focused re-review)
    -> Principal Engineer Reviewer / Workflow Coordinator (coordination + abnormality checks)
      -> Tech Lead / CEO authorizes scope closure and commit
        -> CEO Physical UAT
```

---

## Codex Focused Re-Review Prompt (use after Developer fix is complete)

```
TO: Codex Reviewer
MODEL: best available reviewer model for this run
REASONING: Medium
ROLE: Codex Reviewer
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Focused re-review after REQUEST CHANGES fix, read-only, no staging, no commit

PHASE: 7C-UI-06-HOTFIX-DISCOUNT-UI (Codex focused re-review)

PRIOR CODEX VERDICT: REQUEST CHANGES

FIXES APPLIED BY DEVELOPER:
1. Trailing whitespace removed from docs/reports/latest-agy-review.md line 11.
2. Documentation evidence updated: developer report now notes Codex found the
   trailing whitespace, Developer fixed it, and rerun git diff --check PASS.
3. STATE.md and NEXT_ACTION.md updated to reflect AGY PASS, Codex REQUEST CHANGES,
   Developer fix cycle, and correct routing to Codex re-review.

APP HOTFIX IMPLEMENTATION UNCHANGED:
- src/pages/POSPage.tsx: discount badge display (unchanged from prior review).
- src/pages/POSPage.css: discount badge readability (unchanged from prior review).
- src/components/pos/ItemDiscountModal.tsx: numpad wiring (unchanged from prior review).
- src/components/pos/NumpadDialog.tsx: backdrop dismiss race fix (unchanged from prior review).
- useCart.ts, useCart.contract.test.ts, cartUtils.ts: untouched.
- No checkout/payment/stock/inventory/FIFO/Firebase/Android/.claude/scripts/tooling.

VERIFY:
1. git diff --check passes (trailing whitespace fixed).
2. STATE.md and NEXT_ACTION.md routing is current and correct.
3. Documentation evidence in latest-developer-report.md is accurate.
4. All prior app-scope confirmations still hold.
5. docs/reports/latest-agy-review.md is accounted for in the package.

RUN AND REPORT:
git status --short
git diff --name-only
git diff --stat
git diff --check
git diff --cached --name-only

Produce a verdict (PASS / PASS WITH NOTES / REQUEST CHANGES).
Do not stage or commit.
If PASS / PASS WITH NOTES, route to Principal Engineer Reviewer / Workflow Coordinator.
```

---

## Important Reminders

- AGY verdict is PASS (confirmed from docs/reports/latest-agy-review.md).
- The existing governance chain remains the absolute source of truth.
- Do not stage or commit until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Modified Files in Package (complete list)

- src/pages/POSPage.tsx -- discount badge display.
- src/pages/POSPage.css -- discount badge readability.
- src/components/pos/ItemDiscountModal.tsx -- numpad wiring.
- src/components/pos/NumpadDialog.tsx -- backdrop dismiss race fix.
- docs/agent-workflow/STATE.md -- phase / owner / status tracking.
- docs/agent-workflow/CURRENT_PACKET.md -- hotfix packet.
- docs/agent-workflow/NEXT_ACTION.md -- handoff routing (this file).
- docs/reports/latest-developer-report.md -- developer report.
- docs/reports/latest-agy-review.md -- AGY-generated review artifact.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
