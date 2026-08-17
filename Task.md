# Twinpet POS — Task Tracker

> Last reconciled: 2026-08-17
> Current repository HEAD: `a081bcb850da3b9b3ac3bd2d9280a0815ecd4eab` (`feat(pos): add trusted orchestration owner enforcement`)
> D3 closure commit (binding): `a081bcb850da3b9b3ac3bd2d9280a0815ecd4eab`
> PK-2A code commit (historical): `79ba840ab6e01ee1a5fff6c0094104c25d754668`
> PK-2A parent: `23f51554f6a9e31bb7232a38cb9721c40f630566`
> PK-1 final HEAD (binding, unchanged): `513b198a30a1af72151ab6a8c0976799871529b8`
> PK-1 parent: `5e9b52bbbb8892d6c5dcf3453c3332724af7763b` (`feat(pos): enable offline shift open with durable intent and reconciliation`)
> Packet S implementation commit (historical, unchanged): `e9363e35f5a79f8e21d5dafe1e70d8ff3f82559c` (`feat(pos): add shift close case figures callable`)
> Packet S docs/tracker closure commit (historical, unchanged): `c6bdbd00d01541201dbc53236b06080db1a148e4`
> P-OBS-1 implementation commit (historical, unchanged): `da3a8d1c9ddcb605a1f9a6e3cebc21d8dc2ffe72`
> P-OBS-1 closure docs commit (historical, unchanged): `78f7ffe5c5b69f47af5c20ed8efd54410f35ee09`

---

## P1 Offline / Sync Resiliency — Packet 5 / PK-2B / R7 / R7-6 — Post Claude Correction-003 Master Plan Reconciliation (this pass)

**Status: `R7-6 / Post Claude Correction-003 / Pre Fresh Codex Architecture Rereview`** — docs-only current-state correction after the formal Claude correction-003 report. Leave uncommitted (`DOC_COMMIT_PUSH_AUTHORIZED: NO`).

- [x] Baseline recorded — HEAD = origin/main = live remote main = `a081bcb850da3b9b3ac3bd2d9280a0815ecd4eab`
- [x] `ROADMAP_LABEL: R7-6 — all-history order / receipt freshness`
- [x] `CORRECTED_BOUNDED_SCOPE: Sales History record freshness and receipt authority`
- [x] `D3_STATUS: CLOSED` at `a081bcb850da3b9b3ac3bd2d9280a0815ecd4eab`
- [x] Codex rereview-003 recorded — `BLOCK / GEMINI REDECISION REQUIRED` (historical; not a rereview of correction-003)
- [x] G-D6 recorded — `DECIDED OPTION_A` (VAT breakdown suppressed; no snapshot; no backfill; no legal/tax conclusion). Do not reopen.
- [x] Gemini decision set recorded as exactly five — G-D1/G-D2/G-D3/G-D5 `OPEN`; G-D6 `DECIDED OPTION_A`
- [x] `CLAUDE_CORRECTION_003_STATUS: COMPLETE`
- [x] B1–B9 recorded as `CLAUDE_CORRECTION_003_CLAIMS_CLOSED / PENDING_FRESH_CODEX_VERIFICATION` (not final CLOSED)
- [x] Claude candidate package recorded — 169 tests / 43 files = CLAUDE CANDIDATE / NOT YET CODEX-ACCEPTED / NOT IMPLEMENTATION-FROZEN
- [x] Prior 120 tests / 41 files remain `NOT FROZEN`
- [x] Closed-gate non-reopen recorded — Row28/Row30/D1/D3/Row32 = `NO`
- [x] `ENTRY_STORE_RELATION: PARALLEL_FOR_RECORD_FRESHNESS_ONLY`
- [x] Application Integration recorded — `STILL_NOT_READY` / `NOT AUTHORIZED`
- [x] R7-6 implementation recorded — `NOT AUTHORIZED` / not implementation-ready
- [x] Previous Owner-interrupt (Grok-001) retained as historical (it correctly wrote conservative state before the formal correction-003 report existed)

**CURRENT_STATUS:** Claude correction-003 formal report COMPLETE. B1-B9 claimed closed by Claude architecture correction. 169-test / 43-file candidate package produced. Fresh Codex architecture rereview still required. No implementation authority.

**NEXT_WORKFLOW_ACTION:** Return the seven-doc reconciliation to ChatGPT; obtain separate exact seven-doc commit/push authority if approved; return the repository to an accepted clean baseline; ONLY THEN run a genuinely fresh Codex architecture rereview of correction-003. Do not start Codex from this dirty worktree. **Next implementation action:** NONE — NOT AUTHORIZED.

## P1 Offline / Sync Resiliency — Packet 5 / PK-2B / R7 / R7-6 — Master Plan Interrupt (historical)

**Status: HISTORICAL** — Owner-interrupt docs-only write of conservative R7-6 state before the formal Claude correction-003 report existed. Superseded as current phase by the post-correction-003 reconciliation above. That interrupt recorded Claude correction-003 as NOT EXECUTED and B1–B9 as OPEN/PENDING awaiting Claude correction. Those current-state claims are no longer current.

## P1 Offline / Sync Resiliency — Packet 5 / PK-2A Boot / Session Gating and Offline Blocker — Docs Reconciliation (historical)

**Status: `PK2A_CODE_IMPLEMENTATION_STATUS: CLOSED_WITH_NOTES`** — historical docs reconciliation of verified PK-2A code closure (superseded as current phase by R7-6, then by post-correction-003 reconciliation).

- [x] `PK2A_CODE_IMPLEMENTATION_STATUS: CLOSED_WITH_NOTES` at `79ba840ab6e01ee1a5fff6c0094104c25d754668`
- [x] Code commit recorded — `feat(pos): harden offline boot and session gating`
- [x] Parent recorded — `23f51554f6a9e31bb7232a38cb9721c40f630566`
- [x] Exact 11-file code commit + normal fast-forward push verified (`HEAD == origin/main == remote main`)
- [x] Codex implementation review recorded — `PASS`; `MATERIAL_FINDING_COUNT: 0`
- [x] AGY UI/UX review recorded — `PASS`; `MATERIAL_FINDING_COUNT: 0`
- [x] Implemented PK-2A semantics recorded (provenance-aware boot; fail-closed unverifiable active shift; cache-empty not authoritative absence; session schema/issuedAt; legacy session in-memory upgrade; cached role/branch offline continuation; offline-no-session LoginPage blocker; DEC-10 live; no navigator-only short-circuit; no offline credential login)
- [x] Validation evidence recorded — focused 5 files / 95 PASS; bounded regression 3 files / 69 PASS; `tsc --noEmit` PASS; `git diff --check` PASS
- [x] Closure notes recorded (non-blocking for code closure):
  - browser responsive UAT NOT performed
  - Emulator runtime UAT NOT performed
  - deployment NOT performed
  - production activation/access NOT performed
- [x] `PK1_STATUS: CLOSED_WITH_NOTES` preserved; `PK1_REOPEN_AUTHORIZED: NO`
- [x] `PACKET_5_STATUS: NOT_CLOSED`; `BROADER_PACKET_5_CLOSURE_AUTHORIZED: NO`
- [x] `G14_ACTIVATION_TRACK_STATUS: ABORTED` preserved
- [x] Next roadmap candidate recorded — PK-2B — Cart Snapshot Store + Restore/Conflict Logic
- [x] `PK2B.ARCHITECTURE_PLANNING_AUTHORIZED_NOW: NO`
- [x] `PK2B.IMPLEMENTATION_AUTHORIZED: NO`

**Historical note:** PK-2A code remains `CLOSED_WITH_NOTES` at `79ba840`. Do not reopen PK-1. Preserved holds remain (deploy, production access, stash operations, G14 ABORTED, OBS-C, broader Packet 5 closure, offline credential login, returns/refunds, PK-2C..PK-6 implementation). R7-6 implementation is separately **NOT AUTHORIZED**.

## P1 Offline / Sync Resiliency — Packet 5 / PK-1 Offline Shift Session — Docs Reconciliation (historical)

**Status: `PK1_STATUS: CLOSED_WITH_NOTES`** — historical docs reconciliation of verified PK-1 closure (superseded as current phase by PK-2A code closure docs reconciliation).

- [x] `PK1_STATUS: CLOSED_WITH_NOTES` at final HEAD `513b198a30a1af72151ab6a8c0976799871529b8`
- [x] Final remediation commit recorded — `fix(pos): harden offline shift open reconciliation`
- [x] Parent recorded — `5e9b52bbbb8892d6c5dcf3453c3332724af7763b`
- [x] Final Codex recorded — `PASS_WITH_NOTES`; `MATERIAL_FINDING_COUNT: 0`
- [x] Final AGY recorded — `PASS`; `MATERIAL_FINDING_COUNT: 0`
- [x] Closure notes recorded as non-blocking / out of PK-1 scope:
  - analogous `closeShift` structured-result handling remains deferred
  - Browser/Emulator runtime UAT remains separately gated (not required for PK-1 closure)
- [x] `PK1_REOPEN_AUTHORIZED: NO`
- [x] `PACKET_5_STATUS: NOT_CLOSED`; `BROADER_PACKET_5_CLOSURE_AUTHORIZED: NO`

## P1 Offline / Sync Resiliency — Packet 5 / Post-R6 Seven-File Tracker Reconciliation (historical)

**Status: HISTORICAL** — superseded as current phase by PK-1 closure. `P_OBS_1_STATUS: CLOSED` (permanent owner `docs/ops/packet-5-monitoring-runbook.md` §9). R6 Codex current-head re-review was `PASS_WITH_NOTES`. `PROV` and `E-2` POSIX evidence remains **not authorized** / `IDENTIFIED_BUT_HELD`. Broader Packet 5 remains **NOT CLOSED**.

## P1 Offline / Sync Resiliency — Packet 5 / UI-B2 / Packet S — getShiftCloseCaseFigures

**Status: TECHNICALLY CLOSED WITH NONBLOCKING NOTES**

- [x] Implementation — new read-only server-side callable `getShiftCloseCaseFigures` returning selected shift-close case figures
- [x] Codex final C12 benign-presence exactness re-review — PASS WITH NOTES (0 blockers, 0 request changes, 2 carried nonblocking notes)
- [x] Commit/push — `e9363e3` (`feat(pos): add shift close case figures callable`); fast-forward `5654362..e9363e3`; exactly 6 files
- [x] Deployment — `getShiftCloseCaseFigures` deployed live: `twinpet-pos`, `asia-southeast1`, `pos-db`, `nodejs22` v2/2nd Gen; successful create; no `--force`
- [x] Verification — targeted core 448 / targeted shell 135 / full Functions unit suite 24 files / 1353 tests; typecheck PASS; build PASS; `git diff --check` PASS
- [x] Docs/tracker reconciliation — CLOSED at `c6bdbd0` (`docs(pos): reconcile packet s closure`)

**Boundaries:** no callable invocation performed; no production business-data UAT performed; no broader Packet 5 closure claimed; Packet R/C/U not authorized or claimed; `stash@{0}` untouched.

**N-FINAL-01 (active downstream constraint):** selected-run figures returned by `getShiftCloseCaseFigures` are not final settlement truth; future UI/copy consuming this callable must not present them as reconciled or final without a separate backend contract.

## P1 Offline / Sync Resiliency — Packet 5 / UI-C Manager Adjudication Action Surface

**Status: CLOSED AS COMMITTED AND PUSHED**

- [x] Implementation — manager Acknowledge/Resolve action surface over read-only `/shift-close-review/:shiftId`; adjudication state machine; non-throwing callable adapter; extended allowlist projection
- [x] Codex implementation review + closure re-review — PASS WITH NOTES (0 blockers, 0 request changes, 4 notes)
- [x] Remediation chain — RC + RC-4 + retry-scope + rendered-UX remediations completed
- [x] AGY final rendered UX re-review — PASS (0 blockers, 0 request changes, 1 note; viewport 320/768/1080); V-1 CLOSED; L-1 CLOSED; A-1 accepted deferred note
- [x] Gemini implementation-closure + commit/push authorization — AUTHORIZED (A-1 deferred note accepted)
- [x] Commit/push — `3ef4d01` (`feat(pos): add shift close manager adjudication surface`); fast-forward `70a23f9..3ef4d01`; exactly 10 files; `3616 insertions(+), 12 deletions(-)`
- [x] Docs reconciliation — CLOSED at `5654362` (`docs(pos): close packet 5 ui-c manager adjudication`)

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

**Billing (O-15) — Completed with notes, 2026-07-20:** Owner completed the paid-account upgrade with a THB 25 Owner-accepted / Owner-managed budget. Billing account open, project linkage verified, `billingEnabled` verified, relevant IAM/linkage verified. The specific paid-upgrade status remains Owner-attested because the CLI cannot independently distinguish a free-trial state from the specific paid-upgrade state. No engineering action is currently pending.

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

1. **R7-6 / Post Claude Correction-003 / Pre Fresh Codex Architecture Rereview** at `a081bcb850da3b9b3ac3bd2d9280a0815ecd4eab` — Claude correction-003 COMPLETE; B1–B9 `CLAUDE_CORRECTION_003_CLAIMS_CLOSED / PENDING_FRESH_CODEX_VERIFICATION`; 169/43 CLAUDE CANDIDATE / NOT YET CODEX-ACCEPTED; G-D6 OPTION_A DECIDED; not implementation-ready
2. **D3 — `CLOSED`** at `a081bcb850da3b9b3ac3bd2d9280a0815ecd4eab` — do not reopen
3. **PK-2A Boot / Session Gating — `CLOSED_WITH_NOTES`** at `79ba840ab6e01ee1a5fff6c0094104c25d754668` — historical
4. **PK-1 Offline Shift Session — `CLOSED_WITH_NOTES`** at `513b198a30a1af72151ab6a8c0976799871529b8` — do not reopen
5. **`PACKET_5_STATUS: NOT_CLOSED`** — broader Packet 5 closure **NOT AUTHORIZED**
6. **NEXT_WORKFLOW_ACTION:** Return this seven-doc reconciliation to ChatGPT; obtain separate commit/push authority if approved; return to an accepted clean baseline; ONLY THEN fresh Codex architecture rereview of correction-003. Do not start Codex from this dirty worktree. **Next implementation action:** NONE — NOT AUTHORIZED. Application Integration: `STILL_NOT_READY` / NOT AUTHORIZED
7. **NOT authorized:** R7-6 implementation, Application Integration, final G-D1/G-D2/G-D3/G-D5 Gemini bundle, PK-2C..PK-6 implementation, offline credential login, returns/refunds, G14 (ABORTED), OBS-C, UI-B.1, UI-B2, P5-F, recapture, deploy, runtime activation, callable invocation, production access, stash operations, Packet R/C/U, broader Packet 5 closure, docs commit/push without separate authorization
8. Do not automatically start implementation or Codex from the current dirty worktree

**Not active:** R7-6 implementation, Application Integration, PK-2C, PK-3..PK-6, UI-B.1, UI-B2, P5-F, recapture, or any new feature packet.
