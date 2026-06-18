# Current Work Packet

## Phase

**7C-UI-06-ENHANCEMENT-DISCOUNT-MODAL** -- item discount modal scaling plus a new "Discount per unit" (ส่วนลดต่อหน่วย) discount option and its math. Built on the Part A hotfix commit `1a68983`. Implementation complete, pending AGY review. No staging, no commit.

## Enhancement goals

1. UI scaling -- make `ItemDiscountModal` feel balanced and comfortable next to the large numpad overlay.
2. New feature -- add a "Discount per unit" discount option (Thai: ส่วนลดต่อหน่วย).
3. Logic -- per-unit discount: row total discount = per-unit amount x item quantity.

## Logic exception (narrow)

Tech Lead / CEO authorized modifying cart math/logic strictly to implement Discount per unit. Exercised in:
- `src/lib/pos/types.ts` -- add `disc_per_unit` to `ItemDiscountType`.
- `src/lib/pos/cartUtils.ts` -- `getLineTotal` per-unit branch (`base - val * qty`, clamped at 0) and the `IDP_LABELS` entry.

`src/hooks/pos/useCart.ts` was inspected and left unchanged: its `setLineDiscount` stores `{ type, val }` generically, so the new mode needs no hook change. This narrow permission is not a license for unrelated cart-math edits.

## Implementation summary

- Modal scaling (POSPage.css, idp-scoped only; UomModal shared rules untouched): `.pos-item-disc-popup` width 280px -> 360px, padding 18px -> 22px, gap 10px -> 14px; tabs padding/font enlarged (9px / 12px, nowrap); input 16px; result 13px; actions/buttons enlarged; title/prod/cancel idp overrides added.
- New tab (ItemDiscountModal.tsx): the tab list now includes `disc_per_unit` rendered as "ลด/หน่วย"; a `TAB_LABELS` map replaces the old inline ternary so each mode caption is explicit. The full field label "ส่วนลดต่อหน่วย (฿)" shows above the input via `IDP_LABELS`.
- Preview (ItemDiscountModal.tsx): per-unit preview mirrors `getLineTotal` (`base - num * qty`).
- Math (cartUtils.ts): `getLineTotal` returns `max(0, base - val * qty)` for `disc_per_unit`. The existing cart-row badge already derives its displayed amount from `base - getLineTotal`, so it shows the per-unit row discount with no POSPage change.
- Save/apply flow unchanged: the existing Save button calls `onSave(mode, val)` -> `setLineDiscount`; no auto-submit; numpad confirm only writes the field value.

## Authorized files

- `src/lib/pos/types.ts`
- `src/lib/pos/cartUtils.ts`
- `src/components/pos/ItemDiscountModal.tsx`
- `src/pages/POSPage.css`
- `src/hooks/pos/useCart.contract.test.ts`
- (allowed but not needed: `src/hooks/pos/useCart.ts`, `src/pages/POSPage.tsx`, `src/components/pos/NumpadDialog.tsx`)
- docs: `STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `latest-developer-report.md`

`src/lib/pos/types.ts` is outside the "likely allowed" list but was directly required to declare the new discount mode (the canonical type location); justified here and in the developer report.

## Forbidden files / scope

- checkout / payment flow (beyond the existing computed line-discount display path)
- stock / inventory / FIFO logic
- Firebase / functions / rules, Android / Capacitor, `.claude/`, scripts, tooling
- UI-07 Cart Summary redesign, UI-08 Action Buttons, UI-09 Checkout / F12
- staging, commit, `git add`

## Tests / checks

- `git diff --check` (PASS).
- `npx tsc -b` (exit 0).
- `npx vitest run` targeted (useCart.contract, keyboard-contract, product-card) -- 242 passed (7 new per-unit tests).
- `npx vitest run` full suite -- 734 passed (32 files).

New per-unit math tests (useCart.contract.test.ts): per-unit qty>1 (5x3=15 off), qty=1 (5 off), clamp-at-0, and regression locks for disc_thb / disc_pct / override / none.

## Review protocol (AGY first, then Codex)

1. Developer implements and self-reviews (this packet).
2. AGY (Senior QA & UX Lead) reviews modal proportions and the new tab/option FIRST.
3. Codex Reviewer reviews code, types, cart math, and test coverage (heavily) after AGY passes.
4. Principal Engineer Reviewer / Workflow Coordinator coordinates + abnormality checks.
5. Tech Lead / CEO authorizes scope closure and commit.
6. CEO performs Physical UAT.

## Stop condition

After this packet and the developer report, stop. Do not stage or commit the enhancement. Do not route to Codex before AGY. Wait for AGY visual / UX review.

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
