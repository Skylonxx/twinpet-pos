# TwinPet POS — Technical Audit & Architecture Review (2026)

> **Scope:** React components, Firebase data-fetching hooks, and utility/calculation logic.
> **Method:** Static read-through of `src/` (≈46.7k LOC across `.ts`/`.tsx`). No code was modified.
> **Tone:** Deliberately brutal and honest, as requested. Findings are ranked by blast radius, with `file:line` citations and concrete remediations.
> **Auditor:** Claude (Opus) — read-only pass, 2026-05-30.

---

## 0. Executive Summary

The codebase is **well-structured at the seams** — `lib/` is cleanly split by domain, dev-mock fallbacks are consistent, and the FIFO sale transaction is genuinely careful (reads-before-writes, conflict-free lot merging). That is the good news, and it is real.

The bad news is concentrated in three places and it is serious:

1. **Firestore read economics are unbounded and N+1-ridden.** Several "report" and "history" hooks subscribe to *entire* collections with **no `limit()`** and then fan out **one sub-collection read per document** — *inside a realtime listener*. `useProfitReport` is the marquee offender: every new sale in a branch silently re-reads every order-item sub-collection and every product image for that branch's entire history. This is a billing and latency time-bomb that grows linearly with store age.
2. **Money is computed in raw IEEE-754 floats with no rounding discipline** on the hottest path (the POS cart → sale). The transfer module rounds correctly; the sale module does not. The same project disagrees with itself about whether `฿` is an integer-cents quantity.
3. **Three "god components" (1,100–1,400 LOC each)** concentrate state, data fetching, and rendering in single files, making them effectively unreviewable and a magnet for regressions.

Across the whole `src/lib` tree, **`limit()` appears exactly once** (`src/lib/pos/shiftService.ts:125`). That single statistic summarizes the Firebase risk profile.

| Area | Severity | Headline finding |
|---|---|---|
| Firebase Optimization | 🔴 Critical | Realtime listeners + N+1 sub-collection fan-out, zero pagination |
| Component Complexity | 🟠 High | `StockReportPage` (1389), `ProductDrawer` (1252), `POSPage` (1121) |
| State Management | 🟡 Medium | Monolithic `AuthContext`; `usePosProducts` re-renders entire POS on any stock tick |
| Logic Vulnerabilities | 🔴 Critical | Unrounded float money on the sale path; FIFO lot-set captured before transaction |

---

## 1. Firebase Optimization

### 1.1 🔴 CRITICAL — `useProfitReport` re-reads the world on every snapshot
**File:** `src/lib/profitReport/useProfitReport.ts:62-103`

```ts
const q = query(
  collection(db, collections.orders),
  where('branchId', '==', branchId),
  orderBy('createdAt', 'desc'),          // ❌ no limit(), no date bound
);

const unsub = onSnapshot(q, async (snap) => {
  const orders = snap.docs.map(...);
  const active = orders.filter((o) => o.status !== 'voided');
  const itemSets = await Promise.all(
    active.map(async (order) => {
      const items = await fetchOrderItems(order.id);   // ❌ N+1: 1 getDocs / order
      return orderToProfitLines(order, items);
    }),
  );
  const flat = itemSets.flat();
  const imageMap = await fetchProductImageMap([...new Set(flat.map((l) => l.productId))]); // ❌ M getDoc
  ...
});
```

**Why it's brutal:**
- It is an `onSnapshot` (realtime). **Every new order** — i.e. every checkout anyone in the branch makes — fires this callback again.
- Each fire re-fetches **every order-item sub-collection for the branch's entire history** (`fetchOrderItems` per order, line 18-24) plus a `getDoc` per unique product image (`fetchProductImageMap`, line 26-38).
- Read cost per snapshot ≈ `O(Orders + Σ OrderItems + UniqueProducts)`. For a store with 8,000 historical orders averaging 3 lines, **one new sale triggers ~32,000 document reads**. At Firestore pricing that is roughly **$0.01 per checkout just to keep this one screen warm**, scaling to dollars/day, growing forever.
- There is no `limit()` and no date window — the working set only ever grows.

**Fix:**
- Convert to a **paged `getDocs`** with `limit(50)` + cursor (`startAfter`), or constrain by the date range the UI already exposes (`where('createdAt', '>=', from)`).
- **Denormalize COGS/revenue onto the `Order` document** at write time (the sale transaction already computes `fifoCost` per line in `fifo.ts:371`). Then the report needs *zero* sub-collection reads.
- Drop the realtime listener for a historical report; a manual "refresh" (as `useSalesHistory` already offers) is correct here.

### 1.2 🔴 CRITICAL — N+1 order-items fan-out repeated in the dashboards
**Files:** `src/lib/dashboard/useDashboardData.ts:197-230` and `src/lib/dashboard/useAdminDashboardData.ts:163-165`

```ts
// useDashboardData.ts
const itemSnaps = await Promise.all(
  orders.map((order) =>
    getDocs(collection(db!, collections.orders, order.id, collections.orderItems)), // ❌ N+1
  ),
);
```

Same anti-pattern as 1.1 (one sub-collection round-trip per order), here at least gated behind a date-bounded `getDocs` rather than a listener, which makes it *merely* expensive rather than catastrophic. The admin variant (`useAdminDashboardData.ts:163`) repeats it verbatim across all branches.

**Fix:** Same denormalization. A dashboard should read aggregates off `orders` (or a roll-up doc), never walk sub-collections. If sub-collections are unavoidable, a `collectionGroup('orderItems')` query with a `createdAt` mirror field collapses N reads into one.

### 1.3 🟠 HIGH — `useSalesHistory`: unbounded subscription + full payment re-fetch per tick
**File:** `src/lib/salesHistory/useSalesHistory.ts:134-184, 40-64`

This hook is **noticeably better engineered** than `useProfitReport` — order items are lazy-loaded with a cache (`loadItems`, line 195-219) and payments are batched with `where('orderId','in',chunk)` in chunks of 10 (line 44-61). Credit where due.

But:
- The orders query (`buildOrdersQuery`, line 72-78) has **no `limit()`** — it subscribes to *all* branch orders forever.
- On **every** snapshot, `fetchPaymentsForOrders(orders.map(o => o.id))` (line 149) re-reads payments for the **entire** order set: `ceil(N/10)` reads per tick. At 5,000 orders that's 500 reads every time anyone checks out.

**Fix:** Add `limit(100)` + cursor pagination; only fetch payments for the page in view; or denormalize a `paymentMethods`/`paidAmt` summary onto the order (the sale transaction already writes `paidAmt` to the order at `fifo.ts:478`, so payment docs may not even be needed for the list view).

### 1.4 🟠 HIGH — `usePosProducts` per-product listener fallback = N realtime connections
**File:** `src/lib/pos/usePosProducts.ts:121-160, 162-201`

The happy path is good: one `collectionGroup(productStocks)` listener (line 168-171). But the **fallback** (triggered by a missing composite index, line 188-196) switches to `syncPerProductStockListeners`, which opens **one `onSnapshot` per product** (line 143-156). For a 600-SKU catalog that is **600 concurrent realtime listeners**, each calling `publish()` (line 151) on every tick.

Two compounding problems:
1. **Listener explosion** — silent, index-dependent, and easy to ship to production without noticing because dev has few SKUs.
2. **`publish()` rebuilds the entire `PosProduct[]` and calls `setProducts` on every single stock document change** (line 111-114), re-rendering the whole POS grid for one SKU's stock tick (see §3.3).

**Fix:** Treat the missing index as a hard, loud error (it's a one-time `firestore.indexes.json` deploy), not a silent degrade into N listeners. If a fallback must exist, batch per-product reads with `getDoc` + a single debounced `publish()` rather than N live listeners.

### 1.5 🟡 MEDIUM — Sequential awaits in the sale transaction add avoidable latency
**File:** `src/lib/fifo.ts:213-218, 242-263`

```ts
for (const productId of uniqueProductIds) {
  lotRefsByProduct.set(productId, await fetchActiveLotRefs(...)); // ❌ serial network round-trips
}
```
and inside the transaction:
```ts
for (const productId of uniqueProductIds) {
  stockSnaps.set(productId, await tx.get(productStockRef));        // ❌ serial
  productSnaps.set(productId, await tx.get(doc(...products, productId)));
}
```

These are correct but **serialized**. A 10-distinct-product cart pays 10× the round-trip latency it needs to. `fetchActiveLotRefs` (pre-transaction) can be `Promise.all`-ed trivially; `tx.get` calls can also be parallelized (Firestore permits parallel reads as long as they precede writes).

**Fix:** `await Promise.all(uniqueProductIds.map(...))` for the pre-tx lot discovery and for the in-tx read phase. Pure latency win, zero semantic change.

### 1.6 Summary table

| Hook | `limit()`? | Realtime? | N+1? | Verdict |
|---|---|---|---|---|
| `useProfitReport` | ❌ | ✅ | ✅ items + ✅ images | 🔴 Rewrite |
| `useDashboardData` | date-bounded | ❌ | ✅ items | 🟠 Denormalize |
| `useAdminDashboardData` | date-bounded | ❌ | ✅ items | 🟠 Denormalize |
| `useSalesHistory` | ❌ | ✅ | payments/tick | 🟠 Paginate |
| `usePosProducts` | n/a | ✅ | N listeners (fallback) | 🟠 Harden fallback |
| `useStockReport` | ❌ | ✅ | no | 🟡 Add limit |
| `completePosSale` | n/a | tx | serial reads | 🟡 Parallelize |

> **One-line indictment:** `grep -rn "limit(" src/lib` returns a single hit. Every list in this app is a full-collection scan waiting to get expensive.

---

## 2. Component Complexity — Top 3 Refactor Targets

Measured density (LOC / `useState` / hook-call-sites):

| Component | LOC | `useState` | hook calls | `useEffect` |
|---|---|---|---|---|
| `pages/StockReportPage.tsx` | **1389** | 26 | 30 | 2 |
| `components/products/ProductDrawer.tsx` | **1252** | 10 | 24 | 3 |
| `pages/POSPage.tsx` | **1121** | 23 | 48 | 4 |
| *(hon. mention)* `pages/ProfitReportPage.tsx` | 1114 | 19 | 32 | 6 |
| *(hon. mention)* `components/receiving/ReceivingForm.tsx` | 1061 | 25 | 39 | 7 |

### 2.1 🥇 `StockReportPage.tsx` — 1,389 LOC, 26 `useState`
This is a **four-applications-in-a-trenchcoat** component: Overview, Products, FIFO Queue, and Movement tabs all live in one function with one flat state bag (`prodSearch`, `fifoSearch`, `mvSearch`, three independent date ranges, three sort configs, three picked-id sets, …). 26 `useState` in one render function is the tell.

**Proposed split:**
- Extract one component per tab: `<StockOverviewTab>`, `<StockProductsTab>`, `<StockFifoTab>`, `<StockMovementTab>`. Each owns only its own search/sort/filter state. Only the active tab mounts → 3/4 of the state and memos stop existing on any given render.
- Promote the shared `DateRangeDropdown` (already inline in this file) to `components/common/DateRangeDropdown.tsx` so the FIFO and Movement tabs — and `SalesHistoryPage` — share one implementation.
- Move the `SortableTh` / `sortStockProducts` / `sortLowStockProducts` helpers into `lib/stockReport/sorting.ts`.
- Parent keeps only `tab` + the `useStockReport` data; passes slices down.

### 2.2 🥈 `ProductDrawer.tsx` — 1,252 LOC
A single mega-form covering identity, pricing, multi-UOM rows, tier pricing, branch availability, expiry policy, and the active/mute toggles. The local `Toggle`, `BaseRetailPriceInput`, `TierPriceManageButton` sub-components and the `set()` reducer-by-hand all live inline.

**Proposed split:**
- Section components: `<ProductIdentitySection>`, `<ProductPricingSection>`, `<ProductUomEditor>`, `<ProductTierPricing>`, `<ProductBranchAvailability>`, `<ProductFlagsSection>` (active/mute/oversell).
- Replace the 10 `useState` + bespoke `set<K>()` (line 384-389) with a single `useReducer` over `ProductFormData` — the form is a textbook reducer case (many fields, interdependent updates like `setBaseUnit` cascading into UOM rows).
- Extract the inline `Toggle` to a shared primitive (it is re-implemented in `SettingsPage`, `BranchManagementPage`, etc.).

### 2.3 🥉 `POSPage.tsx` — 1,121 LOC, 23 `useState`, 48 hook call-sites
The checkout orchestrator: cart, UOM selection, customer/tier, discounts, shift lifecycle, suspended bills, payment, receipt, plus eight modal open/close booleans. It directly imports the FIFO transaction (`completePosSale`) and hand-rolls dev-mock side effects (`devApplyCrmAfterSale`, `devIncrementShiftTotals`).

**Proposed split:**
- `useCart()` hook: cart record, add/remove/update-qty, discount application, `calcCartTotals` memo. Removes ~8 state vars and the cart mutators from the component.
- `useCheckout()` hook: wraps `completePosSale` + the dev-mock branching + CRM/credit post-effects, exposing `submitSale(payments)`. Removes the dev/prod fork from the view.
- `useShiftController()` hook: open/close/active-shift state and the shift modals.
- A `useModalRouter()` or single `useReducer<{ openModal: 'payment' | 'customer' | ... | null }>` to collapse the ~8 boolean modal flags into one discriminated value (they are mutually exclusive in practice).
- The view component then renders `<ProductGrid>`, `<CartPanel>`, and the modal stack from those hooks.

> **General rule for all three:** these are not "big components," they are *missing components*. The fix is mechanical extraction, not a rewrite — and it directly enables `React.memo`, which is currently impossible because everything shares one render scope.

---

## 3. State Management — Context vs Local, and Unnecessary Re-renders

### 3.1 🟡 Monolithic `AuthContext` mixes volatile state with stable actions
**File:** `src/lib/auth/AuthProvider.tsx:261-289`

The single context value bundles `session`, `firebaseUser`, `isLoading` (volatile) together with `loginWithPin`, `logout`, `setBranchId`, … (stable callbacks). The value is correctly `useMemo`-ed (line 261) and the callbacks are `useCallback`-ed with `[]` deps, so this is **not currently a hot path** — `firebaseUser`/`session` change rarely.

**But** every component calling `useAuth()` (and there are many) re-renders whenever *any* of `session`/`firebaseUser`/`isLoading` changes, even components that only need `logout`. The classic split is warranted as the app grows:
- `AuthStateContext` (session/user/branchId/isLoading) and `AuthActionsContext` (the callbacks). Action-only consumers (logout buttons, branch switchers) then never re-render on auth state changes.

Severity is **medium, not high**, precisely because auth state is low-frequency. This is a "do it before it bites" item, not a fire.

### 3.2 🟡 `branchId` is derived in two places with a `localStorage` read inside `useMemo`
**File:** `src/lib/hooks/useBranch.ts:40-53`

`branchId` is computed in `useBranch` via a `useMemo` that **reads `localStorage` during render** (line 47). Side-effecting reads inside `useMemo` are impure (the memo can be dropped/recomputed by React at will) and make the value non-deterministic w.r.t. its declared deps. Meanwhile `AuthProvider` *also* owns a `branchId` (`session.branchId`). Two sources of truth for the single most important scoping key in a multi-branch POS is a latent consistency bug.

**Fix:** Read `localStorage` once in an effect or in lazy `useState` initialization; make `session.branchId` the single source of truth and let `useBranch` only *read* it.

### 3.3 🟠 `usePosProducts.publish()` re-renders the entire POS on every stock tick
**File:** `src/lib/pos/usePosProducts.ts:111-114, 151, 185`

`publish()` calls `setProducts(mergePosProducts(...))`, rebuilding a brand-new `PosProduct[]` (new array + new object identities) on **every** stock snapshot — and in the per-product fallback, once per product per tick (§1.4). Because `POSPage` consumes the whole array and isn't split into memoized children (§2.3), **one SKU's stock change re-renders the full product grid and cart panel**.

**Fix:**
- Debounce/coalesce `publish()` (one microtask flush per snapshot batch).
- Preserve object identity for unchanged products so a memoized `<ProductCard>` can bail out: only replace the entries whose stock actually changed.
- This only pays off after §2.3's extraction — today there are no memoized children to protect.

### 3.4 Observation — heavy reliance on local state is mostly *fine*
The codebase sensibly keeps page-level state local rather than over-globalizing (no Redux sprawl, no giant app store). The problem isn't "too much context," it's **too much state per component** (§2) and **new-identity churn from data hooks** (§3.3). The remedy is component extraction + identity-stable hooks, not a global store.

---

## 4. Logic Vulnerabilities (Calculation / FIFO / Edge Cases)

### 4.1 🔴 CRITICAL — Money is unrounded IEEE-754 on the entire POS sale path
**Files:** `src/lib/pos/cartUtils.ts:7-39`, consumed by `src/lib/fifo.ts:349-479`

```ts
// cartUtils.ts
export function getLineTotal(line: CartLine): number {
  const base = line.unitPrice * line.qty;
  if (type === 'disc_pct') return Math.max(0, base * (1 - val / 100)); // ❌ float, never rounded
  ...
}
export function calcCartTotals(...) {
  const subtotal = lines.reduce((s, l) => s + getLineTotal(l), 0);     // ❌ accumulates float error
  const billDiscount = ... subtotal * (billDiscountValue / 100);        // ❌
  const fee = afterDiscount * (feeRatePercent / 100);                   // ❌
  const grandTotal = afterDiscount + fee;                               // ❌ stored to Firestore
}
```

None of these round to satang (2 dp). The unrounded `grandTotal`, `subtotal`, `lineTotal`, `discountAmt`, and `fifoCost` are then **persisted** in the sale transaction (`fifo.ts:369-371, 469-477`). Consequences:

1. **Stored money with >2 decimal artifacts.** A 7% line on `฿33.33` yields `30.9969`; sums of many such lines drift (the classic `0.1 + 0.2 = 0.30000000000000004`).
2. **Change/balance comparisons go wrong.** `fifo.ts:467` sets order status via `paidAmt < input.grandTotal`, and `changeAmt: Math.max(0, paidAmt - input.grandTotal)` (line 479). If `grandTotal` is `100.00000000000001` and the customer pays exactly `100`, the order is silently flagged `pending_payment` and change math is off by a hair — on a *cash register*.
3. **Self-inconsistent codebase.** The **transfer** module rounds correctly — `const round2 = (n) => Math.round(n*100)/100;` (`transferCrud.ts:33`, applied at line 237) — and the **document/VAT** formatter rounds (`documents/formatters.ts:112-113`). Only the **sale** path, the most important money path in the system, does not. There is **no shared `roundMoney` utility**; `round2` is a private const in one file.

**Fix:** Introduce `lib/money.ts` with `roundSatang(n) = Math.round(n*100)/100` (or, better, an integer-satang representation) and apply it at every boundary in `getLineTotal`/`calcCartTotals` and before persisting in `completePosSale`. This is small, mechanical, and high-value.

### 4.2 🔴 HIGH — FIFO lot *set* is captured before the transaction (mid-sale race)
**File:** `src/lib/fifo.ts:209-218` vs `220-263`

`fetchActiveLotRefs` runs **outside** the transaction (line 213-216) to discover which lot docs exist; the transaction then `tx.get`s those specific refs (line 258). The transaction re-reads each lot's *quantity* freshly (good, prevents qty races), but the **set of lots is frozen at pre-transaction time**. If a GRN/receiving lands a new lot for the same product **between** `fetchActiveLotRefs` and the transaction commit:
- The new (possibly *older-dated*, e.g. back-dated receipt) lot is invisible to this sale.
- FIFO ordering can be violated, and in a near-empty-stock situation the sale can spuriously hit the oversell path (`fifo.ts:335-345`) despite stock existing in the unseen lot.

The code comments acknowledge this is "the same pattern as confirmReceiving ghost lots," i.e. it's a known, accepted design constraint — but it **is** a correctness edge case under concurrency and deserves to be documented as such, not just in a code comment.

**Fix:** Either (a) re-query lot refs *inside* the transaction's read phase (Firestore transactions can run a query read), or (b) gate sales and receiving for the same product/branch behind the per-product stock doc as the transaction's contended key so a concurrent receive forces a transaction retry.

### 4.3 🟠 MEDIUM — Zero credit limit = unlimited credit
**File:** `src/lib/fifo.ts:383`

```ts
if (customer.creditLimit > 0 && currentOutstanding + creditAmt > customer.creditLimit) {
  throw new Error('ยอดเชื่อเกินวงเงินที่กำหนด');
}
```

The guard is skipped entirely when `creditLimit === 0`. A customer whose limit was never set (or explicitly zeroed to *deny* credit) can charge an **unbounded** amount on credit. `0` is being overloaded to mean "no limit / unlimited," which is almost certainly the opposite of intent for a customer with no approved credit.

**Fix:** Decide the semantics explicitly. If `0` means "no credit allowed," reject any `creditAmt > 0` when `creditLimit <= 0`. If "unlimited" is a real concept, model it as `null`/`Infinity`, not `0`.

### 4.4 🟡 LOW — `formatMoney` round-trips through `String`/`parseFloat`
**File:** `src/lib/pos/cartUtils.ts:41-46` (and duplicated in `profitReport/types.ts:88`)

```ts
return parseFloat(String(n || 0)).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
```

`parseFloat(String(n))` is a no-op obfuscation of `Number(n)` and the `n || 0` swallows a legitimate `0` vs `NaN` distinction. Harmless today (display only) but it is duplicated logic that should live in the `lib/money.ts` proposed in §4.1.

### 4.5 🟢 Things that are actually done right (credit where due)
- **Divide-by-zero is handled in profit margins:** `margin = revenue > 0 ? (profit / revenue) * 100 : 0` (`profitReport/types.ts:148,174`; `devMock.ts:83,146`). Contrast with §4.1 — the team clearly *knows* how to guard, which makes the unrounded sale path an oversight, not ignorance.
- **The sale transaction obeys Firestore's read-before-write rule** rigorously (explicit Phase 1/2/3 structure, `fifo.ts:233-388`).
- **`mergeLotCuts` (`fifo.ts:174-186`)** correctly collapses multiple cart lines hitting the same lot into a single write, avoiding the "two writes to one doc in a transaction" failure.
- **Index-missing fallbacks** are pervasive and thoughtful (`isIndexError` guards in dashboard/sales hooks) — though §1.4 shows one fallback that degrades too silently.
- **Transfer costing rounds and guards** (`transferCrud.ts:33,235`) — the correct pattern that §4.1 should adopt.

---

## 5. Prioritized Remediation Backlog

| # | Item | Area | Severity | Effort | Payoff |
|---|---|---|---|---|---|
| 1 | Add `lib/money.ts` `roundSatang`, apply in `cartUtils` + `completePosSale` | Logic | 🔴 | S | Correct money everywhere |
| 2 | Rewrite `useProfitReport`: paginate + denormalize COGS onto `Order` | Firebase | 🔴 | M | Kills the read bomb |
| 3 | Denormalize order aggregates; remove orderItems N+1 in dashboards | Firebase | 🔴 | M | Order-of-magnitude fewer reads |
| 4 | Re-query FIFO lots inside the transaction (or contend on stock doc) | Logic | 🟠 | M | Closes mid-sale race |
| 5 | Add `limit()` + cursor to `useSalesHistory`, `useStockReport` | Firebase | 🟠 | S | Bounded reads |
| 6 | Harden `usePosProducts` index fallback; debounce `publish()` | Firebase/State | 🟠 | S | Fewer listeners + renders |
| 7 | Split `StockReportPage` into 4 tab components | Complexity | 🟠 | M | Reviewability + perf |
| 8 | Extract `useCart`/`useCheckout`/`useShiftController` from `POSPage` | Complexity | 🟠 | M | Testable checkout |
| 9 | `useReducer` + section components for `ProductDrawer` | Complexity | 🟡 | M | Maintainability |
| 10 | Fix `creditLimit === 0` semantics | Logic | 🟠 | S | Closes credit hole |
| 11 | Split `AuthContext` into state/actions; single source for `branchId` | State | 🟡 | S | Fewer re-renders |

**If you only do three things:** #1 (money rounding), #2 (profit-report read bomb), and #4 (FIFO transaction race). Those are the items that cost real money or produce wrong numbers.

---

*End of report. No source files were modified during this audit — only this document was created.*
