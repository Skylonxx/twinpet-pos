# Twinpet POS — Project Context

> Last reconciled: 2026-07-06
> HEAD: `3fe056e6162115a9593c8e58a9d8eb79fb15513e`
> origin/main: `3fe056e6162115a9593c8e58a9d8eb79fb15513e`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 1 Sale Intent Journal: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 1 pushed commit

| Hash | Message |
|------|---------|
| `3fe056e` | feat(pos): add sale intent journal sidecar |

### P1 Packet 1 scope

Created exactly 7 new files under `src/lib/pos/offline/`:

- `saleIntentJournalTypes.ts`
- `saleIntentJournalStore.ts`
- `saleIntentJournalLogic.ts`
- `saleIntentJournal.ts`
- `saleIntentJournalLogic.test.ts`
- `saleIntentJournalStore.test.ts`
- `saleIntentJournalMigration.test.ts`

No tracked file modified at implementation time; no production importers; zero runtime checkout wiring.

### P1 Packet 1 architecture

- IndexedDB Sale Intent Journal sidecar — durability and observability layer only
- Mirrors caller-supplied `asyncOrders/{deviceId-seq}` identity (`asyncOrderId` / `localQueueId` / `idempotencyKey` aliases)
- Does **not** replace `asyncOrders`, allocate sale/receipt IDs, settle payments, cut stock, or become a transport queue
- Event details sanitized; `redacted` payload policy strips customer PII; full payload retained only while unresolved

### P1 Packet 1 hard stops / deferred scope

- **Packet 2 checkout wiring** — not authorized; separate Gemini gate + Codex review required
- **Sequence hardening** — separate future packet/gate
- **Rejected-write reproduction / UAT** — future or parallel evidence gate before Packet 2 finalization
- POSPage / asyncCheckout / submitAsyncOrder / useCheckout / PaymentModal — untouched
- Firebase/functions/rules, package/config, UI/CSS, printer/thermal, platform — untouched

### Validation (P1 Packet 1)

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| `saleIntentJournalMigration.test.ts` | 5/5 |
| `reversalLocalStore.migration.test.ts` | 3/3 |
| `offlineReversalQueue.test.ts` | 31/31 |
| `git diff --check` | PASS |
| Codex implementation review (fix pass) | PASS |
| Codex post-commit review | PASS WITH NOTES |
| Push | PASS — HEAD == origin/main == `3fe056e` |

### Prior phase — UI-11 Packet 1

| Hash | Message |
|------|---------|
| `ffa433c` | feat(ui): add manager approval modal primitive |
| `cfc644c` | docs: reconcile ui-11 packet 1 closure |

Isolated presentational `ManagerPinModal` primitive — CLOSED / PUSHED. Packet 2 not authorized.

### Prior phase — UI-10-C

| Hash | Message |
|------|---------|
| `8449e98` | test(pos): harden numpad dialog keyboard contract |

Test-only `NumpadDialog` contract hardening — CLOSED / PUSHED.

### Deferred / cancelled (not active)

- **Printer / Thermal Receipt / Print Polish** — cancelled/deferred
- **UI-10-D** — NOT STARTED
- **UI-11 Packet 2** — NOT STARTED
- **P1 Packet 2 checkout wiring** — NOT STARTED

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
