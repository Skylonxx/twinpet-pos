# Current Task Tracker — Phase 7C-D4-C-3 (POS F12 Modal Suppression — IMPLEMENTATION / AWAITING CODEX REVIEW)

> Living checkpoint doc for agents. Detailed history: `docs/reports/latest-report.md` (do not duplicate long-form evidence here).

## Current baseline

**Transfer Reversal Evidence sequence: FULLY CLOSED / COMMITTED**

- **H6-E2-A** — Pure Transfer Evidence Builder + Dual-Branch Invariant — CLOSED / COMMITTED — `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`
- **H6-E2-B** — Write Transfer Evidence Header at Completion — CLOSED / COMMITTED — `82d3352 feat(pos): write transfer reversal evidence header on completion`
- **H6-E2-C** — Transfer Evidence Coordinator Validation — CLOSED / COMMITTED — `fe3ff44 feat(pos): validate transfer reversal header evidence`

**Current clean baseline:** `d4261f5 fix(pos): restore search focus after POS dialogs` (7C-D4-C-2). **7C-C3, 7C-C4, 7C-D2, 7C-D3-A, 7C-D3-B, 7C-D4-A, 7C-D4-C, 7C-D4-C-1, and 7C-D4-C-2 are CLOSED / COMMITTED.** 7C-D4-C-3 is an implementation slice on top of this baseline and NOT yet committed.

**Phase 7C-D4-C-3 — POS F12 Modal Suppression (Tech Lead / CEO authorized after D4-C-2 commit) — IMPLEMENTATION / AWAITING CODEX REVIEW:**

Third implementation slice off the D4-C plan. **Scope: F12 modal suppression ONLY** — stop the F12 checkout shortcut from stacking `PaymentModal` over an already-open blocking dialog. Tests updated FIRST (added a suppression test + a no-new-listener/no-F12-in-PaymentModal test; preserved all existing F12 parity tests), then runtime. In `src/pages/POSPage.tsx`: new derived `const hasBlockingModalOpen = Boolean(uomProduct || pickerOpen || discountLineKey || qtyNumpadLineKey || showCloseShift || holdNoteOpen || suspendedListOpen || showCashTx || catModalOpen || isSortingModalOpen || confirmModalState.open || checkout.customerModalOpen)`; the F12 `onKey` now does `e.preventDefault()` (unconditional, devtools stays suppressed) then `if (hasBlockingModalOpen) return;` **before** the existing `if (cartLines.length > 0 && activeShift) setPaymentOpen(true)`; effect deps extended to `[cartLines.length, activeShift, hasBlockingModalOpen]`. **OpenShiftModal intentionally excluded** — F12 already requires `activeShift` (null while OpenShift shows). **Checkout-disabled parity preserved (`disabled={cartLines.length===0 || !activeShift}` unchanged); single global keydown listener + cleanup unchanged; no checkout/payment/processing/write-path/cart/UOM/discount/quantity change; no Escape/IME/focus-return/scanner change; no PaymentModal/CSS change.** Validation: targeted spec **26 passed**; `vitest run` **518 passed** (was 516; +2); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-3):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no cart/discount/UOM/quantity formula change; no Escape implementation; no new/duplicate global listener; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**Next step (D4-C-3):** Codex GPT-5.5 High review of the F12 suppression implementation before Tech Lead closure / commit. Do NOT mark D4-C-3 closed. Do NOT authorize D4-C-4 (Escape).

**Phase 7C-D4-C-2 — POS Focus-return Consistency — CLOSED / COMMITTED — `d4261f5 fix(pos): restore search focus after POS dialogs` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

Second implementation slice off the D4-C plan. **Scope: focus-return consistency ONLY** — restore focus to `#pos-search` after the four audited focus-drop modals close. Tests updated FIRST (flipped the three D4-A `CURRENT GAP` locks + added a category test), then runtime. Changes in `src/pages/POSPage.tsx`, all via the existing `focusSearch()` helper: **UomModal** `onSelect` + `onClose` → `focusSearch()`; **ItemDiscountModal** `onClose` → `focusSearch()` (the modal funnels both save and cancel through `onClose`); **NumpadDialog** `onClose` + `onConfirm` (only after a successful `setLineQty`) → `focusSearch()`; **category overlay** — new `closeCatModal = () => { setCatModalOpen(false); focusSearch(); }` helper now backs all four close routes (backdrop, close button, "ทั้งหมด" reset, category select), with `setActiveCategory` left in place. **No cart/discount/UOM/quantity/category-filter calculation changed; NumpadDialog stays touch-only (component not modified); no hardware-key/Enter added; no F12/Escape/IME/scanner change; no PaymentModal/CSS change.** Validation: targeted spec **24 passed**; `vitest run` **516 passed** (was 515; +1); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-2):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no cart/discount/UOM/quantity formula change; no F12-listener or Escape change; no scanner/IME-guard change; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C-2 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `d4261f5`. Third slice D4-C-3 (F12 suppression) now in implementation (above).

**Phase 7C-D4-C-1 — POS IME / Composition Guard — CLOSED / COMMITTED — `97a6bb2 fix(pos): guard scan input during IME composition` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES):**

First implementation slice off the D4-C plan. **Scope: the IME/composition guard ONLY.** Added a single synchronous early-return in `handleSearchKeyDown` (`src/pages/POSPage.tsx`): after the `Enter` check, `if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;` so a Thai-IME `Enter` that commits an in-progress composition no longer fires `findByScanCode`/`addToCart`/clear/miss-toast. **Scanner speed preserved** — hardware scanners emit no composition events, so the guard is always false for them; **no debounce, no timers, no delay, no new listener; `findByScanCode` algorithm unchanged.** Test `src/pages/POSPage.keyboard-contract.test.ts`: flipped the prior D4-A "no IME guard" CURRENT GAP into a present-and-ordered-before-scan assertion (checks `isComposing` + `keyCode === 229`, guard precedes trim/`findByScanCode`), plus a new "NO debounce/timer/delayed scan" assertion (`not.toContain` setTimeout/setInterval/requestAnimationFrame/debounce). All other contracts (scan match/miss, F12 parity, focus-return present + UOM/ItemDiscount/Numpad GAPS, PaymentModal Red path) left unchanged. Validation: targeted spec **23 passed**; `vitest run` **515 passed** (was 514; +1 net); `tsc -b` clean.

**Forbidden boundaries honored (D4-C-1):** no CSS change; no `PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` change; no checkout/cart/payment/`confirmSale`/`submitAsyncOrder`/offline/IndexedDB/manual-review change; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; no F12-suppression / focus-return / Escape work (those are later slices); only `Task.md`, `Context.md`, `src/pages/POSPage.tsx`, and `src/pages/POSPage.keyboard-contract.test.ts` changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C-1 next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `97a6bb2`. Second slice D4-C-2 (focus-return) now in implementation (above).

**Phase 7C-D4-C — Modal Focus & IME Fix Planning — CLOSED / COMMITTED — `dc8a08b docs: add modal focus ime fix plan` (Tech Lead Option B — APPROVED WITH NOTES; Codex PASS WITH NOTES after two wording revisions):**

Read-only technical blueprint for the four D3-B follow-up fixes — **no implementation, no runtime/keyboard/focus/test change.** Deliverable `docs/reports/phase-7c-d4-c-modal-focus-ime-fix-plan.md` plans: (1) **IME/composition guard** on `handleSearchKeyDown` (`isComposing`/`keyCode===229` to suppress Thai-IME premature scan; scanner-speed preserved because scanners emit no composition events); (2) **F12 modal suppression** (gate the global F12 listener on a "no POS modal open" predicate to stop PaymentModal stacking; keep `preventDefault` + open-gate parity); (3) **focus-return consistency** (route UOM / ItemDiscount / NumpadDialog / category-overlay closes through `focusSearch()`); (4) **Escape behavior matrix** per modal — corrects the record that Escape is NOT globally absent (CustomerPicker input-level Escape `:102–104`; DestructiveConfirm overlay-level Escape `!loading` `:88–93`), with the cross-cutting rule that Escape may only cancel/close and must NEVER confirm a Red action (Payment/Shift/Cash/Hold). Recommends ordered slices D4-C-1 (IME) → D4-C-2 (focus-return) → D4-C-3 (F12) → D4-C-4 (Escape), each tests-first + separately authorized + Codex-reviewed + keyboard-UAT. Verified current source (read-only): PaymentModal `pay-modal-bg` has NO backdrop dismissal (X-button only), correcting the D3-B prose.

**Forbidden boundaries honored (D4-C):** no runtime POS source / keyboard / focus / handler / state / query change; no `POSPage.tsx`/`POSPage.css`/`PaymentModal`/`NumpadDialog`/`components/pos/*`/`lib/*` edit; no test edit (incl. `POSPage.keyboard-contract.test.ts`); no checkout/cart/payment/offline/IndexedDB/manual-review change; no Firebase rules/Functions; no H7-F/Android/Capacitor/`.claude/`; only `Task.md`, `Context.md`, and the new D4-C report changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-C next step (DONE):** Codex PASS WITH NOTES → Tech Lead Option B closure → committed `dc8a08b`. First slice D4-C-1 (IME guard) now in implementation (above).

**Phase 7C-D4-A — POS Keyboard Contract Tests — CLOSED / COMMITTED — `74371db test(pos): add keyboard contract coverage` (Tech Lead Option B — APPROVED WITH NOTES; revised after Codex NEEDS REVISION, then Codex re-review PASS):**

Test-only coverage that **locks the CURRENT** POS keyboard & focus contracts mapped in D3-B before any behavior change — **no runtime behavior change, no POS source edit.** New spec `src/pages/POSPage.keyboard-contract.test.ts` (**22 tests**) uses source-level `?raw` assertions (mirroring the H7-G precedent; vitest unit env is `node`/no-DOM and POSPage's Firebase/cart/offline harness makes mounting unsafe). Covers: (A) scan match/miss — `findByScanCode` trims + empty-guard, top-level SKU/barcode priority over UOM-specific barcode, Enter-only handler, clear+`focusSearch` on match, toast-only (no clear) on miss, and the **locked GAP** that no IME/composition guard exists; (B) F12 ↔ checkout parity — single cleaned-up global keydown listener, `preventDefault`, gate `cart>0 && activeShift` = De-Morgan complement of `disabled={cartLines.length===0 || !activeShift}`; (C) focus-return present after **new-sale, customer close/select, payment-close, HOLD (`handleHoldConfirm`), RESTORE (`handleRestoreBill`), and BOTH clear-cart + cancel-parked confirmations** (region-scoped, exactly two `focusSearch()` in the destructive-confirm handler), plus **locked GAPS** of no focus-return after UOM / ItemDiscount close and **no focus-return contract on the NumpadDialog qty path** (labeled CURRENT GAP); (D) payment confirm is a guarded **Red** native button — keyboard-activatable via native button semantics when focused (Tab+Enter/Space), double-submit guard `!canConfirm||confirming||processing`, and **no extra modal-level Enter/composition handler** wired into `handleConfirm`; NumpadDialog touch-only. Validation: `vitest run` 514 passed (was 492; +22); `tsc -b` clean.

**Codex revision addressed:** added hold/restore/clear-cart/cancel-parked focus-return assertions + the NumpadDialog focus-return GAP lock; corrected the payment-confirm comment (native button IS keyboard-activatable when focused — that is why it is Red — assertion only proves no EXTRA modal-level key handler).

**Forbidden boundaries honored:** no runtime POS source / keyboard / focus / handler / state / query change; no `POSPage.tsx`/`PaymentModal`/`NumpadDialog`/CSS edit; no checkout/cart/payment/offline/IndexedDB/manual-review change; no helper extraction / no test-only production flag; no H7-F/Functions/rules; only `Task.md`, `Context.md`, and the new test file changed; `stash@{0}` untouched (read-only `git stash list` only).

**D4-A next step (DONE):** Codex re-review PASS → Tech Lead Option B closure → committed `74371db`. Superseded by D4-C planning above.

**Phase 7C-D3-B — POS Keyboard UX / Focus Audit — CLOSED / COMMITTED — `e754461 docs add pos keyboard focus audit`:**

Strictly read-only audit of POS keyboard & focus behavior. Deliverable `docs/reports/phase-7c-d3-b-pos-keyboard-focus-audit.md` maps: focus bootstrap (search `autoFocus` + RAF `focusSearch`), the Enter-scan contract (`findByScanCode`), the single global **F12** listener (gated `cart>0 && activeShift`, active during modals → stacking risk), the absence of a global **Escape**, per-modal Enter/autoFocus (Numpad touch-only; Payment confirm = native button, keyboard-activatable when focused — Red, no modal-level Enter handler; Shift/Hold/Cash have their own), inconsistent focus-return after UOM/Numpad/ItemDiscount close, and a **missing IME/composition guard** on the scan input (Thai-input premature-scan risk). Classifies surfaces Green (focus-ring/label CSS only), Yellow (focus/scan/F12/modal/parity), Red (keyboard-triggered checkout/cart/shift/offline). Recommends future slices D4-A (keyboard contract tests, test-only), D4-B (focus-ring/label CSS), D4-C (IME/focus-return/Escape/F12-during-modal — read-only planning, separate authorization required).

**Phase 7C-D2 — POS Cashier UX Boundary Audit (Tech Lead / CEO authorized Option B) — CLOSED / COMMITTED:**

Read-only mapping of the complete POS cashier workflow (entry `/pos → POSPage`, product grid/search/barcode, cart, payment/checkout, keyboard-first interactions, offline/manual-review/oversell). **No implementation; no POS source / offline-schema / IndexedDB / Firebase-rules / Functions edits; `stash@{0}` untouched.** Deliverable: `docs/reports/phase-7c-d2-pos-cashier-ux-boundary-audit.md` — classifies surfaces Green (presentation-safe `pos-*` chrome), Yellow (focus/F12/Enter-scan/modal/disabled-state), Red (write path `confirmSale→submitAsyncOrder→setDoc('asyncOrders')`, totals/pricing, shift ledger, suspended bills, oversell allowance, offline reversal/manual-review) and recommends narrow future slices (D3-A pos- visual shell; D3-B keyboard/focus read-only-first; D3-C payment-modal presentation-only). Codex: PASS WITH NOTES. Report: `docs/reports/phase-7c-d2-pos-cashier-ux-boundary-audit.md`.

**Next step:** Separately authorized Phase 7C-D3-A POS Read-only Visual Shell Polish. No POS implementation without separate authorization.

**Phase 7C-C4 — Admin UI Polish on Isolated Namespaces (Tech Lead / CEO authorized) — CLOSED / COMMITTED — `00ab856 style(admin): add subtle card elevation to isolated views`:**

Presentation-only polish building on the C3 isolation. **Scope: visual consistency only — NOT redesign, NOT business logic, NOT POS cashier, NOT broad Admin/Inventory polish.** Delivered a single coherent **card-elevation consistency pass**: a unified subtle resting `box-shadow: 0 1px 2px 0 rgba(16, 24, 40, 0.05)` added to all card surfaces on both isolated admin screens — `adash-kpi-card`/`adash-chart-box`/`adash-pay-section`/`adash-table-card` (in `AdminDashboardPage.css`) and `absr-metric-card`/`absr-chart-box`/`absr-card` (in `AllBranchesStockOverview.css`). **CSS-only, confined to the isolated `adash-*` / `absr-*` namespaces** (box-shadow does not affect layout flow). No TSX changes; behavior/state/query/lifecycle/chart-config/CSV-export/conditional-rendering unchanged.

**Target files (only):** `src/pages/admin/AdminDashboardPage.css`, `src/pages/admin/AllBranchesStockOverview.css`. No shared `DashboardPage.css`/`StockReportPage.css` edit; no global-token change; no H7-F or write-path page touched; `stash@{0}` untouched. Codex: PASS WITH NOTES. Tech Lead / CEO Option B — APPROVED WITH NOTES.

**7C-C1-0 (CSS Namespace Audit) and 7C-C2 (TSX-only Admin polish — evidence-based no-op/deferral) are CLOSED / COMMITTED at `b757c65`.** The C1-0 audit concluded that meaningful Admin/Inventory consistency requires namespace isolation first.

**Phase 7C-C3 — Admin Dashboard / Report Namespace Isolation (Tech Lead / CEO authorized) — CLOSED / COMMITTED — `4262a25 refactor(style): isolate admin dashboard and report css namespaces`:**

C3 scope was **namespace isolation only — NOT broad visual polish, NOT redesign, NOT business logic.** Breaks two shared-CSS couplings flagged by the C1-0 audit by forking admin-specific namespaces (rules copied 1:1; no visual change intended):

- **Admin Dashboard:** forked `dash-*` (+ shared `.dashboard-page`) → **`adash-*`** (+ `.adash-page`). New `src/pages/admin/AdminDashboardPage.css` defines the `adash-*` rules AdminDashboard consumes (footer rules not copied — unused); `AdminDashboardPage.tsx` now imports the local CSS instead of `../DashboardPage.css` and uses `adash-*`. Shared `DashboardPage.css` UNMODIFIED.
- **All Branches Stock Overview:** forked `sr-*` → **`absr-*`**. `AllBranchesStockOverview.css` now defines the `absr-*` rules it consumes (incl. the donut-legend scroll tweak); `AllBranchesStockOverview.tsx` drops `import '../StockReportPage.css'` and uses `absr-*`. Shared `StockReportPage.css` UNMODIFIED.

After the fork: `AdminDashboardPage.tsx` consumes no `dash-*`/`dashboard-page`; `AllBranchesStockOverview.tsx` consumes no `sr-*` (only a doc-comment references the old prefix). `AdminStockReportPage.tsx`/`.css` untouched.

**Forbidden boundaries honored:** no edit to shared `DashboardPage.css` / `StockReportPage.css`; no `index.css`/`variables.css`/global token change; no protected H7-F file touched; no deferred namespace (`sh-`/`inv-adj-`/`ss-`/`qm-`/`asr-`/`asr-bsel-`/`asup-`/`sup-`) implementation; no behavior/state/query/lifecycle/CSV-export change; no route/nav/server/rules/offline/POS change; `stash@{0}` untouched.

**Codex:** PASS WITH NOTES. **Verification:** structural CSS/DOM verification used as fallback for live seeded visual UAT (blocked by admin auth / seeded Firebase data requirements); 0 drift in forked rules after reverse mapping and full rendered-class coverage; no fake screenshots produced. Live seeded visual UAT is optional future confidence work, not a C3 closure blocker. Full web `npx vitest run` → **492 passed (29 files)**; `npx tsc -b` clean; forbidden-area diff EMPTY; `stash@{0}` untouched. Tech Lead accepted structural verification fallback and authorized closure.

**Next step:** Strategic next-slice decision — Admin UI polish leveraging isolated `adash-*` / `absr-*`; POS Cashier UX Boundary Audit; or optional seeded admin visual UAT confidence check. No implementation without separate authorization.

**H6-F1** — Transfer Reversal Evidence Rejection Visibility — CLOSED / COMMITTED — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`
**H6-G1** — Receiving Evidence Rejection Visibility & Void Error Handling — CLOSED / COMMITTED — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`
**H7-A** — Pure Latent Reversal Rejection Record — CLOSED / COMMITTED — `749e6e6 feat(pos): add latent reversal rejection record model`
**H7-B** — Storage Design Audit (read-only design artifact; Codex PASS WITH NOTES). No code/doc changes.
**H7-C** — Durable Rejection Log Store Wiring — CLOSED / COMMITTED — `76b7451 feat(pos): add latent durable reversal rejection log store`
**H7-D** — Catch-site Integration Design Audit (read-only design artifact; receiving-first recommended). No code/doc changes.
**H7-E** — Receiving-only Catch-site Integration — CLOSED / COMMITTED — `ad1ff61 feat(pos): log receiving reversal evidence rejections`
**H7-F** — Transfer Pair Catch-site Integration — **CLOSED / COMMITTED** — `872575a feat(pos): log transfer reversal evidence rejections`
**H7-G** — Manual Review Ops Durable Rejection Panel — **CLOSED / COMMITTED** — `86a628e feat(pos): add read-only manual review ops durable rejection panel`

**Phase 7B-H series is CLOSED / COMMITTED.** H7-E activated the durable rejection log for Receiving; H7-F extended it to BOTH transfer surfaces; H7-G surfaces those durable logs read-only in the existing Manual Review Ops page.

**Durable logging initiative is complete:**
1. Receiving capture — H7-E (`ad1ff61`)
2. Transfer capture — H7-F (`872575a`)
3. Admin/Ops local read-only surfacing — H7-G (`86a628e`)

**H7-G is visibility-only:** NO resolve/delete/retry/sync/export/queue/stock/server action button is added; `recordId` used only as internal React row key (not displayed); no write API introduced. Existing manual-review queue behavior unchanged. No catch-site/helper/model/log/store/schema/server/rules/write-path change.

**`stash@{0}` remains present and untouched.**

**Phase 7C (Stabilization & UI Polish) — 7C-A + 7C-D1 CLOSED / COMMITTED:**

**7C-A** — Regression Stabilization Pass — **CLOSED / COMMITTED** — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`
**7C-D1** — Operator Runbook for Durable Rejection Panel — **CLOSED / COMMITTED** — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`

7C-A de-brittled the H7-G source-level assertions (no production code touched); 7C-D1 added a plain-Thai operator runbook (`docs/operator-runbook-durable-rejection-panel.md`). **No production behavior changed, no UI behavior/layout/polish change, no POS cashier UX work, no source/write-path/schema/server/rules change.** Codex: PASS WITH NOTES (accepted: remaining source-level tests rely on stable semantic markers; materially better than exact whole-page button counts; CRLF warnings accepted; zero production code mutated). 492 web tests (29 files); `tsc -b` clean; forbidden diff EMPTY.

**Baseline is hardened for visual/UI polish planning.** No POS cashier UX work has started.

**7C-B1** — Manual Review Ops UI Polish — **CLOSED / COMMITTED** — `f4d9e7a style(pos): polish manual review ops durable rejection panel`. Option A APPROVED (Zero Behavioral Change). Presentation-only polish of `src/pages/ManualReviewOpsPage.tsx`: a stronger visual boundary between the actionable Manual Review Queue and the read-only Durable Rejection Forensic Log (thicker top divider `border-t-2` + increased `mt-8`/`pt-8` spacing), an "อ่านอย่างเดียว" (read-only) badge on the forensic-log header to reinforce its non-actionable nature, a softer dashed-border empty state for the forensic log, and monospace timestamps for scannability in both tables. **No behavior/state/query/lifecycle change, no gate change, durable panel still read-only with no action buttons, Thai disclaimer meaning preserved, `recordId` still internal-only (sole `key={r.recordId}` use), no route/nav/global-CSS/schema/server/rules/write-path change.** The 24 stabilized 7C-A assertions pass unchanged. Codex: PASS WITH NOTES (accepted: tracker wording precision about "one file" meant one production source file; zero business logic or state changes occurred; source-level tests still rely on semantic source markers, accepted as test-maintenance risk). `stash@{0}` remained untouched.

**Next step:** Strategic option selection for next Phase 7C slice — (C) Admin/Inventory visual consistency (batched, namespace-collision-aware); (B) POS cashier UX polish (highest value, requires read-only boundary audit first); or another separately authorized planning step. No Admin/Inventory or POS cashier UI work without separate authorization.

---

## Phase 7C-B1 — Manual Review Ops UI Polish (presentation-only)

**Status:** CLOSED / COMMITTED — `f4d9e7a style(pos): polish manual review ops durable rejection panel`
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED. Golden rule: **Zero Behavioral Change** (strictly cosmetic/layout). Codex: PASS WITH NOTES.
**Goal:** Improve readability/operator clarity of the Manual Review Ops page, especially the visual distinction between the actionable Manual Review Queue and the read-only Durable Rejection Forensic Log.

### What was delivered (all presentation-only, single file)

- `src/pages/ManualReviewOpsPage.tsx` (MOD, +16/−9):
  - Forensic-log section boundary strengthened: `mt-6 … border-t … pt-6` → `mt-8 … border-t-2 … pt-8`.
  - Forensic-log header gains a read-only badge (`<Badge>อ่านอย่างเดียว</Badge>`) beside the existing `<h2>` (heading text unchanged), with the heading row wrapped in a flex container; subtitle gets `mt-1`.
  - Forensic-log empty state restyled from `<Alert color="gray">` to a dashed-border centered muted `<div>` (same Thai text/meaning).
  - Timestamp cells in BOTH tables (`it.createdAt`, `r.createdAt`) gain `font-mono text-xs` for scannability.
  - No logic, state, handler, data-flow, gate, import-behavior, or marker change; `Badge` was already imported; `Alert` still used elsewhere.

### What is NOT in this slice

No business-logic/state/query/`useEffect`/`useMemo` change; no change to `listQueue`/`listReversalRejections`/`resolveManualReview`/`buildManualReviewResolvePayload`; no Manager/Admin gate or unauthorized-behavior change; no queue resolve-flow change; durable panel remains read-only (no resolve/delete/retry/sync/export/action button); Thai local-device disclaimer meaning preserved; no `recordId` display (still the sole `key={r.recordId}`); no route/nav change; no global/shared CSS, no inline styles, no cross-page Flowbite migration; no offline-schema/`DB_VERSION`/helper/model/log/store change; no Receiving/Transfer catch-site, server-resolver, or Firestore-rules change; no POS/cart/checkout/stock-mutation/write-path change; no test changes (stabilized assertions still pass); `stash@{0}` untouched.

### Verification

- Focused `manualReviewOps` 24 passed (stabilized assertions unchanged); `recordEvidenceRejection`/`reversalRejectionLog`/`reversalLocalStore`/`offlineReversalQueue` 75 passed.
- Full web `npx vitest run` → **492 passed (29 files)**; `npx tsc -b` clean; `functions resolveReversal` 43 passed (server unchanged).
- `git diff --check` clean; forbidden-area diff EMPTY; `git diff --stat` = 1 file (`ManualReviewOpsPage.tsx`); `stash@{0}` present and untouched.

### Closure

7C-B1 is **CLOSED / COMMITTED** — `f4d9e7a style(pos): polish manual review ops durable rejection panel`. Codex: PASS WITH NOTES. Accepted notes: tracker wording precision about "one file" meant one production source file; zero business logic or state changes occurred; source-level tests still rely on semantic source markers, accepted as test-maintenance risk.

### Final test evidence

```
npx.cmd vitest run manualReviewOps → PASS, 24 tests
npx.cmd vitest run → PASS, 492 tests / 29 files
npx.cmd tsc -b → PASS
forbidden diff → EMPTY
stash@{0} → present and untouched
```

---

## Phase 7C-A — Regression Stabilization Pass (+ 7C-D1 Operator Runbook)

**Status:** CLOSED / COMMITTED — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`
**Authorization:** Gemini / Tech Lead / CEO — Option B APPROVED (bundled 7C-A + 7C-D1; test/docs-only stabilization, no production behavior change). Codex: PASS WITH NOTES.
**Goal:** Harden the H7 source-level tests against brittle/formatting-sensitive assertions (preserving or strengthening safety coverage), document/guard the in-memory-store concurrent-write ordering artifact, and add an operator-facing runbook for the durable rejection panel.

### What was delivered

- `src/lib/pos/offline/manualReviewOps.test.ts` (MOD, 21 → 24 tests) — stabilized the H7-G `?raw` source-level assertions:
  - Replaced the brittle whole-page `expect(source.split('<Button').length - 1).toBe(3)` count with two intent-based tests: (a) a region-scoped check (`rejectionPanelRegion` helper slices the page from the panel's marker comment to the resolve `<Modal`) asserting the panel contains NO `<Button` and NO action wiring (`onClick`/`openResolve`/`submitResolve`/`resolveManualReview`); (b) a positive check that the existing manual-review QUEUE retains its resolve affordance (`onClick={() => openResolve(it)}` + `void submitResolve()`), so stabilization cannot silently drop it.
  - Replaced the spacing-sensitive `recordId` negatives (`>{r.recordId}`/`title={r.recordId}`) with a robust single-use check: `r.recordId` appears EXACTLY ONCE and that use is `key={r.recordId}` — proving recordId stays an internal React key and never reaches a visible cell/title. Hash/serialized internals (`serializeReversalRejectionRecord`/`observedDocumentUpdatedAt`) remain asserted absent.
  - Added a `GUARD` test + documentation comment for the in-memory store concurrent-write artifact: the in-memory double commits a readwrite txn by REPLACING the whole store map, so concurrently-started txns lose distinct-key writes (last-commit-wins) — a property of the TEST DOUBLE only (real IndexedDB serializes readwrite txns per store; production unaffected). The guard pins the safe sequential contract (serialized writes to distinct keys both persist) that the newest-first read-path test depends on.
  - All other existing assertions (gate reuse, loader gating, read-only via `listReversalRejections`, no write API, Thai disclaimer, queue path intact) preserved unchanged.
- `docs/operator-runbook-durable-rejection-panel.md` (NEW) — plain-Thai, operator-friendly runbook for Manager/Admin: what the panel is; where it appears (Manual Review Ops, Manager/Admin only); what a row means; what "local-device only" means; what it is NOT (not central audit, not server-synced, not stock truth, not a queue item needing resolution); what operators should do (read the reason, watch repeats, report to admin/owner, do not "close" rows); what not to do; and the known limitation that clearing local browser/PWA storage can remove historical records.

### What is NOT in this slice

No production source change (`ManualReviewOpsPage.tsx` and all offline/runtime/store/catch-site files untouched — forbidden-area diff EMPTY); no in-memory/IndexedDB store behavior or schema change (no `DB_VERSION` bump); no UI behavior/layout/polish change; no POS cashier UX / cart / checkout / stock-mutation change; no server resolver / Firestore-rules change; no route/nav change; no new feature; safety coverage preserved or strengthened (net +3 tests).

### Verification

- Focused: `manualReviewOps` 24 passed; `recordEvidenceRejection`/`reversalRejectionLog`/`reversalLocalStore`/`offlineReversalQueue` 75 passed.
- Full web `npx vitest run` → **492 passed (29 files)** (was 489; +3); `npx tsc -b` → clean; `functions resolveReversal` → 43 passed (server unchanged).
- `git diff --check` clean; forbidden-area diff EMPTY (incl. `ManualReviewOpsPage.tsx`); `git diff --stat` = 1 modified test file + 1 new docs file; `stash@{0}` present and untouched.

### Closure

7C-A + 7C-D1 are **CLOSED / COMMITTED** — `9ad2c51 test(pos): stabilize durable rejection tests and add operator runbook`. Codex: PASS WITH NOTES. Accepted notes: remaining source-level tests still rely on stable semantic markers (acceptable; materially better than exact whole-page button counts); CRLF warnings accepted; zero production code mutated.

### Final test evidence

```
npx.cmd vitest run manualReviewOps → PASS, 24 tests
npx.cmd vitest run → PASS, 492 tests / 29 files
npx.cmd tsc -b → PASS
Forbidden diff → EMPTY (incl. ManualReviewOpsPage.tsx)
stash@{0} → present and untouched
```

---

## Phase 7B-H7-G — Manual Review Ops Durable Rejection Panel

**Status:** CLOSED / COMMITTED — `86a628e feat(pos): add read-only manual review ops durable rejection panel`
**Authorization:** Gemini / Tech Lead / CEO — Option B APPROVED WITH NOTES (Codex PASS WITH NOTES; row key updated to `record.recordId`; `Context.md` stale wording corrected).
**Goal:** Surface the durable rejection logs (H7-A model, H7-C store, written by H7-E/H7-F) in the existing Manual Review Ops page as a LOCAL READ-ONLY forensic panel. It must not become an action queue; the existing manual-review queue behavior is unchanged.

### What was delivered

- `src/pages/ManualReviewOpsPage.tsx` (MOD) — adds a read-only durable-rejection panel below the existing manual-review queue:
  - Imports `listReversalRejections` (read API) and the `ReversalRejectionRecord` type. NO write API (`recordEvidenceRejection`/`recordReversalRejection`) imported or called.
  - Independent panel state (`rejections`/`rejectionsLoading`/`rejectionsError`) + a `refreshRejections` `useCallback` that is gated on the SAME `canResolve` flag (`if (!canResolve) → setRejections([])`) and reads ONLY `listReversalRejections(store)` against the EXISTING memoized `createIndexedDbReversalStore`. The existing `refresh`/queue state is untouched.
  - New section titled `บันทึกการปฏิเสธหลักฐาน (อุปกรณ์นี้)` with a count badge, an `info` Alert disclaimer (`...เฉพาะเครื่องนี้เท่านั้น ไม่ได้ซิงก์ขึ้นเซิร์ฟเวอร์ ไม่ใช่ audit log กลาง และไม่ต้องปิดงานจากรายการนี้ (อ่านอย่างเดียว)`), and loading/error/empty states matching the queue pattern.
  - Read-only table columns: เวลา (`r.createdAt`), ประเภท (`r.sourceType` badge), เอกสาร (`r.sourceId`), สาขา (`r.branchId`), รหัส (`r.evidenceCode`), เหตุผล (`r.evidenceMessage`), ผู้ทำรายการ (`r.staffId ?? '—'`). Row key is `r.recordId` (internal React rendering only; NOT displayed to the user). `recordId`/hashes/raw payloads/qty-cost/`observedDocumentUpdatedAt` are NOT rendered in cells. NO action column / NO buttons in the panel.
- `src/lib/pos/offline/manualReviewOps.test.ts` (MOD, +11 tests → 21 total) — `H7-G: ... read path` (records via `recordEvidenceRejection`, reads back newest-first through the shared store; empty store → empty list) + `H7-G: ManualReviewOpsPage.tsx ... (source-level)` `?raw` assertions (reads only `listReversalRejections(store)` + `refreshRejections`; introduces NO `recordEvidenceRejection`/`recordReversalRejection`; reuses the `canViewManualReviewOps` gate + early not-authorized return; loader gated + clears data for non-authorized; `<Button` count unchanged at 3; only the safe H7-A fields displayed; `recordId`/`serializeReversalRejectionRecord`/`observedDocumentUpdatedAt` NOT exposed; local-device disclaimer present; existing queue `listQueue`/`resolveManualReview`/`buildManualReviewResolvePayload` path intact).

### What is NOT in this slice

No catch-site change (`ReceivingEditPage.tsx`/`TransferHistoryPage.tsx`/`AdminTransferPage.tsx` untouched); no helper/model/log/store/schema change (`recordEvidenceRejection.ts`/`reversalRejectionRecord.ts`/`reversalRejectionLog.ts`/`reversalLocalStore.ts` untouched; no `DB_VERSION` bump; no index added); no display-label helper added to the offline layer; no resolve/delete/retry/sync/export/queue/stock/server action; no new route/nav; no separate Admin page; no server resolver/Firestore-rules change; no validation/fail-closed change; no transfer/receiving write-path change; no server-sync/central-audit architecture.

### Verification

- Focused: `manualReviewOps` 21 passed; `reversalRejectionLog`/`recordEvidenceRejection`/`reversalLocalStore`/`offlineReversalQueue` 75 passed.
- Full web `npx vitest run` → **489 passed (29 files)** (was 478 at H7-F; +11 H7-G tests); `npx tsc -b` → clean; `functions resolveReversal` → 43 passed (server unchanged).
- Forbidden-area diff EMPTY; `git diff --stat` = 2 code files (`ManualReviewOpsPage.tsx`, `manualReviewOps.test.ts`); `stash@{0}` present and untouched.

### Closure

H7-G is **CLOSED / COMMITTED** — `86a628e feat(pos): add read-only manual review ops durable rejection panel`. Codex: PASS WITH NOTES. Notes resolved before commit: stale `Context.md:151` future-work wording corrected; durable rejection panel React row key updated to internal `r.recordId`. **Phase 7B-H series is CLOSED / COMMITTED.**

### Final test evidence (H7-G commit)

```
npx.cmd vitest run manualReviewOps → PASS, 21 tests
npx.cmd vitest run → PASS, 489 tests / 29 files
npx.cmd tsc -b → PASS
Forbidden diff → EMPTY
git diff --check → clean, known CRLF warnings only
post-commit git status --short → clean
stash@{0} → present and untouched
```

---

## Phase 7B-H7-F — Transfer Pair Catch-site Integration

**Status:** CLOSED / COMMITTED — `872575a feat(pos): log transfer reversal evidence rejections`
**Authorization:** Gemini / Tech Lead / CEO — Option B APPROVED WITH NOTES.
**Goal:** Wire BOTH transfer fail-closed evidence rejection catch sites to the durable local rejection log, reusing the proven H7-E `recordEvidenceRejection` helper. The current `setToast` operator feedback and `busy`-cleanup behavior are unchanged.

### What was delivered

- `src/pages/inventory/TransferHistoryPage.tsx` (MOD) — imports `createIndexedDbReversalStore` + `recordEvidenceRejection`; one `const rejectionLogStore = useMemo(() => createIndexedDbReversalStore(), [])`; in `handleCancel`'s `TransferReversalEvidenceError` branch only, computes `evidenceMessage`/`message` (toast text unchanged), `setToast(message)`, then dispatches un-awaited `recordEvidenceRejection(rejectionLogStore, { sourceType:'transfer', sourceId: cancelTarget.id, branchId: cancelTarget.fromBranchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt) })`; `rejectionLogStore` added to the `useCallback` deps. Non-evidence `else` branch and `finally { setBusy(false) }` unchanged.
- `src/pages/admin/AdminTransferPage.tsx` (MOD) — identical wiring in its `handleCancel` `TransferReversalEvidenceError` branch; `rejectionLogStore` added to that `useCallback`'s deps. `editBranchTransfer` catch untouched.
- `src/lib/pos/offline/recordEvidenceRejection.test.ts` (MOD, +12 tests → 25 total) — `H7-F: simulated transfer caller path` (toast still set to the original message when logging fails; never throws) + parametric `describeTransferCatchSiteSource` source-level `?raw` assertions for BOTH pages (one memoized store; `recordEvidenceRejection(` called exactly once ⇒ non-evidence branch does not log; `sourceType: 'transfer'`; `branchId: cancelTarget.fromBranchId`; not awaited; `setToast(message)` preserved).

### Execution order (enforced, both pages)

Detect `TransferReversalEvidenceError` → compute operator message → `setToast(message)` → dispatch fire-and-forget log → existing `finally { setBusy(false) }` runs unchanged. The helper is synchronous/void/fully-guarded, so it cannot block, delay, swallow, or alter the toast/busy-cleanup behavior. Non-evidence errors are NOT logged.

### Field mapping (identical both pages)

`sourceType:'transfer'`, `sourceId: cancelTarget.id`, `branchId: cancelTarget.fromBranchId` (transfer ORIGIN — not the auth branch; identical on both surfaces), `evidenceCode: err.code`, `evidenceMessage` (the already-computed friendly toast message), `staffId: user.id`, `observedDocumentUpdatedAt: toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)`. `evidenceSource` omitted (unresolved at the catch site).

### What is NOT in this slice

No `ReceivingEditPage.tsx` change; no helper/model/log/store/schema change (`recordEvidenceRejection.ts`/`reversalRejectionRecord.ts`/`reversalRejectionLog.ts`/`reversalLocalStore.ts` untouched; no `DB_VERSION` bump); no Admin/Ops surfacing; no Manual Review Ops UI; no server resolver/Firestore-rules change; no validation/fail-closed/thrown-error change; no F1/G1/transfer evidence message-text change; no transfer/receiving write-path change.

### Files changed (code)

```
src/pages/inventory/TransferHistoryPage.tsx          (MOD — useMemo store + 1 helper call in the evidence-error branch)
src/pages/admin/AdminTransferPage.tsx                (MOD — useMemo store + 1 helper call in the evidence-error branch)
src/lib/pos/offline/recordEvidenceRejection.test.ts  (MOD — +12 H7-F tests; 25 file total)
```

### Evidence

- `npx vitest run recordEvidenceRejection` → **25 passed** (13 H7-E + 12 H7-F)
- `npx vitest run reversalRejectionRecord reversalRejectionLog reversalLocalStore offlineReversalQueue manualReviewOps` → **80 passed** (regression green)
- Full web `npx vitest run` → **478 passed** (29 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean (benign CRLF only); forbidden-area diff EMPTY (`ReceivingEditPage`, helper/model/log/store, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

Unlike Receiving (which re-throws), both Transfer catch sites surface the rejection via `setToast(...)` and continue into `finally { setBusy(false) }`; logging stays an un-awaited, fully-guarded side effect inside the `TransferReversalEvidenceError` branch only — placing it elsewhere, awaiting it, logging the non-evidence branch, or using the auth branch id instead of `cancelTarget.fromBranchId` could corrupt forensic records or subtly alter operator feedback.

### Closure

H7-F is **CLOSED / COMMITTED** — `872575a feat(pos): log transfer reversal evidence rejections`. Approved: Gemini / Tech Lead / CEO Option B APPROVED WITH NOTES. The durable rejection log is now active for both Receiving and Transfer. Admin/Ops surfacing remains future work. Next step: read-only strategic planning for Admin/Ops Surfacing.

---

## Phase 7B-H7-E — Receiving-only Catch-site Integration

**Status:** CLOSED / COMMITTED — `ad1ff61 feat(pos): log receiving reversal evidence rejections`
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED (receiving-only; Claude Opus 4.8 / High). H7-D design audit recommended receiving-first.
**Goal:** Wire ONLY the receiving fail-closed evidence rejection catch site to the durable local rejection log — the first production caller of the H7-A/H7-C substrate. The current throw-to-banner UX is unchanged.

### What was delivered

- `src/lib/pos/offline/recordEvidenceRejection.ts` (NEW) — bridge helper `recordEvidenceRejection(store, input): void`. Returns `void` (not a Promise); builds via H7-A `buildReversalRejectionRecord`, dispatches via H7-C `recordReversalRejection`; **both** the build (which can throw fail-closed) and the async dispatch are guarded, and the async promise carries `.catch(() => {})` — never throws into the caller, no unhandled rejection. `evidenceSource` omitted (not resolved at the throw). Touches only the `rejections` store via the log API.
- `src/lib/pos/offline/recordEvidenceRejection.test.ts` (NEW, 13 tests) — record construction (receiving + transfer-shaped), persistence, `evidenceSource` omitted, returns void, async-failure swallowed, build-failure swallowed, no unhandled rejection, simulated receiving caller still throws the F1/G1 message on logging failure, and source-level `?raw` assertions on `ReceivingEditPage`.
- `src/pages/ReceivingEditPage.tsx` (MOD) — imports `createIndexedDbReversalStore` + `recordEvidenceRejection`; one `const rejectionLogStore = useMemo(() => createIndexedDbReversalStore(), [])`; in the `ReceivingReversalEvidenceError` branch only, computes the existing message, dispatches `recordEvidenceRejection({ sourceType:'receiving', sourceId: id, branchId, evidenceCode: err.code, evidenceMessage, staffId: user.id, observedDocumentUpdatedAt })`, then `throw new Error(message)` exactly as before. Non-evidence errors still `throw err` unchanged.

### Execution order (enforced)

Detect `ReceivingReversalEvidenceError` → compute operator message → dispatch fire-and-forget log → throw `new Error(message)`. The helper is synchronous/void/fully-guarded, so it cannot block, delay, swallow, or alter the throw-to-banner behavior.

### What is NOT in this slice

No transfer catch-site integration (`TransferHistoryPage`/`AdminTransferPage` untouched), no Admin/Ops surfacing, no Manual Review Ops UI, no offline store schema change (`reversalLocalStore.ts`/`reversalRejectionLog.ts` untouched), no server resolver/Firestore-rules change, no validation/fail-closed/thrown-error change, no F1/G1 message-text change, no receiving/transfer write-path change.

### Files changed (code)

```
src/lib/pos/offline/recordEvidenceRejection.ts        (NEW — void bridge helper)
src/lib/pos/offline/recordEvidenceRejection.test.ts   (NEW — 13 tests incl. source-level)
src/pages/ReceivingEditPage.tsx                        (MOD — useMemo store + 1 helper call in the evidence-error branch)
```

### Evidence

- `npx vitest run recordEvidenceRejection` → **13 passed**
- `npx vitest run reversalRejectionRecord reversalRejectionLog reversalLocalStore offlineReversalQueue manualReviewOps` → **80 passed** (regression green)
- Full web `npx vitest run` → **466 passed** (29 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; forbidden-area diff EMPTY (transfer pages, offline store/log, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

H7-E is the first production caller of the durable rejection log; if the helper could throw, returned a dropped Promise, or were placed before message determination, the forensic log could disrupt the receiving fail-closed banner path it is meant to observe — the `void`/synchronous/fully-guarded contract and the after-message placement are what prevent that.

---

## Phase 7B-H7-C — Durable Rejection Log Store Wiring (latent)

**Status:** **CLOSED / COMMITTED** — `76b7451 feat(pos): add latent durable reversal rejection log store`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED. H7-B design reviewed by Codex: PASS WITH NOTES.
**Goal:** Implement the latent durable rejection-log substrate per the H7-B design — IndexedDB store + in-memory parity + write/list APIs + tests. **No production caller; 100% latent.**

### What was delivered

- `src/lib/pos/offline/reversalLocalStore.ts` (MOD) — additive only: `'rejections'` added to `ReversalStoreName` + `REVERSAL_STORES`; **`DB_VERSION` 1 → 2**; in-memory `data` gains `rejections: new Map()`. `transact`/`openDb`/`onupgradeneeded`/`dump`/abort logic and the four existing stores (`intents`/`stock`/`ledger`/`markers`) are otherwise unchanged. The `onupgradeneeded` loop creates only missing stores, so the v1→v2 upgrade is data-preserving.
- `src/lib/pos/offline/reversalRejectionLog.ts` (NEW) — focused, latent, no UI imports. `recordReversalRejection(store, record)` → `'recorded' | 'duplicate' | 'unavailable' | 'failed'`, **best-effort and NEVER throws**; keys the H7-A `ReversalRejectionRecord` out-of-line by `recordId` (content-addressed → idempotent overwrite; distinct `createdAt` → distinct row). `listReversalRejections(store, filter?)` → newest-first by `createdAt`, optional `sourceType`/`branchId` filters, read-only. Touches ONLY the `rejections` store — no stock/ledger/intents/markers mutation, no queue-state control reads.
- `src/lib/pos/offline/reversalRejectionLog.test.ts` (NEW, 15 tests) + `src/lib/pos/offline/reversalLocalStore.migration.test.ts` (NEW, 3 tests).

### Codex H7-B notes carried forward

- `duplicate` vs `recorded` not over-specified for cross-tab races (content-addressed key → identical record re-`put`s over itself either way).
- `unavailable` vs `failed` is a best-effort hint only; callers must treat any non-`recorded`/`duplicate` identically.
- The "caller still completes F1/G1 on logging failure" case is a small wrapper unit test — **no real catch-site wiring**.

### What is NOT in this slice

No catch-site integration, no UI/Manual Review Ops surfacing, no server resolver/Firestore-rules change, no validation/fail-closed/thrown-error change, no transfer/receiving write-path change. No production caller imports the new API.

### Files changed (code)

```
src/lib/pos/offline/reversalLocalStore.ts                 (MOD — rejections store + DB_VERSION 1→2 + in-memory parity)
src/lib/pos/offline/reversalRejectionLog.ts               (NEW — recordReversalRejection + listReversalRejections)
src/lib/pos/offline/reversalRejectionLog.test.ts          (NEW — 15 tests)
src/lib/pos/offline/reversalLocalStore.migration.test.ts  (NEW — 3 migration tests)
```

### Evidence

- `npx vitest run reversalRejectionLog reversalLocalStore` → **19 passed** (2 files)
- `npx vitest run reversalRejectionRecord offlineReversalQueue manualReviewOps` → **61 passed** (regression green)
- Full web `npx vitest run` → **453 passed** (28 files); `npx tsc -b` → clean
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean (benign CRLF only); forbidden-area diff EMPTY (UI pages/components, server resolver, Firestore rules, transfer write-path); `stash@{0}` untouched.

### Hidden risk

H7-C is the first edit to the protected offline/IndexedDB layer and the first DB schema-version bump; even with additive migration and best-effort logging, any accidental throw or coupling to stock/ledger/intent transactions could disturb the live reversal queue.

---

## Phase 7B-H7-A — Pure Latent Reversal Rejection Record

**Status:** **CLOSED / COMMITTED** — `749e6e6 feat(pos): add latent reversal rejection record model`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Goal:** Define + test the record model ONLY for a future durable local rejection log. F1/G1 made fail-closed transfer/receiving evidence rejections *visible*, but they are thrown BEFORE any offline intent is created, so they leave no durable forensic trail. **No live runtime behavior changes; 100% latent.**

### Audit findings (gate before implementation)

- Rejection catch sites (untouched): `TransferHistoryPage.tsx:166`, `AdminTransferPage.tsx:184`, `ReceivingEditPage.tsx:229`. At each, the data on hand at the throw is: source doc id, branch (transfer origin / receiving branch), `staffId` (`user.id`), `observedDocumentUpdatedAt` (already ISO via `toObservedDocumentUpdatedAtIso`), and `err.code`. `evidenceSource` is generally NOT resolved at throw time → modeled optional.
- Error types: `ReceivingReversalEvidenceError` (17 codes), `TransferReversalEvidenceError` (26 codes), each with `.code`. Message helpers `get{Transfer,Receiving}ReversalEvidenceMessage(code)` are pure/display-only.
- A pure inventory-domain file is sufficient; **`src/lib/pos/offline` does NOT need touching** (no scope expansion requested). Model lives outside the offline layer and imports nothing from it.

### What was delivered (pure latent only)

- `src/lib/inventory/reversalRejectionRecord.ts` (NEW) — self-contained, no I/O, no offline imports:
  - Types `ReversalRejectionSourceType` (`'transfer' | 'receiving'`), `ReversalRejectionRecord`, `ReversalRejectionRecordInput`, error `ReversalRejectionRecordError`.
  - `buildReversalRejectionRecord(input)` — normalizes/validates required identity fields fail-closed, omits absent optionals, derives a deterministic content-addressed `recordId`.
  - `createReversalRejectionRecordId(input)` — deterministic `rej_<16hex>` id (FNV-1a-style, dependency-free); matches the builder's embedded id.
  - `serializeReversalRejectionRecord(record)` — canonical, key-ordered, stable JSON; omits absent optionals.
- `src/lib/inventory/reversalRejectionRecord.test.ts` (NEW) — 20 tests (construction both source types, required-field validation, optional omission, no over-collection, unknown-code safety, deterministic id, stable serialization, sourceType separation, JSON round-trip).

### Record fields (minimal; no over-collection)

`recordId`, `sourceType`, `sourceId`, `branchId`, `evidenceCode` (raw string — unknown-code safe), `evidenceMessage` (caller passes the already-computed friendly message → no coupling to the code unions), `evidenceSource?`, `staffId?`, `observedDocumentUpdatedAt?`, `createdAt` (input, so the helpers stay pure/deterministic). **Excluded:** raw evidence payloads, item/lot/qty/cost lines, reason/note free-text, actor role, device fingerprint.

### What is NOT in this slice

No persistence wiring, no IndexedDB/localStorage/Firestore/network/queue write, no catch-site/UI change, no `src/lib/pos/offline` change, no server resolver/rules change, no transfer/receiving write-path change, no validation/fail-closed/thrown-error change.

### Files changed (code)

```
src/lib/inventory/reversalRejectionRecord.ts        (NEW — pure builder + serializer + id + types)
src/lib/inventory/reversalRejectionRecord.test.ts   (NEW — 20 tests)
```

### Evidence

- `npx vitest run reversalRejectionRecord` → **20 passed**
- `npx vitest run reversalCoordinator` → **111 passed** (regression green)
- Full web `npx vitest run` → **434 passed** (26 files); `npx tsc -b` → clean
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed**; `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; only the two new untracked files; `stash@{0}` untouched; no diff under `src/lib/pos/offline`, server resolver, Firestore rules, transfer write-path, or UI pages/components.

### Hidden risk

H7-A defines the durable rejection record model, but actual persistence wiring remains a future separately authorized slice; wiring it too early would risk coupling a new write path to the protected offline/IndexedDB layer.

---

## Phase 7B-H6-G1 — Receiving Evidence Rejection Visibility & Void Error Handling

**Status:** **CLOSED / COMMITTED** — `e80b2a3 feat(pos): surface receiving reversal evidence rejection reasons`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Scope:** UI/error-visibility only — the receiving symmetric counterpart of H6-F1. **No validation, fail-closed policy, receiving evidence validator behavior, offline queue schema/IndexedDB/`src/lib/pos/offline`, server resolver, or transfer behavior change.** The thrown `ReceivingReversalEvidenceError` (type, `code`, generic `message`) is UNCHANGED.

### Audit findings (gate before implementation)

- `ReceivingEditPage.handleVoid` calls `executeReceivingReversal` and previously had **no try/catch**, BUT its caller `ReceivingForm.handleVoidConfirm` already wraps `onVoid` in try/catch and shows `err.message` in the `rcv-error-banner` (dialog stays open). So receiving rejections were **caught and shown — but only via the single generic `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE` for all 17 codes** (the specific code was lost). This is the same message-granularity gap F1 fixed for transfers, NOT a true unhandled rejection.
- `AdminReceivingPage` voids via the **legacy `cancelReceiving`** path (no `executeReceivingReversal`, no `ReceivingReversalEvidenceError`) — needs no parity. Authorized file list is therefore sufficient; **no scope expansion required**.
- Fix kept entirely within `ReceivingEditPage.tsx`: `handleVoid` now catches `ReceivingReversalEvidenceError` and re-throws a friendly Thai message + raw code to `ReceivingForm`'s existing banner; non-evidence errors re-throw unchanged. No edit to `ReceivingForm.tsx`.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`: new exhaustive `Record<ReceivingReversalEvidenceCode, string>` (`RECEIVING_REVERSAL_EVIDENCE_MESSAGES`) + pure `getReceivingReversalEvidenceMessage(code): string` (unknown code → `RECEIVING_EVIDENCE_INCOMPLETE_MESSAGE`). Mirrors the F1 transfer helper. Thrown error/validation unchanged.
- `src/pages/ReceivingEditPage.tsx`: `handleVoid` wrapped in try/catch — `ReceivingReversalEvidenceError` re-thrown as `Error(getReceivingReversalEvidenceMessage(code) + " (รหัส: <code>)")` so the existing void-dialog banner shows the specific reason; all other errors re-thrown unchanged (not swallowed). Success/navigation/manual-review wording, validation order, authority gating, and the form's busy/`finally` cleanup all unchanged.
- `src/lib/inventory/reversalCoordinator.test.ts`: +4 H6-G1 tests (every code non-empty Thai; unknown→generic fallback; `header_total_qty_mismatch` specific; thrown error message unchanged).

### What is NOT in this slice

No change to receiving validation / `resolveReceivingReversalEffects` / `validateReceivingHeaderEvidence` / `executeReceivingReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, offline queue schema / IndexedDB / `src/lib/pos/offline`, the server resolver, transfer behavior, `transferCrud`/`transferDevMock`/`transferTypes`, `ReceivingForm.tsx`, `AdminReceivingPage`, `cancelReceiving`. No durable local rejection log (future separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ receiving message map + getReceivingReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-G1 tests; 111 file total)
src/pages/ReceivingEditPage.tsx                 (handleVoid try/catch: evidence-error display only)
```

### Evidence

- `npx vitest run reversalCoordinator` → **111 passed** (+4 H6-G1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **414 passed** (25 files); `npx tsc -b` → clean
- `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

G1 improves receiving void rejection visibility, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-F1 — Transfer Reversal Evidence Rejection Visibility

**Status:** **CLOSED / COMMITTED** — `3a3d202 feat(pos): surface transfer reversal evidence rejection reasons`.
**Authorization:** Gemini / Tech Lead / CEO — Option A APPROVED.
**Scope:** UI/display-only visibility for the H6-E2-C fail-closed rejections. **No validation, fail-closed policy, offline queue schema/behavior, IndexedDB store, server resolver, or transfer write-path change.** The thrown `TransferReversalEvidenceError` (type, `code`, generic `message`) is UNCHANGED — F1 only makes the already-computed reason legible.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`:
  - New exhaustive `Record<TransferReversalEvidenceCode, string>` (`TRANSFER_REVERSAL_EVIDENCE_MESSAGES`) — one friendly Thai message per code (TS build fails if a code is unmapped).
  - New pure `getTransferReversalEvidenceMessage(code): string` — returns the mapped message; an unknown/unexpected code falls back to the existing `TRANSFER_EVIDENCE_INCOMPLETE_MESSAGE`.
- `src/pages/inventory/TransferHistoryPage.tsx` & `src/pages/admin/AdminTransferPage.tsx`: the cancel-handler `catch` now, **only when** the caught error `instanceof TransferReversalEvidenceError`, surfaces `getTransferReversalEvidenceMessage(err.code)` with the raw code as secondary detail (`(รหัส: <code>)`). All other errors keep the existing generic fallback. Control flow, `finally` busy-cleanup, branch gating, modal/route behavior, success flow all unchanged. (Admin's separate `editBranchTransfer` catch is untouched.)
- `src/pages/ManualReviewOpsPage.tsx`: new read-only "แหล่งหลักฐาน" column rendering a **page-local** `getEvidenceSourceLabel(source)` (`header_snapshot`→หลักฐานจากหัวเอกสาร, `legacy_subcollection`→รายการย่อยเดิม, absent/unknown→ไม่ระบุ) over the existing `it.evidenceSource` intent field. The label helper is defined inside the page module — **no runtime helper added to `src/lib/pos/offline`** (Codex blocker fix). No query/schema/store/mutation change.

### What is NOT in this slice

No change to `validateTransferHeaderEvidence` / `resolveTransferReversalEffects` / `executeTransferReversal` control flow, the thrown error, the fail-closed policy, `createOfflineReversal`, the offline queue schema or IndexedDB stores, **any `src/lib/pos/offline` runtime code**, the server resolver, the H6-E2-B write path, transfer creation, receiving, `cancelBranchTransfer`/`editBranchTransfer`. No durable local rejection log (a future, separately-authorized slice).

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (+ message map + getTransferReversalEvidenceMessage)
src/lib/inventory/reversalCoordinator.test.ts   (+4 H6-F1 message-map tests; 107 file total)
src/pages/inventory/TransferHistoryPage.tsx     (catch: evidence-error display only)
src/pages/admin/AdminTransferPage.tsx           (cancel catch: evidence-error display only)
src/pages/ManualReviewOpsPage.tsx               (+ page-local getEvidenceSourceLabel + read-only evidenceSource column)
```

### Codex blocker fix

Codex returned FAIL: the first cut added a runtime helper (`getEvidenceSourceLabel`) + a test to `src/lib/pos/offline/manualReviewOps.ts(.test.ts)`, which was strictly out of scope (`src/lib/pos/offline` runtime). Fix: both offline files reverted to **no diff**; the label mapping now lives **page-local** in `ManualReviewOpsPage.tsx`. Removing the 3 offline-helper tests dropped the full web count 413 → **410**.

### Evidence

- `npx vitest run reversalCoordinator` → **107 passed** (+4 H6-F1)
- `npx vitest run transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **410 passed** (25 files); `npx tsc -b` → clean
- `functions resolveReversal` → **43 passed** (server UNCHANGED)
- `git diff --check` clean; `stash@{0}` untouched; **no diff under `src/lib/pos/offline`**, no server resolver diff, no transfer write-path diff.

### Hidden risk

H6-F1 improves operator visibility for local pre-queue rejection reasons, but it does not create a durable rejection log; durable local rejection logging remains a future separately authorized slice.

---

## Phase 7B-H6-E2-C — Transfer Evidence Coordinator Validation

**Status:** **CLOSED / COMMITTED** — `fe3ff44 feat(pos): validate transfer reversal header evidence`.
**Authorization:** CEO Option A — APPROVED.

### What was delivered

- `src/lib/inventory/reversalCoordinator.ts`:
  - `TransferReversalInput` gains `transferHeaderEvidence?: unknown` (UNTRUSTED at the boundary — never typed as `TransferReversalEvidence`).
  - `TransferReversalOutcome` gains `evidenceSource: ReversalEvidenceSource` (mirrors receiving).
  - `TransferReversalEvidenceCode` extended with 15 `header_*` codes.
  - `assertTransferReversalInput` split into `assertTransferReversalHeaderFields` (transferId/branches/staff/reason — runs on BOTH paths) + `assertTransferReversalItems` (legacy path only); the original retained as a composed wrapper.
  - new `validateTransferHeaderEvidence(raw, fromBranchId, toBranchId): OriginalStockEffect[]` — untrusted-boundary type-guards → version/source/branch checks → per-effect validity + direction-bound branch → checksums (`itemCount`/`totalQtyBase`, the latter with an explicit `Number.isFinite` guard) + dual-branch balance, all against the RAW entries; projects dest_gain→`+qty@to` and source_loss→`-qty@from` (lotId audit-only). Self-consistent; does NOT consult the item subcollection.
  - **Codex blocker fix:** `totalQtyBase` checksum now rejects non-finite values (`NaN`/±Infinity) — previously `typeof NaN === 'number'` + `Math.abs(NaN) > EPSILON === false` let a `NaN` total slip through. +3 regression tests.
  - new `resolveTransferReversalEffects(input)` — Case 1/2 header present (validate-or-throw, no fallback) → `header_snapshot`; Case 3/4 header absent → legacy item gate → `legacy_subcollection`.
  - `executeTransferReversal` now runs header-field gate → `resolveTransferReversalEffects` → sets `evidenceSource` on `CreateReversalInput` and the outcome.
- `src/pages/inventory/TransferHistoryPage.tsx` & `src/pages/admin/AdminTransferPage.tsx`: pass `transferHeaderEvidence: cancelTarget.reversalEvidence` (data argument only — no route/gating/modal change).
- `src/lib/inventory/reversalCoordinator.test.ts`: new `describe('H6-E2-C: …')` — 24 tests (valid preferred incl. empty-items, absent-falls-back, legacy-reversible, full invalid-header matrix with no-fallback/no-write proof, mapping equivalence, single/multi-lot lotId, E2-B round-trip, source tagging, Staff rejected on header path, header-field validation on header path).

### What is NOT in this slice

No transfer write-path change (`transferCrud.ts`/`transferDevMock.ts`/`transferTypes.ts` untouched). No server resolver change (`functions/` untouched — it re-reads items and remains authoritative). No offline queue schema change (`evidenceSource` already existed, optional). No receiving/manual-review/POS change. No new enum value; no new files.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts       (+transferHeaderEvidence, validateTransferHeaderEvidence, resolveTransferReversalEffects, gate split, evidenceSource)
src/lib/inventory/reversalCoordinator.test.ts  (+27 H6-E2-C tests; 103 file total)
src/pages/inventory/TransferHistoryPage.tsx     (+transferHeaderEvidence arg)
src/pages/admin/AdminTransferPage.tsx           (+transferHeaderEvidence arg)
```

### Evidence

- `npx vitest run reversalCoordinator` → **103 passed**; `transferCrud` → **18 passed**; `transferReversalEvidence` → **41 passed**
- Full web `npx vitest run` → **406 passed** (25 files); `npx tsc -b` → clean
- `functions` `resolveReversal` → **43 passed** (server unchanged)
- `git diff --check` clean; `stash@{0}` untouched; forbidden-path diff EMPTY (write-path/server/offline schema).

### Hidden risk

H6-E2-C activates fail-closed header evidence preference, so malformed post-E2-B evidence will BLOCK local queue-first reversal (→ manual review) rather than silently falling back; this is intentional, and server authority remains unchanged.

---

## Phase 7B-H6-E2-B — Write Transfer Evidence Header at Completion

**Status:** **CLOSED / COMMITTED** — `82d3352 feat(pos): write transfer reversal evidence header on completion`.
**Authorization:** CEO Option A — APPROVED.

### What was delivered

- `src/lib/inventory/transferTypes.ts`: added `import type { TransferReversalEvidence }` and `reversalEvidence?: TransferReversalEvidence` as optional field on `InventoryTransfer` (absent on legacy docs).
- `src/lib/inventory/transferCrud.ts`: in `confirmBranchTransfer`, after `linePlans` are finalized (end of Phase 2) and before Phase 3 writes, builds `TransferReversalEvidenceInput` from `linePlans` (with FIFO `sourceLotDetails`), calls `buildTransferReversalEvidence` then `assertTransferReversalEvidenceCoversCompletion` fail-closed, and adds `reversalEvidence` to the Phase-3 `tx.set` atomically with the transfer header. Evidence `createdAt` is a client ISO string (`new Date().toISOString()`); header `createdAt`/`updatedAt` remain server timestamps.
- `src/lib/inventory/transferDevMock.ts`: `devConfirmBranchTransfer` mirrors the production path — builds the same evidence input from `savedItems`, calls builder + assertion, and writes `reversalEvidence` on the in-memory doc.
- `src/lib/inventory/transferCrud.test.ts`: 8 new H6-E2-B tests in `describe('H6-E2-B: write reversalEvidence at transfer completion', ...)`.

### What is NOT in this slice

No coordinator validation against the persisted evidence in this slice. `reversalCoordinator.ts`, UI pages, server resolver, offline queue, Firestore rules — all UNCHANGED in this slice. H6-E2-C (coordinator validation) is now also CLOSED / COMMITTED — `fe3ff44`.

### Files changed (code)

```
src/lib/inventory/transferTypes.ts       (+ reversalEvidence?: TransferReversalEvidence)
src/lib/inventory/transferCrud.ts        (evidence build + tx.set update in confirmBranchTransfer)
src/lib/inventory/transferDevMock.ts     (evidence build + doc update in devConfirmBranchTransfer)
src/lib/inventory/transferCrud.test.ts   (+8 H6-E2-B tests; 18 transferCrud total)
```

### Evidence

- `npx vitest run transferCrud` → **18 passed** (+8 H6-E2-B); `npx vitest run transferReversalEvidence` → **41 passed** (regression green)
- Full web `npx vitest run` → **379 passed** (25 files); `npx tsc -b` → clean
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-B persists the evidence snapshot at completion but does not yet validate it at reversal time — until H6-E2-C wires the coordinator to read and verify the header evidence before accepting a reversal, the snapshot is audit-only (not fail-closed on the reversal path).

---

## Phase 7B-H6-E2-A — Pure Transfer Evidence Builder + Dual-Branch Invariant

**Status:** **CLOSED / COMMITTED** — `53a2123 feat(pos): implement dual-branch transfer reversal evidence builder and invariants`.
**Authorization:** CEO Option A — APPROVED (pure evidence builder + invariant only).

### What was delivered

- New pure file `src/lib/inventory/transferReversalEvidence.ts`:
  - `TransferReversalEvidence` / `TransferReversalEvidenceEffect` / `TransferReversalEvidenceDirection` types.
  - `TransferReversalEvidenceInput` / `TransferReversalEvidenceItemInput` builder input types (decoupled from runtime transfer types).
  - `TransferReversalEvidenceError` (structured codes: builder + invariant).
  - `buildTransferReversalEvidence(input)` — validates input fail-closed; produces one `dest_gain` + one `source_loss` effect per item (both positive qty); derives `itemCount` and `totalQtyBase` from input; sorts effects deterministically by `productId|direction|branchId|lotId`. Source lot identity is audit-only (populated for single-lot; null for multi-lot — no over-rejection gate).
  - `assertTransferReversalEvidenceCoversCompletion(input, evidence)` — proves version/source, branch IDs, effect well-formedness, `itemCount` == `input.items.length`, `totalQtyBase` == sum(transferQty), and per-product dual-branch balance (dest_gain total == source_loss total == input qty for every product; extra products in effects also fail closed).
- New test file `src/lib/inventory/transferReversalEvidence.test.ts`: 41 tests (36 original + 5 branch-direction invariant tests from the Codex blocker fix) covering all 24 required specification cases plus the branch-direction binding cases.

### What is NOT in this slice

No runtime wiring. No header write. No coordinator validation. No evidence persistence. `transferCrud.ts`, `reversalCoordinator.ts`, `transferDevMock.ts`, UI, server resolver, offline queue — all UNCHANGED. H6-E2-B (header write at completion) and H6-E2-C (coordinator validation) are future slices.

### Files changed (code)

```
src/lib/inventory/transferReversalEvidence.ts       (NEW — pure builder + invariant)
src/lib/inventory/transferReversalEvidence.test.ts  (NEW — 41 tests)
```

### Evidence

- `npx vitest run transferReversalEvidence` → **41 passed**; `npx vitest run transferCrud` → **10 passed**; `npx vitest run reversalCoordinator` → **76 passed**; full web `npx vitest run` → **371 passed** (25 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → **43 passed** (resolver UNCHANGED).
- `git diff --check` clean; `stash@{0}` untouched; no diff in any forbidden file.

### Hidden risk

H6-E2-A proves the evidence math but remains latent; it does not yet protect live queue-first local correction until a later write/validation slice is authorized.

---

## Phase 7B-H6-E1 — Transfer `updatedAt` Stamping

**Status:** **CLOSED / COMMITTED** — `8a3d03f feat(pos): stamp updatedAt on transfer completion for stale-client protection`.
**Authorization:** CEO Option A — APPROVED (timestamp-only).

### What was delivered

- `confirmBranchTransfer` (`transferCrud.ts`) Phase-3 header `tx.set` now writes `updatedAt: now` alongside the existing `createdAt: now` (both `serverTimestamp()`); `updatedAt === createdAt` at inception is expected/acceptable.
- `devConfirmBranchTransfer` (`transferDevMock.ts`) mirrors the shape, writing `updatedAt: ts(now)` on the created doc.
- No other write path changed: `cancelBranchTransfer` already stamped `updatedAt`; `editBranchTransfer` creates a fresh transfer via `confirmBranchTransfer` (so edit-created docs inherit the stamp). `InventoryTransfer.updatedAt` was already optional — no type change.

### Why this closes the gap

Pre-E1, a freshly `completed` transfer had `createdAt` but no `updatedAt`, so the server `isClientObservationStale` saw `serverDoc.updatedAt == null` → not stale (doubly inert with the omitted client observation). With E1, new transfers carry `updatedAt`, so the H6-D2 capture `toObservedDocumentUpdatedAtIso(cancelTarget.updatedAt)` is populated AND the server has a baseline — activating the stale-client guard end-to-end. No page/coordinator/resolver edit was needed (H6-D2 was built forward-compatible).

### Legacy docs policy (accepted)

No backfill. Existing transfers without `updatedAt` stay fresh-by-default (guard fail-open); the server reversal mutation remains authoritative through the existing guards. New transfers get reliable `updatedAt`.

### Files changed (code)

```
src/lib/inventory/transferCrud.ts        (confirmBranchTransfer header: + updatedAt: now)
src/lib/inventory/transferDevMock.ts     (devConfirmBranchTransfer doc: + updatedAt: ts(now))
src/lib/inventory/transferCrud.test.ts   (+2 H6-E1 tests: production + dev/mock stamping)
```

### Evidence

- `npx vitest run transferCrud` → 10 passed; `npx vitest run reversalCoordinator` → 76 passed; full web `npx vitest run` → 330 passed (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → 43 passed (server resolver UNCHANGED; the transfer stale-guard regression already exists at `resolveReversal.test.ts` lines 454–468 and stays green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched (no UI, coordinator, resolver, or offline-queue diff).

### Out of scope (unchanged)

Transfer header evidence/checksum snapshot (future H6-E2), server resolver implementation, offline queue schema, Firestore rules, receiving behavior, H6-D2 UI route wiring/coordinator, `cancelBranchTransfer`/`editBranchTransfer` behavior, `sent→received` lifecycle refactor, legacy-doc backfill.

### Hidden risk

Legacy transfer docs without `updatedAt` remain fresh-by-default (stale-client guard inert for them), but new transfers now activate the guard end-to-end; additionally, a metadata-only `reportTransferDiscrepancy` writes a subcollection without advancing the header `updatedAt`, so a discrepancy report is not seen as a state advance by the guard (acceptable — it mutates no stock).

---

## Phase 7B-H6-D2 — UI Route Wiring & Legacy Path Retirement

**Status:** **CLOSED / COMMITTED** — `bb30881` `feat(pos): wire ui to queue-first transfer reversal and retire legacy path` (CEO Option B — APPROVED WITH NOTES).
**Authorization:** CEO Option A — APPROVED.

### Codex blocker fix (origin-branch authority gate)

Codex returned **FAIL**: `TransferHistoryPage` lists both outgoing (`fromBranchId`) and incoming (`toBranchId`) transfers, but the queue-first executor applies a local IndexedDB correction + queue write BEFORE server sync using `fromBranchId` as authority — so a destination-branch user could locally apply/queue a reversal they don't control. **Fix:** a pure fail-closed preflight `canBranchReverseTransfer(currentBranchId, fromBranchId)` (in `reversalCoordinator.ts`) gates BOTH the modal entry point (`onCancelTransfer` is only wired when active branch === origin) AND `handleCancel` (hard early-return before `executeTransferReversal`). `AdminTransferPage` is the global-admin surface (`hasBranchAccess` → `true` for `admin`), so it intentionally does NOT use the gate. New tests prove the helper's fail-closed behavior, the gated entry point, the guard-before-executor ordering, and that Admin stays ungated. Server resolver, offline-queue schema, and `transferCrud.ts` unchanged.

### What was delivered

- **D2-α prerequisite cleanup:**
  - Removed the now-stale `TRANSFER_REVERSAL_DEFERRED_NOTE` constant (and its tests/JSDoc references); it claimed completed transfers were not resolver-compatible, which H6-C (resolver activation) + H6-D1 (latent executor) made false.
  - Tightened `assertTransferReversalInput`: whitespace-only `productId` now fails closed as `missing_product_id`; trim-equal `fromBranchId`/`toBranchId` now fail closed as `same_branch`.
- **D2-β UI route wiring:**
  - `decideReversalRoute('transfer')` now returns `transfer_queue_first` (the `transfer_legacy_executor` route value is retired from `ReversalRoute`).
  - `TransferHistoryPage` + `AdminTransferPage` confirmed-cancel handlers now call `executeTransferReversal` queue-first, fetching transfer items fresh and building the payload (`transferId`, `fromBranchId`, `toBranchId`, items, `sourceLotDetails`, reason/note, `observedDocumentUpdatedAt` via `toObservedDocumentUpdatedAtIso`). Queue-first outcome wording mirrors the receiving reversal UX (manual-review / synced / queued-offline).
  - Legacy `cancelBranchTransfer` import + call removed from BOTH pages. `AdminTransferPage` keeps `editBranchTransfer` (and its internal `cancelBranchTransfer` step is untouched in `transferCrud.ts`).

### Timestamp handling (known limitation)

`observedDocumentUpdatedAt` is threaded WHEN the transfer doc has a convertible `updatedAt`, omitted otherwise. `confirmBranchTransfer` may not reliably stamp `updatedAt` at creation yet, so full stale-client protection for transfers is NOT claimed — that is the future **H6-E** hardening slice.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (route flip + whitespace tightening + stale-note removal + comment refresh)
src/lib/inventory/reversalCoordinator.test.ts   (route/validation tests + H6-D2 source-level mutual-exclusion tests)
src/pages/inventory/TransferHistoryPage.tsx     (queue-first migration; cancelBranchTransfer retired)
src/pages/admin/AdminTransferPage.tsx           (queue-first migration; cancelBranchTransfer retired, editBranchTransfer preserved)
```

### Evidence (post blocker fix)

- `npx vitest run reversalCoordinator` → 76 passed; full web `npx vitest run` → 328 passed (24 files); `npx tsc -b` → clean.
- `npm --prefix functions run test:unit -- resolveReversal` → 43 passed (server resolver unchanged — regression green).
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

Server resolver, offline-queue schema, Firestore rules, receiving/POS/checkout/returns/RTV, `transferCrud.ts` (`cancelBranchTransfer`/`editBranchTransfer` behavior), transfer header evidence/checksum snapshot, `updatedAt` stamping at transfer completion, `sent→received` lifecycle refactor.

### Hidden risk

Page-component guarantees are proven by source-level import/call inspection (the pages carry a heavy Firebase/router/auth/modal harness), so a future refactor that re-introduces a legacy `cancelBranchTransfer` call through an alias or indirection could evade the regex guards without failing the suite.

---

## Phase 7B-H6-D1 — Transfer Queue-first Executor (LATENT)

**Status:** **IMPLEMENTED — AWAITING CODEX REVIEW** (not committed; not closed).
**Authorization:** CEO Option A — APPROVED (latent executor + tests only).

### What was delivered

- Latent `executeTransferReversal` in `reversalCoordinator.ts` mirroring `executeReceivingReversal`: fail-closed validation (`assertTransferReversalInput` + `TransferReversalEvidenceError`), dual-branch `buildTransferReversalEffects`, `observedDocumentUpdatedAt` threading, queue-first create + sync.
- Intent uses `sourceType:'transfer'`, `sourceId: transferId`, `branchId: fromBranchId` (origin — matches server authority). No offline-queue schema change.
- **Not wired into any UI (as of H6-D1; superseded by H6-D2).** At D1, `decideReversalRoute('transfer')` still returned the legacy route and the two transfer pages were untouched — capability was dead-but-tested. **H6-D2 has since flipped the route to `transfer_queue_first` and migrated both pages.**

### Dual-branch math (proven)

- Original effects: destination `+transferQty`, source `−transferQty`. Reversal engine negates → local correction destination `−qty`, source `+qty`; aggregated by product×branch.

### Files changed (code)

```
src/lib/inventory/reversalCoordinator.ts        (executeTransferReversal + builder + validation + types)
src/lib/inventory/reversalCoordinator.test.ts   (16 new H6-D1 tests)
```

### Evidence

- `npx vitest run reversalCoordinator` → 63 passed; full web `npx vitest run` → 315 passed (24 files); `npx tsc -b` → clean.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged)

UI route flip, transfer page migration, legacy `cancelBranchTransfer` retirement, server resolver, offline-queue schema, transfer evidence/checksum snapshot, `updatedAt`-at-completion, `sent→received` lifecycle refactor.

### Hidden risk

The executor is fully functional but unreferenced by production UI, so a future H6-D2 that forgets to also remove the legacy `cancelBranchTransfer` page calls could leave two live reversal paths for the same transfer.

---

## Phase 7B-H6-C — Server Resolver Activation + Tests

**Status:** **CLOSED / COMMITTED**
**Commit:** `68f46e2` — `feat(pos): activate server transfer reversal resolver` (CEO Option B — APPROVED WITH NOTES)
**Authorization:** CEO Option A — APPROVED (server resolver + tests only).

### What was delivered

- Activated the (previously dormant) transfer reversal resolver for the live model: `completed` is now the reversible state (H6-B Option A). Eligibility is **centralized** in `isTransferStatusReversible(status)` backed by the single-source-of-truth set `REVERSIBLE_TRANSFER_STATES = {'completed'}`; the resolver gate calls only that helper (no scattered `status === 'completed'` checks).
- `completed` is **eligible only to proceed into the existing strict downstream guards** — it is never unconditionally reversible. Guard ordering preserved: `source_document_not_found` → authority/PIN → H4 stale-client guard → `already_reversed` (cancelled/reversedBy) → eligibility gate → dest stock/lot sufficiency → dual-branch writes → intent/audit.
- No client/UI/offline-queue change. Resolver activation is **latent in production** until the future H6-D client wiring (no caller currently queues a `transfer_reversal`).

### Files changed (code)

```
functions/src/resolveReversal.ts        (centralized policy helper + gate + header comment)
functions/src/resolveReversal.test.ts   (transfer tests updated to live model + new coverage)
```

### Evidence

- `npm --prefix functions run build` → clean.
- `npx vitest run resolveReversal` → 43 passed; full functions suite `npx vitest run` → 112 passed (8 files).
- Receiving + H4 stale-guard tests remain green.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged by H6-C)

Client queue-first transfer reversal, `executeTransferReversal`, transfer UI/Admin routing, legacy `cancelBranchTransfer` retirement, transfer evidence/checksum snapshot, `updatedAt` stamping at completion, `sent→received` lifecycle refactor, Firestore rules, receiving paths.

### Hidden risk

H6-C flips the server gate so a `completed` transfer is now reversible server-side, but no client path queues a transfer reversal yet — so the activation is inert in production until H6-D, and any premature direct callable invocation would now execute a real dual-branch reversal under the guards.

---

## Phase 7B-H6-B — Transfer Reversal Architecture Decision

**Status:** **IN PROGRESS — docs-only, not yet committed.**
**Authorization:** CEO Option A — APPROVED. Docs-only architecture decision recording. No TypeScript implementation in H6-B.

### H6 Environment Audit Findings (read-only — point-in-time at the H6-B audit, SINCE SUPERSEDED by H6-C/H6-D1/H6-D2)

> These findings describe the state at the H6-B audit. **H6-C (committed `68f46e2`) activated the resolver for `completed` transfers under strict guards; H6-D1 (`4aa8065`) added the latent queue-first executor; H6-D2 wired the targeted UI surfaces.** The "dormant"/"cannot fire" rows below are historical, not current.

| Finding | Detail |
|---------|--------|
| Current Transfer state model | Two states only: `completed` \| `cancelled` |
| Live transfer creation | Transfers are created directly as `completed` (no intermediate `sent`/`received` steps in the current production path) |
| Existing server resolver transfer branch | Was dormant at the audit — gated on `sent`/`received` (states no live transfer carries). **H6-C has since activated it for `completed` transfers under strict guards.** |
| Impact | At the audit, the resolver transfer path could not fire end-to-end until the gate was updated. **H6-C updated the gate to admit `completed`; the path is now live server-side and wired in H6-D2.** |

### CEO Architecture Decision (Option A)

For the current Transfer model, **`completed` is approved as the reversible state** for future queue-first Transfer Reversal.

**Semantics clarification:**
- `completed` does NOT mean "always reversible."
- `completed` means "**eligible for reversal under strict server-authoritative guards**."
- The same guard stack (authority, stale-client, idempotency, already-reversed, stock/lot sufficiency) applies as for receiving reversals.

**Deferred:** A full `sent → received → completed` lifecycle refactor is explicitly out of scope for the H6 implementation track and must not be introduced unless separately authorized.

### Long-Term Risk Documentation

#### Technical Debt

Treating `completed` as reversible creates **controlled technical debt, not blocking debt**. It matches the current production data model exactly. Forcing a broad transfer lifecycle refactor now would be riskier and broader than the immediate problem warrants. The debt is bounded: if business requirements later introduce a multi-step workflow, only the reversible-state policy needs to change — not the resolver logic everywhere.

#### Future Scalability

If a future `sent → received → completed` workflow is introduced, the resolver remains adaptable **if and only if** H6-C centralizes reversible-state eligibility in one helper/policy (e.g. `isTransferReversible(transfer)`) and tests both accepted and rejected states against that helper. A single centralized change then covers all call sites.

#### Mitigation Pattern (H6-C must follow)

| Requirement | Rule |
|-------------|------|
| Reversible-state check | Centralized helper — do NOT scatter `status === 'completed'` checks across resolver code |
| Semantics | `completed` = "eligible under guard," never "reversible unconditionally" |
| Server authority | Final mutation always server-authoritative |
| Stock/lot sufficiency | Destination stock/lot sufficiency must be required before reversal |
| Cost preservation | Source lot restoration must preserve original cost and `receivedAt` evidence |
| Stale-client guard | Must remain active when client payload is wired (same H4/H5 pattern) |
| Idempotency | Already-reversed check mandatory |
| Lifecycle refactor | No transfer lifecycle refactor unless separately authorized |

### Next queued slice

**Phase 7B-H6-C: Server Resolver Activation + Tests — Planning Only.**
No code implementation until Tech Lead approves the H6-C execution plan.

---

## Phase 7B-D4 — Docs/Context Sync After H5 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `f61e94e` — `docs: sync phase 7b tracker after h5 receiving hardening closure`
Docs-only sync pass after Phase 7B-H5 was closed and committed (`4762d97`). Recorded H5 as CLOSED/COMMITTED, advanced the baseline to the H5 commit, recorded End-to-End Receiving Reversal Hardening as functionally complete, and queued H6. No source code or tests modified.

---

## Phase 7B-D3 — Docs/Context Sync After H4 Closure

**Status:** **CLOSED / COMMITTED**
**Commit:** `fb4c3b0` — `docs: sync phase 7b tracker after h4 closure`

Docs-only sync pass after Phase 7B-H4 was closed and committed (`4da7757`). Recorded H4 as CLOSED/COMMITTED, advanced the baseline to the H4 commit, and queued H5. No source code or tests modified. D3 is no longer active.

---

## Phase 7B-H5 — Wire Client Observation Timestamp Payload

**Status:** **CLOSED / COMMITTED**
**Commit:** `4762d97` — `feat(pos): wire client observation timestamp for reversals`
**Authorization:** Option A — APPROVED (receiving-only). CEO Option B — APPROVED WITH NOTES (closure).
**Milestone:** End-to-End Receiving Reversal Hardening is functionally complete. H4 (server-side stale-client guard) and H5 (client/offline timestamp payload wiring) together protect the Receiving reversal flow end-to-end.

### What was delivered summary

Wired `clientObservedDocumentUpdatedAt` into the offline/client resolver payload so Phase 7B-H4's server-side stale-client guard is active end-to-end for the **live receiving reversal flow**.

### What was delivered (receiving-only payload wiring — committed)

- The receiving void page (`ReceivingEditPage.handleVoid`) captures the loaded receiving doc's `updatedAt`, converts it defensively to an ISO 8601 string (`toObservedDocumentUpdatedAtIso`), and passes it through `ReceivingReversalInput`.
- The value is persisted on the durable offline intent as the optional **internal** field `observedDocumentUpdatedAt` (ISO 8601), so a later sync forwards the same observation.
- At the sync boundary, `toResolveRequest` maps it to the **server wire** field `clientObservedDocumentUpdatedAt`, **omitting** it entirely when unavailable.
- No server resolver change (H4 guard already shipped in `4da7757`).

### Backward compatibility

- All new fields optional. Legacy queued intents (pre-H5) carry no `observedDocumentUpdatedAt` ⇒ `toResolveRequest` omits `clientObservedDocumentUpdatedAt` ⇒ H4 guard stays inert (fresh) for them. No migration required.
- Missing / malformed / unconvertible `updatedAt` ⇒ field omitted (never `''`, never `null` on the wire).

### Idempotency

- The observed timestamp is **not** part of `deriveReversalIds` (intent id / idempotency key / localMutationId) and is excluded from the server payload hash by H4's design. Tests prove two intents differing only by `observedDocumentUpdatedAt` derive identical ids.

### Files changed

```
src/pages/ReceivingEditPage.tsx                    (capture + convert at void)
src/lib/inventory/reversalCoordinator.ts           (input field + toObservedDocumentUpdatedAtIso + thread-through)
src/lib/pos/offline/offlineReversalTypes.ts        (CreateReversalInput + OfflineReversalIntent fields)
src/lib/pos/offline/offlineReversalLogic.ts        (persist on intent)
src/lib/pos/offline/syncOfflineReversals.ts        (wire field + emit in toResolveRequest)
src/lib/pos/offline/offlineReversalQueue.test.ts   (3 new H5 tests)
src/lib/pos/offline/offlineReversalLogic.test.ts   (3 new H5 tests)
src/lib/inventory/reversalCoordinator.test.ts      (8 new H5 tests)
```

### Evidence

- `npx vitest run` (web) → 298 passed (24 files).
- Server resolver `functions: npx vitest run resolveReversal` → 39 passed (**unchanged**).
- `npx tsc -b` (web) → clean; `npm --prefix functions run build` → clean.
- `git diff --check` clean; `stash@{0}` untouched; no forbidden areas touched.

### Out of scope (unchanged by H5)

- Transfer reversal wiring (out of scope for H5; at that time it routed to the legacy executor and the resolver transfer path was dormant — since changed by H6-C activation, H6-D1 executor, and H6-D2 UI wiring).
- Manual-review resolution (local-only; never calls the server).
- Global Admin UI; multi-device/server-broadcast propagation.
- POS/cart/checkout/returns/RTV; Firestore rules; server resolver logic.

### Hidden risk

The observation is captured at void time from the page's already-loaded receiving doc; if that in-memory copy is staler than Firestore at the moment of voiding, the guard could reject a reversal the operator believes is current — surfaced via the existing manual-review path, not silent data loss.

---

## Phase 7B-H4 — Resolver Hardening / Stale Client Guard

**Status:** **CLOSED / COMMITTED**
**Commit:** `4da7757` — `feat(pos): harden resolver against stale client observations`
**Authorization:** Option B — APPROVED WITH NOTES (CEO)

### What was delivered

- Server-authoritative stale-client guard in `functions/src/resolveReversal.ts`. The resolver now rejects a reversal whose client-observed document version (`clientObservedDocumentUpdatedAt`) is older than the live server document `updatedAt`.
- New structured reject code `stale_client_observation` (status `rejected`). Mutation-free: zero stock, zero lot, no reversal/manual-review state advance, no audit/intent-ledger write.
- Guard placed AFTER authority (branch + Staff PIN) and BEFORE every status check and write in both `resolveReceivingReversal` and `resolveTransferReversal`.
- Conservative & deterministic: absent observation ⇒ not stale (legacy callers unaffected); no comparable server `updatedAt` ⇒ not stale; strict `server > observed` ⇒ stale (equal instants are fresh, so retries are safe).

### Files changed

```
functions/src/resolveReversal.ts        (guard + helpers + reject code)
functions/src/resolveReversal.test.ts   (11 new H4 tests)
```

### Evidence

- `npx vitest run resolveReversal` → 39 passed.
- Full functions suite `npx vitest run` → 108 passed (8 files).
- `npm run build` (tsc) → clean.
- `git diff --check` → clean; post-commit working tree **clean**; `stash@{0}` untouched.

### Hidden risk (accepted — primary H5 requirement)

The guard only fires when the client actually sends `clientObservedDocumentUpdatedAt`; until the offline-queue client is wired to populate it (out of this slice's scope), real-world staleness is not yet detected end-to-end. **Accepted by CEO (Option B) as a non-blocking known risk.** Wiring `clientObservedDocumentUpdatedAt` into the client/offline resolver payload is the primary Phase 7B-H5 requirement.

---

## Phase 7B-H3 — Manual Review Operations UI

**Status:** **CLOSED / COMMITTED**
**Codex:** PASS WITH NOTES / no required fixes / no blockers
**Commit:** `4d69143` — `feat(pos): add manual review ops UI`

> LOCAL/device-visible queue UI only. NOT a global Firestore admin dashboard. No global Firestore queries, no stock mutation, no Firestore reconciliation (that remains an external manual admin process outside the app).

### What was delivered

- Read-only view of THIS DEVICE's `manual_review_required` intents (via `listQueue(store, ['manual_review_required'])`).
- Manager/Admin-only resolve action (`resolveManualReview` from H2) with required `reasonCode` + optional `note`.
- Authority gating: `canViewManualReviewOps` delegates to H2's `isOfflineReversalAuthoritySupported` (Manager/Admin only; Staff sees not-authorized state).
- Unit/integration tests: `manualReviewOps.test.ts` (10 passed). Full web unit suite: 284 passed (24 files). `tsc -b --noEmit`: clean.

### Architectural boundaries

- **Local/device-only:** reads the IndexedDB reversal queue on THIS device only; not a cross-device or global scan.
- **No Firestore reconciliation:** Firestore reconciliation remains an external manual admin process outside the app.
- **No stock mutation:** `resolveManualReview` leaves the internal stock counter untouched.
- **Staff blocked:** Manager/Admin only; Staff cannot see or invoke the resolution action.

---

## Phase 7B-D1 — Project Context and Task Tracking Docs

**Status:** **CLOSED / COMMITTED**
**Commit:** `dacccd1` — `docs: add project context and task tracker`

| File | Purpose |
|------|---------|
| `Context.md` | Twinpet POS Project Context & System Rules |
| `Task.md` | This checkpoint tracker |

---

## Phase 7B-H2 — Manual Review Operational Guard

**Status:** **CLOSED / COMMITTED**
**Codex:** PASS WITH NOTES / Required Fixes: None
**Tech Lead:** APPROVED / COMMIT AUTHORIZED
**Commit:** `8b48513` — `feat(pos): add manual review resolution state`

---

## Checkpoint goal (H2)

When a Manager/Admin reconciles Firestore stock but a device still has a `manual_review_required` offline intent, the POS overlay keeps showing a **ghost delta**. H2 adds a **local-only** transition to `manual_review_resolved` so that device stops overlaying — without rolling back the local correction or touching server state.

---

## What is done (this checkpoint)

| Item | State |
|------|-------|
| New status `manual_review_resolved` + `manualReviewResolution` audit block | Done |
| Pure helpers: eligibility, guard, build (`offlineReversalLogic.ts`) | Done |
| `resolveManualReview()` orchestration (`offlineReversalQueue.ts`) | Done |
| Overlay excludes `manual_review_resolved` (doc comment updated) | Done |
| Tests: `manualReviewResolution.test.ts` (15), overlay (19), queue (28), logic (16) | Green |
| Full web unit suite | 274 passed (23 files) |
| Playwright `pos-safety.spec.ts` | 2 passed |
| `resolveReversal.test.ts` (server) | 29 passed — **unchanged** |

### Approved H2 semantics (do not reinterpret)

- **Local stock counter NOT touched**; `localCorrection.reversed` stays `false`.
- **Outcomes:** `resolved | already_resolved | not_found | not_eligible`; throws only for authority / missing actor / missing reason.
- **Eligibility:** only `manual_review_required` with `applied && !reversed`. `server_rejected` is **not** resolvable.
- **Idempotent:** second call → `already_resolved`, metadata preserved.
- **Multi-device propagation:** deferred (per-device only).

---

## What is NOT in scope (H2 / D1)

- Admin UI for manual-review resolution
- Server / rules changes (`resolveReversal.ts` unchanged)
- `stash@{0}` / Flowbite migration
- Transfer-logic refactor
- Completed-transfer queue-first reversal
- Multi-device broadcast of resolution

---

## D-track context (7B-3D — foundation, not H2 scope)

Already on mainline before H2:

| Track | Delivered |
|-------|-----------|
| **7B-3D-2** | Server `resolveReversal` callable |
| **7B-3D-3** | Offline reversal queue + IndexedDB correction |
| **Post-commit integration** | Receiving/Transfer/POS wired + `reversalStockOverlay` |
| **7B-H1** | Receiving `reversalEvidence` header snapshot |

H2 sits on this stack; it does not replace or modify the server resolver.

---

## Open actions (D1 checkpoint)

| # | Action | Owner | Status |
|---|--------|-------|--------|
| 1 | Codex review of `8b48513` (H2 commit) | Codex | **Done** — PASS WITH NOTES |
| 2 | Paranoid Checklist pass on H2 diff | Codex | **Done** |
| 3 | Tech Lead go/no-go for H2 | Gemini | **Done** — APPROVED |
| 4 | Commit `Context.md` + `Task.md` (docs-only) | Developer | **Ready** |
| 5 | Tech Lead decides next implementation track | Gemini | **Done** — H3 (Manual Review Ops UI) implemented |

---

## Files in H2 scope (reference)

```
src/lib/pos/offline/offlineReversalTypes.ts
src/lib/pos/offline/offlineReversalLogic.ts
src/lib/pos/offline/offlineReversalQueue.ts
src/lib/pos/offline/reversalStockOverlay.ts          (doc comment only)
src/lib/pos/offline/manualReviewResolution.test.ts   (NEW)
src/lib/pos/offline/reversalStockOverlay.test.ts
```

---

## Forbidden touch list (all agents)

- `functions/**` (especially `resolveReversal.ts`)
- `firestore.rules`
- `Android/**`
- `.claude/settings.local.json`
- Settings / UOM files in `stash@{0}`
- `rp.md` (personal scratchpad — not part of project commits)
- `docs/reports/latest-report.md` (unless explicitly tasked to update)

---

## H2 closeout (recorded)

- Codex: **PASS WITH NOTES** — no required fixes.
- Tech Lead: **APPROVED** — commit authorized.
- Deferred (not H2 blockers): Admin UI for manual-review resolution; multi-device propagation; completed-transfer queue-first reversal.
