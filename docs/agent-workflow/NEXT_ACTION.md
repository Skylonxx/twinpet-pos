# Next Action

## Current State

Phase **7C-UI-06-CART-ITEM-ROWS-IMPLEMENTATION** is in **Codex blocker fix** cycle. The Developer is fixing docs/hygiene issues identified by Codex REQUEST CHANGES. The app implementation (CSS-only in `src/pages/POSPage.css`) is confirmed safe by Codex and is not being changed.

Review progress:

- AGY review: **PASS** (see `docs/reports/latest-agy-review.md`).
- Codex review: **REQUEST CHANGES** -- app scope confirmed safe, but docs/hygiene blockers found (trailing whitespace in AGY report, stale NEXT_ACTION routing, AGY verdict text mismatch, unaccounted AGY report file).
- Developer: fixing the docs/hygiene blockers (this cycle).

Checks (from implementation phase, unchanged):

- TypeScript build: `tsc -b` exit 0.
- Targeted POS tests: 235 passed (keyboard-contract, product-card, useCart.contract).
- Staged: none. Committed: none.

## What Happens Next

**Current owner: Developer Agent** -- fixing Codex REQUEST CHANGES blockers (docs/hygiene only).

**After fix, next owner: Codex Reviewer** -- re-review the package with the docs/hygiene fixes applied.

Do not route to Principal Engineer until Codex returns PASS or PASS WITH NOTES.

## Review Chain (remaining after Developer fix)

```
Developer Agent (now -- fixing Codex blockers)
  -> Codex Reviewer (re-review)
    -> Principal Engineer Reviewer / Workflow Coordinator (coordination + abnormality checks)
      -> Tech Lead / CEO authorizes scope closure and commit
        -> CEO Physical UAT
```

---

## Codex Re-Review Prompt (use after Developer fix is complete)

```
TO: Codex Reviewer
MODEL: best available reviewer model for this run
REASONING: Medium
ROLE: Codex Reviewer
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Re-review after REQUEST CHANGES fix, read-only, no staging, no commit

PHASE: 7C-UI-06-CART-ITEM-ROWS-IMPLEMENTATION (Codex re-review)

PRIOR CODEX VERDICT: REQUEST CHANGES

FIXES APPLIED BY DEVELOPER:
1. Trailing whitespace removed from docs/reports/latest-agy-review.md line 9.
2. NEXT_ACTION.md updated to reflect AGY PASS, Codex REQUEST CHANGES, and correct routing.
3. AGY verdict reconciled: the AGY report says PASS, all references now say PASS consistently.
4. docs/reports/latest-agy-review.md accounted for as AGY-generated review artifact in developer report and workflow docs.

APP IMPLEMENTATION UNCHANGED:
- src/pages/POSPage.css: CSS-only cart item row polish (unchanged from prior review).
- POSPage.tsx: not modified.
- useCart.ts, useCart.contract.test.ts, cartUtils.ts: untouched.
- No checkout/payment/stock/inventory/Firebase/Android/.claude/scripts/tooling.

VERIFY:
1. git diff --check passes (trailing whitespace fixed).
2. NEXT_ACTION.md routing is current and correct.
3. AGY verdict is consistently PASS across all docs.
4. docs/reports/latest-agy-review.md is accounted for in the package.
5. All prior app-scope confirmations still hold.

RUN AND REPORT:
git status --short
git diff --name-only
git diff --stat
git diff --check
git diff --cached --name-only

Produce a verdict (PASS / PASS WITH NOTES / REQUEST CHANGES).
Do not stage or commit.
```

---

## Important Reminders

- AGY verdict is PASS (confirmed from docs/reports/latest-agy-review.md).
- `UI_MASTER_PLAN.md` order is unchanged; only the stale markers were corrected per Option B.
- The existing governance chain remains the absolute source of truth.
- Do not stage or commit until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Modified Files in Package (complete list)

- src/pages/POSPage.css -- app implementation (CSS-only cart item row polish).
- docs/agent-workflow/UI_MASTER_PLAN.md -- marker correction only (Option B).
- docs/agent-workflow/STATE.md -- phase / owner / status tracking.
- docs/agent-workflow/CURRENT_PACKET.md -- phase packet.
- docs/agent-workflow/NEXT_ACTION.md -- handoff routing (this file).
- docs/reports/latest-developer-report.md -- developer report.
- docs/reports/latest-agy-review.md -- AGY-generated review artifact (modified during AGY review step).

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
