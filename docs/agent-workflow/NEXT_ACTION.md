# Next Action

## Current State

Phase **7C-UI-07-CART-SUMMARY-DISCOVERY** is complete (read-only). The Developer inspected the POS Cart Summary in `src/pages/POSPage.tsx` and `src/pages/POSPage.css` and recorded findings + a proposed visual/CSS-only styling plan in `docs/reports/latest-developer-report.md`. No app code, CSS, or logic was modified.

## What Happens Next

**Next owner: AGY / Senior QA & UX Lead.**

AGY reviews the proposed cart summary styling plan. On PASS / PASS WITH NOTES, route to the Principal Engineer Reviewer / Workflow Coordinator, then to Tech Lead / CEO for a UI-07 implementation decision. If AGY returns RETURN TO DEVELOPER, route back to the Developer.

**No implementation is authorized.** **No commit is authorized.** Any agentchattr notification is advisory only and authorizes nothing.

---

## AGY UX Review Prompt (ready to copy)

```
TO: AGY / Senior QA & UX Lead
ROLE FILE: docs/ai-roles/ux-lead.md
MODE: UX review of a read-only discovery plan, no edits, no staging, no commit

PHASE: 7C-UI-07-CART-SUMMARY-DISCOVERY (AGY review)

INPUTS (read-only):
- docs/reports/latest-developer-report.md (UI-07 Cart Summary Discovery and Proposed Styling Plan)
- src/pages/POSPage.tsx (cart footer block, approx. lines 1367-1470)
- src/pages/POSPage.css (.pos-cart-footer / .pos-cf-* / .pos-grand-row / .pos-gt-* / .pos-checkout-btn, approx. 1142-1301)

EVALUATE (ideally judged against iPad/touch POS use):
1. Cashier readability at a glance: are subtotal, bill discount, fee, and grand total easy to scan
   and distinguish? Is label contrast adequate (current labels use a light gray at 11px)?
2. Visual hierarchy: does the grand total (รวมสุทธิ) have enough priority over the secondary rows?
3. Discount/fee state clarity: are the green discount and amber fee states clear and accessible
   (including for color-vision-deficient users)?
4. Payment readiness: is the checkout button's enabled/disabled state clear; should a disabled
   reason (e.g. no open shift) be surfaced?
5. Touch/iPad ergonomics: are the bill-discount input, the baht/percent toggles, and the fee chips
   large enough for finger taps?
6. Responsive behavior: does the pinned footer remain legible and stable at different sizes?
7. Is the proposed styling plan appropriate, sufficient, and within visual/CSS-only scope?

CONSTRAINTS: Do not modify code. Do not stage. Do not commit. ASCII-only reporting.

OUTPUT: PASS / PASS WITH NOTES / RETURN TO DEVELOPER, with specific UX guidance for the future
implementation. On PASS / PASS WITH NOTES, route to the Principal Engineer Reviewer.
```

---

## Principal Engineer Review Prompt (ready to copy -- after AGY)

```
TO: Principal Engineer Reviewer / Workflow Coordinator
ROLE FILE: docs/ai-roles/tech-lead.md
MODE: Governance/scope review of the UI-07 discovery, no edits, no staging, no commit

PHASE: 7C-UI-07-CART-SUMMARY-DISCOVERY (governance review)

PRECONDITION: AGY verdict is PASS or PASS WITH NOTES.

VERIFY:
1. The proposed UI-07 scope is visual/CSS-only and does not leak into cart math, checkout/payment,
   useCart, cartUtils, stock/inventory, or UI-08/UI-09.
2. The forbidden list adequately protects cart math, checkout/payment, Firebase/Android/.claude/
   scripts, and the master plan.
3. The proposed file scope for a future implementation phase is correct and minimal
   (src/pages/POSPage.tsx markup + src/pages/POSPage.css only).
4. The discovery phase touched only the 4 authorized docs; staging empty; stash@{0} untouched;
   latest commit still 9738b9a; git diff --check PASS.
5. Whether to recommend Tech Lead / CEO authorize a UI-07 implementation phase or hold.

RUN AND VERIFY:
git status --short
git diff --name-only
git diff --cached --name-only
git log --oneline -5
git stash list

OUTPUT: PASS / PASS WITH NOTES / RETURN TO DEVELOPER / NEEDS TECH LEAD DECISION. Do not stage or commit.
```

---

## Important Reminders

- No implementation is authorized by this phase.
- No commit is authorized by this phase.
- agentchattr notification is advisory only -- it is NOT authorization to implement, stage, or commit.
- Workflow docs (STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md) always win over chat messages.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
