# Twinpet POS — Project Context

> Last reconciled: 2026-07-10
> HEAD: `1e41b0eb0871e5788a553e579f8087171ba38077` (Packet 7C-B1 closed/committed/pushed; Packet 7C-B2 implementation this pass is unstaged, on top of this HEAD)
> origin/main: `1e41b0eb0871e5788a553e579f8087171ba38077`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 7C-B2 Close-Intent Reconciliation: REVIEWED / AUTHORIZED FOR COMMIT AND FAST-FORWARD PUSH** — first Codex FAIL; remediation PASS; Codex re-review PASS WITH NOTES; Gemini AUTHORIZED; commit execution in progress

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

**Repository baseline:** branch `main`, HEAD/origin `1e41b0e`, staged **empty**, `stash@{0}` present and untouched. Implementation + remediation this pass is **unstaged**.

### P1 Packet 7C-B2 Close-Intent Reconciliation (implemented + remediated — not committed)

**Status:** Implemented per Gemini authorization (`TWINPET-P1-OFFLINE-SYNC-GEMINI-PACKET-7C-B2-IMPLEMENTATION-AUTHORIZATION-001`) following Codex architecture review PASS WITH NOTES. Variant C hybrid (local-journal-authoritative + best-effort `syncState` doc normalization) implemented as directed.

**First Codex implementation review: FAIL / implementation-ready-for-commit: NO** — the packet passed Vitest + `tsc --noEmit` but failed the repository build path (`npx tsc -b` / `npm run build`) on two TypeScript errors. **Remediated** (`TWINPET-P1-OFFLINE-SYNC-PACKET-7C-B2-CODEX-FAIL-REMEDIATION-CLAUDE-001`):
- **Blocker 1** — `ShiftModals.tsx` `formatShiftTime` param widened to `Shift['closedAt']` (`Timestamp | null`) so `getClosedTimeLabel(shift.closedAt)` type-checks (TS2345); the runtime null-guard already returned the em-dash fallback — no cast/`!` used.
- **Blocker 2** — `shiftCloseReconciler.ts` now imports `ShiftCloseIntentEntry` from `./shiftCloseIntentTypes` (its true source) instead of the store module, which only imports it internally (TS2459).
- **Medium (lifecycle)** — `CloseShiftModal` added a `mountedRef` unmount guard so the late `whenServerConfirmed` observer cannot `setConfirmation` after unmount / Z-report dismissal.
- **Low (journal result)** — the reconciler now inspects `markSynced`/`markRejectedManualAttention` `ok`; a failed local journal transition returns retryable `unreachable` (and skips Variant C normalization), never claiming a completed transition on real server proof.

**Build passes** (`tsc -b` exit 0; `npm run build` exit 0). Full suite **1187/1187**. Codex re-review PASS WITH NOTES; Gemini commit/push AUTHORIZED. Not yet committed/pushed — commit execution in progress.

**Process notes (Codex-accepted, not expanded):** `POSPage.hold-bill-interaction.test.tsx` mock-harness change accepted as a procedural deviation (not a blocker); Opus-vs-Sonnet execution-model label is a non-blocking deviation (remediation pass ran under Claude Opus 4.8 after a `/model` switch; the implementation pass ran under Sonnet 5); duplicate concurrent normalization writes remain LOW/best-effort — no lock/single-flight added.

**Delivered:**
- New pure reconciler `src/lib/pos/offline/shiftCloseReconciler.ts` — `reconcileShiftCloseIntent()` + `runShiftCloseReconciliationSweep()`. Classifies a `local_closed_pending` intent as `confirmed | still_pending | identity_mismatch | unreachable` using an injected confirmation-grade reader (never Firestore/IndexedDB directly — fully unit-testable). Full frozen-identity match (branch/staff/device + every drawer total) before ever confirming; device-scoped (only this device's own intents); idempotent (a non-`local_closed_pending` entry short-circuits with no network call).
- `shiftService.ts`: `readShiftCloseConfirmation` (production reader, `getDocFromServer` — bypasses `persistentLocalCache`, same rationale as `asyncOrderLookup.ts`) and `normalizeShiftCloseSyncState` (Variant C's one-field `syncState:'synced'` writer). `closeShift` now returns `whenServerConfirmed: Promise<ShiftCloseConfirmation>` alongside the frozen snapshot: once the queued write ACKs, it triggers a confirmation-grade reconciliation (the SAME one boot/reconnect use) that performs the actual journal transition — the ACK promise alone never marks the journal `synced` or claims a server time. This fire-and-forget chain always runs regardless of whether any caller awaits the handle. Close-write payload, drawer math, and fail-fast paths are unchanged from 7C-B1.
- `ShiftModals.tsx` (+`.css`): Z-report sync badge is now reactive — pending → confirmed (server-recorded close time) once `whenServerConfirmed` resolves; a purely computed, age-ticking **stale** state (10-minute threshold, unchanged from 7C-B1's `isStaleClosePending`); an **attention** state for a genuine write rejection or a confirmed identity mismatch. New `ShiftBootBlockedModal` — an honest, unverifiable/attention dialog for the boot fail-closed state below.
- `POSPage.tsx`: (a) **RC-3 fix** — the boot guard's non-ok `getCloseIntent` branch now fails **closed** (`shiftBootBlocked`) instead of re-opening the shift into a live drawer; `shiftBootBlocked` also suppresses `OpenShiftModal` so no replacement-open is offered while unverifiable. (b) Boot sweep — runs `runShiftCloseReconciliationSweep` once behind `shiftReady`, non-blocking. (c) Reconnect sweep — re-runs the same sweep on the browser `online` event; single listener, cleaned up on unmount.
- Tests: new `shiftCloseReconciler.test.ts` (18 tests, pure), extended `shiftService.test.ts` (+8 tests for `whenServerConfirmed`/reconciliation), extended `ShiftModals.test.tsx` (+11 tests for the new badge states + `ShiftBootBlockedModal`), new focused `POSPage.shift-boot-reconciliation.test.tsx` (7 tests for the RC-3 fail-closed guard + sweep wiring). `POSPage.hold-bill-interaction.test.tsx`'s mock harness was extended (not behaviorally changed) to keep mocking `ShiftModals`/`shiftService`/`shiftCloseIntentStore` complete after the new imports — required for that pre-existing suite to keep passing, not a scope expansion.

**Variant C normalization guardrails (as implemented):** normalizes only when the confirmation-grade doc currently has `syncState==='pending'` AND the doc's `deviceId` matches this device; writes ONLY `syncState:'synced'` (no `closedAt`/`closedOffline`/status/identity/totals/variance touched); best-effort, no-guaranteed-retry (an already-`synced` journal entry is never re-swept, matching the Codex review's explicit "do not overclaim retry" guardrail).

**Not touched:** `shiftLedger.ts`, `localLedger.ts`, `useLocalLedger.ts`, drawer/variance math, `functions/**`, `firestore.rules`, `firestore.indexes.json`, `PaymentModal.*`, checkout/Sale Intent Journal write paths.

**Packet 5 boundary (unchanged):** not implemented; 7C-B2 only *flags* an identity mismatch (`rejected_manual_attention`) — it never adjudicates, never claims cross-device/global correctness, never performs server-authoritative drawer math.

### P1 Packet 7C-B1 Local Optimistic Offline Close (CLOSED — COMMITTED — PUSHED)

**Status:** CLOSED / COMMITTED / PUSHED at `1e41b0e` (`feat(pos): add local optimistic shift close`). Post-commit UAT: PASS WITH NOTES (`...QA\twinpet-p1-offline-sync-packet-7c-b1-post-commit-uat-evidence-report.md`) — confirmed the "perpetual pending" gap that 7C-B2 above fixes.

**Delivered:**
- Durable local close-intent store keyed by `shiftId` (`src/lib/pos/offline/shiftCloseIntentStore.ts` + `shiftCloseIntentTypes.ts`) — idempotent upsert, conflict-safe (a differing snapshot for the same shift is never silently overwritten), fail-fast on IndexedDB unavailable/quota (no cache-only fallback).
- `closeShift()` (`src/lib/pos/shiftService.ts`) rewritten: cache-only verification (`getDocFromCache`, never awaits the network) — cold/stale/unverifiable cache or an already-closed cached shift fails fast, no fabricated close; persists the close-intent; queues a non-awaited shift-doc `updateDoc` that includes `closedAt: serverTimestamp()` (the persisted doc keeps its canonical, authoritative server close time — 7C-B1 has no boot/reconnect worker to back-fill it later, so it must be enqueued here) plus `closedOffline`, `syncState:'pending'`, `deviceId` (reusing existing `Shift` fields); returns a client-built frozen closed snapshot immediately. The RETURNED local snapshot's `closedAt` is never back-filled with a fake device timestamp (`serverTimestamp()` is a write-only sentinel, not a readable value) — a new optional `closedAtLocal?: number` field (`src/lib/types.ts`) carries the honest device time for display until a later fetch reads the real server value back. (Codex REQUEST CHANGES remediation, `TWINPET-P1-OFFLINE-SYNC-PACKET-7C-B1-CODEX-REQUEST-CHANGES-REMEDIATION-CLAUDE-001`: the first implementation pass omitted `closedAt` from the queued write and wrote an unused `closedAtServer:null` mirror field instead — fixed; `closedAtServer` is no longer written by `closeShift`.)
- `ShiftModals.tsx`: `handleClose` — the 7C-A hard offline block is removed (replaced by the optimistic local-close path); the one-shot guard and the 10s timeout remain as a defensive backstop for the online-but-unreachable edge, not the primary offline path. `ZReportView` renders a pending-sync badge + device-time label (`(เวลาเครื่อง)`) whenever `closedOffline && syncState === 'pending'`.
- `POSPage.tsx` boot: cross-checks the local close-intent store against the fetched active shift — if this device already closed the shift locally, it is never re-opened / re-folded into a live drawer, even if the cached shift doc still momentarily reads `open`.

**7C-B1 limitations (as shipped at `1e41b0e`; the reliability gap below is what Packet 7C-B2 above now addresses, pending its own Codex review/commit):**
- No reliable post-reload `server_acknowledged` / `rejected` transition from 7C-B1 alone — same-runtime write-promise observation was best-effort only. 7C-B2 (this pass, uncommitted) adds the boot/reconnect reconciliation sweep and the same-runtime `whenServerConfirmed` handle.
- Pending close-intents can be read as stale (`isStaleClosePending`, 10-minute threshold) — a purely computed display concern, not a stored transition; 7C-B2 gives it a real Z-report UI surface (the `stale` badge).

**Packet 5 boundary (unchanged):** not required before honest local pending close; required for backend validation/audit/settlement/cross-device authority — **not implemented**. Backend must not mutate/recompute `shifts.expected*`.

**Not touched:** `shiftLedger.ts`, `localLedger.ts`, `useLocalLedger.ts`, drawer/variance math, `functions/**`, `firestore.rules`, `firestore.indexes.json`, `PaymentModal.*`, checkout/Sale Intent Journal write paths, Packet 7A warning behavior.

**Re-review report (architecture basis):** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\reviewer\twinpet-p1-offline-sync-packet-7c-b-true-offline-close-architecture-codex-re-review-report.md`

**Packet 5 boundary:**
- Packet 5 **not** required before honest local pending close
- Packet 5 **required** for backend validation/audit/settlement/cross-device authority
- Backend must not mutate/recompute `shifts.expected*`
- Packet 5 is audit/alert over frozen client snapshot — not server-authoritative drawer math
- Packet 5 is **not implemented**

### P1 Packet 7C-A Offline-Safe Close-Shift UX Guard (prior — CLOSED / COMMITTED / PUSHED)

**Status:** CLOSED / COMMITTED / PUSHED.

**Commit:** `34a3d24de69751d3bdf9c9ace0cc8cf491845265` — `fix(pos): guard offline shift close ux`

**Delivered (temporary UX stopgap only):**
- Fail-fast pre-close offline guard + bounded 10s timeout backstop
- Roadmap update for 7C-B / Packet 5 priority
- `shiftService.ts`, `closeShift`, shift math, drawer totals, variance, Z-report totals **not modified**

**Limitation:** 7C-A does **not** implement true optimistic offline close.

### P1 Packet 7A shift close warning (prior — CLOSED / DOCS CLOSED)

**Implementation:** `cb2e9ef` — `feat(pos): warn on pending sync before closing shift`

**Docs:** `74a84c3` — `docs: close p1 packet 7a shift warning`

Non-blocking this-terminal pending-sync warning; close remains enabled.

### No-overclaim boundaries

- Do not claim backend accepted/settled/synced while pending
- Do not claim reliable post-reload ack/rejection outside the honest confirmation-grade conjunction (`getDocFromServer` + resolved `closedAt` + full identity match) 7C-B2 implements
- Do not claim Packet 5 implemented
- Do not claim cross-device/global correctness
- 7C-A is superseded by 7C-B1 for the close path — no longer the active offline-close guard
- 7C-B2 only *flags* an identity mismatch — it never adjudicates which side is correct (Packet 5's role)

### Prior closed packets

- **Packet 7C-B1** — `1e41b0e` (superseded for reliability by 7C-B2, this pass — uncommitted)
- **Packet 7C-A** — `34a3d24` (superseded by 7C-B1's optimistic close path)
- **Packet 8** — dev-emulator drill PASS WITH NOTES; docs `6526970`
- **Packet 6** — `81d8a20` + `2a98f33` + docs `8197d64`

### Deferred / next gate

1. **This pass:** Packet 7C-B2 Close-Intent Reconciliation — implemented + Codex-FAIL-remediated, unstaged; build path now green
2. Codex 7C-B2 implementation re-review
3. Gemini commit authorization
4. Next roadmap priority after 7C-B2: **Packet 5** (backend validation/audit/settlement/cross-device authority)

### Other deferred

- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Packet 7B** admin reconciliation — after Packet 5/backend clarity
- **PaymentModal W-12** — deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred
- Sale Intent Journal is sidecar-only — not source of truth
