# Twinpet POS — Project Context

> Last reconciled: 2026-07-09
> HEAD: `9d4b811a1622fdefacbf76a2e5800b194b6161d9` (Packet 7C-B1 implementation this pass is unstaged, on top of this HEAD)
> origin/main: `9d4b811a1622fdefacbf76a2e5800b194b6161d9`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 7C-B1 Local Optimistic Offline Close: IMPLEMENTED (uncommitted) — pending Codex implementation review**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

**Repository baseline (pre-implementation):** branch `main`, HEAD/origin `9d4b811`, working tree **clean**, staged **empty**, `stash@{0}` present and untouched. Implementation this pass is **unstaged**.

### P1 Packet 7C-B1 Local Optimistic Offline Close (implemented — not committed)

**Status:** Implemented per the authorized Option 2 architecture (Codex re-review PASS WITH NOTES). Not staged, not committed, not pushed. Next gate: Codex implementation review → Gemini commit authorization.

**Delivered:**
- Durable local close-intent store keyed by `shiftId` (`src/lib/pos/offline/shiftCloseIntentStore.ts` + `shiftCloseIntentTypes.ts`) — idempotent upsert, conflict-safe (a differing snapshot for the same shift is never silently overwritten), fail-fast on IndexedDB unavailable/quota (no cache-only fallback).
- `closeShift()` (`src/lib/pos/shiftService.ts`) rewritten: cache-only verification (`getDocFromCache`, never awaits the network) — cold/stale/unverifiable cache or an already-closed cached shift fails fast, no fabricated close; persists the close-intent; queues a non-awaited shift-doc `updateDoc` that includes `closedAt: serverTimestamp()` (the persisted doc keeps its canonical, authoritative server close time — 7C-B1 has no boot/reconnect worker to back-fill it later, so it must be enqueued here) plus `closedOffline`, `syncState:'pending'`, `deviceId` (reusing existing `Shift` fields); returns a client-built frozen closed snapshot immediately. The RETURNED local snapshot's `closedAt` is never back-filled with a fake device timestamp (`serverTimestamp()` is a write-only sentinel, not a readable value) — a new optional `closedAtLocal?: number` field (`src/lib/types.ts`) carries the honest device time for display until a later fetch reads the real server value back. (Codex REQUEST CHANGES remediation, `TWINPET-P1-OFFLINE-SYNC-PACKET-7C-B1-CODEX-REQUEST-CHANGES-REMEDIATION-CLAUDE-001`: the first implementation pass omitted `closedAt` from the queued write and wrote an unused `closedAtServer:null` mirror field instead — fixed; `closedAtServer` is no longer written by `closeShift`.)
- `ShiftModals.tsx`: `handleClose` — the 7C-A hard offline block is removed (replaced by the optimistic local-close path); the one-shot guard and the 10s timeout remain as a defensive backstop for the online-but-unreachable edge, not the primary offline path. `ZReportView` renders a pending-sync badge + device-time label (`(เวลาเครื่อง)`) whenever `closedOffline && syncState === 'pending'`.
- `POSPage.tsx` boot: cross-checks the local close-intent store against the fetched active shift — if this device already closed the shift locally, it is never re-opened / re-folded into a live drawer, even if the cached shift doc still momentarily reads `open`.

**7C-B1 limitations (explicit, preserved):**
- No reliable post-reload `server_acknowledged` / `rejected` transition — same-runtime write-promise observation is best-effort only. Reliable boot/reconnect reconciliation is **7C-B2 (not implemented)**.
- No automatic boot sweep/retry/replay.
- No cross-device shift authority, no backend settlement, no "synced/settled" claim while pending.
- Pending close-intents can be read as stale (`isStaleClosePending`, 10-minute threshold) — a purely computed display concern, not a stored transition; no dedicated stale-pending UI surface beyond the pure selector + its unit tests in this packet.

**Packet 5 boundary (unchanged):** not required before honest local pending close; required for backend validation/audit/settlement/cross-device authority — **not implemented**. Backend must not mutate/recompute `shifts.expected*`.

**Not touched:** `shiftLedger.ts`, `localLedger.ts`, `useLocalLedger.ts`, drawer/variance math, `functions/**`, `firestore.rules`, `firestore.indexes.json`, `PaymentModal.*`, checkout/Sale Intent Journal write paths, Packet 7A warning behavior.

**Re-review report (architecture basis):** `C:\Users\Narachat\OneDrive\Ai-Report\twinpet-pos\reviewer\twinpet-p1-offline-sync-packet-7c-b-true-offline-close-architecture-codex-re-review-report.md`

**7C-B2 (future, not implemented):** Reliable boot/reconnect ACK/rejection reconciliation.

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
- Do not claim reliable post-reload ack/rejection exists before 7C-B2 implementation
- Do not claim Packet 5 implemented
- Do not claim cross-device/global correctness
- 7C-A is superseded by 7C-B1 for the close path — no longer the active offline-close guard

### Prior closed packets

- **Packet 7C-A** — `34a3d24` (superseded by 7C-B1's optimistic close path)
- **Packet 8** — dev-emulator drill PASS WITH NOTES; docs `6526970`
- **Packet 6** — `81d8a20` + `2a98f33` + docs `8197d64`

### Deferred / next gate

1. **This pass:** Packet 7C-B1 Local Optimistic Offline Close — implemented, unstaged
2. Codex 7C-B1 implementation review
3. Gemini commit authorization
4. Next roadmap priority after 7C-B1: **Packet 7C-B2** (reliable boot/reconnect ack/rejection reconciliation) + **Packet 5** (backend validation/audit/settlement/cross-device authority)

### Other deferred

- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Packet 7B** admin reconciliation — after Packet 5/backend clarity
- **PaymentModal W-12** — deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred
- Sale Intent Journal is sidecar-only — not source of truth
