# Current Work Packet

## Phase

**7C-UI-06-HOTFIX-MODAL-REDESIGN** -- ItemDiscountModal draft-vs-saved state contract and footer UX redesign, after CEO UAT failed again on the modal's state behavior and footer proportions. Implementation complete, pending AGY review. No staging, no commit.

## Supersedes (not committed)

The prior RBAC hotfix package (`7C-UI-06-HOTFIX-MODAL-UX-RBAC`) reached Codex PASS but was NOT committed; it is superseded by this new CEO UAT failure. We continue from the same uncommitted working tree and layer these redesign fixes on top. Nothing is committed.

## Baseline

HEAD remains `77837ca` (manager PIN backlog). The working tree already carried the prior uncommitted RBAC package (CURRENT_PACKET.md, NEXT_ACTION.md, STATE.md, latest-agy-review.md, latest-developer-report.md, ItemDiscountModal.tsx). Preflight matched; staging empty; `stash@{0}` untouched.

## CEO UAT failed issues

1. State destruction -- switching tabs and then Saving could erase/overwrite the saved discount; the modal must not mutate cart data merely because a tab changed.
2. Poor footer UI -- the Clear button was too heavy/obtrusive; Cancel and Save proportions looked awkward/broken.
3. AGY must heavily re-review proportions, spacing, hierarchy, and standard dialog pattern.

## Strict scope

- Draft vs saved state separation in ItemDiscountModal.
- Tab-switch local draft reset.
- Clear/remove discount as a DRAFT edit (no cart mutation until Save).
- Footer layout/proportions redesign.
- Preserve the existing Price Override RBAC.

Not in scope: Manager PIN Overlay, UI-07/08/09, checkout/cart-summary redesign, any new auth/session feature.

## Implementation summary

- Draft contract: `mode` + `value` are the local draft; the cart line is mutated ONLY by `onSave` via the Save button (`handleSave`). The open-effect seeds the draft from the saved line (RBAC-guarded). Tab switch and Clear edit the draft only; Cancel (`onClose`) discards the draft; saved state is unchanged unless Save is pressed.
- Clear: `handleClear` resets the draft to a safe no-discount state (mode -> `disc_thb`, value cleared, numpad closed) and updates the preview to base price. It NO LONGER calls `onSave`; the prior immediate `onSave('none', 0)` mutation was removed. Clear then Cancel keeps the original discount; Clear then Save removes it.
- Tab switch: clears draft input (`setValue('')`) and closes the numpad (`setNumpadOpen(false)`); no auto-apply; saved state untouched.
- Footer redesign: a new standard dialog footer (`.pos-idp-footer`) -- subtle ghost red "ล้างส่วนลด" on the left; Cancel (outline) + Save (primary solid) grouped on the right with clean gap. Replaces the prior full-width Clear block and the awkward actions row.
- RBAC preserved: `useAuth().user.role`; `availableModes` excludes override for non-managers; open-effect forces a safe mode if a line carries an override for a non-manager; `handleSave` has the final non-manager override guard.
- Preview: unchanged -- still computed via the shared `getLineTotal` (no local duplicate discount math).

## Authorized files

- `src/components/pos/ItemDiscountModal.tsx` (modified).
- `src/pages/POSPage.css` (modified -- minimal new footer classes; strictly necessary for the footer layout/proportions).
- docs: `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `STATE.md`, `docs/reports/latest-developer-report.md`, and `docs/reports/latest-agy-review.md` (marked superseded for the new phase).

## Forbidden (untouched)

- `src/hooks/pos/useCart.ts`, `src/lib/pos/cartUtils.ts`, `src/hooks/pos/useCart.contract.test.ts`, `src/lib/pos/types.ts`, `src/pages/POSPage.tsx`
- checkout / payment, stock / inventory, FIFO
- Firebase / functions / rules, Android / Capacitor, `.claude/`, scripts, tooling
- `UI_MASTER_PLAN.md`, Manager PIN Overlay (UI-10), UI-07 / UI-08 / UI-09
- staging, commit, `git add`

## Critical logic boundary (preserved)

No change to `getLineTotal`, per-unit discount, price-override calculation, line total, checkout totals, payment totals, tax, stock, or FIFO. The modal still commits via the existing `onSave`.

## Tests / checks

- `git diff --check` (PASS).
- `npx tsc -b` (exit 0).
- `npx vitest run` targeted (useCart.contract, keyboard-contract, product-card) -- 242 passed.
- `npx vitest run` full -- 734 passed (32 files).
- No existing ItemDiscountModal test file (not overclaiming).

## Review protocol (AGY first, then Codex)

1. Developer implements and self-reviews (this packet).
2. AGY heavily re-reviews footer proportions/spacing/hierarchy/standard dialog pattern, tab UX, saved-state preservation, and RBAC visibility.
3. Codex reviews draft-vs-saved separation, Clear-without-mutation, Cancel-discards, Save-commits, RBAC non-bypass, and that no cart math/useCart/cartUtils/checkout/payment/stock/Firebase changed.
4. Principal Engineer coordinates + abnormality checks.
5. Tech Lead / CEO authorizes scope closure and commit.
6. CEO performs Physical UAT.

## Stop condition

After this packet and the developer report, stop. Do not stage or commit. Do not route to Codex before AGY. Wait for AGY visual / UX review.

---

## STATE CARD Requirement

Every report for this phase must end with a filled STATE CARD block:

```
STATE CARD
Phase:
Current owner:
Verdict:
Files changed:
Files inspected:
Tests/checks:
Staged:
Committed:
Required fixes:
Next owner:
Next action:
Stop condition:
```

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
