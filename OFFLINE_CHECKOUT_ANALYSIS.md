# OFFLINE_CHECKOUT_ANALYSIS.md
### Architecture Analysis — TRUE Offline-First Async Checkout (Eventual Consistency)

> **Status:** Analysis only. No implementation written.
> **Builds on:** `PWA_RISK_ASSESSMENT.md` (which established that `completePosSale` is a `runTransaction` and cannot run offline).
> **Code grounding:** `src/lib/fifo.ts` (`completePosSale` :275, tx :308), `src/lib/pos/billId.ts` (shared counter `settings/system/docCounters/{PREFIX_YYMMDD}`), `src/lib/types.ts` (`Order`, `OrderItem`, `StockLot`, `ProductStock`, `PosDevice` :609, `Shift`), `OVERSELL_LOT_ID` (already in `fifo.ts`).

---

## 0. The Core Architectural Shift (one paragraph)

Today checkout is **synchronous and server-authoritative**: one `runTransaction` reads the shared receipt counter + shift + stock + FIFO lots and writes everything atomically. Offline this throws. The new model **inverts the trust boundary**: the client writes an **immutable "sale intent"** order document using *only queueable operations* (no `runTransaction`, no server reads), with a **client-generated id and bill number**; the heavy, conflict-prone work (definitive FIFO lot cutting, stock decrement, credit posting, shift roll-ups) is moved to a **Cloud Function reconciler** triggered `onCreate`. The order has a lifecycle: **`pending_sync` → (flush) → `pending_reconcile` → `settled` | `exception`**. The receipt the customer holds is final at sale time; the *ledger* settles eventually.

---

## 1. End-to-End Roadmap (where to start, where to end)

**Build the reconciler Cloud Function FIRST — not the client refactor.** The reconciler is the new consistency boundary and the riskiest code (FIFO + idempotency + concurrency). Building it first, against hand-seeded order docs in the emulator, lets us prove the hard part in isolation before the client can even produce the docs. The client refactor then targets a *known, tested contract*.

| Phase | Step | Why / Exit criteria |
|---|---|---|
| **P0 — Contract** | Define the offline-writable **`Order` intent schema**: client `orderId` (= idempotency key), client `billId` (device-segmented, §4), `deviceId`, `shiftId`, `lines[]` with frozen prices, `payments[]`, `reconcileStatus`, `clientCreatedAt` + `serverCreatedAt`. Decide the state machine. | A written schema both client & CF agree on. No code yet depends on it. |
| **P1 — Reconciler CF** | `onCreate(orders/{orderId})` Cloud Function that, **idempotently** and inside a **server-side** `runTransaction`, does what `completePosSale` does today: validate shift, FIFO-cut lots (reusing `planFifoCut`/`OVERSELL_LOT_ID` logic), decrement `productStocks`, post credit (`creditAccounts`/`creditTransactions`), roll up shift totals, set `reconcileStatus: 'settled'` (or `'exception'`). | Emulator unit tests pass with **seeded** order docs, incl. duplicate delivery, oversell, missing shift, credit. |
| **P2 — Client checkout refactor** | Replace `completePosSale`'s `runTransaction` with a **single `setDoc`/`writeBatch`** that writes the order + items with a **deterministic `orderId`** and a **device-local bill number**. No server reads. Print the receipt from the client-final `billId`. | Online E2E: sale writes intent, CF settles within seconds, stock/credit/shift match the old path exactly (shadow-compare). |
| **P3 — Offline UX & local ledger** | Local **optimistic stock decrement** for the session; a **"pending sync" indicator** + per-order sync state; durable local queue (Firestore persistence already provides this); shift totals computed **including local pending orders**. | DevTools-offline: complete a sale, hand goods, reconnect → settles, no double-ring, indicator clears. |
| **P4 — Device & numbering** | Implement the chosen **Device ID strategy** (§4) + device-segmented numbering + per-device local sequence (durable). | Two terminals, **both offline**, same branch/day → zero bill collisions after sync. |
| **P5 — Voids/refunds & shift close** | Make void/refund **async-safe** (cancel a still-`pending` intent vs. CF-reverse a `settled` order); gate or annotate **shift close** for pending orders (§2). | Void a pending order and a settled order; close a shift with a pending order — totals stay correct. |
| **P6 — Exceptions & audit** | Build an **admin reconciliation/exceptions view**: negative-stock events, oversell lots, unsettled orders, stale devices. Add a **scheduled sweeper** CF to retry/escalate stragglers. | Admin can see & action every non-`settled` order. |
| **P7 — Shadow → Cutover** | Run async path in **shadow** (write intent + still run old tx) on one branch; compare ledgers; then flip to async-authoritative per branch. | Reconciled vs. legacy figures match on a real branch for N days. |

**Testing strategy throughout:** Firestore + Functions **emulators**; unit tests for the reconciler (FIFO, idempotency, oversell, credit); a **duplicate-delivery** test (CF fires twice); a **two-offline-terminals** collision test; **clock-skew** test; DevTools offline simulation for the client; shadow-compare in staging.

---

## 2. Completeness & Blind Spots

The async plan is **directionally complete but has several retail/agri blind spots** that must be designed for, not discovered in production:

- **Voids & refunds on async orders.** A void can land while the order is still `pending`/`pending_reconcile`. Voiding must **cancel the intent** (so the CF never settles it) — *not* let it settle and then reverse, which risks double stock movement. After `settled`, void = CF-driven reversal (reuse `voidOrder` logic server-side). **Refunds** (partial returns with restock + credit note) don't exist yet and interact badly with unsettled orders. **Decision: voids on `pending` orders must be a tombstone the CF honors.**
- **Shift cash reconciliation vs. delayed sync.** Shift expected totals are rolled up at sale time today. If a sale **syncs after the shift is closed** (device offline through close), the closed shift's variance is wrong. Options: (a) **block shift close until the device's local queue is empty** (simplest, recommended), and/or (b) compute shift totals from **orders tagged `shiftId` including local pending**, and let the CF post into an *open* shift only. **This is the single most likely operational bug.**
- **Local stock drift / oversell visibility.** POS stock comes from the static Light-Path snapshot. Offline sales don't decrement it until refresh, so a cashier can keep selling the same last bag across terminals → **negative stock** (handled by `OVERSELL_LOT_ID`, but invisible until reconcile). Need **session-local optimistic decrement** + an oversell audit (§3).
- **Credit-limit enforcement offline.** Can't verify a customer's live balance/limit offline → a farmer can exceed their credit limit. **Decide soft (warn, allow) vs. hard (block credit offline).** Agri context leans soft, but needs an exceptions report.
- **Receipt number printed ≠ ledger number.** If the server ever **renumbers**, the printed receipt mismatches the record. **Decision (strongly recommended): the client-generated, device-segmented number is FINAL/authoritative** — the CF never renumbers it. (See §4.)
- **Thai tax-invoice (ใบกำกับภาษี) sequential numbering.** RD compliance generally requires **gapless sequential** tax-invoice numbers — fundamentally incompatible with offline device-segmented numbering. **Decision: separate the sales receipt (offline-OK, device-segmented) from the tax invoice (issued online-only, server-sequential).**
- **COGS/profit at sale time.** FIFO cost is computed at reconcile, not at sale — so the offline receipt can't show profit, and profit reports lag until settled. Acceptable, but reports must distinguish `pending` vs `settled`.
- **Lost/destroyed device with unsynced sales.** A dropped/wiped iPad loses any sales not yet flushed. Persistence (IndexedDB) helps, but a destroyed device = real data loss. **Business risk to accept explicitly**, plus a "stale device with pending orders" alert.
- **Clock skew.** Device clock drives `billId` date segment and counterKey. Keep `serverCreatedAt` (serverTimestamp) authoritative for ledger ordering; treat client time as display-only.

---

## 3. Risk Assessment of Eventual Consistency

| Risk | Detail | Mitigation |
|---|---|---|
| **Negative stock tolerance** | Offline sales bypass the synchronous stock guard; concurrent terminals oversell. `fifo.ts` already supports oversell via `OVERSELL_LOT_ID` + `allowNegativeStock`. | Make oversell an **explicit, logged** outcome: CF writes an oversell `StockMovement`/ghost lot and flags the order `hadOversell`. **Admin audit:** a "Negative Stock / Oversell" report listing product, branch, qty, device, time — so managers reconcile physical counts. Per-product/branch policy for whether offline oversell is even allowed. |
| **Duplicate syncs / idempotency** | Firestore's offline queue is ~exactly-once on flush, **but CF triggers are at-least-once** (can fire >1×). Multi-tab/retries could also re-emit. | **Two layers:** (1) **Deterministic `orderId`** = `deviceId + localSeq` so a client retry overwrites the *same* doc (no duplicate intent). (2) CF reconcile is **idempotent**: inside its transaction, check `reconcileStatus`/`reconciledAt`; if already settled, **no-op**. The receipt counter is never touched by the CF (client owns the number), removing that contention entirely. |
| **CF cold starts / failures** | Cold start adds latency (seconds) — acceptable for async. A failed reconcile leaves an order `pending_reconcile`. | CF **retries on throw** (idempotent, so safe). Add a **scheduled sweeper** that re-triggers orders stuck `> N min`, and a **dead-letter/`exception`** state surfaced in the admin view. Per-product stock decrement uses a **server-side transaction** (server has connectivity) to serialize concurrent reconciles safely. |
| **Consistency window** | Between sale and settle, stock/credit/shift/profit are **provisional**. Reports can show transient drift. | Make `pending` vs `settled` **first-class** in every report/dashboard; never silently mix them. Show a small "X sales syncing" indicator for managers. |
| **Cross-terminal contention at reconcile** | Many terminals reconciling the same hot product. | Server-side transactions serialize per-`productStocks` doc; throughput is fine because it's server-to-server. |
| **Ordering / fairness** | Two offline sales of the last unit both succeed; FIFO/oversell decided at reconcile by arrival order, not sale order. | Accept it (oversell ghost lot covers it); audit report makes it visible. Optionally order reconcile by `clientCreatedAt`. |

---

## 4. Crucial Upfront Decisions (before any code)

### 🎯 CRITICAL — Device ID / Terminal ID strategy (drives the whole numbering scheme)

**Why this is the lynchpin:** receipt numbers today come from a **single shared counter** at `settings/system/docCounters/{PREFIX_YYMMDD}`, incremented atomically inside the checkout transaction (`billId.ts:124-160`). Two terminals serialize through that doc. **Offline, that coordination is impossible** — so the bill number must become **collision-free without any server round-trip**. The way to do that is to embed a **device segment** so each terminal owns its own number space:

```
[PREFIX]-[YYMMDD]-[DEVICE]-[LOCAL_SEQ]      e.g.  RCP-260602-LDP01-0007
```

Each device keeps its **own durable local counter**; `(branch+date+device+localSeq)` is globally unique with zero coordination. The three viable strategies for the `DEVICE` segment:

| | **Strategy A — Admin-Registered Devices** | **Strategy B — Auto-Generated UUID** | **Strategy C — Hybrid (recommended)** |
|---|---|---|---|
| **How** | Admin UI registers each terminal in the existing **`posDevices`** collection with a short human code (`LDP-01`, `LDP-02`). Device "claims" its code on first launch (stored in localStorage **+ IndexedDB**). | Device self-generates a UUID/nanoid on first run, persists locally, best-effort registers to `posDevices`. Bill uses a short hash of it. | Device self-generates a **durable UUID (identity)** on first run and registers to `posDevices`; admin later assigns a **friendly short code + compact per-branch ordinal** (1,2,3) used in the bill. Until labeled, fall back to a short UUID hash. |
| **Receipt readability** | ✅ Human (`LDP01`) | ❌ Opaque (`A7F3`) | ✅ Human once labeled, safe before |
| **Setup friction** | ⚠️ Manual claim per device | ✅ Zero-touch | ✅ Zero-touch identity, label later |
| **Collision safety** | ✅ if admin disciplined (token-locked claim) | ✅ astronomically low | ✅ guaranteed instantly (UUID), readable later |
| **Audit ("which iPad?")** | ✅ strong | ⚠️ needs a mapping screen | ✅ strong |
| **localStorage wipe / PWA reinstall** | ⚠️ must re-claim (could double-claim a code if careless) | ⚠️ becomes a **new** device id (no collision, but orphaned sequence) | ✅ re-registers new UUID; admin relabels; sequences stay unique |
| **Uses existing `PosDevice` model** | ✅ directly (`id/name/token`) | ⚠️ partially | ✅ directly |

**Recommendation: Strategy C (Hybrid).** It guarantees uniqueness the instant a device powers on (no onboarding race — critical when "a new iPad is added to a branch" mid-shift), keeps receipts human-readable for audits, and degrades gracefully if local storage is wiped. It reuses the `posDevices` collection that already exists in the schema. **Durability note for all strategies:** persist the device id and its local sequence in **both** localStorage **and** IndexedDB, because a PWA cache clear can wipe localStorage — losing the local sequence would risk re-using numbers on that device.

### Other decisions Khun Chat must make now

1. **Authoritative number = client (recommended).** The CF must **never renumber** a settled order, or printed receipts won't match the ledger. Confirm.
2. **Negative-stock policy offline:** allow oversell globally, per-product (`allowNegativeStock`), or per-branch? Default for agri?
3. **Credit offline:** soft (warn + allow over-limit) vs. hard (block credit sales offline)?
4. **Shift close with pending orders:** **block close until local queue flushes** (recommended) vs. allow + reconcile into the closed shift?
5. **Tax invoice (ใบกำกับภาษี):** issue **online-only with server-sequential numbers**, separate from the offline sales receipt? (Strongly recommended for RD compliance.)
6. **Max offline window / "stale device with unsynced sales" alert threshold**, and explicit acceptance of **lost-device data risk**.
7. **Reconcile ownership:** who monitors the exceptions dashboard, and the sweeper SLA (e.g., escalate orders unsettled > 15 min)?

---

## ✅ Conclusion & Question for Khun Chat

The migration is feasible and the roadmap is **build-reconciler-first → refactor-client → device numbering → voids/shift → exceptions → shadow → cutover**, with eventual-consistency risks (oversell, idempotency, cold starts) all mitigable via deterministic order ids, idempotent server-side reconciliation, and an admin exceptions view. The **device-segmented receipt number** is the keystone that makes offline numbering collision-free.

**The single decision that unblocks everything else is the Device ID strategy. Khun Chat — which do you prefer: A (Admin-Registered), B (Auto-UUID), or C (Hybrid, recommended)?**

Once you choose, I'll fold it into a concrete P0 schema + P1 reconciler design for your approval before any code is written.
