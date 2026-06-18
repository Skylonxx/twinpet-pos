# Current Work Packet

## Phase

**7C-UI-06-HOTFIX-DISCOUNT-UI** -- authorized hotfix after CEO Physical UAT failed on the UI-06 commit (`630b742`). Three targeted fixes. Implementation complete, pending AGY review. No staging, no commit.

## UAT failed issues (origin of this hotfix)

1. Cart item row discount badge -- text cramped, overflows, and does not show the actual discount amount.
2. Item discount modal -- the value input does not trigger the custom on-screen numpad.
3. Bill discount numpad on iPad / touch -- tapping the input makes the numpad flash and instantly disappear (touch/focus race).

## Authorized scope

Visual / interaction hotfix only, for the three issues above. Permission explicitly extends to the bill-discount trigger area strictly to fix the numpad race -- this is NOT permission to implement UI-07.

## Implementation result (this packet)

- Fix 1 (discount badge): `src/pages/POSPage.tsx` cart row now renders the formatted discount amount (`ลด ฿X`), derived from values already computed in the row (base minus `getLineTotal`). `src/pages/POSPage.css` `.pos-ci-disc-tag` made `inline-block` + `nowrap` with a touch more padding so it never breaks mid-number or reads as cramped. No new discount math.
- Fix 2 (item discount modal numpad): `src/components/pos/ItemDiscountModal.tsx` value input now opens the existing touch-only `NumpadDialog` (decimal/zero mode) on pointerdown, mirroring the bill-discount field. The numpad writes back into the field value only; the existing Save button still applies the discount. No discount math, no auto-submit.
- Fix 3 (numpad touch race): `src/components/pos/NumpadDialog.tsx` backdrop now dismisses on `onPointerDown` instead of `onClick`, so the same tap that opens the dialog (from an input's onPointerDown) can no longer close it via the ghost compatibility click.

## Allowed files (this hotfix)

- `src/pages/POSPage.tsx` (modified -- discount badge display)
- `src/pages/POSPage.css` (modified -- discount badge readability)
- `src/components/pos/ItemDiscountModal.tsx` (modified -- numpad wiring)
- `src/components/pos/NumpadDialog.tsx` (modified -- backdrop dismiss race fix; this is the existing numpad component)
- workflow/report docs: `STATE.md`, `CURRENT_PACKET.md`, `NEXT_ACTION.md`, `latest-developer-report.md`

Conditionally allowed test files were NOT needed: the `?raw` contract assertions remain green unchanged (no asserted substring/region was removed), so no test edit was justified.

## App-code boundary (preserved)

- No cart math, pricing, discount-calculation, tax, total, checkout/payment, stock/inventory, or FIFO change.
- `src/hooks/pos/useCart.ts`, `src/hooks/pos/useCart.contract.test.ts`, and `src/lib/pos/cartUtils.ts` untouched.
- Existing modal behavior, keyboard contracts, bump-flash, qty numpad, F12/payment flow all unchanged.

## Forbidden scope (this hotfix)

- cart math, pricing, discount calculation, tax, total calculation, checkout/payment calculation, stock/inventory, FIFO, `useCart` rules, `cartUtils` calculations
- restructuring Cart Summary beyond the numpad trigger fix
- UI-07 / UI-08 / UI-09
- PaymentModal redesign, checkout/order-submit/stock-mutation changes
- Firebase / functions / rules, Android / Capacitor, `.claude/`, scripts, tooling
- staging, commit, `git add .`

## Test / check plan

- `git diff --check` (PASS).
- TypeScript build (`tsc -b`).
- Targeted POS tests (keyboard-contract, product-card, useCart.contract).
- Full Vitest unit suite (shared `NumpadDialog` touched).

## Review protocol

1. Developer implements and self-reviews (this packet).
2. AGY (Senior QA & UX Lead) performs visual / UX review FIRST.
3. Codex Reviewer reviews code, tests, scope, hygiene, package after AGY passes.
4. Principal Engineer Reviewer / Workflow Coordinator coordinates + abnormality checks.
5. Tech Lead / CEO authorizes scope closure and commit (commit-only prompt).
6. CEO performs Physical UAT.

## Stop condition

After this hotfix packet and the developer report, stop. No staging, no commit, no `git add .`. Do not route to Codex before AGY. Wait for AGY visual / UX review.

---

## Role Sequence (this hotfix)

```
Developer Agent                         -- ROLE FILE: docs/ai-roles/developer.md
  -> AGY / Senior QA & UX Lead          -- ROLE FILE: docs/ai-roles/ux-lead.md
    -> Codex Reviewer                   -- ROLE FILE: docs/ai-roles/reviewer.md
      -> Principal Engineer Reviewer /  -- ROLE FILE: docs/ai-roles/tech-lead.md
         Workflow Coordinator
        -> Tech Lead / CEO authorizes scope closure and commit
          -> CEO Physical UAT
```

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
