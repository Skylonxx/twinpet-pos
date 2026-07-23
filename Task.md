# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-23
> HEAD: `490f4cf47a579241fcf10b1feba7edd6fcc09d44` (feat(pos): add shift close alert review detail)
> origin/main: `490f4cf47a579241fcf10b1feba7edd6fcc09d44`
> Implementation: `490f4cf47a579241fcf10b1feba7edd6fcc09d44` (Packet 5 / Client-UI-B — CLOSED AS COMMITTED AND PUSHED)

---

## P1 Offline / Sync Resiliency — Packet 5 / Client-UI-B

**Status: CLOSED AS COMMITTED AND PUSHED**

- [x] Implementation — read-only `/shift-close-review/:shiftId` detail view; two direct-doc listeners; safe projection; queue-to-detail navigation
- [x] Codex implementation review — REQUEST CHANGES (0 blockers, 4 RCs)
- [x] Gemini bounded remediation — RC-1/RC-2/RC-3; historical stash incident waived for that incident only
- [x] Codex re-review — PASS WITH NOTES (0 blockers, 0 RCs, 4 notes)
- [x] AGY UX review — PASS (0 blockers; viewport 320/768/1080)
- [x] Commit/push — `490f4cf` (`feat(pos): add shift close alert review detail`); fast-forward push; 12 files; `2115 insertions(+), 15 deletions(-)`
- [x] Gemini closure — Option A; process deviation accepted as nonblocking
- [ ] Docs reconciliation — **active** (this pass; unstaged, uncommitted)

**Boundaries:** no acknowledge/resolve; no UI-B2; no write path/callable/production mutation/deploy. Fallback A missing-vs-denied ambiguity unresolved.

**Next:** Codex strict read-only docs review → Gemini separate docs commit/push authorization consideration.

## P1 Offline / Sync Resiliency — Packet 5 / Client-UI-A

**Status: CLOSED AS COMMITTED AND PUSHED** (`4614e70` — shift close review queue)

## P1 Offline / Sync Resiliency — Packet 5 / G3 Monitoring

**Status: docs/runbook CLOSED** — Cloud Monitoring resources created (Scope 1) and independently verified (Scope 2 `PASS WITH NOTES`, no blockers).

- [x] Scope 1 — creation: 1 email channel, 2 log-based metrics, 8 alert policies (A1–A8), all enabled, caps respected
- [x] Scope 2 — independent verification (separate reviewer): `PASS WITH NOTES`, no blockers, no required remediation
- [x] Scope 3 — docs/runbook: `docs/ops/packet-5-monitoring-runbook.md` created; trackers reconciled

**No code/config/runtime changed. No monitoring resource created/modified/deleted in Scope 3. No deploy/manual invocation/test-fire/synthetic event/data mutation.**

**Next:** free-trial upgrade decision (owner, ≈2026-08-27) — tracked separately from monitoring docs closure.

## P1 Offline / Sync Resiliency — Packet 5 / P5-E Adjudication Callable

**Status: `PACKET_5_P5_E_CLOSED` — COMMITTED / PUSHED / LIVE**

- [x] Implementation — `resolveShiftCloseAlertCore.ts`, `resolveShiftCloseAlert.ts`, tests, `index.ts`, `package.json`
- [x] Review (Codex-persona) — PASS WITH NOTES (0 blocking)
- [x] Commit/push — `afacd3b` (`feat(pos): add shift close alert adjudication callable`)
- [x] Live deployment — `resolveShiftCloseAlert` ACTIVE, `asia-southeast1`, `pos-db`, callable / Functions v2, `nodejs22`
- [x] Observation — deploy-time metadata/startup only; ACTIVE, startup probe succeeded; no callable request sent

**Behavior:** D5 = Option C (optional transient PIN, never verified/stored); worker lease = Option 1 (refuse on live lease, zero writes); manager/admin-only auth; CAS via `expectedCaseVersion`; idempotent via `commandId` ledger; immutable audit event. Write scope: `shiftCloseCases`, `shiftCloseAlerts`, `shiftCloseAuditEvents`, `shiftCloseAdjudicationCommands` only. No `shifts`/`shifts.expected*` access; no FIFO/stock/credit/settlement writes.

**Boundaries:** no production/emulator data mutation; no manual invocation; no business-path execution; no rules/index deploy; `stash@{0}` untouched.

**Next:** post-P5-E read-only roadmap audit (passive observation / P5-F / recapture / client-UI / monitoring ownership / docs cleanup assessed at roadmap level only). P5-F, recapture, and client/UI planning remain unauthorized until the audit recommends and Gemini authorizes.

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

**Next:** P5-E adjudication callable — CLOSED / LIVE (see section above).

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

1. Packet 5 / Client-UI-B — **CLOSED AS COMMITTED AND PUSHED** (`490f4cf`)
2. **Active: UI-B docs reconciliation** — seven tracker documents updated (unstaged); next gate Codex strict read-only docs review
3. **After Codex docs review:** Gemini separate docs commit/push authorization consideration
4. **NOT authorized:** UI-B.1, UI-B2, UI-C, P5-F, recapture, new implementation, deploy, runtime activation, production access, stash operations, POSPage/PaymentModal/checkout/navigation/global-keyboard changes
5. **Next implementation/roadmap direction** — later Gemini decision after docs closure; no active implementation packet
6. Do not automatically start another packet.

**Not active:** UI-B.1, UI-B2, UI-C, P5-F, recapture, or any new feature packet.
