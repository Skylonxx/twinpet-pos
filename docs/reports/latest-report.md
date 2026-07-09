# Latest Report — P1 Offline / Sync Packet 7C-B1 Local Optimistic Offline Close (Implementation + Codex Remediation)

> Date: 2026-07-09
> HEAD: `9d4b811a1622fdefacbf76a2e5800b194b6161d9`
> origin/main: `9d4b811a1622fdefacbf76a2e5800b194b6161d9`
> Status: **PACKET 7C-B1 IMPLEMENTED + REMEDIATED (uncommitted)** — pending Codex implementation re-review

---

## Summary

Packet 7C-B1 Local Optimistic Offline Close (Option 2) implemented per Gemini authorization (`TWINPET-P1-OFFLINE-SYNC-GEMINI-PACKET-7C-B1-IMPLEMENTATION-AUTHORIZATION-001`) and the corrected architecture (Codex re-review PASS WITH NOTES). `closeShift` no longer awaits the network: it verifies from the local cache only, persists a durable local close-intent, queues a non-awaited shift-doc write, and returns a frozen client-built snapshot immediately. Not staged, not committed, not pushed.

**Codex implementation review returned REQUEST CHANGES** (`...\reviewer\twinpet-p1-offline-sync-packet-7c-b1-local-optimistic-close-codex-review-report.md`): the queued shift-doc write omitted `closedAt: serverTimestamp()`, so a successfully-synced closed shift could persist with `status:'closed'` and `closedAt: null` forever (no 7C-B1 worker ever back-fills it). **Remediated** (`TWINPET-P1-OFFLINE-SYNC-PACKET-7C-B1-CODEX-REQUEST-CHANGES-REMEDIATION-CLAUDE-001`): the queued `updateDoc` now includes `closedAt: serverTimestamp()`, restoring the pre-7C-B1 baseline guarantee that the persisted doc gets a canonical server close time once the write flushes. The unused `closedAtServer:null` mirror field is no longer written (it had no reader and no path to ever become non-null). The RETURNED local snapshot's `closedAt` is unaffected — it still is never back-filled with a fake device timestamp; `closedAtLocal` remains the honest device-time display field until a later fetch reads the real server value back.

## Implementation

| Field | Value |
|-------|-------|
| Durable close-intent store | `src/lib/pos/offline/shiftCloseIntentStore.ts` + `shiftCloseIntentTypes.ts` — keyed by `shiftId`; idempotent upsert; a differing snapshot for the same shift is never silently overwritten (`conflict`); fails fast on IndexedDB unavailable/quota — no cache-only fallback |
| `closeShift` | `src/lib/pos/shiftService.ts` — cache-only verification (`getDocFromCache`); cold/stale/unverifiable cache or an already-closed cached shift fails fast (no fabricated close); queued non-awaited `updateDoc` includes `closedAt: serverTimestamp()` (canonical persisted close time) plus `closedOffline`, `syncState:'pending'`, `deviceId`; returns a frozen local snapshot whose `closedAt` is never back-filled with a fake device value |
| `Shift` type | `src/lib/types.ts` — new optional `closedAtLocal?: number` (honest device-time display field). Pre-existing `closedAtServer?` field is untouched but no longer written by `closeShift` |
| UI | `src/components/pos/ShiftModals.tsx` (+`.css`) — 7C-A hard offline block removed; one-shot guard + 10s timeout kept as a defensive backstop only; `ZReportView` shows a pending-sync badge + device-time label while `closedOffline && syncState === 'pending'` |
| Boot guard | `src/pages/POSPage.tsx` — cross-checks the close-intent store at boot; a locally-closed shift is never re-opened / re-folded into a live drawer |
| Tests | `shiftCloseIntentStore.test.ts` (17), `shiftService.test.ts` (12, incl. 2 new regression tests for the `closedAt: serverTimestamp()` fix), `ShiftModals.test.tsx` (17) — all passing; full suite 1143/1143 passing; `tsc --noEmit -p tsconfig.json` clean |

## 7C-B1 limitations (preserved, explicit)

- No reliable post-reload `server_acknowledged` / `rejected` transition. Same-runtime write-promise observation is best-effort only, never relied on.
- No automatic boot sweep/retry/replay.
- No cross-device shift authority, no backend settlement, no "synced/settled" claim while pending.
- Reliable boot/reconnect ACK/rejection reconciliation → **Packet 7C-B2 (not implemented)**.

## Packet 5 boundary

- Not required before honest local pending close.
- Required for backend validation/audit/settlement/cross-device authority.
- Backend must not mutate `shifts.expected*`.
- **Not implemented.**

## No-Overclaim

No backend accepted/settled/synced while pending. No reliable post-reload ack/rejection claimed. No Packet 5 implemented. No cross-device/global correctness claims. No backend/rules/functions changed.

## Red Zones

Untouched: `shiftLedger.ts`, `localLedger.ts`, `useLocalLedger.ts`, `calcShiftDrawerExpected`/variance formula, `functions/**`, `firestore.rules`, `firestore.indexes.json`, `package.json`/lockfiles, `firebase.json`, `PaymentModal.*`, checkout/Sale Intent Journal write paths, Packet 7A warning behavior. `stash@{0}` present and untouched.

## Next Gate

Codex 7C-B1 implementation review → Gemini commit authorization → Packet 7C-B2 / Packet 5 roadmap.
