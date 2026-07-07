# Latest Report — P1 Offline / Sync Packet 3B-2 Atomic Device Sequence Allocator

> Date: 2026-07-07
> HEAD: `30c32cd2f927a080b9729567bfa2f9f6f0832c16`
> origin/main: `30c32cd2f927a080b9729567bfa2f9f6f0832c16`
> Status: **P1 PACKET 3B-2 CLOSED / PUSHED**

---

## Summary

P1 Offline / Sync Packet 3B-2 is **closed and pushed** at `30c32cd feat(pos): add atomic device sequence allocator`. Added unwired `allocateLocalSeq()` primitive with IndexedDB readwrite transaction correctness and bounded fail-open fallback to legacy `nextLocalSeq()`. No checkout integration; `allocateOrderIdentity()` deferred to 3B-3.

Previous HEAD: `8ce68d3 docs: reconcile p1 offline sync packet 3a-2b closure`

## Scope Delivered (2 files)

- `src/lib/pos/deviceId.ts` — `allocateLocalSeq(): Promise<number>`
- `src/lib/pos/deviceSeqAllocator.test.ts` — 18 tests

## Allocator Behavior

- IndexedDB database: `twinpet-device`; object store: `kv`; key: `deviceSeq`
- `get` + `put` inside one readwrite transaction
- Next sequence: `max(sanitizedIdbSeq, sanitizedLocalStorageSeq, 0) + 1`
- Invalid bases sanitized: missing / non-numeric / NaN / negative / non-finite
- localStorage mirror updates only after successful IDB commit
- Bounded fail-open fallback to legacy `nextLocalSeq()` — IDB unavailable, open error, blocked/hung/never-settling open, transaction failure; does not throw
- Legacy `nextLocalSeq()` remains behavior-compatible
- Existing public APIs compatible: `getDeviceId()`, `nextLocalSeq()`, `peekLocalSeq()`, `setDeviceIdentity()`, `initDeviceIdentity()`, `makeAsyncOrderId()`, `getReceiptDeviceSegment()`
- `allocateOrderIdentity()` deferred to 3B-3 (billId.ts / Firebase import chain boundary)
- No production checkout call-site

## Explicit Non-Scope

- No checkout integration; no `useCheckout` / `asyncCheckout` changes
- No asyncOrders runtime behavior change; no receipt format change; no asyncOrder ID shape change
- No Sale Intent Journal behavior change
- No Web Locks; no BroadcastChannel; no Firestore reads/writes
- No rules/functions/package/config changes; no docs tracker changes in implementation commit
- No 3B-3 work

## Prior Phases

| Packet | Commit | Status |
|--------|--------|--------|
| Packet 3A-2B Startup Sweep Boot | `cde8226` + docs `8ce68d3` | CLOSED / PUSHED |
| Packet 3A-2A Lookup Adapter | `535073e` + docs `944acfc` | CLOSED / PUSHED |
| Packet 3A-1 Sweep Primitives | `421d368` + docs `09cace8` | CLOSED / PUSHED |
| Packet 2 Runtime Observer | `d500bf9` + docs `371b537` | CLOSED / PUSHED |
| Packet 1 Sale Intent Journal | `3fe056e` + docs `644dc85` | CLOSED / PUSHED |

## Validation

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `deviceSeqAllocator.test.ts` | 18/18 |
| Vitest subtotal | 150/150 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS (CRLF advisory only) |
| Codex review | PASS WITH NOTES (no blocking findings) |
| Push | PASS — plain `git push origin main`; no force |
| stash@{0} | untouched |

## Codex Non-Blocking Notes (Carried Forward)

1. 3B-2 intentionally unwired; checkout still uses `nextLocalSeq()` until 3B-3.
2. Late IDB callbacks after timeout/fallback can advance IDB mirror with harmless gaps; no duplicate/regression risk.
3. IDB degraded fallback and mixed old/new tab bundles may carry legacy race after future integration — UAT/release guidance.
4. `allocateOrderIdentity()` appropriately deferred to 3B-3.
5. `git diff --check` CRLF advisory only.

## Deferred / Next Gate

**3B-3 Decision Gate — NOT STARTED.** Gemini may choose:

- Authorize 3B-3 checkout preallocation integration planning/implementation gate
- Authorize additional 3B-2 degraded-mode tightening if desired
- hold

## Docs Reconciliation

Separate docs-only pass (TWINPET-P1-OFFLINE-SYNC-PACKET-3B-2-DOCS-RECONCILIATION-CLAUDE-001). Not part of pushed commit `30c32cd`.
