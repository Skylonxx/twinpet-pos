# Phase 7C POS UI Master Plan

**Current HEAD:** `fac83d2898606f101b966d8c51e1cab3f133a801` (verified; UI-10-B pushed; docs reconciliation separate pass)

1. UI-01 through UI-09-M — [DONE]
2. UI-10-A: SharedNumpad primitive - [DONE] — CLOSED / PUSHED at `bc76e1e` + docs `df5fd87`
3. UI-10-B: PaymentModal SharedNumpad migration - [DONE] — **CLOSED / PUSHED** at `fac83d2` (PASS WITH NOTES)

---

## UI-10-C (not started)

No implementation authorized. Requires Gemini explicit authorization.

---

## Future Backlog (deferred)

- Manager PIN Authorization Overlay — separate from UI-10 track; requires Tech Lead authorization
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
- UI-10-C requires separate Gemini authorization.
