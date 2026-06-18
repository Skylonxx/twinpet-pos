# Latest Developer Report

## Phase

7C-UI-07-CART-SUMMARY-DISCOVERY -- UI-07 Cart Summary Discovery and Proposed Styling Plan.

## 1. Summary

Read-only discovery of the POS Cart Summary (the cart footer totals + checkout area). Inspected the markup in `src/pages/POSPage.tsx` and the styling in `src/pages/POSPage.css`, plus the totals shape in `src/lib/pos/cartUtils.ts` (read-only, for display wiring only). No application code, CSS, cart math, or checkout/payment logic was modified. This phase produces findings and a proposed visual/CSS-only styling plan for a FUTURE implementation phase. Note: the summary has NO VAT/tax line; `fee` is a payment-method surcharge, not tax. Preflight was clean (HEAD `9738b9a`, staging empty, `stash@{0}` untouched).

## 2. Files inspected (read-only)

- `src/pages/POSPage.tsx` -- cart footer block (approx. lines 1367-1470).
- `src/pages/POSPage.css` -- `.pos-cart-footer` / `.pos-cf-*` / `.pos-disc-*` / `.pos-fee-*` / `.pos-grand-row` / `.pos-gt-*` / `.pos-checkout-btn` (approx. lines 1142-1301).
- `src/lib/pos/cartUtils.ts` -- `calcCartTotals` return shape (display wiring understanding only; NOT modified).

## 3. Files changed

- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md` (this report)

No application code, CSS, or logic changed.

## 4. Current cart summary structure (POSPage.tsx, `<footer className="pos-cart-footer">`)

Top to bottom:
1. Collapsible toggle `.pos-cf-extra-toggle` -- "เพิ่มส่วนลด / ค่าธรรมเนียม" / "ซ่อน..." (right-aligned, 12px, secondary color).
2. When expanded:
   - Bill-discount row `.pos-cf-row`: label "ลดท้ายบิล" + `.pos-disc-row` (numeric input `.pos-disc-inp` that opens the custom numpad on pointerdown, plus baht/percent toggles `.pos-disc-tog`).
   - Fee row `.pos-cf-row`: label "ค่าธรรมเนียม" + `.pos-fee-chips` (chips for 0 / 1% / 3%, `.pos-fee-chip`).
3. Always:
   - Subtotal row: "รวม" + `.pos-cf-val` `฿{subtotal}`.
   - Bill discount row (only if `billDiscount > 0`): "ส่วนลด" + value `-฿{billDiscount}` with an INLINE style color `#1d9e75` (green).
   - Fee row (only if `fee > 0`): "ค่าธรรมเนียม" + value `฿{fee}` with an INLINE style color `#ba7517` (amber).
   - Grand total `.pos-grand-row`: "รวมสุทธิ" (`.pos-gt-lbl`) + value `฿{grandTotal}` (`.pos-gt-val`); dashed top border.
   - Item-count line: INLINE style `{ fontSize: 10, color: var(--g400), textAlign: right }` -- "X รายการ | Y ชิ้น".
   - Checkout button `.pos-checkout-btn` -- "ชำระเงิน (F12)"; `disabled` when `cartLines.length === 0 || !activeShift`; onClick opens PaymentModal.

Totals source (read-only): `calcCartTotals` returns `{ subtotal, billDiscount, fee, grandTotal, itemCount, totalQty }`. There is NO tax field; `fee` is a percentage surcharge, not VAT.

## 5. Current CSS structure (POSPage.css)

- `.pos-cart-footer`: flex column, gap 7px, `padding 10px 12px`, white background, `border-top`, `flex-shrink: 0` (pinned at the bottom of the cart card).
- `.pos-cf-row`: flex space-between, `font-size: 11px`.
- `.pos-cf-lbl`: color `var(--g400, #888780)` (light gray).
- `.pos-cf-val`: Prompt font, weight 500. A `.pos-cf-val--green` class exists (#1d9e75) but the discount value uses an inline color instead.
- `.pos-disc-inp`: width 60px, `font-size: 11px`, `padding: 2px 6px`. `.pos-disc-tog`: `font-size: 10px`, `padding: 1px 6px`.
- `.pos-fee-chip`: `font-size: 10px`, `padding: 2px 7px`.
- `.pos-grand-row`: flex baseline space-between, `padding-top: 4px`, `border-top: 1px dashed`.
- `.pos-gt-lbl`: `font-size: 13px`, weight 500. `.pos-gt-val`: `font-size: 20px`, weight 600, purple `var(--p600)`.
- `.pos-checkout-btn`: full width, height 60px, `font-size: 20px`, bold, purple; `:disabled { opacity: 0.5 }`.

## 6. UX findings

1. Label contrast is low: `.pos-cf-lbl` uses `--g400` (#888780) at 11px on white -- weak for fast scanning.
2. Visual hierarchy is flat among the secondary rows: subtotal, discount, and fee are all 11px with near-identical styling; only the grand total stands out, so the eye cannot quickly separate "added" (fee) from "subtracted" (discount).
3. Discount/fee state colors are hardcoded inline (`#1d9e75`, `#ba7517`), bypassing the token system and the existing `.pos-cf-val--green` class -- an inconsistency, and the small 11px colored text is a weak signal (and a color-only signal, an accessibility risk).
4. Grand total priority is acceptable but could be stronger: value 20px vs a 13px label; on an at-arm's-length iPad the total could be more dominant.
5. The item-count line uses inline styles at 10px -- very small and easy to miss.
6. Payment readiness: the checkout button disables on empty cart / no active shift, but gives NO visible reason when disabled (e.g. shift not open), which can confuse a cashier.

## 7. Cashier readability findings

- At a glance, the only strongly legible element is the grand total. Subtotal, discount, and fee compete at the same small size and low contrast.
- The discount (green) vs fee (amber) distinction relies on subtle color alone, not on a clear +/- or labeled treatment.
- The "X รายการ | Y ชิ้น" count is too small to act as a quick sanity check.

## 8. Touch / iPad / responsive findings

- Touch targets in the expandable area are small: bill-discount input (60px wide, 11px), baht/percent toggles (`.pos-disc-tog`, ~10px text, tiny padding), and fee chips (`.pos-fee-chip`, ~10px) are well below the ~44px comfortable finger-target guideline.
- The footer is pinned (`flex-shrink: 0`) and the checkout button (60px) is comfortably tappable, but the secondary controls are not.
- Responsive: the summary rows use fixed small px sizes; on smaller or zoomed displays the 10-11px gray text degrades further. The pinned footer height is otherwise stable.

## 9. Proposed styling plan (visual / CSS-only; FUTURE phase)

Markup-light, CSS-first. Each item is presentation only:
1. Raise secondary-row label contrast: change `.pos-cf-lbl` from `--g400` to a darker token (e.g. `--text-secondary` #6b7280 or a g600-level value); bump `.pos-cf-row` 11px -> 12px.
2. Strengthen discount/fee clarity: replace the inline `#1d9e75` / `#ba7517` with classes/tokens (reuse `.pos-cf-val--green` for discount; add an amber fee class); make the sign explicit ("-" for discount, "+" for fee) so the meaning does not depend on color alone.
3. Elevate the grand total: larger label (13 -> 14/15px) and larger value (20 -> 24px), with a slightly stronger separator (or a subtle band) so it clearly dominates.
4. Move the item-count inline style into a small class; consider 11px and a token color for legibility.
5. Enlarge touch targets for the bill-discount input, baht/percent toggles, and fee chips toward ~40-44px height for iPad comfort (CSS sizing only).
6. Keep the pinned-footer height stable and verify legibility at smaller/zoomed sizes (consider clamp-based sizing).
7. (Affordance only) Consider a short disabled-reason hint near the checkout button when no shift is open -- BUT only if it can be done from existing state without new logic; otherwise defer to UI-09.

## 10. Implementation boundaries for the future phase

Allowed (future UI-07 implementation): `src/pages/POSPage.tsx` cart-footer markup (class names / presentational structure only) and `src/pages/POSPage.css` summary selectors.

Must NOT be touched:
- cart math: `calcCartTotals`, `getLineTotal`, `cartUtils.ts`, `useCart.ts`, and the totals values themselves (only their presentation).
- checkout/payment logic and `PaymentModal` behavior; the checkout button's onClick/disabled LOGIC (UI-09 territory) -- UI-07 may restyle the button but must not rewire it.
- stock/inventory/FIFO, Firebase/functions/rules, Android/Capacitor.
- package.json, lockfiles, scripts, tooling configs, `.claude/`.
- UI-08 (action buttons), UI-09 (checkout/F12 logic).

## 11. Risks and mitigations

- Risk: UI-07 restyling blurs into UI-09 (the checkout button). Mitigation: limit UI-07 to summary rows + grand-total presentation; coordinate any checkout-button change with UI-09.
- Risk: new colors reduce contrast or clash. Mitigation: use existing tokens and verify contrast (incl. color-blind-safe sign/labeling, not color alone).
- Risk: enlarging touch targets changes the pinned footer height. Mitigation: keep footer height stable; test on iPad dimensions.
- Risk: replacing inline styles could miss an edge state. Mitigation: map each inline style to a class one-to-one; visual-diff the discount/fee/zero states.

## 12. Recommended next phase

`7C-UI-07-CART-SUMMARY-IMPLEMENTATION` -- visual/CSS-only polish of the cart summary per this plan, gated by AGY UX review first, then Codex, then Principal Engineer, then Tech Lead / CEO authorization and CEO Physical UAT. Implementation requires separate Tech Lead / CEO authorization.

## 13. Agentchattr notification status

Skipped / not posted. The agentchattr tool exists on disk but its server is not running, and posting a chat message would require launching the tool; the notification is advisory-only and authorizes nothing, so it is not required for this deliverable. The workflow docs remain the source of truth. (If desired later, a human/operator may post the `[READY_FOR_REVIEW]` advisory; it would not constitute authorization.)

## 14. STATE CARD

```
STATE CARD
Phase: 7C-UI-07-CART-SUMMARY-DISCOVERY
Current owner: Developer Agent
Verdict: DISCOVERY COMPLETE / READY FOR AGY UX REVIEW
Files changed: docs/agent-workflow/STATE.md; docs/agent-workflow/CURRENT_PACKET.md; docs/agent-workflow/NEXT_ACTION.md; docs/reports/latest-developer-report.md
Files inspected: src/pages/POSPage.tsx (cart footer); src/pages/POSPage.css (.pos-cart-footer/.pos-cf-*/.pos-grand-row/.pos-gt-*/.pos-checkout-btn); src/lib/pos/cartUtils.ts (calcCartTotals, read-only)
Tests/checks: read-only discovery; git diff --check PASS; staging empty; no app code/CSS changed
Staged: no
Committed: no
Required fixes: none (discovery only)
Next owner: AGY / Senior QA & UX Lead
Next action: AGY UX review of the proposed cart summary styling plan, then Principal Engineer review, then Tech Lead / CEO implementation decision
Stop condition: no implementation/staging/commit; wait for AGY UX review, then Principal Engineer review, then Tech Lead / CEO authorization
```
