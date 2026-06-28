# Phase 7C POS UI Master Plan

This file is the source of truth for Phase 7C POS UI refactoring scope and sequence.

**Current HEAD:** `f0c783c docs: close ui-09-b checkout button uat`

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
11. UI-09-C: Payment Modal / Payment Flow planning - [NEXT CANDIDATE — NOT STARTED; planning/audit only; **NOT authorized for implementation**]

---

## Future Backlog

12. UI-10: Security and RBAC: Manager PIN Authorization Overlay - [FUTURE BACKLOG]

Scope:
- Numeric PIN pad modal for restricted actions (e.g. Price Override).
- When a Staff user attempts a restricted action, a Manager PIN prompt appears.
- Manager enters PIN to authorize only that specific action.
- Authorization is temporary and action-scoped.
- Main cashier session remains unchanged; no full logout/login required.
- Does not change main authentication state.
- Restricted actions include Price Override and future high-risk cashier actions as defined by Tech Lead / CEO.

Non-goals (this backlog entry only records the requirement):
- No implementation until a separate Tech Lead / CEO authorization is issued.
- No auth/session change now.
- No Firebase/rules change now.
- No PIN storage design until a future security phase defines it.

Status: Future backlog. Not current. Requires separate Tech Lead / CEO authorization before implementation begins.

---

## UI-09-C Gate (current)

- **Next candidate:** Payment Modal / Payment Flow planning/audit
- **NOT STARTED**
- **NOT authorized for implementation**
- Red zones: PaymentModal, payment calculation, checkout/order write paths, global Enter-confirm behavior
- Requires Gemini authorization for read-only planning phase first

---

## Rules

- Future Phase 7C UI work must align with this file and `docs/UI_MASTER_PLAN.md`.
- Do not skip, rename, or broaden items without Tech Lead / CEO authorization.
- AGY visual review is required for UI-facing changes before Codex unless explicitly waived by CEO.
- No work beyond the current authorized item is permitted by this file alone.
- agentchattr is transport only; Twinpet workflow docs and Gemini/Owner authority govern.
- `stash@{0}` must not be touched.
