# Next Action

## Current State

Phase **7C-UI-06-HOTFIX-MODAL-REDESIGN** is **implemented** and awaiting review (HEAD `77837ca`; uncommitted, superseding the prior RBAC package which is NOT committed).

Delivered (in `src/components/pos/ItemDiscountModal.tsx` + footer CSS in `src/pages/POSPage.css`):
- Draft-vs-saved state contract: tab switches and Clear edit a local draft only; the cart line is mutated solely by Save; Cancel discards the draft.
- Clear ("ล้างส่วนลด") is now a DRAFT edit (no `onSave` until Save); preview returns to base price.
- Tab switch clears draft input + closes the numpad; no auto-apply; saved state untouched.
- Footer redesign: subtle ghost Clear (left) + Cancel (outline) and Save (primary) grouped (right), standard dialog proportions.
- Price Override RBAC preserved (manager/admin only; default-deny; open-effect + save guard).

Checks:
- `tsc -b`: exit 0.
- `vitest run` targeted (useCart.contract + keyboard-contract + product-card): 242 passed.
- `vitest run` full: 734 passed (32 files).
- `git diff --check`: PASS.
- Staged: none. Committed: none.

## What Happens Next

**Next owner: AGY / Senior QA & UX Lead.**

AGY visual / UX review must occur BEFORE Codex. After AGY PASS / PASS WITH NOTES, route to Codex with the prompt below. If AGY returns REQUEST CHANGES, route back to the Developer.

---

## AGY Review Prompt (ready to copy)

```
TO: AGY / Senior QA & UX Lead
ROLE FILE: docs/ai-roles/ux-lead.md
MODE: Visual / UX review, read-only, no staging, no commit

PHASE: 7C-UI-06-HOTFIX-MODAL-REDESIGN (AGY review)

CONTEXT: ItemDiscountModal redesign after CEO UAT failed on state behavior and footer proportions.
App files: src/components/pos/ItemDiscountModal.tsx and src/pages/POSPage.css (footer classes).

VERIFY (read-only; ideally on an iPad / touch emulation):
1. Footer proportions and pattern:
   - Standard dialog footer: subtle "ล้างส่วนลด" (ghost/red text) on the LEFT; Cancel (outline) and
     Save (primary solid) grouped on the RIGHT with clean, balanced spacing.
   - Clear is subtle and does NOT visually compete with Save; no heavy full-width block.
   - Cancel/Save alignment and spacing look professional; no awkward/broken proportions.
2. Modal comfort: the modal stays comfortable and legible with the on-screen numpad open.
3. Tab switching UX: switching tabs clears the draft input smoothly; no stale value carries over.
4. Saved-state preservation (UX perspective):
   - Open an item that has a saved discount, switch tabs, then Cancel -> the item keeps its original
     discount (nothing destroyed).
   - Clear then Cancel -> original discount preserved; Clear then Save -> discount removed.
5. RBAC: staff/cashier cannot see or use Price Override ("แก้ราคา"); manager/admin can (if testable).

CONSTRAINTS: Do not modify code. Do not stage. Do not commit. ASCII-only reporting.

OUTPUT: PASS / PASS WITH NOTES / RETURN TO DEVELOPER, with any visual fixes required.
On PASS / PASS WITH NOTES, hand off to Codex using the Codex prompt in NEXT_ACTION.md.
On REQUEST CHANGES, route back to the Developer.
```

---

## Codex Review Prompt (ready to copy -- use ONLY after AGY PASS / PASS WITH NOTES)

```
TO: Codex Reviewer
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Code / state-contract / RBAC / hygiene review, read-only, no staging, no commit

PHASE: 7C-UI-06-HOTFIX-MODAL-REDESIGN (Codex review)

PRECONDITION: AGY verdict is PASS or PASS WITH NOTES (see docs/reports/latest-agy-review.md).

REVIEW: src/components/pos/ItemDiscountModal.tsx and src/pages/POSPage.css (footer classes).

VERIFY:
1. Draft vs saved separation: `mode` + `value` are local draft only; the cart line is mutated ONLY
   by onSave, called solely by Save (handleSave). The open-effect seeds the draft from the saved line.
2. Clear does NOT mutate the cart: handleClear resets draft state only (no onSave); the cart line is
   removed only when the cashier presses Save afterward.
3. Tab switch does not erase saved cart state: tab onClick only sets local draft (setMode/setValue/
   setNumpadOpen); no onSave; no auto-apply.
4. Cancel discards the draft (onClose, no save); Save commits the draft (onSave then onClose).
5. RBAC cannot be bypassed via stale internal state: availableModes excludes override for non-managers;
   open-effect forces a safe mode when a line carries an override for a non-manager; handleSave has the
   final non-manager override guard (mode === 'override' && !canOverridePrice -> safe mode).
6. Preview still uses the shared getLineTotal (no local duplicate discount math).
7. No cart math / useCart.ts / cartUtils.ts / types.ts / POSPage.tsx change; no checkout/payment/
   stock/inventory/FIFO/Firebase/Android/.claude/scripts/tooling; no Manager PIN; no UI-07/08/09.
8. TypeScript safety and git hygiene (diff --check passes; nothing staged).

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
AGY / Senior QA & UX Lead (now)
  -> Codex Reviewer (state contract / RBAC / hygiene)
    -> Principal Engineer Reviewer / Workflow Coordinator (coordination + abnormality checks)
      -> Tech Lead / CEO authorizes scope closure and commit
        -> CEO Physical UAT
```

## Important Reminders

- The prior RBAC package's Codex PASS is SUPERSEDED by this CEO UAT failure; do not commit it.
- Manager PIN Overlay is FUTURE backlog (UI-10) -- not implemented here.
- Do not stage or commit until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP -- do not touch.
- Old manual workflow remains available as fallback.

## Modified Files in Package (this phase, unstaged)

- src/components/pos/ItemDiscountModal.tsx
- src/pages/POSPage.css
- docs/agent-workflow/CURRENT_PACKET.md
- docs/agent-workflow/NEXT_ACTION.md
- docs/agent-workflow/STATE.md
- docs/reports/latest-developer-report.md
- docs/reports/latest-agy-review.md (marked superseded; fresh AGY review pending)

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Principal Engineer Reviewer / Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
