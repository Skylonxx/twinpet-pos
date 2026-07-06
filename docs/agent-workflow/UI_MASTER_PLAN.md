# Phase 7C POS UI Master Plan

**Current HEAD:** `ffa433ccdf8fb570632658ab93dac0b737dc7a11` (verified; UI-11 Packet 1 pushed; docs reconciliation separate pass)

1. UI-01 through UI-09-M — [DONE]
2. UI-10-A: SharedNumpad primitive - [DONE] — CLOSED / PUSHED at `bc76e1e` + docs `df5fd87`
3. UI-10-B: PaymentModal SharedNumpad migration - [DONE] — CLOSED / PUSHED at `fac83d2` + docs `8bc2875` (PASS WITH NOTES)
4. UI-10-C: Cart/Inventory Numpad Adapters (test-only hardening) - [DONE] — CLOSED / PUSHED at `8449e98` + docs `62be589` (PASS WITH NOTES)
5. UI-11 Packet 1: Manager Approval Modal Primitive (`ManagerPinModal`) - [DONE] — **CLOSED / PUSHED** at `ffa433c` (PASS)

---

## UI-11 Packet 1 Gate (closed)

- **Status:** CLOSED / PUSHED (PASS)
- Implementation: `ffa433c feat(ui): add manager approval modal primitive`
- Scope: isolated presentational Manager Approval Modal Primitive; source impact `ManagerPinModal.tsx/.css/.test.ts` only (all new files)
- Architecture: callback-driven (`onSubmitPin(pin)`) forwarding digits to a caller-owned verifier; local transient masked buffer; not a security boundary; no PIN verification; no protected-action execution; not wired into `POSPage`
- OS keyboard standard: no editable input/textarea in PIN entry path; non-editable masked dot display + button keypad only
- Untouched: `POSPage.tsx`, `SharedNumpad`, `NumpadDialog`, `PaymentModal`, `ItemDiscountModal`, `useAuth`/RBAC, checkout/cart/payment/inventory, Firebase/functions/rules/config
- Hard stops: real PIN verification, protected-action execution, `POSPage` wiring, Packet 2, backend/security verifier — all separate Gemini authorization gates
- Tests: `ManagerPinModal.test.ts` 26/26; POSPage keyboard contract 168/168 (unchanged); SharedNumpad contract 19/19 (unchanged)

## UI-11 Packet 2 (not started)

Real PIN verification, `POSPage` wiring, backend/security verifier. Requires separate Gemini explicit authorization. Not automatically next after Packet 1.

---

## UI-10-C Gate (closed)

- **Status:** CLOSED / PUSHED (PASS WITH NOTES)
- Implementation: `8449e98 test(pos): harden numpad dialog keyboard contract`
- Scope: test-only contract hardening for `NumpadDialog`; source impact `POSPage.keyboard-contract.test.ts` only
- Architecture decision: Route C (leave `NumpadDialog` runtime unchanged) + Route D (defer inventory-side numpad — none exists in inspected scope)
- Migration blockers: `SharedNumpad` lacks `grid-3x4-decimal`; `NumpadDialog` needs `. 0 ⌫` row + Tabler `ti-backspace` icon vs. `SharedNumpad`'s literal `⌫`; fixing parity risks `PaymentModal` (UI-10-B consumer)
- Untouched: `SharedNumpad.tsx/css`, `NumpadDialog.tsx/css`, `ItemDiscountModal`, `POSPage.tsx`, `PaymentModal`
- Tests: 187/187 combined; POSPage keyboard contract 168/168; SharedNumpad contract 19/19 (unchanged)

---

## UI-10-D (not started)

No implementation authorized. Requires Gemini explicit authorization.

---

## Future Backlog (deferred)

- Manager PIN Authorization Overlay — Packet 1 primitive (`ManagerPinModal`) CLOSED / PUSHED at `ffa433c`; Packet 2 (real verification + `POSPage` wiring) separate from UI-10 track, requires Tech Lead authorization
- Printer / Thermal Receipt / Print Polish — **cancelled/deferred** unless Owner revives with Gemini

---

## UI-10-B Gate (closed)

- **Status:** CLOSED / PUSHED (PASS WITH NOTES)
- Implementation: `fac83d2 feat(pos): migrate payment keypad to shared numpad`
- SharedNumpad: `grid-4x5-payment`, `pay-keypad`, caller-owned `onKey`/`disabled`/`accessories`
- PaymentModal retains all payment state/logic/confirm ownership
- Untouched: `PaymentModal.css`, `SharedNumpad.tsx/css`, `POSPage.tsx`
- Accepted deltas: clear `C` aria-label parity; tab/accessory DOM-order — not active blockers

---

## UI-10-A Gate (closed)

- **Status:** CLOSED / PUSHED at `bc76e1e` + docs `df5fd87`
- Stateless primitive + contract tests

---

## Architecture Lock

SharedNumpad: stateless, no payment state, no parse/format, no confirm/submit, no keyboard/global listeners, no checkout/cart/Firebase logic.

PaymentModal: owns `activeMethod`, amounts, entry, confirm, routing, formatting, shortcuts.

---

## Rules

- `stash@{0}` must not be touched.
- UI-10-D requires separate Gemini authorization.
- UI-11 Packet 2 (real PIN verification, `POSPage` wiring, backend/security verifier) requires separate Gemini authorization; not automatically next after Packet 1.
