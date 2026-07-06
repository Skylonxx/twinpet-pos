# Phase 7C POS UI Master Plan

This file is the source of truth for Phase 7C POS UI refactoring scope and sequence.

**Current HEAD:** `bc76e1ea20614ead114c7446aea4bf10b0f27deb` (verified; UI-10-A pushed; docs reconciliation separate pass)

1. UI-01: โครงสร้างเลย์เอาต์หลัก (Main POS Layout) - [DONE]
2. UI-02: ช่องค้นหาและบาร์โค้ด (Search & Scanner Input) - [DONE]
3. UI-03: หมวดหมู่สินค้าและเมนูด่วน (Categories & Quick Menu) - [DONE]
4. UI-04: การ์ดสินค้า (Product Grid Cards) - [DONE]
5. UI-05: แผงตะกร้าสินค้า (Cart Container) - [DONE]
6. UI-06: รายการสินค้าในตะกร้า (Cart Item Rows) - [DONE]
7. UI-07: ส่วนสรุปยอดและส่วนลด (Cart Summary) - [DONE]
8. UI-08: แผงปุ่มจัดการบิล (Action Buttons) - [DONE] — CLOSED / PASSED UAT (`873997e`)
9. UI-09-A: Checkout boundary read-only audit - [DONE]
10. UI-09-B: ปุ่มชำระเงิน visual polish (Checkout Button) - [DONE] — CLOSED / PASSED UAT (`baca4fe`, closure `f0c783c`)
11. UI-09-C: Payment Modal UX Hardening - [DONE] — COMPLETED (PASS WITH NOTES) at `de2de43`
12. UI-09-M: Payment Modal layout corrective pass - [DONE] — CLOSED (PASS WITH NOTES) at `9573abb`
13. UI-10-A: SharedNumpad primitive - [DONE] — **CLOSED / PUSHED** at `bc76e1e` (PASS WITH NOTES)

---

## UI-10-B (not started)

Likely: PaymentModal keypad migration onto SharedNumpad.

- **NOT STARTED** — no implementation authorized
- Must preserve PaymentModal-owned state/routing/confirm/keyboard contract
- Codex carry-forward: `classPrefix` `pay-keypad` regression; do not weaken keyboard-contract tests; inventory usage parent-owned

---

## Future Backlog (deferred)

14. Manager PIN Authorization Overlay — [FUTURE BACKLOG / DEFERRED]

Numeric PIN pad modal for restricted actions (e.g. Price Override). Separate from UI-10 SharedNumpad track. Requires Tech Lead / CEO authorization.

Printer / Thermal Receipt / Print Polish — **cancelled/deferred**; not active unless Owner explicitly revives with Gemini.

---

## UI-10-A Gate (closed)

- **Status:** CLOSED / PUSHED (PASS WITH NOTES)
- Implementation: `bc76e1e feat(ui): add shared numpad primitive`
- Stateless primitive + namespaced CSS + contract tests only
- No production import; no barrel export; PaymentModal/NumpadDialog/POSPage untouched
- Architecture B: stateless primitive + caller-side adapters

---

## UI-09-M Gate (closed)

- **Status:** CLOSED (PASS WITH NOTES)
- Implementation: `9573abb fix(pos): refine payment modal layout balance`

---

## UI-09-C Gate (closed)

- **Status:** COMPLETED (PASS WITH NOTES)
- Focus trap not implemented — see backlog below

---

## [TECHNICAL DEBT & ACCESSIBILITY BACKLOG]

- Item: Missing PaymentModal Focus Trap
- Context: Denied during UI-09-C pass due to strict constraints within the pre-existing global keyboard contract tests.
- Status: Open / Deferred Follow-up
- Source Phase: UI-09-C PaymentModal UX Hardening

---

## Rules

- Future Phase 7C UI work must align with this file and `docs/UI_MASTER_PLAN.md`.
- `stash@{0}` must not be touched.
- UI-10-B requires separate Gemini authorization before implementation.
