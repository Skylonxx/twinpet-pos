 Local-First Re-Architecture Plan

  0. The paradigm shift in one sentence

  Today: the client writes to asyncOrders but reads from orders + server-incremented shift fields — so the server is
  the source of truth and the client is always waiting for it. Local-First inverts this: the local write-model 
  (asyncOrders in persistentLocalCache) becomes the source of truth for the terminal; the server-built orders 
  collection becomes a downstream projection for back-office/HQ reporting.

  The terminal never asks the cloud "what's my drawer / today's sales?" It already knows, from its own local ledger.
  The cloud is told, not asked.

  1. Do NOT introduce Dexie/RxDB. Use the local DB you already have.

  A tempting reading of "Local-First" is "rip out Firestore, store everything in IndexedDB via Dexie." I recommend 
  against it, because:

  - firebase.ts:49 already configures persistentLocalCache with CACHE_SIZE_UNLIMITED + multi-tab. That is an
  IndexedDB-backed local database with an automatic, durable, ordered write-queue and conflict-free
  flush-on-reconnect. It already holds the 10k-item catalog offline.
  - Adding Dexie creates a second local store and a second sync problem (Dexie ⇄ Firestore), doubling the bug
  surface and re-implementing exactly what Firestore offline already gives you (queued writes, retry, idempotent
  flush).
  - Your reconciler's idempotency design (deterministic ${deviceId}-${seq} id, at-least-once trigger,
  reconcileStatus guard) is built around Firestore docs. Keep it.

  So the "pivot" is not a new database — it's a discipline change: read from the write-model locally, treat the 
  server collections as a projection. (If you later want to fully divorce from the Firebase SDK — e.g. for a
  different backend — Dexie/RxDB + a custom sync engine is the path, but that's a much larger rewrite and out of
  scope for this goal.)

  2. Flip the source of truth for reads (the "local ledger selector")

  Introduce one local-ledger access layer the terminal reads from, backed by asyncOrders filtered to this device
  (the cache always has these, online or offline):

  - POS-side surfaces (Sales History on the terminal, today's totals, drawer): read the local ledger (asyncOrders
  where deviceId == thisDevice), normalized to a unified sale view. This is authoritative and instant, offline or
  online.
  - Back-office surfaces (Admin Dashboard, Profit Report, multi-branch analytics): keep reading the canonical orders
  projection. These are inherently online/eventually-consistent and that's acceptable.

  This cleanly dissolves the original problem: the cashier's Sales History/drawer comes from the local write-model
  (always shows offline sales); HQ analytics come from the projection. No "merge bandage," because we stop
  pretending orders is the terminal's truth.

  ▎ Note: the local ledger is naturally per-device, and that's correct — a drawer/shift belongs to one cashier on 
  ▎ one terminal. Multi-terminal branch-wide views are a back-office (online) concern, not a drawer concern.

  3. Local-First Shift Management (event-sourced drawer)

  The drawer balance must be a pure function of local data, never a server-incremented counter.

  What's wrong today

  - reconcileOrder.ts:395 increments the server shift doc's expectedCash/... on settle (server-owned, only happens
  online).
  - useCheckout.ts:87 also optimistically bumps expectedCash — but only in ephemeral React state, which is lost on 
  reload. So a cashier who reloads mid-shift while offline sees a wrong drawer until reconcile. That's the
  cloud-first friction, exactly.
  - closeShift (shiftService.ts:169) reads those server-incremented fields to compute variance.

  The local-first model

  Treat the shift as an event log, and compute the drawer as a derived value:

  drawerExpected =
      startingCash
    + Σ(cash component of local sales in this shift)   ← from the local asyncOrders ledger
    + Σ(pay_in)  −  Σ(pay_out)                          ← from shift.cashEntries[]

  Your Shift type is already designed for this and the fields are currently underused:
  - cashEntries?: ShiftCashEntry[] (types.ts:799) — embedded cash movements so the Z-report renders offline.
  - localOrderCount? (types.ts:801), openedOffline, closedOffline, openedAtServer, closedAtServer, syncState
  (types.ts:788-801) — the whole offline-shift scaffold exists.

  Concretely:
  1. Open writes the shift doc with a client openedAt + openedOffline: true + syncState: 'pending'; openedAtServer
  fills in on flush. Works from cache offline (getActiveShift's query resolves from cache).
  2. Cash in/out appends to the embedded cashEntries[] (queueable write) instead of relying on the server
  cashTransactions transaction (shiftService.ts:218 currently uses runTransaction — which is not offline-safe; this
  must change to a queueable append).
  3. The live drawer + Z-report are computed locally from startingCash + local ledger cash + cashEntries. The
  expected* fields on the doc become derived snapshots written at close time for HQ — never the authoritative live
  value.
  4. Close computes variance locally at close time and freezes the snapshot onto the doc with closedOffline /
  closedAtServer.

  Critical server change to avoid double-counting

  Once the drawer is computed locally from the ledger, the reconciler must stop independently incrementing the 
  shift's expected* fields (reconcileOrder.ts:395-404) — otherwise the same sale is counted once locally (from the
  ledger) and again server-side. Choose one:
  - (Recommended) Reconciler stops touching shift totals entirely; the terminal owns the drawer and writes the
  authoritative snapshot at close. Server expected* becomes purely the terminal-written close snapshot.
  - Or reconciler keeps writing totals but the client ignores server expected* and always recomputes from the ledger
  (server fields become HQ-only denormalization). Riskier — two numbers that can disagree.
  
  I strongly favor the first: single writer (the terminal) for the drawer.

  4. Offline Voiding (mandatory) — intent flag, not a transaction

  The mechanism you described already half-exists in handleVoidIntent (reconcileOrder.ts:561). Here's the safe full
  design.

  The local void is just a status flip on the local doc

  Voiding an order the terminal owns becomes a queueable merge-write on the asyncOrders doc:
  { voidRequested: true, status: 'voided', voidReason, voidedBy, voidedAt }.

  - Because reads derive from the local ledger (§2), flipping the local doc's status to voided instantly removes it
  from drawer/sales totals — offline, no server round-trip. This is the local-first void.
  - This replaces routing pending orders through voidOrderSafe/voidOrder.ts, which transacts on orders/{id} +
  orderItems and cannot work for a pending order (no canonical doc, no orderItems, no lotRefs). That path stays only
  for genuinely-canonical orders voided from the back-office.

  Reconciler behavior on flush — two cases

  1. Order never settled (the common case the user described): handleVoidIntent (reconcileOrder.ts:567) already
  tombstones it — sets status: 'voided' + reconcileStatus: 'settled', writes no canonical order, no side-effects.
  The sweeper already knows to skip these (sweeper.ts:96). ✅ Already works.
  2. Order settled during a brief online blip, then voided offline later (the dangerous race): the order already cut
  FIFO/stock/credit and may have a canonical orders doc. Voiding it requires full server-side reversal — and that
  is the status === 'settled' branch of handleVoidIntent (reconcileOrder.ts:579), which is currently a TODO (P5).

  Honest constraint: in a system designed to be offline for days, case 2 is not hypothetical — a sale can settle in
  a 30-second connectivity blip and be voided hours later offline. So mandatory offline void requires finishing the 
  P5 settled-reversal on the server. The reversal logic already exists as a reference in the client voidOrder.ts
  (restock lots, restore productStocks, reverse shift totals, reverse credit, write audit + stock movements) — P5 is
  essentially porting that into handleVoidIntent's settled branch, made idempotent (guard on an already-voided
  canonical doc / a voidReconciled flag).

  Guardrails

  - Offline void applies only to orders the terminal can resolve locally (its own ledger). Voiding another
  terminal's settled order while offline can't be safely reversed locally → keep that on the online canonical path
  or disable when offline.
  - The reconciler must treat a void-tombstone idempotently (re-delivery must not error or re-reverse) — same
  reconcileStatus-guard pattern already used for settlement.

  5. Summary of required changes by layer

  ┌───────────────┬─────────────────────────────────────────────────────────────────────────────────────────────┐
  │     Layer     │                                           Change                                            │
  ├───────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
  │               │ New local-ledger selector over asyncOrders (this device); useSalesHistory +                 │
  │ Reads (POS)   │ drawer/today's-totals read it. Back-office hooks (useAdminDashboardData, useDashboardData,  │
  │               │ useProfitReport) keep reading canonical orders.                                             │
  ├───────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
  │               │ Drawer = derived from startingCash + local ledger cash + cashEntries. Cash in/out →         │
  │ Shift         │ queueable append to cashEntries[] (drop the runTransaction in shiftService.ts:218).         │
  │ (client)      │ Open/close fully offline using existing openedOffline/closedOffline/...Server/syncState     │
  │               │ fields.                                                                                     │
  ├───────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Checkout      │ Remove the ephemeral optimistic applyShiftPaymentTotals (useCheckout.ts:87) in favor of the │
  │               │  derived drawer (single source).                                                            │
  ├───────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Void (client) │ Pending/local void = merge-write voidRequested + status:'voided' on the async doc.          │
  │               │ Canonical/back-office void keeps voidOrderSafe.                                             │
  ├───────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Reconciler    │ (a) Stop incrementing shift expected* (reconcileOrder.ts:395) — terminal owns the drawer.   │
  │ (server)      │ (b) Finish P5 settled-reversal in handleVoidIntent, idempotent. Pending tombstone already   │
  │               │ done.                                                                                       │
  ├───────────────┼─────────────────────────────────────────────────────────────────────────────────────────────┤
  │ Housekeeping  │ clearTestData.ts should also clear asyncOrders (currently only clears orders).              │
  └───────────────┴─────────────────────────────────────────────────────────────────────────────────────────────┘

  6. Phased roadmap (safe, reversible)

  1. Local-ledger selector + unit tests — pure normalization of asyncOrders → unified sale view (handle null
  serverCreatedAt, clientCreatedAt ordering, exclude voided/exception). Lock with tests before any wiring.
  2. Wire POS Sales History + "today" totals to the local ledger. Verify offline sales appear instantly and a synced
  sale doesn't double (dedupe by the shared id is moot here since we read only asyncOrders).
  3. Derived drawer — compute drawer/Z-report locally; remove the ephemeral optimistic bump. Verify a mid-shift
  offline reload preserves the correct drawer (the current failure mode).
  4. Server: stop the reconciler shift increment (coordinate with step 3 to flip the single-writer cleanly). Verify
  no drawer double-count across a real sync.
  5. Offline cash in/out — convert to queueable cashEntries[] append; verify offline.
  6. Offline void — Phase A (pending): local voidRequested flip + rely on existing tombstone. Ships the user's
  described behavior.
  7. Offline void — Phase B (settled reversal, P5): implement the idempotent settled-order reversal in
  handleVoidIntent; only then is offline void fully safe for the connectivity-blip race.
  8. clearTestData parity + a manual end-to-end offline soak test (open shift → sell → void → cash in/out → reload
  offline → reconnect → verify HQ projection matches the locally-shown Z-report with zero drift).

  ---
  Decisions I need before locking the design
  
  1. Drawer single-writer (§3): confirm you're OK with the reconciler no longer touching shift totals (terminal
  becomes the sole authority, server stores the terminal-written close snapshot). This is the cleanest
  anti-double-count guarantee. My recommendation: yes.
  2. Offline void scope (§4): ship Phase A (pending tombstone) first as a standalone increment, then Phase B 
  (settled reversal) — or hold the whole void feature until B is done so offline void is never partially-safe? My 
  recommendation: ship A, fast-follow B, and disable offline void of already-synced orders until B lands.
  3. Back-office reads: leave Admin Dashboard / Profit Report on the canonical orders projection (eventually
  consistent), correct? Or do you also want pending offline sales reflected in back-office analytics? My 
  recommendation: leave them on the projection.

  Tell me your calls on these three and I'll finalize the structural design. I won't touch any code until you
  approve.

✻ Sautéed for 2m 7s