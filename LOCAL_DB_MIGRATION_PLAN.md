# LOCAL_DB_MIGRATION_PLAN.md
### Deep Architectural Pre-Flight Check — Firestore "Push" → Offline-First IndexedDB + Repository Pattern

> **Status:** Read-only analysis. No source code was modified.
> **Scope analyzed:** `src/lib/types.ts`, `src/lib/pos/usePosProducts.ts`, `src/lib/pos/categoryService.ts`, `src/lib/inventory/categoryService.ts`, `src/lib/pos/types.ts`, `src/hooks/pos/useCart.ts`, `src/pages/POSPage.tsx`, `src/lib/firebase.ts`.

---

## 0. The Two Findings That Reframe This Migration

Before the risk table, two facts change the risk profile dramatically:

1. **We are already an IndexedDB app.** `src/lib/firebase.ts:31-57` initializes Firestore with `persistentLocalCache({ tabManager: persistentMultipleTabManager() })`, with graceful fallback to single-tab persistence → memory cache. Every `onSnapshot` is **already** written to and served from IndexedDB by the SDK. We are not adding offline storage from zero; we are deciding whether to **replace the SDK's cache + listener model with a hand-rolled repository.** That is a different, smaller, and more reversible decision.

2. **The POS UI never touches a raw Firestore object.** The cart and grid consume `PosProduct` (`src/lib/pos/types.ts`), a **primitive-only projection** built by `toPosProduct()` (`usePosProducts.ts:63-81`). It contains no `Timestamp`, no `DocumentReference` — only strings, numbers, booleans, and plain `Record<>`/array maps. **`PosProduct` is already structured-clone-safe.** The serialization trap (Vector 1) only bites if the Sync Agent caches the **raw** `Product`/`ProductStock` documents instead of the projection.

**Architectural implication:** the cleanest cut point for the repository is **at the projection boundary** — cache `PosProduct`, not `Product`. This sidesteps the entire Timestamp problem for the POS read path.

---

## 1. Risk Assessment

### Vector 1 — The Firestore Timestamp / Reference Serialization Trap

| Type | File / Line | Field(s) | IndexedDB behavior if stored raw |
|---|---|---|---|
| `Product` | `types.ts:171-172` | `createdAt`, `updatedAt: Timestamp` | Silent corruption (see note) |
| `SoftDelete` (mixed into `Product`, `User`, `Customer`, `Supplier`) | `types.ts:11-13` | `deletedAt: Timestamp \| null` | Silent corruption + filter risk |
| `ProductStock` | `types.ts:183-184` | `lastMovementAt`, `updatedAt: Timestamp` | Silent corruption |
| `ProductCategory` | `types.ts:129-134` | *(none — `id`, `name`, `branchSettings` only)* | **✅ Safe as-is** |
| `PosProduct` | `pos/types.ts` | *(none — fully primitive)* | **✅ Safe as-is** |

**Precision note — "crash" vs. "corrupt":** the prompt's framing is directionally right but worth tightening, because the two failure modes need different defenses:
- A Firestore **`Timestamp`** is a class instance with own props `seconds`/`nanoseconds` plus prototype methods. IndexedDB's structured-clone algorithm **does not throw** on it — it silently drops the prototype, yielding a plain `{ seconds, nanoseconds }` object. Any later `.toDate()` / `.toMillis()` call then throws `TypeError: x.toDate is not a function`. This is a **latent, silent** bug, not an upfront crash.
- A Firestore **`DocumentReference`** holds non-cloneable internals (functions, the Firestore instance). Structured clone **does throw `DataCloneError`** on it. *Good news:* a grep of the analyzed types shows **no `DocumentReference` fields** — all relationships are stored as string IDs (`productId`, `customerId`, `refOrderId`, etc.). So the hard-crash vector is **not present** in our schema today.

**Concrete breakage if we naively cache raw docs:**
- `usePosProducts.ts:216` — `.filter((p) => !p.deletedAt)` currently relies on `Timestamp | null` truthiness. After a structured-clone round-trip, `deletedAt` becomes a truthy `{seconds,nanoseconds}` plain object for *non-deleted* docs **only if** the source ever wrote a non-null sentinel — today non-deleted rows are `null`, so this specific line survives, but it is fragile and must be locked behind the projection.
- Any admin/report consumer that calls `.toDate()` on a cached `Product.createdAt` would throw. The POS read path does **not** do this (the projection drops these fields), but a **shared** repository used by admin screens would.

**Verdict:** **LOW** risk *if* the repository's serialization boundary is `PosProduct` (or an explicit `Serializable<Product>` DTO that converts `Timestamp → number (epoch ms)` at write time). **HIGH** risk if we cache raw snapshot `.data()` blobs.

---

### Vector 2 — Branch-Scoped Sorting & Visibility Consistency

**How it works today (pure, already cache-friendly):**
- `branchSettings: Record<string, ProductBranchSetting>` lives on `Product` (`types.ts:166`); `ProductBranchSetting = { isVisibleInPos, sortOrders: Record<string, number> }` (`types.ts:122-127`).
- `toPosProduct()` copies the **entire** map verbatim: `branchSettings: product.branchSettings` (`usePosProducts.ts:78`) — i.e. **every branch's** settings currently ride along into each `PosProduct`.
- Reads are pure and already branch-scoped:
  - `sortProductsByCustomOrder()` reads `p.branchSettings?.[branchId]?.sortOrders?.[categoryKey]` (`pos/categoryService.ts:70-85`).
  - Grid visibility filter reads `p.branchSettings?.[posBranchId]?.isVisibleInPos === false` (`POSPage.tsx:134`).
  - Category visibility/order: `isCategoryVisible` / `sortCategories` (`pos/categoryService.ts:31-63`).

Because these are **pure functions over plain objects**, they behave **identically** whether `products` arrives from `onSnapshot` or from IndexedDB. **No logic change is required.**

**The one real decision — strip other branches' settings, or keep the full map?**

| Option | Pro | Con / Risk |
|---|---|---|
| **A. Cache full `branchSettings` map** (status quo) | Zero transform; admin tools could reuse the same store | Larger cache; leaks other branches' config to the terminal |
| **B. Sync Agent strips to `{ [thisBranch]: ... }`** | Smaller payload; branch isolation by construction | **Footgun:** must preserve *this* branch's key **exactly** |

> ⚠️ **Default-visible semantics are the trap.** `isProductVisible`/`isCategoryVisible` treat a **missing** branch key as **visible** (`!== false`, `pos/categoryService.ts:32,37`). Therefore:
> - Stripping **other** branches' keys is **safe** (POS only ever reads its own `branchId`).
> - **Accidentally stripping or omitting *this* branch's key flips a hidden product to visible.** Any "strip" implementation must be an allowlist that *keeps* `branchSettings[thisBranchId]` untouched, never a transform that rebuilds it.

**Recommendation:** **Option B**, implemented as a pure projection `pickBranchSettings(product, branchId)` that keeps exactly one key. This also keeps the cache footprint flat as the chain adds branches. (Keep the admin Sorting modal on its own full-fidelity read path — it legitimately needs all branches; see Vector 3.)

**Verdict:** **LOW** risk. The sort/visibility layer is already a clean, testable, pure module (`pos/categoryService.ts`) — it is the *least* exposed part of this migration.

---

### Vector 3 — The "Admin → POS" Sync Gap (the real engineering cost)

**What gets severed.** Today the POS holds **three** live listeners that make admin edits appear instantly:
1. Products: `onSnapshot(productQ)` — `usePosProducts.ts:210`.
2. Stock: `onSnapshot` on `productStocks` collection-group, with a per-product fallback — `usePosProducts.ts:145,175`.
3. Categories (incl. branch order/visibility/styling): `onSnapshot` in `useCategories()` — `inventory/categoryService.ts:197`.

When an admin edits a price/sort/visibility via `SortingSettingsModal` → `sortingStore` / `saveCategoryBranchSetting`, the change lands in Firestore and these listeners repaint the POS within ~1s. **Reading strictly from a local repository severs all three.**

**Proposed signal mechanism — `sync_signals/{branchId}` (lightweight, single listener):**

```
sync_signals/{branchId}
  rev: number                       // monotonic bump on ANY catalog/stock/category change for this branch
  updatedAt: Timestamp
  scopes: {                         // optional granularity → enables partial pulls
    products:   number,
    stock:      number,
    categories: number,
  }
```

- The POS keeps **one** tiny `onSnapshot(doc(sync_signals/{branchId}))`. On `rev` change, the **Sync Agent** pulls the changed scope(s) via `getDocs` (server source), re-projects to `PosProduct`/`ProductCategory`, writes to IndexedDB, then bumps a local in-memory `dataVersion` that `useLocalInventory` subscribes to. UI re-reads from the repository. (`BroadcastChannel` propagates the bump to other tabs.)

**⚠️ The hard part is *who writes the signal*, and this is the migration's largest risk.** Catalog/stock mutations are spread across **many** call sites — `sortingStore.ts`, `inventory/categoryService.ts`, `productCrud/useProductCrud.ts`, plus receiving, adjustments, and transfers all mutate `products`/`productStocks`. Instrumenting every writer to bump `sync_signals` client-side is fragile — **one missed call site = a POS terminal silently serving stale prices/stock**, which is exactly the checkout-safety failure this sprint exists to prevent.

**Recommendation:** bump `sync_signals/{branchId}` from a **Cloud Function** `onWrite` trigger on `products/**`, `productStocks/**`, and `categories/**` (the repo already has a `functions/` package). One server-side trigger = no missed writers, no client trust. This is the single most important reliability decision in the plan.

> 💡 **Lower-risk alternative worth weighing before we build any of this:** because `persistentLocalCache` is *already* enabled (`firebase.ts:34`), we could keep `onSnapshot` exactly as-is and get offline reads for free — the SDK already serves the last cached snapshot when offline and reconciles on reconnect. The Repository Pattern's real wins here are (a) a clean, mockable data seam for tests and (b) explicit control over *when* we pay for a server read. If those are the goals, we can adopt the repository **interface** while letting the SDK remain the cache engine, and skip the `sync_signals` + Sync Agent machinery entirely. I flag this so we choose the heavier path deliberately, not by default.

**Verdict:** **HIGH** risk / **HIGH** effort — concentrated almost entirely in *signal authorship* and *stock freshness* (stale stock between syncs → overselling). Recommend a Cloud-Function-authored signal and keeping **stock** on a tighter refresh cadence (or a dedicated live listener) even if the catalog goes fully local.

---

### Vector 4 — Cart Price Freezing Compatibility

**Current contract.** `useCart({ products, customer, showToast })` (`hooks/pos/useCart.ts`) is **data-source-agnostic** — it accepts a `PosProduct[]` and a `customer`; it neither knows nor cares whether they came from `onSnapshot` or IndexedDB. The freeze design (shipped this sprint):
- Each cart line snapshots `unitPrice`/`originalPrice` at add-time; totals use `line.unitPrice` only.
- The cart is the raw frozen lines — **no per-render reprice from live products.**
- The **only** sanctioned reprice is the tier-change effect, deps `[activeTier, customer, products]`, guarded so a `products`-array change early-returns without repricing.

**Swapping `usePosProducts` → `useLocalInventory`: compatibility analysis.**

| Concern | Assessment |
|---|---|
| Freeze against live edits | ✅ **Strengthened.** Today a live admin edit pushes a new `products` array (guard absorbs it). With IndexedDB, `products` only changes on a sync-pull — *less* churn, freeze still holds. |
| Tier reprice on customer change | ✅ **Intact.** `resolvePosUnitPrice` reads `product.tierPrices` / `overrideTierPrices` / `uomOptions` — all carried in `PosProduct` (`usePosProducts.ts:76-79`), all serializable. Reprice reads the *last-synced* product, which is acceptable (and arguably more consistent with the freeze intent). |
| Grid display price | ✅ `POSPage.tsx:457` calls `getActivePriceForCustomer(p, baseOption, customer)` on the same `products` array — works identically off cached data. |
| **Referential stability** | ⚠️ **The one real risk.** If `useLocalInventory` returns a **new array identity every render** (e.g., re-maps without memoization), the reprice effect's `products` dep changes constantly. The tier-guard still prevents leaks, but it's wasteful churn. **`useLocalInventory` must stabilize identity** the way `usePosProducts` does (commit a new array only when data actually changes). `repriceCartLines` returning the same ref on no-op (and `setRawCart` bailing) limits the blast radius, but don't rely on it. |
| Stock validation | ⚠️ `validateAddToCartStock` reads `product.stock` from the cached entry. Between syncs this is **stale** → overselling risk. Ties directly to Vector 3's stock-freshness recommendation. |

**Verdict:** **LOW** risk to the freeze/tier logic itself — it was, perhaps fortuitously, built source-agnostic. The two caveats (array identity stability, stock staleness) are properties of the **new hook and the sync cadence**, not of the cart.

---

### Risk Summary

| Vector | Risk | Effort | Where the risk actually lives |
|---|---|---|---|
| 1. Timestamp/Reference trap | **LOW** | Low | Only if we cache raw docs instead of the `PosProduct` projection |
| 2. Branch sort/visibility | **LOW** | Low | The "strip other branches" footgun (must keep *this* branch's key) |
| 3. Admin→POS sync gap | **HIGH** | High | *Who authors the signal* + stock freshness |
| 4. Cart freeze compatibility | **LOW** | Low | New hook's array-identity stability + stock staleness |

---

## 2. Proposed Data Flow

```
                         ┌──────────────────────────────────────────┐
                         │  ADMIN WRITE (price / sort / visibility)  │
                         │  SortingSettingsModal, productCrud,       │
                         │  receiving, adjustments, transfers …      │
                         └──────────────────────┬───────────────────┘
                                                │  setDoc / merge
                                                ▼
                                   ┌────────────────────────┐
                                   │   FIRESTORE (source     │
                                   │   of truth: products,   │
                                   │   productStocks,        │
                                   │   categories)           │
                                   └───────────┬────────────┘
                                               │  onWrite trigger (Cloud Function)
                                               ▼
                                   ┌────────────────────────┐
                                   │  sync_signals/{branchId}│  rev++  (+ scopes)
                                   └───────────┬────────────┘
                                               │  ONE lightweight onSnapshot
                                               ▼
        ┌──────────────────────────────────────────────────────────────────┐
        │                       POS TERMINAL                                 │
        │                                                                    │
        │   SYNC AGENT                                                       │
        │   • observes sync_signals/{branchId}.rev                           │
        │   • on bump → getDocs(changed scope, source:'server')              │
        │   • SERIALIZATION BOUNDARY:                                        │
        │       Product   ──toPosProduct()──▶ PosProduct (primitive-only)    │
        │       Timestamp ──▶ epoch ms (number)   [if any ts is ever kept]   │
        │       branchSettings ──pickBranchSettings(thisBranch)──▶ 1 key     │
        │   • writes projections ──▶ IndexedDB (repository store)            │
        │   • bumps local dataVersion / BroadcastChannel('pos-sync')         │
        │                                                                    │
        │            ▼ read (repository.getProducts / getCategories)         │
        │   useLocalInventory()  ── identity-stable PosProduct[] ──┐         │
        │            │                                             │         │
        │            ├──▶ POSPage grid (filter + sortProductsBy…)  │         │
        │            └──▶ useCart({ products, customer })          │         │
        │                     • addToCart → freezes unitPrice      │         │
        │                     • tier change → reprice from cache   │         │
        └──────────────────────────────────────────────────────────────────┘

   Offline: reads served entirely from IndexedDB. Writes (sales) queue locally
            and flush on reconnect (separate outbound concern — see roadmap §6).
```

**Key invariants this flow guarantees:**
- The cart never sees a `Timestamp` or a cross-branch `branchSettings` key.
- A single Cloud-Function-authored signal means **no write path can forget to invalidate the cache.**
- The cart's freeze/tier logic is untouched — it still receives a `PosProduct[]`.

---

## 3. Step-by-Step Execution Plan

Sequenced so each step is independently shippable and reversible. Nothing in Step 1–4 removes the existing `onSnapshot` path, so we can run **old and new side-by-side behind a flag** (`POS_FEATURES`) and roll back instantly.

**Step 1 — Define the serialization boundary & repository interface (no behavior change).**
- Add an explicit `PosProductDTO` / confirm `PosProduct` as the canonical cached shape.
- Write a pure `serializeProduct(raw: Product): PosProduct` (lift the existing `toPosProduct` logic) + `pickBranchSettings(product, branchId)` with a unit test proving *this* branch's key survives and others are dropped (guards the Vector 2 footgun).
- Define `interface InventoryRepository { getProducts(branchId): Promise<PosProduct[]>; getCategories(): Promise<ProductCategory[]>; subscribe(cb): () => void }`.

**Step 2 — Implement the IndexedDB repository (`idb` is already a transitive dep).**
- One object store per scope (`products`, `categories`, `stock`), keyed by id, plus a `meta` store holding the last-applied `rev`.
- Add `confirmInventoryAdjustment`-style unit tests around read/write round-trips proving no `Timestamp`/`DataCloneError` escapes.

**Step 3 — Build the Sync Agent + `sync_signals` signal (read path).**
- Cloud Function `onWrite` on `products/**`, `productStocks/**`, `categories/**` → bump `sync_signals/{branchId}.rev` (+ scope counters). Deploy and verify in isolation.
- Client Sync Agent: one `onSnapshot(sync_signals/{branchId})` → on bump, `getDocs(source:'server')` for the changed scope → serialize → write IndexedDB → bump local `dataVersion` (+ `BroadcastChannel`).

**Step 4 — Add `useLocalInventory` behind a feature flag.**
- Same return contract as `usePosProducts` (`{ products, categories, loading, error }`), reading from the repository, **identity-stable** array (Vector 4 caveat).
- Flag in `POS_FEATURES`; default OFF.

**Step 5 — Flip POS reads, keep cart/sort untouched.**
- In `POSPage.tsx`, swap `usePosProducts` → `useLocalInventory` under the flag. `useCart`, `sortProductsByCustomOrder`, and the visibility filter need **no changes** (verified pure & source-agnostic in §1).
- Decide stock cadence: either include stock in the signal pulls or keep a dedicated live stock listener (recommended for overselling safety).

**Step 6 — (Separate sprint) Outbound offline writes.**
- Queue sales in IndexedDB and flush on reconnect. Out of scope for this read-path pre-flight, but the repository interface should leave room for it. Flag the interaction with shift/stock-movement integrity early.

**Step 7 — Decommission the old path.**
- After a soak period with the flag ON in production, remove the POS-side `onSnapshot` product/stock/category listeners. Keep `persistentLocalCache` (it still benefits every *other* live screen).

**Cross-cutting validation gate for every step:** `npx tsc -b` clean, targeted unit tests for the pure serializers, and a manual POS smoke test confirming (a) admin edit propagates within the sync window, (b) a cart item's price stays frozen across a sync pull, and (c) a tier-customer swap still reprices.

---

## 4. Open Questions for You & Khun Chat

1. **Heavy path or light path?** Given `persistentLocalCache` is already live (`firebase.ts:34`), do we want the **full** Repository + `sync_signals` + Sync Agent (explicit control, best test seam), or the **repository interface only** over the SDK's existing cache (far less to build/own)? This is the biggest fork in the road (see Vector 3's alternative).
2. **Signal authorship:** confirm we author `sync_signals` from a **Cloud Function** trigger (recommended) rather than instrumenting every client write site.
3. **Stock freshness:** are we comfortable letting **stock** go eventually-consistent through the same signal, or should stock stay on a live listener to protect against overselling?
4. **`branchSettings`:** strip to this branch only (Option B, recommended) or keep the full map for simplicity?

---

## ✅ Request for Approval

This completes the read-only pre-flight check. The headline is reassuring: **three of the four vectors are LOW risk** because the codebase already projects to a primitive-only `PosProduct`, already runs on IndexedDB via `persistentLocalCache`, and keeps sort/visibility/freeze logic in pure, source-agnostic modules. **The real work — and the real risk — is concentrated in Vector 3 (Admin→POS sync signal authorship + stock freshness).**

**May I proceed to Step 1 — "Define the serialization boundary & repository interface" (pure code, no behavior change, fully reversible)?**

Before I do, I'd like your call on **Open Question #1 (heavy vs. light path)**, since it determines whether Steps 3 and the Cloud Function are in scope at all. Reply with your preference and a "go", and I'll begin Step 1.
