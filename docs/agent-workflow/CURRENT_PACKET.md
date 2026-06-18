# Current Work Packet

## ⚠️ UAT Bug Fix Intervention (re-opened)

This packet is a **UAT bug fix intervention**, not new feature work. Physical UAT of the prior UI-04 package **FAILED**: the Settings controls were visible but non-functional — Product Name font size, Price font size, and Stock visibility did not dynamically update the Product Grid Cards.

- **Goal: fix the settings → product-card state wiring ONLY.** No new features, no new settings/persistence architecture, no scope expansion.
- The **prior UI-04 commit authorization is HELD / superseded** until this fix passes AGY and Codex again.
- **No cart/checkout scope** is authorized: no Cart Item Rows (UI-06), Cart Summary (UI-07), Action Buttons (UI-08), Checkout/F12 (UI-09), no cart math, no stock/inventory logic, no checkout/payment logic, no Firebase/functions/rules.
- **Root cause + fix:** `usePOSPreferences` gave each consumer its own `useState` copy (read from localStorage once on mount), so the Settings editor and POS grid held independent states and edits never reached the mounted cards. It is now a single module-level reactive store consumed via `useSyncExternalStore` — one source of truth, every consumer re-renders on change. Public API, localStorage key, validation, and defaults are unchanged.

## Phase

**7C-UI-04-PRODUCT-GRID-CARDS** — Product Grid Cards with existing Settings integration (RE-OPENED for UAT bug fix)

## Master Plan

Source of truth: **`docs/agent-workflow/UI_MASTER_PLAN.md`**. This packet is item **4 (UI-04: การ์ดสินค้า — CURRENT)**. No work beyond UI-04 is authorized by this packet.

## Goal

Integrate the existing POS display preferences with the Product Grid Cards so cashier/admin can control, from the existing Settings module:

1. **Stock visibility** on product cards
2. **Product name font size**
3. **Price font size**

Reuse the existing global-state pattern (`usePOSPreferences`, localStorage) and the existing Settings UI — no new settings architecture, no new persistence layer, no Firebase/backend writes. **AGY visual review is required before Codex.**

## Implementation Directives (summary)

**A — Settings integration.** Add a "การแสดงผลสินค้า (POS)" section to the existing unified Settings (new `pos-display` nav item → `SettingsPage` `posDisplay` section): a stock-visibility toggle and two independent small/normal/large size pickers. Built from existing Settings components (`Toggle`, `stg-notif-chip` chips).

**B — Global state wiring.** Extend the existing `usePOSPreferences` store (localStorage) with `showStock`, `productNameFontSize`, `priceFontSize` (validated, persisted, default-safe). The Settings controls call its setters; POSPage consumes the values. Defaults preserve the current visual style exactly.

**C — Product card consumption.** Product cards consume `productNameFontSize`, `priceFontSize`, `showStock`: name/price sizes change via independent CSS scales; the stock indicator renders only when `showStock` is on (no empty gap when off). Click / add-to-cart behavior unchanged.

**D — Layout / Style.** Image + placeholder (existing `ProductImageThumb`), name, price, conditional stock. Grid integrity, category dropdown (UI-03), cat-bar horizontal scroll, and the UI-05 cart seam are preserved. Flowbite / Clean / Impeccable aesthetic.

## Strict Non-Goals

Do NOT touch: Cart item rows (UI-06), Cart Summary (UI-07), Action Buttons (UI-08), Checkout/F12 (UI-09), checkout/payment logic, cart math, stock logic, scanner/focus behavior, category dropdown behavior (only preserve layout compatibility), Toast, Firebase/functions/rules, Android/Capacitor, `.claude/`. No new scripts. No staging. No commit.

## AGY Review Requirement (MANDATORY before Codex)

AGY must verify: Settings controls are clean/understandable; product-name size visibly affects cards; price size visibly affects cards (independent of name); stock toggle hides/shows stock cleanly with no awkward gap; cards show image/placeholder, name, price, conditional stock cleanly; grid stays stable/responsive; UI-03 category dropdown intact; cart items/summary/action buttons/checkout-F12 untouched; no broad redesign or scope creep.

## Status

**UAT Failed / Bug Fix In Progress** — settings→product-card wiring fixed and re-verified (tsc + full vitest green); **awaiting AGY visual/functional re-validation (before Codex)**. Prior commit authorization HELD / superseded.

---

## Scope

### Authorized implementation files (app)

- `src/hooks/pos/usePOSPreferences.ts` — extend the existing POS display store (new fields + setters)
- `src/lib/settings/settingsNav.ts` — add the `pos-display` nav item
- `src/lib/settings/types.ts` — add `'posDisplay'` to `SettingsSection`
- `src/pages/SettingsPage.tsx` — new POS-display settings section
- `src/pages/POSPage.tsx` — consume preferences + conditional stock
- `src/pages/POSPage.css` — scoped product-card scale styling
- `src/pages/POSPage.product-card.test.ts` — new source-contract test
- Do NOT broaden beyond product-card display + its Settings controls.

### Authorized workflow / report files

- `docs/agent-workflow/UI_MASTER_PLAN.md`
- `docs/agent-workflow/STATE.md`
- `docs/agent-workflow/CURRENT_PACKET.md`
- `docs/agent-workflow/NEXT_ACTION.md`
- `docs/reports/latest-developer-report.md`

### Forbidden Files / Areas

- **Cart item rows (UI-06), Cart Summary (UI-07), Action Buttons (UI-08), Checkout/F12 (UI-09)** — reserved; do NOT touch
- `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math
- Checkout / payment business logic, stock matrix / inventory logic, seed data
- Toast files; Firebase / functions / rules; Android / Capacitor; `.claude/`
- No new scripts, no new dependencies; no UI-06/07/08/09 work

### Preservation note

The product cards keep their existing structure (image/placeholder, name, price, stock) and existing `onProductClick` add-to-cart behavior. New presentation is purely additive and driven by `usePOSPreferences` with visual-preserving defaults. The UI-03 category dropdown, `.pos-cat-bar` horizontal scroll, the UI-05 cart seam, and scanner/focus handlers are all untouched.

---

## Role Sequence

```
Developer Agent              — ROLE FILE: docs/ai-roles/developer.md
  → Senior QA & UX Lead/AGY  — ROLE FILE: docs/ai-roles/ux-lead.md
    → Codex Reviewer         — ROLE FILE: docs/ai-roles/reviewer.md
      → Tech Lead / CEO      — ROLE FILE: docs/ai-roles/tech-lead.md
```

**AGY:** **REQUIRED for this phase (before Codex)** — this phase includes visual UI changes, so AGY visual/UX validation gates the handoff to Codex.
AGY ROLE FILE: `docs/ai-roles/ux-lead.md`

### Required Handoff Header Format

Every handoff prompt must include these exact lines:

```
TO:
MODEL:
REASONING:
ROLE:
ROLE FILE:
MODE:
```

## Decision Rules

1. **Developer** completes implementation and writes `docs/reports/latest-developer-report.md`.
2. **Developer** updates `docs/agent-workflow/NEXT_ACTION.md` to route to **AGY first** (visual review), not Codex.
3. **If unauthorized files are changed** → STOP and report.
4. **If tests fail** → STOP and report.
5. **AGY reviews UX/visuals first** (Impeccable Style + no visual regression).
6. **If AGY FAIL** → return to Developer / Principal Engineer Reviewer for remediation.
7. **If AGY PASS / PASS WITH NOTES** → route to **Codex Reviewer** for code/scope/keyboard review.
8. **If Codex FAIL** → return to Principal Engineer Reviewer / Workflow Coordinator.
9. **If Codex PASS / PASS WITH NOTES** → route to Principal Engineer Reviewer / Workflow Coordinator for Tech Lead closure memo.
10. **No commit** until Tech Lead / CEO authorizes the exact staging and commit commands.

---

## Report Requirements

Every agent must produce a report in its corresponding `docs/reports/latest-*-report.md` file. Every report must end with a STATE CARD block.

## STATE CARD Requirement

Every report must end with this exact block, filled in:

```
STATE CARD
Phase:
Current owner:
Verdict:
Files changed:
Tests/checks:
Staged:
Committed:
Required fixes:
Next owner:
Next action:
Stop condition:
```

---

## Fallback

If this workflow creates friction, revert to the previous manual routing process. The old workflow remains valid.
