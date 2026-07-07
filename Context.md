# Twinpet POS — Project Context

> Last reconciled: 2026-07-07
> HEAD: `30c32cd2f927a080b9729567bfa2f9f6f0832c16`
> origin/main: `30c32cd2f927a080b9729567bfa2f9f6f0832c16`

---

## Current Phase

**P1 Offline / Sync Resiliency — Packet 3B-2 Atomic Device Sequence Allocator: CLOSED / PUSHED**

Manual workflow remains active. `agentchattr` was not used as the executor for this phase.

### P1 Packet 3B-2 pushed commit

| Hash | Message |
|------|---------|
| `30c32cd` | feat(pos): add atomic device sequence allocator |

Previous HEAD: `8ce68d3` — docs: reconcile p1 offline sync packet 3a-2b closure

### P1 Packet 3B-2 scope (2 files)

- `src/lib/pos/deviceId.ts` — `allocateLocalSeq()` primitive
- `src/lib/pos/deviceSeqAllocator.test.ts` — allocator tests

### P1 Packet 3B-2 behavior

- Added `allocateLocalSeq(): Promise<number>` — unwired atomic local sequence allocator primitive
- IndexedDB readwrite transaction is the correctness primitive
- IndexedDB database: `twinpet-device`; object store: `kv`; key: `deviceSeq`
- `get` + `put` performed inside one readwrite transaction
- Next sequence: `max(sanitizedIdbSeq, sanitizedLocalStorageSeq, 0) + 1`
- Invalid sequence bases sanitized: missing / non-numeric / NaN / negative / non-finite
- localStorage mirror updates only after successful IDB commit
- Bounded fail-open fallback to legacy `nextLocalSeq()` — covers IDB unavailable, open error, blocked/hung/never-settling open, and transaction failure; fallback does not throw to callers
- Legacy `nextLocalSeq()` remains available and behavior-compatible
- Existing public APIs remain compatible: `getDeviceId()`, `nextLocalSeq()`, `peekLocalSeq()`, `setDeviceIdentity()`, `initDeviceIdentity()`, `makeAsyncOrderId()`, `getReceiptDeviceSegment()`
- `allocateOrderIdentity()` deferred to 3B-3 due boundary concern with `billId.ts` / Firebase import chain
- No production checkout call-site yet

### Explicit non-scope (3B-2)

- No checkout integration; no `useCheckout` / `asyncCheckout` changes
- No asyncOrders runtime behavior change; no receipt format change; no asyncOrder ID shape change
- No Sale Intent Journal behavior change
- No Web Locks; no BroadcastChannel; no Firestore reads/writes
- No rules/functions/package/config changes; no docs tracker changes in implementation commit
- No 3B-3 work

### Prior — Packet 3A-2B Startup Sweep Boot Wiring

| Hash | Message |
|------|---------|
| `cde8226` | feat(pos): add startup sale intent sweep wiring |
| `8ce68d3` | docs: reconcile p1 offline sync packet 3a-2b closure |

### Validation (P1 Packet 3B-2)

| Check | Result |
|-------|--------|
| `npm run build` | PASS |
| `deviceSeqAllocator.test.ts` | 18/18 |
| Vitest subtotal | 150/150 |
| `npm run test:rules` | 119/119 |
| `git diff --check` | PASS (CRLF advisory only) |
| Codex implementation review | PASS WITH NOTES (no blocking findings; commit-ready confirmed) |
| Push | PASS — HEAD == origin/main == `30c32cd` |

### Codex non-blocking notes (carried forward)

1. 3B-2 is intentionally unwired; current checkout still uses `nextLocalSeq()` until 3B-3.
2. Late IDB callbacks after timeout/fallback can advance the IDB mirror and create harmless gaps; no duplicate/regression risk identified.
3. IDB degraded fallback and mixed old/new tab bundles can still carry the legacy race after future integration; carry into UAT/release guidance.
4. `allocateOrderIdentity()` appropriately deferred to 3B-3.
5. `git diff --check` had only CRLF advisory.

### Deferred / next gate

**3B-3 Decision Gate** — Gemini may choose:

- Authorize 3B-3 checkout preallocation integration planning/implementation gate
- Authorize additional 3B-2 degraded-mode tightening if desired
- hold

**Deferred (not fixed):** Pre-existing old offline queue UI state bugs.

### Other deferred

- **UI-11 Packet 2** — NOT STARTED
- **UI-10-D** — NOT STARTED
- **Printer / Thermal** — cancelled/deferred

### Known technical debt (unchanged)

- PaymentModal focus trap — deferred; see UI_MASTER_PLAN backlog
- Old offline queue UI state bugs — deferred (acknowledged at 3A-2B UAT)
