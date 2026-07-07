# Twinpet POS — Project Context

> Last reconciled: 2026-07-07
> HEAD: `d500bf99282f8edd8322ecc6f2b5e81e2b451a3d`
> origin/main: `d500bf99282f8edd8322ecc6f2b5e81e2b451a3d`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 2 Runtime Observer: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 2 pushed commits

| Hash | Message |
|------|---------|
| `d500bf9` | feat(pos): add sale intent observer wiring |
| `e3155ad` | test(pos): add w01 rejected write evidence harness |

### P1 Packet 2 scope

Modified 3 files; created 2 new files:

- `src/lib/pos/asyncCheckout.ts` — raw Firestore `setDoc` promise captured before catch transformation; passed to `saleIntentObserver`
- `src/hooks/pos/useCheckout.ts` — observer wiring hook integration
- `src/lib/pos/asyncCheckout.w01.test.ts` — W-01 deterministic rejected-write evidence harness
- `src/lib/pos/offline/saleIntentObserver.ts` — new runtime observer
- `src/lib/pos/offline/saleIntentObserver.test.ts` — new observer tests

### P1 Packet 2 runtime behavior

- Raw Firestore `setDoc` promise captured before catch transformation
- Raw promise passed to `saleIntentObserver` for lifecycle observation
- `permission-denied` / terminal rule rejection → `rejected_by_rules`
- Server resolution → `server_acknowledged`
- Non-rule write/observer exception → `exception_observed`
- Sale Intent Journal remains sidecar-only (not source of truth)
- Cashier-visible `submitAsyncOrder` return flow remains non-blocking
- Observer does not retry or resend writes
- `server_acknowledged` records server resolution on the raw promise — does not mean checkout was accepted before raw promise resolves
- `POSPage.tsx` and `PaymentModal.tsx` — untouched
- Firebase/functions/rules, package/config, UI/CSS, printer/thermal, platform — untouched

### P1 Packet 1 pushed commit (prerequisite)

| Hash | Message |
|------|---------|
| `3fe056e` | feat(pos): add sale intent journal sidecar |

7 new files under `src/lib/pos/offline/saleIntentJournal*` — sidecar durability/observability only; no production importers at Packet 1 time.

### Validation (P1 Packet 2)

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `asyncCheckout.w01.test.ts` | 12/12 |
| `saleIntentObserver.test.ts` | 9/9 |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS |
| Codex review | PASS WITH NOTES (no blockers) |
| Push | PASS — HEAD == origin/main == `d500bf9` |

**Codex non-blocking note:** Developer report cited 10 observer tests; Codex observed 9 — coverage accepted.

### Deferred / next gate

- **P1 Packet 3** — NOT STARTED; requires separate Gemini authorization
  - Suggested topics: startup/lifecycle reconcile sweep; tab-close/reload recovery for incomplete journal lifecycle; sequence hardening / `nextLocalSeq` race; manual review / `rejected_by_rules` operational policy (if Gemini chooses)
- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Printer / Thermal Receipt / Print Polish** — cancelled/deferred

### Prior phase — UI-11 Packet 1

| Hash | Message |
|------|---------|
| `ffa433c` | feat(ui): add manager approval modal primitive |
| `cfc644c` | docs: reconcile ui-11 packet 1 closure |

Isolated presentational `ManagerPinModal` primitive — CLOSED / PUSHED.

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
