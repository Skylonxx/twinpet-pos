# Phase 7C POS UI Master Plan

This file is the source of truth for Phase 7C POS UI refactoring scope and sequence.

1. UI-01: โครงสร้างเลย์เอาต์หลัก (Main POS Layout) - [DONE]
2. UI-02: ช่องค้นหาและบาร์โค้ด (Search & Scanner Input) - [DONE]
3. UI-03: หมวดหมู่สินค้าและเมนูด่วน (Categories & Quick Menu) - [DONE]
4. UI-04: การ์ดสินค้า (Product Grid Cards) - [DONE]
5. UI-05: แผงตะกร้าสินค้า (Cart Container) - [DONE]
6. UI-06: รายการสินค้าในตะกร้า (Cart Item Rows) - [CURRENT]
7. UI-07: ส่วนสรุปยอดและส่วนลด (Cart Summary) - [PENDING]
8. UI-08: แผงปุ่มจัดการบิล (Action Buttons) - [PENDING]
9. UI-09: ปุ่มชำระเงิน (Checkout Button - F12) - [PENDING]

---

## Future Backlog

10. UI-10: Security and RBAC: Manager PIN Authorization Overlay - [FUTURE BACKLOG]

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
- No change to UI-07 / UI-08 / UI-09 scope.

Status: Future backlog. Not current. Requires separate Tech Lead / CEO authorization before implementation begins.

---

## Rules

- Future Phase 7C UI work must align with this file.
- Do not skip, rename, or broaden items without Tech Lead / CEO authorization.
- AGY visual review is required for UI-facing changes before Codex unless explicitly waived by CEO.
- No work beyond the current item is authorized by this file alone.
