# Latest Report — P1 Offline / Sync Packet 5 / P5-D Deployment (`PACKET_5_P5_D_CLOSED`)

> Date: 2026-07-19
> HEAD (code): `7976e3eea64623961f1189b4f1acb91e9efce486`
> Status: **PACKET 5 / P5-D CLOSED / COMMITTED / PUSHED / LIVE**

---

## Closure

P5-D Deployment is closed because both subpackets are verified live. **P5-D = P5-D-1 + P5-D-2 only; no P5-D-3.**

- **P5-D-1 Validation Worker Sweep** — commit `4adb1d5`; `shiftCloseValidationSweep` deployed and ACTIVE; 6/6 composite indexes READY on `pos-db`
- **P5-D-2 Source Event Routing** — commit `7976e3e`; 4 routing triggers deployed and ACTIVE

The live Packet 5 backend pipeline is now: P5-C capture (`shiftCloseEvidenceCapture`) → P5-D-2 source-event routing (4 triggers) → P5-D-1 scheduled sweep + validation worker (`shiftCloseValidationSweep`) — 6 functions, 6 READY indexes, hardened rules, all on `twinpet-pos` / `asia-southeast1` / `pos-db`.

---

## P5-D-1 Validation Worker Sweep

| Field | Value |
|-------|-------|
| Commit | `4adb1d599e1d89f74cd581b77011e6f2f53b4220` |
| Message | `feat(pos): add shift close validation worker sweep` |
| Function | `shiftCloseValidationSweep` |
| Region / Database | `asia-southeast1` / `pos-db` |
| Schedule | `every 60 minutes` |
| Indexes | 6/6 composite indexes READY on `pos-db` |
| Observation | natural no-work invocation `casesProcessed: 0`; non-empty sweep not yet observed |

## P5-D-2 Source Event Routing

| Field | Value |
|-------|-------|
| Commit | `7976e3eea64623961f1189b4f1acb91e9efce486` |
| Message | `feat(pos): add shift close source event routing` |
| Region / Database | `asia-southeast1` / `pos-db` |
| Runtime | v2 `onDocumentWritten`, nodejs22, `retry: true` |

| Function | Trigger path |
|----------|--------------|
| `shiftCloseSourceEventAsyncOrders` | `asyncOrders/{orderId}` |
| `shiftCloseSourceEventOrders` | `orders/{orderId}` |
| `shiftCloseSourceEventCashTransactions` | `cashTransactions/{txId}` |
| `shiftCloseSourceEventCreditPayments` | `creditPayments/{paymentId}` |

- Write surface: only `shiftCloseCases/{shiftId}` via CAS `tx.update`; no case creation; no `shifts` access
- Observation: deploy-time metadata/startup only; no live source-document traffic yet; one transient Cloud Logging retrieval error for `shiftCloseSourceEventCreditPayments` (non-blocking — `functions:list` confirms all four ACTIVE)

---

## Boundaries

No production/emulator data mutation. No synthetic source events. No manual invocation. No index/rules deployment in the docs-closure gate. No `shifts.expected*` mutation. No FIFO/stock/credit/settlement writes. `stash@{0}` untouched.

## D5 Disposition

`D5 Option 2 — explicitly defer into P5-E read-only planning`. The P5-E planner must include **D5 (PIN / recent re-auth for manager adjudication)** as a bracketed product/security decision and must **not** implement it.

## Carried Notes / Risks

1. Bounded ledger degradation — >24 retained ledger entries may allow one harmless extra revalidation (accepted, non-blocking).
2. `JSON.stringify` object/array equality may false-positive (extra Firestore cost) but never under-routes supported values.
3. Stale runtime code comments in shipped `functions/src` files are runtime-inert — fold into a future code gate when those files are touched.
4. The full P5-C/P5-D pipeline has never processed a real shift close end-to-end (no live full-pipeline data yet).
5. G3 — monitoring ownership for structural refusal logs (`capture_refused_*` / `enqueue_refused_branch_mismatch`) remains an unresolved Owner decision (no Cloud Monitoring alert policy exists).

## Unauthorized (remaining)

P5-E implementation, P5-F (historical backfill), recapture callable, manual invocation, production/emulator data mutation, synthetic source events, Firestore index/rules deploy (unless separately authorized), deploy/runtime activation — all NOT authorized.

## Next Gate

**P5-E read-only architecture planning** (alerts + manager adjudication callable) — read-only planning authorized; implementation NOT authorized. Passive read-only observation on natural traffic only authorized in parallel. Do not automatically start P5-E implementation.
