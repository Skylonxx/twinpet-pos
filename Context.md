# Twinpet POS — Project Context

> Last reconciled: 2026-07-06
> HEAD: `ffa433ccdf8fb570632658ab93dac0b737dc7a11`
> origin/main: `ffa433ccdf8fb570632658ab93dac0b737dc7a11`

---

## Current Phase

**UI-11 — Manager Approval Modal Primitive / Packet 1: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### UI-11 Packet 1 pushed commit

| Hash | Message |
|------|---------|
| `ffa433c` | feat(ui): add manager approval modal primitive |

### UI-11 Packet 1 scope

- Created exactly 3 new files: `src/components/pos/ManagerPinModal.tsx`, `src/components/pos/ManagerPinModal.css`, `src/components/pos/ManagerPinModal.test.ts`
- No tracked file modified; no wiring into any consumer

### UI-11 Packet 1 architecture

- `ManagerPinModal` is an isolated presentational shell — a **Manager Approval Modal Primitive / Manager Action Confirmation Shell**
- Callback-driven: `onSubmitPin(pin)` forwards entered digits to a caller-owned verifier
- Collects touch-entered digits into a local, transient, masked buffer
- Performs **no** PIN verification, stores **no** PIN source, executes **no** protected action
- Is **not** a security boundary; does not authorize, authenticate, verify, or secure actions by itself
- Is **not** wired into `POSPage`
- Preserves the zero-virtual-keyboard touch standard: no editable `<input>`/`<textarea>` in the PIN entry path — non-editable masked dot display plus button keypad only, avoiding the iPad/iOS virtual keyboard trigger pattern

### UI-11 Packet 1 hard stops / deferred scope

- Real PIN verification — unimplemented
- Protected-action execution — unimplemented
- `POSPage` wiring — unimplemented
- Packet 2 — separate and **not authorized**
- Backend/Security verifier (Cloud Function, Firestore lookup, stored/hashed PIN, security rules, Firebase/functions/rules/config changes) — separate Gemini authorization gate; hard stop
- No checkout/cart/payment/inventory change
- No `SharedNumpad`/`NumpadDialog`/`PaymentModal`/`ItemDiscountModal`/`useAuth` change
- UI-10-D remains excluded
- Printer/Thermal remains cancelled/deferred

### Validation (UI-11 Packet 1)

- Codex re-review (post build-fix): PASS
- `npm run build`: PASS
- `ManagerPinModal.test.ts`: 26/26
- `POSPage.keyboard-contract.test.ts`: 168/168 (unchanged)
- `SharedNumpad.contract.test.ts`: 19/19 (unchanged)
- Working tree clean after push; staged files clean; stash untouched

### Prior phase — UI-10-C pushed commit

| Hash | Message |
|------|---------|
| `8449e98` | test(pos): harden numpad dialog keyboard contract |

### UI-10-C scope

Test-only hardening, not a runtime migration.

- Modified exactly one file: `src/pages/POSPage.keyboard-contract.test.ts`
- Added source-level contract hardening for `NumpadDialog`
- Runtime unchanged: `SharedNumpad`, `NumpadDialog`, `ItemDiscountModal`, `POSPage.tsx`, `PaymentModal` all untouched
- Inventory-side numpad usage deferred — no inventory numpad exists in inspected scope

### Architecture decision — Route C + D

- **Route C:** leave `NumpadDialog` runtime unchanged; add test-only contract hardening instead of migrating it to `SharedNumpad`
- **Route D:** defer inventory-side numpad adoption because no inventory numpad exists in inspected scope

### Why NumpadDialog was not migrated to SharedNumpad in UI-10-C

- `SharedNumpad` lacks a `grid-3x4-decimal` layout
- `NumpadDialog`'s decimal layout requires a `. 0 ⌫` row
- `NumpadDialog` uses the Tabler `ti-backspace` icon; `SharedNumpad` renders a literal `⌫` character
- Fixing parity would require changes to the `SharedNumpad` primitive itself and risks regressing `PaymentModal` (UI-10-B consumer)

### Validation (UI-10-C)

- Codex implementation review: PASS WITH NOTES
- `npm run build`: PASS
- `POSPage.keyboard-contract.test.ts` + `SharedNumpad.contract.test.ts` combined: 187/187
- POSPage keyboard contract: 168/168
- SharedNumpad contract: 19/19 (unchanged)
- Working tree clean after push; staged files clean; stash untouched

### Prior phase — UI-10-B pushed commit

| Hash | Message |
|------|---------|
| `fac83d2` | feat(pos): migrate payment keypad to shared numpad |

### UI-10-B scope

- Migrated PaymentModal keypad rendering to `SharedNumpad`
- `SharedNumpad` props: `layout="grid-4x5-payment"`, `classPrefix="pay-keypad"`, `onKey={handleNumpad}`, `disabled={!entryEnabled}`, `accessories={keypadAccessories}`
- PaymentModal remains owner of payment state and logic
- Updated `SharedNumpad.contract.test.ts` importer contract
- Updated `POSPage.keyboard-contract.test.ts` source assertions

**Modified:** `PaymentModal.tsx`, `SharedNumpad.contract.test.ts`, `POSPage.keyboard-contract.test.ts`

**Untouched:** `PaymentModal.css`, `SharedNumpad.tsx`, `SharedNumpad.css`, `POSPage.tsx`, checkout/cart/Firebase paths.

### Architecture lock (unchanged)

`SharedNumpad` remains stateless/presentational — no payment state, parse/format, confirm/submit, keyboard/global listeners, or checkout/cart/Firebase logic.

`PaymentModal` retains: `activeMethod`, `amounts`, `entry`, `setMethodAmount`, `paidTotal`, `remaining`/`change`, credit gating/`entryEnabled`, `canConfirm`, `handleConfirm`, double-submit guard, confirm button, `paymentSource`/`onConfirm` routing, formatting/parsing, method routing, `addShortcut`, `applyRemaining`.

### Accepted UI-10-B deltas

- Clear `C` aria-label parity delta — accepted
- Native tab/accessory DOM-order delta — accepted if observed
- Exact aria parity, if desired later, must be a separate SharedNumpad primitive packet — not an active blocker

### Validation (UI-10-B)

- Codex blueprint review: PASS WITH NOTES
- Codex implementation review: PASS WITH NOTES
- `npm run build`: PASS
- SharedNumpad contract tests: PASS
- POSPage keyboard contract (implementation review): 159/159
- Final combined pre-commit tests: 178/178
- Working tree clean after push; staged files clean; stash untouched

### Prior phases (closed)

| Phase | Commit | Status |
|-------|--------|--------|
| UI-10-C numpad hardening | `8449e98` + docs `62be589` | CLOSED / PUSHED |
| UI-10-B PaymentModal migration | `fac83d2` + docs `8bc2875` | CLOSED / PUSHED |
| UI-10-A primitive | `bc76e1e` + docs `df5fd87` | CLOSED / PUSHED |
| UI-09 PaymentModal | `9573abb` + docs chain | CLOSED |

### Deferred / cancelled (not active)

- **Printer / Thermal Receipt / Print Polish** — cancelled/deferred; legacy thermal/print code untouched
- **UI-10-D** — NOT STARTED; no implementation authorized
- **UI-11 Packet 2** (real PIN verification, `POSPage` wiring, backend/security verifier) — NOT STARTED; requires separate Gemini authorization

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
