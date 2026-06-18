# Developer Report — 7C-UI-04-PRODUCT-GRID-CARDS (UAT Bug Fix)

## 1. Summary

This is a **UAT bug fix intervention** on the re-opened Phase 7C-UI-04. The prior package wired up a "การแสดงผลสินค้า (POS)" Settings section (stock visibility + independent product-name / price size pickers) backed by `usePOSPreferences`, but physical UAT failed: the controls were visible yet did not dynamically update the Product Grid Cards. The defect was in the preferences **state wiring** — not in the Settings UI, the CSS, or the card markup, all of which were already correct. The fix converts `usePOSPreferences` from a per-instance `useState` hook into a **single module-level reactive store** consumed via `useSyncExternalStore`, so an edit on the Settings page updates the one shared value and re-renders the POS product cards immediately. Scope was strictly limited to the state wiring; no features, persistence, or architecture were added.

## 2. UAT failure acknowledgement

Physical UAT **FAILED** and is acknowledged. The prior UI-04 commit authorization is **HELD / superseded** until this fix passes AGY and Codex again. Nothing has been staged or committed. Reported symptoms, all reproduced by the root-cause analysis below:

- Product Name font size control did not dynamically update Product Grid Cards.
- Price font size control did not dynamically update Product Grid Cards.
- Stock visibility toggle did not dynamically show/hide stock on Product Grid Cards.

## 3. Root cause found

`usePOSPreferences` backed **every** call with its own `useState` set and read `localStorage` only **once**, in a mount-time `useEffect` (the old lines 110–130). The Settings page and the POS page each call the hook, so they mounted **independent copies** of the state with no shared source of truth and no cross-instance notification:

1. The Settings editor's instance updated its own `useState` and persisted to `localStorage`.
2. The POS page's instance had already hydrated from `localStorage` at its own mount and **never re-read it**, and nothing told it to re-render.

So a setting change persisted but never reached the already-mounted POS product cards — exactly the "controls visible but non-functional / non-reactive source" failure. The card consumption (`POSPage.tsx` class composition + conditional stock span) and the CSS scales were already correct; they simply never received a new value.

## 4. Files changed

App:

- `src/hooks/pos/usePOSPreferences.ts` — **the fix.** Replaced the per-instance `useState` + mount-hydrate + persist effects with a single module-level store (`currentState` + a `listeners` set) consumed via `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)`. Added a `storage` event listener for cross-tab sync, a no-op guard so identical writes don't notify, and an exported internal `posPreferencesStore` (subscribe / getSnapshot / setters) used only by the node-env reactivity test. **Unchanged:** the public `POSPreferences` return shape, the `twinpet_pos_prefs` localStorage key, all validators (`isGridColumns` / `isFontSize` / `isBoolean`), `readStoredPreferences`, and the defaults (`showStock` `true`, `productNameFontSize` / `priceFontSize` `'normal'`).
- `src/pages/POSPage.product-card.test.ts` — added runtime reactivity tests against the shared store and a structural guard for the single-source-of-truth fix (details in §7).

Carried over from the prior package (unchanged by this intervention, still in the working tree): `src/lib/settings/settingsNav.ts`, `src/lib/settings/types.ts`, `src/pages/SettingsPage.tsx`, `src/pages/POSPage.tsx`, `src/pages/POSPage.css`.

Workflow / report:

- `docs/agent-workflow/STATE.md`, `docs/agent-workflow/CURRENT_PACKET.md`, `docs/agent-workflow/NEXT_ACTION.md`, `docs/agent-workflow/UI_MASTER_PLAN.md`, `docs/reports/latest-developer-report.md` (and the carried-over `docs/reports/latest-agy-review.md`, `docs/reports/latest-codex-review.md`).

## 5. State wiring fix summary

- The preferences are now ONE module-level value. `subscribe` registers a listener; `getSnapshot` returns the current value (reference changes only on a real update, so it stays cached as `useSyncExternalStore` requires); `getServerSnapshot` returns the deterministic defaults for SSR safety.
- Each validated setter (`setShowStock`, `setProductNameFontSize`, `setPriceFontSize`, plus the existing `setGridColumns` / `setFontSize`) calls a private `setState` that merges the patch, **persists to the same localStorage key**, and notifies all listeners. The setters are module-level, so their references are stable across renders.
- Effect: editing a control on the Settings page updates the single shared value → every `usePOSPreferences()` consumer (the POS grid included) re-renders with the new value. A `storage` event re-hydrates and notifies in other tabs.

## 6. Product card consumption fix summary

No card markup changes were needed — the consumption was already correct and now receives live values:

- `.pos-page` carries `pos-name-${productNameFontSize}` and `pos-price-${priceFontSize}` (alongside `pos-fontsize-${fontSize}`); these classes now change as the store updates, so `--pos-name-scale` / `--pos-price-scale` re-apply and `.pos-prod-name` / `.pos-prod-price` resize independently.
- The stock indicator still renders only via `{showStock && <span className="pos-prod-stock">{p.stock}</span>}`; `showStock` now flips live, so the stock count shows/hides immediately with no empty gap (the price left-aligns in `.pos-prod-bottom`).
- `onProductClick` add-to-cart, scanner/focus behavior, the UI-03 category dropdown, and grid density are all untouched.

## 7. Tests added/updated

`src/pages/POSPage.product-card.test.ts` (existing `?raw` source-contract tests preserved) gained:

- A structural guard: the prefs source uses `useSyncExternalStore` and a module-level `listeners` set, and contains **no** per-instance `useState<...>` (locks the regression).
- A new runtime suite exercising the exported `posPreferencesStore` directly (valid in the node env — no DOM/React render needed):
  - every consumer reads ONE shared snapshot (a setter moves the value all readers see);
  - a setter notifies subscribers (what triggers the card re-render) and unsubscribe stops notifications;
  - `showStock` toggles both directions;
  - product-name and price scales update independently;
  - invalid input is rejected (store keeps the last valid value);
  - a no-op set does not notify (no needless re-render).
  - State is restored to defaults in `afterEach` so the module singleton can't leak across tests.

## 8. Tests/checks run with results

- `git status --short` / `git diff --name-only` / `git diff --stat` — only authorized files (prefs hook + product-card test + settings/POS files from the prior package + workflow/report docs).
- `git diff --check` — **clean** (only benign "LF will be replaced by CRLF" notices; no whitespace errors).
- `git diff --cached --name-only` — **empty** (nothing staged).
- `npx.cmd tsc -b` — **PASS** (exit 0).
- `npx.cmd vitest run src/pages/POSPage.keyboard-contract.test.ts` — **145 passed** (keyboard/focus contract intact).
- `npx.cmd vitest run src/pages/POSPage.product-card.test.ts` — **15 passed** (incl. the new reactivity cases).
- `npx.cmd vitest run` — **727 passed (32 files)**.

## 9. Boundary confirmation

Only authorized files changed. The fix itself is confined to `src/hooks/pos/usePOSPreferences.ts` + its test. **Not touched:** `useCart.ts`, `useCart.contract.test.ts`, `cartUtils.ts`, cart math, checkout/payment logic, stock/inventory logic, Cart Item Rows (UI-06), Cart Summary (UI-07), Action Buttons (UI-08), Checkout/F12 (UI-09), Toast, Firebase / functions / rules, Android / Capacitor, `.claude/`. No new scripts, dependencies, settings architecture, or persistence layer. Nothing staged, nothing committed. `stash@{0}` untouched (only `git stash list` used).

## 10. Markdown hygiene confirmation

Touched `docs/` Markdown was edited via UTF-8-preserving surgical edits (no PowerShell `Get-Content`/`Set-Content` round-trip on Thai text). No trailing whitespace introduced; Thai content intact with no mojibake/replacement characters; `git diff --check` passes.

## 11. Remaining risks

- **Mount lifecycle, not just navigation:** the fix makes the prefs reactive for any mounted consumer (live update), which also covers the navigate-away-and-back case. No remaining staleness path identified.
- **Module-singleton in tests:** state is reset in `afterEach`; the only shared global is intentional (it is the source of truth).
- **Device-local scope unchanged:** preferences remain per-device (localStorage), not branch-synced — appropriate for cashier-terminal display tuning, consistent with the existing `gridColumns` / `fontSize` prefs.
- **`storage` event listener** is registered once at module load behind a `typeof window !== 'undefined'` guard (SSR/node-safe) and is not removable, which is fine for an app-lifetime singleton store.

## 12. Next owner and next action

**Next owner:** Senior QA & UX Lead / AGY (`docs/ai-roles/ux-lead.md`). **Next action:** human operator routes this report + `CURRENT_PACKET.md` + the current diff to **AGY first** for visual/functional UAT re-validation (prompt in `NEXT_ACTION.md`) — primarily to confirm the controls now actually drive the cards. Codex only after AGY PASS / PASS WITH NOTES. No staging/commit until Tech Lead / CEO authorizes.

---

```
STATE CARD
Phase: 7C-UI-04-PRODUCT-GRID-CARDS (re-opened — UAT bug fix)
Current owner: Developer Agent (bug fix complete) → Senior QA & UX Lead / AGY
Verdict: UAT Failed / Bug Fix In Progress — settings→product-card wiring fixed and re-verified; awaiting AGY re-validation
Files changed: src/hooks/pos/usePOSPreferences.ts, src/pages/POSPage.product-card.test.ts (+ carried-over src/lib/settings/settingsNav.ts, src/lib/settings/types.ts, src/pages/SettingsPage.tsx, src/pages/POSPage.tsx, src/pages/POSPage.css; + docs/agent-workflow/STATE.md, CURRENT_PACKET.md, NEXT_ACTION.md, UI_MASTER_PLAN.md, docs/reports/latest-developer-report.md)
Tests/checks: tsc -b PASS; keyboard-contract 145 passed; product-card 15 passed; full vitest 727 passed (32 files); git diff --check clean; staging empty
Staged: No
Committed: No
Required fixes: Settings controls visible but product cards did not dynamically update — FIXED (single useSyncExternalStore store; pending AGY re-validation)
Next owner: Senior QA & UX Lead / AGY
Next action: Human routes report + packet + diff to AGY first (prompt in NEXT_ACTION.md); Codex only after AGY PASS
Stop condition: No staging, no commit, no Codex until AGY review passes; prior commit authorization HELD/superseded; no UI-05/06/07/08/09; stash@{0} untouched
```
