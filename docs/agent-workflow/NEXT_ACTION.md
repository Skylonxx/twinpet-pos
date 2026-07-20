# Next Action

## Current State

- HEAD (code): `afacd3ba8bbb7b9b7973b70a334cde957ddf6750` (P5-E adjudication callable) — unchanged this pass (docs/runbook only)
- **P1 Packet 5 / G3 Monitoring** — **`G3_MONITORING_DOCS_CLOSED`** — 1 email channel, 2 log-based metrics, 8 alert policies (A1–A8) created and independently verified `PASS WITH NOTES` (no blockers); runbook `docs/ops/packet-5-monitoring-runbook.md` created this pass. No code/config/runtime changed; no monitoring resource changed in this pass.
- **P1 Packet 5 / P5-E Adjudication Callable** — **`PACKET_5_P5_E_CLOSED` / LIVE**
- **P5-E:** committed `afacd3b`; `resolveShiftCloseAlert` live (`asia-southeast1`, `pos-db`, callable / Functions v2, `nodejs22`); ACTIVE, startup probe succeeded; no callable request sent
- **P5-D-1:** committed `4adb1d5`; `shiftCloseValidationSweep` live (`asia-southeast1`, `pos-db`, schedule `every 60 minutes`); 6/6 indexes READY; natural no-work invocation `casesProcessed: 0` observed
- **P5-D-2:** committed `7976e3e`; 4 routing triggers live (`asyncOrders/{orderId}`, `orders/{orderId}`, `cashTransactions/{txId}`, `creditPayments/{paymentId}`), v2 `onDocumentWritten`, `retry: true`; deploy-time observation only
- **P5-C Atomic Capture** — CLOSED / LIVE (`f5b697a` + `eda82dc`)
- **P5-B Pure Core** — CLOSED (`798b344`)
- **UI-11 Packet 2 / UI-10-D** — NOT STARTED

## What Happens Next

1. P5-E Adjudication Callable CLOSED (`resolveShiftCloseAlert` live; docs closure reconciled trackers to production) — **DONE**
2. G3 Monitoring docs/runbook CLOSED (8 alert policies + 2 log-based metrics + 1 email channel live, independently verified `PASS WITH NOTES`; runbook `docs/ops/packet-5-monitoring-runbook.md`) — **DONE this pass**
3. **Next: free-trial upgrade decision (owner, ≈2026-08-27)** — separate item; governs whether the whole live Packet 5 pipeline keeps running past trial expiry
4. **Also next: post-P5-E read-only roadmap audit** — strict read-only assessment of the next safest, highest-value phase (passive observation / P5-F / recapture / client-UI / docs cleanup — monitoring ownership now resolved); no implementation planning beyond roadmap level
5. **D5 disposition:** resolved as Option C in the shipped contract (optional transient PIN, never required/stored day one, future-compatible with step-up auth)
6. **Passive observation** — read-only on natural traffic only is authorized in parallel
7. **NOT authorized:** P5-F planning/implementation, recapture planning/implementation, client/UI planning/implementation (all pending roadmap-audit recommendation + separate Gemini authorization), manual invocation, production/emulator data mutation, synthetic source events, Firestore rules/index deploy, deploy/runtime activation, alert test-fire, monitoring resource changes
8. Do not automatically start P5-F, recapture, client/UI work, or another packet

**Not active:** P5-F backfill, recapture callable, client/UI adjudication surface, broad Packet 5 runtime beyond P5-E closure.

## Reminders

- `stash@{0}` — do not touch (`7d03cfec7ba52ff7e25b7e175ca190efc258d874`)
- P5-E function is live but no production test mutation / synthetic events / manual invocation / business-path execution performed
- No `shifts.expected*` mutation; no FIFO/stock/credit/settlement writes
- P5-F / recapture / client-UI planning require separate Gemini authorization after the roadmap audit — not implied by P5-E closure
- The full P5-C/P5-D/P5-E pipeline has not yet processed a real shift close end-to-end
- Live-lease conflict reuses the `stale_case_version` reject code (no dedicated lease-conflict code exists in the frozen enum)
- **G3 monitoring — RESOLVED** this pass; see `docs/ops/packet-5-monitoring-runbook.md`. Alert firing/email delivery not tested by design. A5 filter should be re-reviewed if `resolveShiftCloseAlert`'s logging surface expands.
- Free-trial credit expiry ≈2026-08-27 is a separate, unresolved owner decision
