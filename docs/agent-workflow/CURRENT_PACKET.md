# Current Work Packet

## Phase

**7C-UI-06-CART-ITEM-ROWS-IMPLEMENTATION** -- authorized visual / interaction polish for cart item rows. Implementation complete, pending AGY review. No staging, no commit.

## Implementation objective

Improve POS cart item row readability and cashier usability while preserving all existing behavior. Visual / interaction polish only.

## Implementation result (this packet)

- CSS-only change in `src/pages/POSPage.css` (`.pos-ci*`). `POSPage.tsx` was not modified -- the markup structure already supported the polish, so no JSX, handler, or data-flow change was needed.
- No optional test file was touched: because the JSX/markup is unchanged, the `?raw` source-contract assertions on `POSPage.tsx` are unaffected, so no test edit was justified.
- `UI_MASTER_PLAN.md` markers corrected per Tech Lead / CEO Option B (UI-04 `[DONE]`, UI-05 `[DONE]`, `[CURRENT]` moved to UI-06; order unchanged).
- TypeScript build passed (`tsc -b`, exit 0). Targeted POS tests passed (235).

## App-code boundary (preserved)

- No cart math, pricing, discount, tax, checkout/payment, or stock/inventory change.
- `useCart.ts`, `useCart.contract.test.ts`, and `cartUtils.ts` untouched.
- Handlers, data flow, keyboard behavior, bump-flash behavior, and the remove/edit/quantity controls are all unchanged.

## Current cart item row location (read-only finding)

- **Rendering:** `src/pages/POSPage.tsx`, the `displayCartLines.map(...)` block (approx. lines 1250-1357). Each row is a `.pos-ci` container with three regions: `.pos-ci-name` (product name + UOM tag + discount/tier tags + oversell warning), `.pos-ci-price-bar` (`.pos-ci-price-row` with original/unit price and `.pos-ci-line-total`), and `.pos-ci-toolbar` (`.pos-ci-qty-group` minus/value/plus, plus `.pos-ci-icon-btn` edit and danger remove buttons).
- **Styling:** `src/pages/POSPage.css`, the `.pos-ci*` class block (approx. lines 865-1124), including the `posCartBumpFlash` keyframes and `prefers-reduced-motion` guard.
- **Math/data (NOT row UI):** line totals and money formatting come from `getLineTotal` and `formatMoney` in `src/lib/pos/cartUtils.ts`; cart mutations (`changeQty`, `removeLine`, `setLineQty`) come from the `useCart` hook (`src/hooks/pos/useCart.ts`). `displayCartLines` is a `useMemo` reverse of `cartLines` in POSPage.

## Proposed implementation scope (later phase, NOT now)

UI-06 is **visual / interaction polish for cart item rows only**, preserving all existing behavior:

- cart item row spacing and padding
- cart item row visual hierarchy (name vs price vs total)
- product name readability (size, weight, truncation/wrap)
- quantity / price display layout
- row hover / focus states where already structurally compatible
- removing or reducing visual clutter
- responsive cart row layout
- readability improvements for cashier speed

No behavior, math, data, or business-logic change.

## Proposed file list

Likely required:
- `src/pages/POSPage.tsx` -- cart row JSX markup only (class names, element grouping, presentational structure). No handler logic, no math, no data flow change.
- `src/pages/POSPage.css` -- `.pos-ci*` styling only.

Optional (only if implementation truly needs it, separately justified):
- `src/pages/POSPage.keyboard-contract.test.ts` -- only if a row structure change must be re-locked by an existing `?raw` contract test.
- `src/pages/POSPage.product-card.test.ts` -- only if a shared POS preference/wiring assertion is affected.

Forbidden unless separately authorized:
- `src/hooks/pos/useCart.ts`
- `src/hooks/pos/useCart.contract.test.ts`
- `src/lib/pos/cartUtils.ts`
- `src/hooks/pos/useCheckout.ts`, `src/lib/pos/asyncCheckout.ts`
- `src/hooks/pos/usePosInventory.ts`, `src/lib/pos/inventoryRepository.ts`
- any Firebase / functions / rules, Android / Capacitor, `.claude/`, scripts, tooling configs

## Forbidden file / scope list (this and the future implementation phase)

- cart math, quantity calculation, pricing calculation
- discount logic, tax logic
- checkout / payment logic
- `useCart` business logic
- stock / inventory logic
- Firebase / functions / rules
- Android / Capacitor
- `.claude/`
- scripts / tooling
- `UI_MASTER_PLAN.md` ordering changes
- UI-07 Cart Summary, UI-08 Action Buttons, UI-09 Checkout / F12

## AGY / Codex review plan

For the future implementation phase, in order:

1. Developer implements the authorized visual/interaction scope and self-reviews.
2. AGY (Senior QA & UX Lead) performs visual / UX review FIRST (required for UI-facing changes unless CEO waives).
3. Codex Reviewer reviews code, tests, scope, hygiene, and package after AGY passes.
4. Principal Engineer Reviewer / Workflow Coordinator coordinates and runs abnormality checks.
5. Tech Lead / CEO authorizes scope closure and the commit (commit-only prompt).
6. CEO performs Physical UAT.

## Stop condition

After this implementation packet and the developer report, stop. No staging, no commit, no `git add .`, no scripts, no installs. Do not route to Codex before AGY. Wait for AGY visual / UX review.

---

## Role Sequence (for the future UI-06 implementation)

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
