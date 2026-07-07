# Twinpet POS — Project Context

> Last reconciled: 2026-07-07
> HEAD: `cde82264f3c54bb7819f5bcd2beb9e8669f5cc60`
> origin/main: `cde82264f3c54bb7819f5bcd2beb9e8669f5cc60`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 3A-2B Startup Sweep Boot Wiring: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 3A-2B pushed commit

| Hash | Message |
|------|---------|
| `cde8226` | feat(pos): add startup sale intent sweep wiring |

### P1 Packet 3A-2B scope (3 files)

- `src/components/AppShell.tsx` — mount `useSaleIntentSweepBoot()`
- `src/lib/pos/offline/saleIntentSweepBoot.ts` — boot wiring module
- `src/lib/pos/offline/saleIntentSweepBoot.test.ts`

### P1 Packet 3A-2B behavior

- AppShell-mounted startup Sale Intent sweep boot wiring (resolves Codex N1 via AppShell mount)
- 10-second fixed delayed background attempt after AppShell mount
- Fire-and-forget execution; silent no-op on skip paths; fail-open on errors
- Once-per-tab guard; Web Locks `ifAvailable` single-flight; unsupported Web Locks falls back to idempotent runner
- Composes existing public APIs only: `createAsyncOrderServerLookup`, `createSaleIntentJournal`, `runSaleIntentSweep`, cached `getIdTokenResult`
- Cached `getIdTokenResult` `staffId` gate
- No UI state / toast / loader / layout / route / sidebar / style change
- No checkout / payment / stock / drawer mutation; no direct Firestore write; no asyncOrder payload read; no `snap.data()`; no transition matrix change

### Physical UAT

Gemini confirmed Physical UAT passed before commit authorization:

- Safe background execution verified
- Silent failure verified
- Pre-existing UI state bugs in old offline queue acknowledged and **deferred — not fixed**

### Prior — Packet 3A-2A Lookup Adapter

| Hash | Message |
|------|---------|
| `535073e` | feat(pos): add async order server lookup adapter |
| `944acfc` | docs: reconcile p1 offline sync packet 3a-2a closure |

### Validation (P1 Packet 3A-2B)

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `saleIntentSweepBoot.test.ts` | 22/22 |
| `asyncOrderLookup.test.ts` | 13/13 |
| `saleIntentSweepLogic.test.ts` | 29/29 |
| `saleIntentSweep.test.ts` | 15/15 |
| `asyncCheckout.w01.test.ts` | 12/12 |
| `saleIntentObserver.test.ts` | 9/9 |
| `saleIntentJournalLogic.test.ts` | 32/32 |
| `saleIntentJournalStore.test.ts` | 18/18 |
| Vitest subtotal | 150/150 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS (CRLF advisory only) |
| Codex implementation review | PASS WITH NOTES (no source blockers; UAT gate cleared by Gemini) |
| Push | PASS — HEAD == origin/main == `cde8226` |

### Deferred / next gate

**Next Packet Decision Gate** — Gemini may choose among:

- Packet 3A-2C / closure hardening (if still needed)
- Packet 3B sequence hardening
- Packet 3C `rejected_by_rules` operational policy
- hold

**Deferred (not fixed):** Pre-existing old offline queue UI state bugs.

### Other deferred

- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Printer / Thermal** — cancelled/deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
- Old offline queue UI state bugs — deferred (acknowledged at 3A-2B UAT)
