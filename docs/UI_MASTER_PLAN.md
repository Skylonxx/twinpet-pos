# UI MASTER PLAN

## Current Baseline

| Field | Value |
|-------|-------|
| HEAD | `baca4fe style(pos): polish checkout button hierarchy` |
| origin/main | `baca4fe` |
| Ahead/behind | `0 / 0` |
| Closure | UI-09-B Physical UAT closure docs — in progress (2026-06-24) |

## Recently Completed / Committed UI Work

All commits below are physically verified in `git log --oneline -n 40` at HEAD `baca4fe`.

### POS Cashier UX & Cart

| Hash | Description |
|------|-------------|
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
| Source impact | `src/pages/POSPage.css` only |
| Behavior impact | none |
| Physical UAT | **PASSED** — Owner feedback: **เทสแล้วผ่านครับ** |
| Codex review | PASS WITH NOTES / READY |
| Keyboard contract test | 145 passed |
| Closure phase | `TWINPET-POS-UI-09-B-PHYSICAL-UAT-CLOSURE` |

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

## UI-09-C Status

**NEXT CANDIDATE — NOT STARTED**

- Scope: Payment Modal / Payment Flow planning
- Requires separate audit, Codex review, Gemini authorization, and strict payment write-path boundaries
- **Not authorized for implementation** in the UI-09-B closure task

## Deferred / Ambiguous Work

| Item | Status | Notes |
|------|--------|-------|
| UI-09-B | **CLOSED / PASSED UAT** | Checkout Button Visual Polish — `baca4fe` + Owner UAT |
| UI-09-A | **CLOSED** | Read-only checkout boundary audit |
| UI-08 | **CLOSED / PASSED UAT** | Action Buttons — `873997e` + Owner UAT |
| UI-09-C | NOT STARTED | Payment Modal / Payment Flow — next candidate; not authorized |
| P1 Offline/Sync relocation | DEFERRED | Separate from UI-08; was P1 triage UI-08 numbering |
| Hardware scanner (iOS/iPad Safari) | DEFERRED | Native App / Capacitor wrapper phase |
| Flowbite migration (tables + modals) | DEFERRED | Batches 2+ deferred; stash@{0} holds WIP |
| Server sync / central audit (rejection logs) | FUTURE | Out of scope; local forensic panel (H7-G) is complete |

## Boundaries

- No implementation without explicit Tech Lead / CEO authorization
- No checkout/payment/cart math/stock math changes
- No Firebase/functions/rules changes
- stash@{0} must not be touched

## Next Decision Gate

    READY_FOR_UI_09_B_CLOSURE_REVIEW

After UI-09-B closure docs are reviewed and committed:
1. Planning coordinator may evaluate UI-09-C (Payment Modal / Payment Flow) as next candidate
2. UI-09-C implementation requires separate Tech Lead / CEO authorization
