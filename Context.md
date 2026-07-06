# Twinpet POS — Project Context

> Last reconciled: 2026-07-06
> HEAD: `8449e98ebb34ea1eff14854aa3e71980c68cbfbf`
> origin/main: `8449e98ebb34ea1eff14854aa3e71980c68cbfbf`

---

## Current Phase

**UI-10-C — Cart / Inventory Numpad Adapters (test-only hardening): CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### UI-10-C pushed commit

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
| UI-10-B PaymentModal migration | `fac83d2` + docs `8bc2875` | CLOSED / PUSHED |
| UI-10-A primitive | `bc76e1e` + docs `df5fd87` | CLOSED / PUSHED |
| UI-09 PaymentModal | `9573abb` + docs chain | CLOSED |

### Deferred / cancelled (not active)

- **Printer / Thermal Receipt / Print Polish** — cancelled/deferred; legacy thermal/print code untouched
- **UI-10-D** — NOT STARTED; no implementation authorized

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
