# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-19
> HEAD: `7976e3eea64623961f1189b4f1acb91e9efce486` (feat(pos): add shift close source event routing)
> origin/main: `7976e3eea64623961f1189b4f1acb91e9efce486`
> Implementation: `7976e3eea64623961f1189b4f1acb91e9efce486` (Packet 5 / P5-D Deployment — sweep + routing live)

---

## P1 Offline / Sync Resiliency — Packet 5 / P5-D Deployment

**Status: `PACKET_5_P5_D_CLOSED` — COMMITTED / PUSHED / LIVE** — P5-D = P5-D-1 + P5-D-2 only; no P5-D-3.

### P5-D-1 Validation Worker Sweep

- [x] Implementation — validation worker sweep core + wiring
- [x] Commit/push — `4adb1d5` (`feat(pos): add shift close validation worker sweep`)
- [x] Live deployment — `shiftCloseValidationSweep` ACTIVE, `asia-southeast1`, `pos-db`, schedule `every 60 minutes`
- [x] Indexes — 6/6 composite indexes READY on `pos-db`
- [x] Observation — natural no-work invocation observed (`casesProcessed: 0`); non-empty sweep not yet observed

### P5-D-2 Source Event Routing

- [x] Implementation — `shiftCloseSourceEventsCore.ts`, `shiftCloseSourceEvents.ts`, tests, `index.ts`, `package.json`
- [x] Commit/push — `7976e3e` (`feat(pos): add shift close source event routing`)
- [x] Live deployment — 4 functions ACTIVE, `asia-southeast1`, `pos-db`, all v2 `onDocumentWritten`, `retry: true`:
  - `shiftCloseSourceEventAsyncOrders` (`asyncOrders/{orderId}`)
  - `shiftCloseSourceEventOrders` (`orders/{orderId}`)
  - `shiftCloseSourceEventCashTransactions` (`cashTransactions/{txId}`)
  - `shiftCloseSourceEventCreditPayments` (`creditPayments/{paymentId}`)
- [x] Observation — deploy-time metadata/startup only; no live source-document traffic yet; one transient credit-payments log-retrieval error (non-blocking)

**Boundaries:** no production/emulator data mutation; no synthetic source events; no manual invocation; no index/rules deploy in docs-closure; no `shifts.expected*` mutation; `stash@{0}` untouched.

**Next:** P5-E read-only architecture planning (implementation NOT authorized). D5 = Option 2 (deferred into P5-E planning as a bracketed decision).

## P1 Offline / Sync Resiliency — Packet 5 / P5-C Atomic Evidence + Case Capture

**Status: CLOSED / COMMITTED / PUSHED / LIVE** — P5-C-1 Functions + P5-C-2 Rules both verified live

### P5-C-1 Functions

- [x] Implementation — `shiftCloseEvidenceCaptureCore.ts`, `shiftCloseEvidenceCapture.ts`, tests, `index.ts`, `package.json`
- [x] Codex final evidence — PASS WITH NOTES (0 blocking findings)
- [x] Commit/push — `f5b697a` (`feat(pos): add atomic shift close evidence capture`)
- [x] Live deployment — `firebase deploy --only functions:shiftCloseEvidenceCapture --project twinpet-pos --force` — PASS
- [x] Live verification — `shiftCloseEvidenceCapture` ACTIVE, `asia-southeast1`, `pos-db`, `shifts/{shiftId}`, `retry: true`

### P5-C-2 Rules

- [x] Rules hardening committed/pushed — `eda82dc`
- [x] Live Firestore rules deployment verification — PASS (`twinpet-pos` / `pos-db`)

**Boundaries:** no production test mutation; no synthetic shift-close event; no `shifts.expected*` mutation; P5-D/P5-E unauthorized; recapture callable unauthorized.

## P1 Offline / Sync Resiliency — Packet 5 / P5-B Pure Core

**Status: CLOSED / COMMITTED / PUSHED** (`798b344`)

## P1 Offline / Sync Resiliency — Packet 7C-B2 / 7C-B1 / 7C-A / 7A — CLOSED

## P1 Packet 8 / Packet 6 / 3B-* / 3A-* / Packet 2 / Packet 1 — CLOSED / PUSHED

## UI-11 Packet 1 / UI-10-C / UI-10-B / UI-10-A — CLOSED / PUSHED

## Future Phase — True Standalone (`TRUE-STANDALONE`) — NOT AUTHORIZED

## UI-10-D / UI-11 Packet 2 — NOT STARTED

### Next step

1. Packet 5 / P5-D Deployment — **`PACKET_5_P5_D_CLOSED`** (P5-D-1 sweep `4adb1d5` + P5-D-2 routing `7976e3e` live; docs closure this pass)
2. **Next: P5-E read-only architecture planning** — authorized read-only planning only; **P5-E implementation NOT authorized**. D5 = Option 2 (deferred into P5-E planning as a bracketed decision).
3. **NOT authorized:** P5-E implementation, P5-F/backfill, recapture callable, manual invocation, production/emulator data mutation, synthetic source events, Firestore index/rules deploy (unless separately authorized), deploy/runtime activation. No `shifts.expected*` mutation; no FIFO/stock/credit/settlement writes; `stash@{0}` untouched.
4. **Passive observation** — read-only on natural traffic only is authorized in parallel.
5. Do not automatically start another packet.

**Not active:** P5-E adjudication callable/UI, recapture callable, P5-F backfill, broad Packet 5 runtime beyond P5-D closure.
