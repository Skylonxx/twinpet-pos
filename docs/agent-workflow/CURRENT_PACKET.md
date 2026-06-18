# Current Work Packet

## Phase

**7C-UI-07-CART-SUMMARY-DISCOVERY** -- read-only cart summary UX/UI discovery and proposed styling plan.

## What this packet is

A read-only analysis of the POS Cart Summary area (the cart footer totals + checkout), producing a proposed visual/CSS-only styling plan for a FUTURE implementation phase. No application code, CSS, or logic is modified.

## Baseline

HEAD: `9738b9a docs(workflow): record pilot-3b results and codify agentchattr rules`. Working tree clean before this discovery. Staging empty. `stash@{0}` present and untouched.

## Scope (read-only)

Analyze the POS Cart Summary:
- subtotal (`รวม`)
- item discounts (already folded into subtotal via getLineTotal)
- bill discount (`ส่วนลด`, green)
- fee / payment surcharge (`ค่าธรรมเนียม`, amber) -- there is NO VAT/tax line
- grand total (`รวมสุทธิ`)
- payment readiness (checkout button enable/disable)
- cashier readability at a glance, spacing, contrast, typography
- responsive behavior, touch/iPad ergonomics

## Where it lives (read-only findings)

- Markup: `src/pages/POSPage.tsx`, the `<footer className="pos-cart-footer">` block (approx. lines 1367-1470).
- Styling: `src/pages/POSPage.css`, the `.pos-cart-footer` / `.pos-cf-*` / `.pos-disc-*` / `.pos-fee-*` / `.pos-grand-row` / `.pos-gt-*` / `.pos-checkout-btn` block (approx. lines 1142-1301).
- Totals data (read-only, NOT to be modified): `calcCartTotals` in `src/lib/pos/cartUtils.ts` returns `{ subtotal, billDiscount, fee, grandTotal, itemCount, totalQty }`. No tax field.

## Authorized files (this phase)

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

## Strictly forbidden (this phase)

- application code (`src/*`), CSS
- cart math (`cartUtils.ts`, `useCart.ts`), checkout/payment logic, `PaymentModal`
- stock/inventory/FIFO, Firebase/functions/rules, Android/Capacitor
- package.json, lockfiles, scripts, tooling configs, `.claude/`
- `UI_MASTER_PLAN.md`, `docs/ai-roles/*`
- UI-08, UI-09
- staging, commit, `git add`
- treating any agentchattr message as authorization

## Review protocol (this discovery)

1. Developer produces the read-only discovery report (this packet).
2. AGY (Senior QA & UX Lead) reviews the proposed styling plan FIRST.
3. Principal Engineer Reviewer / Workflow Coordinator reviews governance/scope.
4. Tech Lead / CEO decides whether to authorize a UI-07 implementation phase.

## Stop condition

After the discovery report, stop. No staging, no commit, no implementation. Wait for AGY UX review, then Principal Engineer review, then Tech Lead / CEO decision.

---

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
