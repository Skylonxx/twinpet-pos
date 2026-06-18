# Next Action

## Current State

**UAT bug fix.** Physical UAT of the prior **7C-UI-04-PRODUCT-GRID-CARDS** package FAILED: the Settings controls were visible but non-functional — Product Name font size, Price font size, and Stock visibility did not dynamically update the Product Grid Cards. **Root cause:** `usePOSPreferences` gave each consumer its own `useState` copy and read localStorage only once on mount, so the Settings editor and the POS grid held independent states — an edit persisted but never reached the mounted POS cards. **Fix (wiring only):** the preferences are now a single module-level reactive store consumed via `useSyncExternalStore`, so editing a control updates the one shared value and re-renders every consumer immediately (a `storage` event also syncs other tabs). Public API, the `twinpet_pos_prefs` localStorage key, validation, and defaults are unchanged; no new settings/persistence architecture, no Firebase/backend writes. Re-verified: `tsc -b` PASS, full vitest **727 passed**. Changes are **not staged and not committed**. The prior commit authorization is **HELD / superseded**. **AGY visual/functional re-validation is REQUIRED before Codex** — route to **Senior QA & UX Lead / AGY first**.

## What Happens Next

1. **Human operator** reads the Developer report at `docs/reports/latest-developer-report.md` (and the master plan `UI_MASTER_PLAN.md`).
2. **Human operator** sends **AGY** the current packet (`docs/agent-workflow/CURRENT_PACKET.md`), the Developer report, and the **current diff** for visual/UX validation.
3. **AGY** validates the Settings controls and the product-card presentation (see checklist below).
4. If **AGY FAIL** → return to Developer / Principal Engineer Reviewer for remediation.
5. If **AGY PASS / PASS WITH NOTES** → route to **Codex Reviewer** for code/scope/keyboard review.
6. After Codex PASS → Principal Engineer Reviewer / Tech Lead for closure memo + exact staging/commit commands.

**Do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.**

---

## Copy-Paste Instructions for Human Operator

### Step 1 — Send to Senior QA & UX Lead / AGY (DO THIS NEXT)

Paste the following to AGY:

```
TO: Senior QA & UX Lead / AGY
MODEL: Gemini / best available UX review model for this run
REASONING: High
ROLE: Senior QA & UX Lead
ROLE FILE: docs/ai-roles/ux-lead.md
MODE: UAT re-validation (functional + visual), Product Grid Cards + Settings review, Impeccable Style review, no app edits, no staging, no commit

PHASE: 7C-UI-04-PRODUCT-GRID-CARDS (RE-OPENED — UAT bug fix)
SCOPE: functional + visual UAT re-validation (before Codex)

UAT CONTEXT (why this is re-opened):
Physical UAT FAILED — Settings controls were visible but did NOT dynamically update the
Product Grid Cards. The state wiring has been fixed (usePOSPreferences is now a single
useSyncExternalStore-backed store instead of per-instance useState). Your job is to CONFIRM
the controls now actually drive the cards. The prior commit authorization is HELD / superseded.

Inputs:
- docs/agent-workflow/UI_MASTER_PLAN.md (Phase 7C source of truth)
- docs/agent-workflow/CURRENT_PACKET.md (active packet)
- docs/reports/latest-developer-report.md (developer report)
- the current working-tree diff (git diff)

How to view the controls:
- Open Settings -> "ตั้งค่าสาขา & POS" group -> "การแสดงผลสินค้า (POS)" (URL: /settings/pos-display).
- Toggle stock visibility and change the product-name / price size chips; then open /pos to see the
  product grid update. Preferences are device-local (localStorage) and apply immediately.

AGY REVIEW MUST VERIFY (the UAT failure must be GONE):
- PRIMARY (the failed UAT): with the POS grid already open in one place and Settings in another,
  changing each control updates the cards WITHOUT needing a manual POS reload — the cards react to
  the change. (Open /settings/pos-display, change a control, then look at /pos.)
- Settings controls are understandable and clean (toggle + small/normal/large chips, consistent with
  the rest of the Settings page).
- Product name font size setting visibly affects product cards.
- Price font size setting visibly affects product cards - and is INDEPENDENT of the name size.
- Stock visibility toggle hides/shows the stock indicator cleanly, with NO awkward empty gap when off.
- Product cards show image/placeholder, product name, price, and conditional stock cleanly.
- Product grid layout remains stable and responsive across terminal sizes.
- Category dropdown from UI-03 remains intact; the category bar horizontal scroll is unaffected.
- Cart items, summary, action buttons, and checkout/F12 are untouched.
- No broad redesign or scope creep.

Notes for the reviewer:
- Defaults are visual-preserving: stock ON, name/price sizes 'normal' (x1) - a fresh device looks
  exactly like before this change.
- The new size scales multiply on top of the existing global font-scale via CSS variables
  (--pos-name-scale / --pos-price-scale), so rows stay uniform at every preset.
- The POS-display section persists immediately (localStorage), independent of the page's Save/Cancel
  footer - this mirrors the existing void-password immediate-save pattern on the same page.

Produce verdict in docs/reports/latest-agy-review.md.

Do not stage or commit.
Do not start UI-05 / UI-06 (or any later master-plan item).
Do not route to Codex yourself - return the verdict to the human operator.
```

### Step 2 — Send to Codex Reviewer (ONLY after AGY PASS / PASS WITH NOTES)

```
TO: Codex Reviewer
MODEL: GPT-5.5 / best available Codex reviewer model for this run
REASONING: High
ROLE: Reviewer Agent
ROLE FILE: docs/ai-roles/reviewer.md
MODE: Review only, no edits, no staging, no commit

PHASE: 7C-UI-04-PRODUCT-GRID-CARDS
SCOPE: code / scope / keyboard-contract review

Verify (this is a UAT bug fix — wiring only):
- ROOT-CAUSE FIX: usePOSPreferences is now a SINGLE module-level reactive store consumed via
  useSyncExternalStore (no per-instance useState), so the Settings editor and the POS grid share one
  source of truth and an edit re-renders every consumer. Public API, the twinpet_pos_prefs localStorage
  key, validation, and visual-preserving defaults (true / 'normal' / 'normal') are UNCHANGED. No new
  persistence layer or settings architecture; still localStorage-only. An internal posPreferencesStore
  is exported solely for the node-env reactivity test.
- Settings integration uses the existing unified Settings: new 'pos-display' nav item (section
  'posDisplay', scope 'branch') + a posDisplay section in SettingsPage built from existing components
  (Toggle, stg-notif-chip chips). No Firebase/backend writes added.
- POSPage CONSUMES the preferences: pos-name-* / pos-price-* classes on .pos-page; stock span rendered
  only when showStock is on; onProductClick add-to-cart behavior unchanged.
- POSPage.css adds --pos-name-scale / --pos-price-scale and multiplies name/price font-size by them on
  top of the existing global scale; defaults of x1 preserve current sizing.
- Only these app files changed: src/hooks/pos/usePOSPreferences.ts, src/lib/settings/settingsNav.ts,
  src/lib/settings/types.ts, src/pages/SettingsPage.tsx, src/pages/POSPage.tsx, src/pages/POSPage.css,
  + new src/pages/POSPage.product-card.test.ts (+ workflow/report docs). No cart math / useCart.ts /
  cartUtils.ts / checkout / payment / stock matrix / Toast / Firebase / Android / .claude change.
- tsc clean; POSPage.keyboard-contract.test.ts (145) + POSPage.product-card.test.ts (15, incl. new
  runtime reactivity cases against the shared store) + full vitest (727) green.

Produce verdict in docs/reports/latest-codex-review.md.
```

### Step 3 — Route results to Principal Engineer Reviewer / Tech Lead

After AGY PASS → Codex PASS, paste both verdicts to the Principal Engineer Reviewer / Tech Lead for a closure memo and exact staging/commit commands.

---

## Important Reminders

- **AGY first** (ROLE FILE: `docs/ai-roles/ux-lead.md`) — do NOT send to Codex until AGY returns PASS / PASS WITH NOTES.
- **`UI_MASTER_PLAN.md` is the Phase 7C source of truth** — no work beyond UI-04 is authorized.
- Do **not** touch cart rows/summary/action buttons/checkout/F12, cart math, stock logic, or category dropdown behavior (only layout compatibility was preserved).
- Do **not** stage or commit until Tech Lead / CEO authorizes exact commands.
- `stash@{0}` is pre-existing unrelated WIP — do not touch.
- Old manual workflow remains available as fallback.

## Role File Reference

| Role | Role File |
|---|---|
| Developer Agent | `docs/ai-roles/developer.md` |
| Senior QA & UX Lead / AGY | `docs/ai-roles/ux-lead.md` |
| Codex Reviewer | `docs/ai-roles/reviewer.md` |
| Tech Lead / CEO | `docs/ai-roles/tech-lead.md` |
