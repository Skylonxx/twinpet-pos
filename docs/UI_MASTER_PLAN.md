# UI MASTER PLAN

## Current Baseline

| Field | Value |
|-------|-------|
| HEAD (verified) | `bc76e1ea20614ead114c7446aea4bf10b0f27deb` |
| origin/main | `bc76e1ea20614ead114c7446aea4bf10b0f27deb` |
| Ahead/behind | `0 / 0` |
| Closure | UI-10-A SharedNumpad primitive **CLOSED / PUSHED** at `bc76e1e`; UI-10-A docs reconciliation separate pass |

## Recently Completed / Committed UI Work

All commits below verified in `git log --oneline -n 40` at HEAD `bc76e1e`.

### POS Cashier UX & Cart

| Hash | Description |
|------|-------------|
| `bc76e1e` | **UI-10-A** — SharedNumpad primitive — CLOSED / PUSHED |
| `a573a29` | **UI-09 final closure** — docs close ui-09 + hold-bill TS6133 fix — CLOSED / PUSHED |
| `62cb3d2` | **UI-09 docs closure** — reconcile ui-09-m payment modal closure |
| `9573abb` | **UI-09-M** — PaymentModal layout balance corrective — PUSHED (PASS WITH NOTES) |
| `de2de43` | **UI-09-C** — PaymentModal UX Hardening — COMPLETED (PASS WITH NOTES) |
| `f0c783c` | **UI-09-B closure docs** — committed |
| `baca4fe` | **UI-09-B** — Polish checkout button hierarchy — CLOSED / PASSED UAT |
| `889e23a` | Make suspended bill IDs LAN-safe |
| `602acea` | Restore hold bill modal flow with DOM coverage |
| `287955e` | Add suspended bill hold/restore contract tests |
| `873997e` | **UI-08** — Polish action button hierarchy — CLOSED / PASSED UAT |
| `8a4ce19` | Polish cart summary layout and resolve responsive constraints |
| `630b742` | Polish cart item row readability |
| `521961f` | Refine seamless split cart layout |
| `3b6b8ed` | Add bump flash feedback for rescanned cart items |
| `c3f7193` | Bump rescanned cart line to top |
| `1e83473` | Stabilize product grid scrollbar gutter |
| `667093e` | Add UI layout preferences and realistic local seed |

### Product Grid & Category

| Hash | Description |
|------|-------------|
| `06bc831` | Add product card display preferences |
| `3b3b909` | Replace category modal with dropdown |
| `d13a9a1` | Restore modal header icons and simplify buttons |
| `b04f303` | Sync categories and refine cashier macro layout |

### Discount & Item Options

| Hash | Description |
|------|-------------|
| `85b3a31` | Add per-unit item discount option |
| `1a68983` | Repair discount badge and numpad touch behavior |
| `ab7eceb` | Stabilize discount modal draft state |

### Toast & Feedback

| Hash | Description |
|------|-------------|
| `f9d11ec` | Polish toast feedback and typography (UI-12 + UI-13 combined) |

### Stock Validation

| Hash | Description |
|------|-------------|
| `29995ea` | Enforce stock oversell matrix (3-tier: strict block / warn / silent) |

### Scanner & Focus

| Hash | Description |
|------|-------------|
| `ce49a82` | Polish refresh update state and focus recovery |
| `023cc8d` | Recover scanner focus across cashier actions |
| `42ff3ed` | Restore scanner focus after cashier actions |
| `bb9b1ad` | Refine search and barcode action bar |

### Prior Committed Work (at or before `07ed7c8`)

See Context.md for the full Phase 7B/7C history including:
- Phase 7B-H series (offline reversal lifecycle) — CLOSED / COMMITTED
- Phase 7C keyboard/focus/IME suite (D4-C-1..4) — CLOSED / COMMITTED
- Phase 7C-L1/L2/L3 (logic fixes + UOM display) — CLOSED / COMMITTED
- Phase 7C-UI-10-B/C (best seller system + strict local search) — CLOSED / COMMITTED
- Phase 7C-POS-Stock-Matrix (3-tier oversell control) — CLOSED / COMMITTED (`29995ea`)
- Phase 7C-UI-12/13 (toast system rebuild) — CLOSED / COMMITTED (`f9d11ec`)
- Phase 7C-UI-01 (layout, preferences, seed) — CLOSED / COMMITTED (`667093e`)

## UI-09-B Status

**CLOSED / PASSED UAT**

| Field | Value |
|-------|-------|
| Formal scope | Checkout Button Visual Polish / `VISUAL_ONLY` |
| Implementation | `baca4fe style(pos): polish checkout button hierarchy` |
| Closure docs | `f0c783c docs: close ui-09-b checkout button uat` |
| Source impact | `src/pages/POSPage.css` only |
| Behavior impact | none |
| Physical UAT | **PASSED** — Owner feedback: **เทสแล้วผ่านครับ** |
| Codex review | PASS WITH NOTES / READY |
| Keyboard contract test | 145 passed |
| Closure phase | **COMMITTED** at `f0c783c` |

**Untouched:** `src/pages/POSPage.tsx`, PaymentModal, confirmSale, submitAsyncOrder, cart math, F12 keyboard behavior, checkout disabled gate, checkout click behavior, payment/order write path, stock/FIFO, hold/suspended bill, shift/cash drawer, scanner flow.

## UI-09-A Status

**CLOSED (read-only audit)**

- Checkout boundary audit completed at HEAD `2e24389` (2026-06-23)
- Report: `C:\Users\Narachat\OneDrive\Ai-Report\claude\twinpet-pos-ui-09-a-checkout-boundary-audit-report.md`
- No implementation performed

## UI-08 Status

**CLOSED / PASSED UAT**

| Field | Value |
|-------|-------|
| Formal scope | Action Buttons / แผงปุ่มจัดการบิล (`.pos-topbar-actions` shift controls) |
| Implementation | `873997e style(pos): polish action button hierarchy` |
| Physical UAT | **PASSED** — Owner feedback: **ใช้ได้ดี** |

**Scope note:** The older P1 triage item "Offline/Sync relocation to AppShell header" (`docs/reports/phase-7c-p1-ui-polish-backlog-triage.md`) is **not** UI-08. It remains a separate deferred backlog item.

## UI-10-A Status

**CLOSED / PUSHED (PASS WITH NOTES)**

| Field | Value |
|-------|-------|
| Scope | Stateless SharedNumpad primitive |
| Implementation | `bc76e1e feat(ui): add shared numpad primitive` |
| Source impact | `SharedNumpad.tsx`, `SharedNumpad.css`, `SharedNumpad.contract.test.ts` |
| Production usage | none — no import, no barrel export |
| Codex review | PASS WITH NOTES |
| `npm run build` | PASS |
| Contract tests | 19/19 |
| Keyboard contract | 145/145 |

**Untouched:** PaymentModal, NumpadDialog, POSPage.

**Architecture B:** stateless primitive + caller-side adapters. PaymentModal retains `activeMethod`, `amounts`, `entry`, `setMethodAmount`, `paidTotal`, `remaining`, credit gating, `canConfirm`, `handleConfirm`.

## UI-10-B Status (not started)

Likely: PaymentModal keypad migration onto SharedNumpad. No implementation authorized. Codex carry-forward: `pay-keypad` classPrefix regression; preserve keyboard-contract tests; inventory usage parent-owned.

## UI-09-M Status

**CLOSED (PASS WITH NOTES)**

| Field | Value |
|-------|-------|
| Formal scope | PaymentModal layout balance corrective pass |
| Implementation | `9573abb fix(pos): refine payment modal layout balance` |
| Source impact | `src/components/PaymentModal.tsx`, `src/components/PaymentModal.css` only |
| Codex commit audit | PASS WITH NOTES |
| Keyboard contract test | 145/145 passed (at UI-09-M closure) |
| Build | TS6133 unused `within` fixed in pushed cleanup commit `a573a29`; `npm run build` **PASS** |

**Delivered:** summary sidebar capped 290px desktop; mobile summary full-width fix; ledger flush-right; receipt typography; active breakdown card; full-width confirm in sidebar; center panel/numpad absorbs freed width.

**Untouched:** `POSPage.tsx`, checkout hooks, async checkout, cart utils, payment/checkout write paths, Firebase/functions/rules, keyboard/listener contract.

## UI-09 Final Closure + Build Debt (pushed)

| Field | Value |
|-------|-------|
| Implementation | `a573a29 docs: close ui-09 and fix hold-bill build debt` |
| Scope | 9 tracker docs + remove unused `within` in `POSPage.hold-bill-interaction.test.tsx` |
| TS6133 | **fixed** — unused `within` import removed |
| `npm run build` | **PASS** |
| Focused tests | **148/148** (hold-bill interaction + keyboard-contract) |
| Status | **CLOSED / PUSHED** on origin/main |

## UI-09-C Status

**COMPLETED (PASS WITH NOTES)** — committed `de2de43`

| Field | Value |
|-------|-------|
| Formal scope | PaymentModal UX Hardening — focus management, cash keyboard input, responsive CSS, ARIA, print notice |
| Source impact | `src/components/PaymentModal.tsx`, `src/components/PaymentModal.css` only |
| Codex review | PASS WITH NOTES |
| Focus trap | **Not implemented** — deferred as technical debt (see backlog below) |

**Untouched:** `src/pages/POSPage.tsx`, `useCheckout.ts`, `asyncCheckout.ts`, `cartUtils.ts` — payment/checkout semantics preserved.

## Deferred / Ambiguous Work

| Item | Status | Notes |
|------|--------|-------|
| UI-09-B | **CLOSED / PASSED UAT** | Checkout Button Visual Polish — `baca4fe` + Owner UAT |
| UI-09-A | **CLOSED** | Read-only checkout boundary audit |
| UI-08 | **CLOSED / PASSED UAT** | Action Buttons — `873997e` + Owner UAT |
| UI-09 final closure | **CLOSED / PUSHED** | `a573a29` — docs + TS6133 hold-bill fix |
| UI-09-C | **COMPLETED (PASS WITH NOTES)** | PaymentModal UX Hardening — `de2de43`; focus trap deferred |
| UI-09-M | **CLOSED (PASS WITH NOTES)** | PaymentModal layout corrective — `9573abb` |
| UI-10-A | **CLOSED / PUSHED** | SharedNumpad primitive — `bc76e1e` |
| UI-10-B | **NOT STARTED** | PaymentModal keypad migration (likely); needs Gemini authorization |
| Printer / Thermal | **CANCELLED/DEFERRED** | Not active unless Owner revives with Gemini |
| P1 Offline/Sync relocation | DEFERRED | Separate from UI-08; was P1 triage UI-08 numbering |
| Hardware scanner (iOS/iPad Safari) | DEFERRED | Native App / Capacitor wrapper phase |
| Flowbite migration (tables + modals) | DEFERRED | Batches 2+ deferred; stash@{0} holds WIP |
| Server sync / central audit (rejection logs) | FUTURE | Out of scope; local forensic panel (H7-G) is complete |

## Boundaries

- No implementation without explicit Tech Lead / CEO authorization
- No checkout/payment/cart math/stock math changes
- No Firebase/functions/rules changes
- stash@{0} must not be touched

## [TECHNICAL DEBT & ACCESSIBILITY BACKLOG]

- Item: Missing PaymentModal Focus Trap
- Context: Denied during UI-09-C pass due to strict constraints within the pre-existing global keyboard contract tests.
- Impact: Minor accessibility gap. Tab navigation can leak outside the active modal container.
- Remediation Strategy: Requires a future dedicated ticket to modify keyboard ownership globally at the POSPage or core modal-manager level rather than mutating PaymentModal.tsx locally.
- Status: Open / Deferred Follow-up
- Source Phase: UI-09-C PaymentModal UX Hardening
- Closure Note: UI-09-C closed as PASS WITH NOTES without local PaymentModal focus trap.

## Next Decision Gate

    UI_10_A_DOCS_RECONCILIATION

1. UI-10-A closed/pushed at `bc76e1e`; docs reconciliation in separate pass
2. Codex docs-only review → docs commit/push authorization
3. UI-10-B planning/implementation only after Gemini confirms
4. Printer/Thermal not active; PaymentModal/checkout red zones unchanged
