# Twinpet POS — Task Tracker

> Last reconciled: 2026-07-24
> HEAD: `3ef4d016eeb288bcdf7d76c959e4a748b97964c6` (feat(pos): add shift close manager adjudication surface)
> origin/main: `3ef4d016eeb288bcdf7d76c959e4a748b97964c6`
> Implementation: `3ef4d016eeb288bcdf7d76c959e4a748b97964c6` (Packet 5 / UI-C Manager Adjudication Action Surface — CLOSED AS COMMITTED AND PUSHED)
> Self-reference lag: edited inside the UI-C docs pass; the docs commit carrying it is not yet created. Treat actual Git HEAD as authoritative.

---

## P1 Offline / Sync Resiliency — Packet 5 / UI-C Manager Adjudication Action Surface

**Status: CLOSED AS COMMITTED AND PUSHED**

- [x] Implementation — manager Acknowledge/Resolve action surface over read-only `/shift-close-review/:shiftId`; adjudication state machine; non-throwing callable adapter; extended allowlist projection
- [x] Codex implementation review + closure re-review — PASS WITH NOTES (0 blockers, 0 request changes, 4 notes)
- [x] Remediation chain — RC + RC-4 + retry-scope + rendered-UX remediations completed
- [x] AGY final rendered UX re-review — PASS (0 blockers, 0 request changes, 1 note; viewport 320/768/1080); V-1 CLOSED; L-1 CLOSED; A-1 accepted deferred note
- [x] Gemini implementation-closure + commit/push authorization — AUTHORIZED (A-1 deferred note accepted)
- [x] Commit/push — `3ef4d01` (`feat(pos): add shift close manager adjudication surface`); fast-forward `70a23f9..3ef4d01`; exactly 10 files; `3616 insertions(+), 12 deletions(-)`
- [ ] Docs reconciliation — **active** (this pass; unstaged, pending commit)

**Verification:** targeted UI-C 5 files/260; full root 69 files/1540; rules 8 files/300; POS three-suite 3 files/178; build/typecheck/targeted-lint/diff-check PASS.

**Boundaries:** mutation only via already-live `resolveShiftCloseAlert` callable (P5-E) — **no callable invocation performed**; no new deploy/runtime activation; no rules/index/functions change; no hook change; A-1 global Flowbite fix deferred; `stash@{0}` untouched.

**Next:** strict read-only post-UI-C roadmap audit (this pass's docs commit/push already Gemini-authorized).

## P1 Offline / Sync Resiliency — Packet 5 / Client-UI-B

**Status: CLOSED AS COMMITTED AND PUSHED** (`490f4cf` — read-only shift-close alert detail; docs closed at `70a23f9`)

- [x] Implementation — read-only `/shift-close-review/:shiftId` detail view; two direct-doc listeners; safe projection; queue-to-detail navigation
- [x] Codex review chain — REQUEST CHANGES (4 RCs) → remediation → PASS WITH NOTES
- [x] AGY UX review — PASS (0 blockers; viewport 320/768/1080)
- [x] Commit/push — `490f4cf`; fast-forward; 12 files; `2115 insertions(+), 15 deletions(-)`
- [x] Docs reconciliation — CLOSED at `70a23f9` (`docs(pos): close client ui-b reconciliation`)

**Boundaries:** read-only in UI-B (acknowledge/resolve delivered later by UI-C); no UI-B2; Fallback A missing-vs-denied ambiguity unresolved.

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

1. Packet 5 / UI-C Manager Adjudication Action Surface — **CLOSED AS COMMITTED AND PUSHED** (`3ef4d01`)
2. **Active: UI-C docs reconciliation** — seven tracker documents updated (unstaged, pending commit this pass)
3. **Next gate: strict read-only post-UI-C roadmap audit** (this pass's docs commit/push already Gemini-authorized)
4. **NOT authorized:** UI-B.1, UI-B2, P5-F, recapture, new implementation (any candidate), deploy, runtime activation, callable invocation, production access, global Flowbite (A-1) fix, stash operations, POSPage/PaymentModal/checkout/navigation/global-keyboard changes
5. **Next implementation/roadmap direction** — later Gemini decision after the roadmap audit; no active implementation packet and no next candidate selected
6. Do not automatically start another packet.

**Not active:** UI-B.1, UI-B2, P5-F, recapture, or any new feature packet.
