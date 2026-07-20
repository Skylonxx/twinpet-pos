# Latest Report — P1 Offline / Sync Packet 5 / G3 Monitoring (`G3_MONITORING_DOCS_CLOSED`)

> Date: 2026-07-20
> HEAD (code): `afacd3ba8bbb7b9b7973b70a334cde957ddf6750` (unchanged — this pass is docs/runbook only)
> Status: **PACKET 5 / G3 MONITORING — DOCS/RUNBOOK CLOSED**

---

## G3 Monitoring closure (this pass)

Cloud Monitoring resources for the Packet 5 pipeline were created and independently verified across three scopes:

- **Scope 1 — creation:** `POLICY CREATION COMPLETE`. Created exactly 1 email notification channel (`Twinpet P5 G3 Owner Email`, `projects/twinpet-pos/notificationChannels/1890505988171137697`, recipient `narachat.damg@gmail.com`), 2 log-based metrics (`twinpet_p5_g3_sweep_heartbeat`, `twinpet_p5_g3_crash_startup_failure`), and 8 alert policies A1–A8 (all enabled, each with exactly 1 channel attached). All Gemini-authorized caps respected (≤2 metrics, ≤8 policies, exactly 1 email channel). No test-fire, no synthetic events, no deploy, no repo changes in Scope 1.
- **Scope 2 — independent verification:** `PASS WITH NOTES`. Reviewer session separate from the Scope 1 operator. No blockers; no required remediation. Non-blocking notes: (1) alert opening/email delivery untested by explicit design; (2) A5's service-scoped `unexpected error` token is safe today but should be re-reviewed if `resolveShiftCloseAlert`'s logging surface expands; (3) absolute historical absence of direct Firestore data-plane writes partly relies on operator attestation where Data Access audit logs may be unavailable — available audit/runtime evidence is clean; (4) the repo's prior rolling report said no monitoring existed for Packet 5 — this pass reconciles that.
- **Scope 3 — docs/runbook (this pass):** new file `docs/ops/packet-5-monitoring-runbook.md` documents the full resource inventory, exact filters/thresholds/grouping, per-alert (A1–A8) response procedures, safe read-only command examples, limitations, cost/free-trial note, and prohibited response actions. `Context.md`, `Task.md`, `docs/STATE.md`, `docs/agent-workflow/CURRENT_PACKET.md`, `docs/agent-workflow/NEXT_ACTION.md`, `docs/agent-workflow/STATE.md` reconciled to record this closure.

**Explicit statements:** no code/config/runtime file changed; no monitoring resource (channel/metric/policy/dashboard) created, modified, or deleted in Scope 3; no deploy, manual invocation, test-fire, synthetic event, or data mutation occurred in any scope.

**Cost:** negligible — USD 0.00/month while Cloud Monitoring alerting remains unbilled (no sooner than 2026-09-01), then an estimated USD 1.05–1.50/month (≈THB 39–49) thereafter, against ≈THB 9,751.22 free-trial credit as of 2026-07-20.

**Owner decision (separate, not resolved here):** free-trial credit expiry ≈2026-08-27 threatens continuity of the entire live Packet 5 pipeline (all 7 functions), not just monitoring — track as its own gate.

**Reports:** Scope 1 `Operator\twinpet-p1-offline-sync-packet-5-g3-monitoring-policy-creation-report.md`; Scope 2 `reviewer\twinpet-p1-offline-sync-packet-5-g3-monitoring-policy-verification-report.md`; cost exactification `Architect\twinpet-p1-offline-sync-packet-5-g3-monitoring-cost-exactification-report.md`; this closure `Developer\twinpet-p1-offline-sync-packet-5-g3-monitoring-runbook-docs-closure-report.md`.

---

# Prior — P1 Offline / Sync Packet 5 / P5-E Adjudication Callable (`PACKET_5_P5_E_CLOSED`)

> Date: 2026-07-19
> HEAD (code): `afacd3ba8bbb7b9b7973b70a334cde957ddf6750`
> Status: **PACKET 5 / P5-E CLOSED / COMMITTED / PUSHED / LIVE**

---

## Closure

P5-E Adjudication Callable is closed because `resolveShiftCloseAlert` is committed, pushed, and verified live.

- **Commit** — `afacd3ba8bbb7b9b7973b70a334cde957ddf6750` (`feat(pos): add shift close alert adjudication callable`)
- **Live function** — `resolveShiftCloseAlert`, ACTIVE, `asia-southeast1`, `pos-db`, HTTPS callable / Firebase Functions v2, `nodejs22`

The live Packet 5 backend pipeline is now: P5-C capture (`shiftCloseEvidenceCapture`) → P5-D-2 source-event routing (4 triggers) → P5-D-1 scheduled sweep + validation worker (`shiftCloseValidationSweep`) → P5-E manager adjudication callable (`resolveShiftCloseAlert`) — 7 functions, 6 READY indexes, hardened rules, all on `twinpet-pos` / `asia-southeast1` / `pos-db`.

---

## P5-E Adjudication Callable

| Field | Value |
|-------|-------|
| Commit | `afacd3ba8bbb7b9b7973b70a334cde957ddf6750` |
| Message | `feat(pos): add shift close alert adjudication callable` |
| Commit payload (6 files) | `functions/package.json`, `functions/src/index.ts`, `functions/src/resolveShiftCloseAlert.ts`, `functions/src/resolveShiftCloseAlertCore.ts`, `functions/src/__tests__/resolveShiftCloseAlert.test.ts`, `functions/src/__tests__/resolveShiftCloseAlertCore.test.ts` |
| Function | `resolveShiftCloseAlert` |
| Project | `twinpet-pos` |
| Region / Database | `asia-southeast1` / `pos-db` |
| Runtime | `nodejs22`, Firebase Functions v2 (Gen 2) |
| Trigger | HTTPS callable / callable-compatible |
| Deploy command | `firebase deploy --only functions:resolveShiftCloseAlert --project twinpet-pos` |
| Deploy result | Successful create operation |
| Observation | ACTIVE Gen 2 callable; startup TCP probe succeeded after 1 attempt; no package-load/startup error; no crash loop; no callable request sent |
| Firestore rules deployed | NO |
| Firestore indexes deployed | NO |
| Other functions deployed | NO |
| Manual invocation | NO |
| Production/emulator data mutation | NO |

### Behavior summary

- **D5** — Option C: `pin?: string` accepted on the request, never read/verified anywhere in the shell or core, never persisted; `pinVerifiedAtServer: null` written unconditionally on every confirmed audit event (reserved slot for a future step-up gate). Compatible with future UI step-up.
- **Worker lease** — Option 1: `isLeaseLive` (strict `leaseExpiryMillis > nowMillis`) checked before any read of the alert doc or any write; a live lease returns `status: 'conflict_requires_manual_review'` with zero writes. Lease fields (`leaseOwner`/`leaseExpiry`) are never modified by this callable.
- **Auth** — manager/admin with branch access only; `staff` always `unauthorized`; no PIN-bypass path; cross-branch requests rejected even for an otherwise-authorized manager of a different branch.
- **CAS** — `expectedCaseVersion` vs. live `caseVersion`, checked inside the transaction before any write; mismatch → `stale_case_version` / `conflict_requires_manual_review`, zero writes.
- **Idempotency** — deterministic `shiftCloseAdjudicationCommands/{sha256(commandId).slice(0,40)}` ledger; same commandId + same payload hash → `duplicate_confirmed` (zero re-mutation); same commandId + different payload → `conflict_requires_manual_review` / `invalid_payload`, zero mutation.
- **Audit** — immutable `shiftCloseAuditEvents/{eventId}` via `tx.create`, deterministic id via the shared P5-D `computeP5DAuditEventId` helper. Rejected/business-failure attempts write no audit event.
- **Transaction write scope** — `shiftCloseCases/{shiftId}` (alertState/settlementState/caseVersion/updatedAt only), `shiftCloseAlerts/{shiftId}`, `shiftCloseAuditEvents/{eventId}`, `shiftCloseAdjudicationCommands/{ledgerId}`.
- **Red zone** — no `shifts` collection read/written; no `shifts.expected*`; no FIFO/stock/inventory/credit/final-settlement writes; no drawer math; no auto-adjudication path (every write requires a verified manager/admin `auth`).

### Test / build evidence (from source reports)

| Suite | Result |
|---|---|
| `resolveShiftCloseAlertCore.test.ts` | 41/41 PASS |
| `resolveShiftCloseAlert.test.ts` | 24/24 PASS |
| `functions` full vitest | 770/770 PASS (22 files) |
| root `npm run test:unit` | 1187/1187 PASS (58 files) |
| `tsc --noEmit` / `npm run build` | exit 0 |
| `git diff --check` | exit 0 |

Review verdict: **PASS WITH NOTES** (0 blockers, 0 request-changes, 4 non-blocking notes). Deployment-readiness audit verdict: **PASS WITH NOTES** (deployment readiness: YES). Deploy/observation verdict: **DEPLOYMENT PASS WITH NOTES**.

---

## Boundaries

No production/emulator data mutation. No manual invocation. No business-path execution (no callable request sent). No Firestore rules/index deployment in this gate. No `shifts`/`shifts.expected*` access. No FIFO/stock/credit/settlement writes. `stash@{0}` untouched.

## D5 Disposition

Resolved as **Option C** in the shipped contract: optional transient PIN accepted on the request, never verified, never stored/persisted; day-one behavior requires no PIN; leaves room for a future UI/security packet to add step-up verification if separately authorized.

## Carried Notes / Risks

1. Firebase CLI warned `firebase-functions` is outdated in `functions/package.json` — non-blocking; no dependency upgrade authorized in this gate.
2. Business path not exercised — no callable request was sent; observation proves deployment metadata/startup health only, not business-path execution.
3. Live-lease conflict reuses the `stale_case_version` reject code under `conflict_requires_manual_review` — the frozen 8-value `AdjudicationRejectCode` enum has no dedicated lease-conflict code; accepted judgment call (mirrors `resolveReversal.ts`'s own precedent), earmarked for a future contract revision.
4. Manager request `reasonCode` accepts the full frozen 10-value `AlertReasonCode` enum, including system-only values (e.g. `superseding_match`, `source_limit_exceeded`) — left to a future UI layer to curate, not a backend defect.
5. `duplicate_confirmed` shell test has a low-risk assertion gap (does not explicitly assert round-tripped `newAlertState`/`newSettlementState`, only `status`/`auditEventId`) — the underlying code is a trivial passthrough, risk is low.
6. The full P5-C/P5-D/P5-E pipeline has never processed a real shift close end-to-end on natural production data in the evidence set (no live full-pipeline data yet).
7. G3 — monitoring ownership for structural refusal logs (`capture_refused_*` / `enqueue_refused_branch_mismatch`) remains an unresolved Owner decision (no Cloud Monitoring alert policy exists).

## Unauthorized (remaining)

P5-F (historical backfill) planning/implementation, recapture planning/implementation, client/UI planning/implementation — all pending a post-P5-E roadmap-audit recommendation and separate Gemini authorization. Manual invocation, production/emulator data mutation, synthetic source events, Firestore rules/index deployment, deploy/runtime activation beyond this callable — all NOT authorized.

## Next Gate

**Post-P5-E read-only roadmap audit** — strict read-only assessment of the next safest, highest-value phase after P5-E closure (candidates: passive operational observation, P5-F read-only planning, recapture read-only planning, client/UI planning, monitoring/alert policy ownership, docs/dependency cleanup). No implementation planning beyond roadmap-level assessment; no repository mutation. Passive read-only observation on natural traffic only authorized in parallel. Do not automatically start P5-F, recapture, or client/UI work.
