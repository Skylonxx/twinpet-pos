# Next Action

## Current State

- HEAD (code): `7976e3eea64623961f1189b4f1acb91e9efce486` (P5-D-2 source event routing)
- **P1 Packet 5 / P5-D Deployment** — **`PACKET_5_P5_D_CLOSED` / LIVE** (P5-D = P5-D-1 + P5-D-2 only; no P5-D-3)
- **P5-D-1:** committed `4adb1d5`; `shiftCloseValidationSweep` live (`asia-southeast1`, `pos-db`, schedule `every 60 minutes`); 6/6 indexes READY; natural no-work invocation `casesProcessed: 0` observed
- **P5-D-2:** committed `7976e3e`; 4 routing triggers live (`asyncOrders/{orderId}`, `orders/{orderId}`, `cashTransactions/{txId}`, `creditPayments/{paymentId}`), v2 `onDocumentWritten`, `retry: true`; deploy-time observation only
- **P5-C Atomic Capture** — CLOSED / LIVE (`f5b697a` + `eda82dc`)
- **P5-B Pure Core** — CLOSED (`798b344`)
- **UI-11 Packet 2 / UI-10-D** — NOT STARTED

## What Happens Next

1. P5-D Deployment CLOSED (P5-D-1 sweep + P5-D-2 routing live; docs closure this pass reconciled trackers to production) — **DONE**
2. **Next: P5-E read-only architecture planning** (alerts + manager adjudication callable) — read-only planning authorized; **P5-E implementation NOT authorized**
3. **D5 disposition:** Option 2 — deferred into P5-E planning as a bracketed product/security decision (planner includes it; does not implement it)
4. **Passive observation** — read-only on natural traffic only is authorized in parallel
5. **NOT authorized:** P5-E implementation, P5-F, recapture callable, manual invocation, production/emulator data mutation, synthetic source events, Firestore index/rules deploy (unless separately authorized), deploy/runtime activation
6. Do not automatically start P5-E implementation or another packet

**Not active:** P5-E adjudication callable/UI, recapture callable, P5-F backfill, broad Packet 5 runtime beyond P5-D closure.

## Reminders

- `stash@{0}` — do not touch (`7d03cfec7ba52ff7e25b7e175ca190efc258d874`)
- P5-D functions are live but no production test mutation / synthetic events / manual invocation performed
- No `shifts.expected*` mutation; no FIFO/stock/credit/settlement writes
- P5-E implementation requires separate authorization — not implied by P5-D closure
- The full P5-C/P5-D pipeline has not yet processed a real shift close end-to-end
- G3 monitoring ownership for structural refusal logs remains unresolved
