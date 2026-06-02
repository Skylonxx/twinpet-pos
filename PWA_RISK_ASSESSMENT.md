# PWA_RISK_ASSESSMENT.md
### Pre-Flight Risk Assessment — Installable Offline-First App Shell (Vite PWA)

> **Status:** Read-only analysis. No implementation written.
> **Files audited:** `src/main.tsx`, `vite.config.ts`, `src/lib/firebase.ts`, `src/lib/auth/AuthProvider.tsx`, `src/lib/auth/session.ts`, `src/lib/firebaseAuth.ts`, `src/components/ProtectedRoute.tsx`, `src/hooks/pos/useCheckout.ts`, `src/lib/fifo.ts`.

---

## 🚨 Headline Finding (read this first)

**Checkout is a Firestore `runTransaction`, not a batch write — so a sale cannot be completed offline today, PWA or not.**

`useCheckout.confirmSale` → `completePosSale` (`lib/fifo.ts:275`) performs:
- **Pre-transaction server reads** — receipt-number config, overdue-credit query, and **FIFO active-lot `getDocs`** (`fifo.ts:281–306`).
- **A `runTransaction`** (`fifo.ts:308`) that reads the receipt counter, shift, per-product stock and product docs, then writes the order, order items, stock decrement, FIFO lot consumption, and the incremented receipt counter — **atomically**.

`runTransaction` **requires a live server round-trip and fails immediately when offline** (`unavailable`). It is *not* latency-compensated and *never* queues. Therefore:

> Installing a PWA shell makes the app **open** offline, but the cashier will still hit **"บันทึกไม่สำเร็จ"** the moment they press Pay. Worse, without explicit UX this invites **double-rings** (cashier retries when back online) or **lost sales**.

This means the PWA must be scoped honestly: **App Shell + offline browse, with checkout explicitly online-required** — *or* we commit to a separate, much larger **offline-write redesign** epic (discussed in §1 and the Strategy). The transactional design exists for good reasons (atomic FIFO, unique sequential bill numbers, oversell guard) that do not survive naive offline queuing.

---

## 1. Firebase Offline Limitations (`runTransaction` & `Auth`)

### 1a. Transactions fail offline — and we use them in three places

| Call site | Operation | Offline behavior |
|---|---|---|
| `lib/fifo.ts:308` `completePosSale` | **Checkout** (order + FIFO + bill number + stock) | ❌ Throws immediately — sale blocked |
| `lib/pos/productSorting.ts` `saveProductSortOrder` | Admin sorting reorder (`rev` guard) | ❌ Throws → generic "บันทึกไม่สำเร็จ", optimistic edit lost on reload |
| `lib/admin/quickMenuStore.ts` `mutate` | Quick Menu CRUD | ❌ Throws → generic "บันทึกไม่สำเร็จ" |

**Why these can't be trivially made offline-queueable:**
- **Sequential bill numbering** (`readReceiptCounterInTransaction`) — queuing offline across multiple terminals would produce **duplicate bill IDs**.
- **FIFO lot consumption** — needs the *current* remaining lot quantities to cut correctly; offline, two terminals can over-consume the same lot.
- **Oversell guard** — depends on current stock.

**Graceful handling (admin sorting/quick menus — LOW blast radius):**
Admins are usually on stable HQ connections, but we should still:
- Detect offline (`!navigator.onLine` or error `code === 'unavailable'`) and show a **specific** message — "ออฟไลน์: บันทึกการจัดเรียงไม่ได้ กรุณาเชื่อมต่ออินเทอร์เน็ต" — instead of the current generic toast.
- **Disable** the reorder/save controls while offline so the optimistic edit isn't silently discarded.

**Graceful handling (checkout — HIGH blast radius):**
- **v1 (recommended): make checkout online-required and explicit.** Bind the **Pay button to online status** — disable it offline with a clear banner ("ออฟไลน์: ไม่สามารถปิดการขายได้"). This prevents the false-confidence failure mode. *The PWA still adds value*: the app opens instantly, the catalog/cart/customer browse all work offline, and only the final commit needs network.
- **v2 (separate epic, not this sprint): true offline sales.** Requires client-generated bill IDs (UUID + later reconciliation), deferring FIFO allocation to server-side reconciliation (Cloud Function), accepting temporary oversell, and a sync/conflict queue. This is a **major architectural change**, not a PWA config flag.

### 1b. Auth on offline boot — **good news, with one hardening item**

The session is **hydrated synchronously from `localStorage`** at provider init: `useState(() => loadSession())` (`AuthProvider.tsx:107`; `session.ts:10`). `isAuthenticated = session != null` (`AuthProvider.tsx:267`). The route guard only redirects to `/login` when `!isAuthenticated && !isLoading` (`ProtectedRoute.tsx:25`).

➡️ **The user is NOT kicked to login offline** — the session exists before the first paint, independent of network. Firebase `onAuthStateChanged` also fires from its **persisted IndexedDB state** offline, so `isLoading` resolves to `false` and the auth token is served from cache for queued writes.

**Risks / hardening:**
- **Loading-hang risk:** `isLoading` starts `true` and only flips in the `onAuthStateChanged` callback (`AuthProvider.tsx:109,148`). If that callback is delayed/never fires (cold Auth IndexedDB, SW serving a stale bundle), the app sits on **"กำลังโหลด…"** forever. Recommend: since the session is already known synchronously, **don't block the authed UI on `isLoading`**, or add a short timeout fallback.
- **`ensureFirebaseAuth()` calls `signInAnonymously`** (`firebaseAuth.ts:11`), which **needs network**. On a truly cold first-ever offline boot (no cached anonymous user), this throws — but it's already wrapped in try/catch (`AuthProvider.tsx:141–145`) and the localStorage session still stands. Firestore writes will simply lack a token until reconnect; **queued non-transactional writes flush on reconnect** once the token refreshes.
- **Token expiry offline:** ID tokens last ~1h; the SDK auto-refreshes on reconnect before flushing the write queue. Custom-claim changes made server-side while offline won't apply until refresh (acceptable).

---

## 2. Service Worker Update Strategy (Stale-Cache Death)

### 2a. `registerType: 'autoUpdate'` is **dangerous for a POS** — do not use it
With `autoUpdate`, vite-plugin-pwa activates the new SW (`skipWaiting` + `clientsClaim`) and **auto-reloads the page** when a deploy is detected. The cart is **in-memory React state** (`useCart`'s `rawCart`) — an auto-reload **mid-sale wipes the cart** and interrupts the cashier. Unacceptable.

### 2b. Use `registerType: 'prompt'` with a sale-aware gate
- Configure `registerType: 'prompt'`, **`skipWaiting: false`** — the new SW waits and never auto-activates.
- Wire `onNeedRefresh` to a **non-intrusive toast/banner**: "มีเวอร์ชันใหม่ — รีเฟรชเมื่อพร้อม".
- **Only call `updateServiceWorker(true)` (which reloads) when it's safe**: gate it behind an explicit cashier tap **and** `cartLines.length === 0` (between sales). Reuse the exact pattern already shipped for the **sync-signal banner** in `POSPage.tsx` (defer disruptive refresh while a sale is in progress) — this is a proven, consistent UX here.
- Wire `onOfflineReady` to a one-time "พร้อมใช้งานออฟไลน์" confirmation.

---

## 3. Routing & Asset Caching (SPA deep links)

React Router is a client-side SPA (`App.tsx` `BrowserRouter`). For offline deep links (e.g. reloading `/admin/inventory` or `/admin/quick-menus` with no network) the SW must serve the cached **`index.html`** so the router can take over.

**Requirements & caveats:**
- Set Workbox **`navigateFallback: 'index.html'`** and ensure `index.html` is precached (and revisioned) so deep-link reloads resolve offline.
- **`navigateFallbackDenylist`** must exclude non-SPA paths so the fallback doesn't hijack them:
  - the dev/prod **Cloud Functions proxy** `^/__/firebase/` (see `vite.config.ts:15`),
  - any Firebase **auth handler** paths,
  - any future API routes.
- **Do NOT add runtime caching for `*.googleapis.com`** (Firestore Listen/Write channels, Auth). Workbox `generateSW` precaches only same-origin build output by default — keep it that way; caching Firestore endpoints would corrupt realtime/offline sync. Firestore's **own IndexedDB persistence**, not the SW, is the data layer.
- Vite emits **content-hashed asset filenames**, so precached JS/CSS are safely cache-busted per build; only `index.html` needs revisioning (Workbox handles this in its precache manifest).

---

## 4. Data Queuing vs App Shell — is `persistentLocalCache` adequate?

**For the *cache/persistence* layer: yes. For *checkout*: no — because checkout doesn't use a queueable write.**

- `firebase.ts:31–57` already configures **`persistentLocalCache` with `persistentMultipleTabManager` and `CACHE_SIZE_UNLIMITED`** — correct and sufficient for offline **reads** and for **queuing non-transactional writes** (`setDoc`/`updateDoc`/`addDoc`/**`writeBatch`**). Those are latency-compensated and flush on reconnect.
- **But the checkout is a `runTransaction`** (§headline), which **bypasses the offline queue entirely**. So the persistence config is *adequate for what it governs*, yet the **sale cannot be queued** as currently written.
- Multi-tab note: `persistentMultipleTabManager` elects one leader tab; this coexists fine with a Service Worker. No change needed.

**Net:** the App Shell (PWA) and the Data Layer (persistence) are two independent concerns. The PWA can ship safely for **shell + offline browse**; **offline *checkout* is gated by the transactional write design, not by the cache config.**

---

## Risk Summary

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 0 | **Offline checkout fails** (`runTransaction`) — false offline confidence, double-rings | **Critical** | v1: bind Pay to online, clear offline banner. v2 (separate epic): offline-write redesign |
| 1a | Admin sorting/quick-menu transactions fail offline | Low | Offline-specific message + disable controls offline |
| 1b | Loading-hang if `onAuthStateChanged` stalls | Medium | Don't gate authed UI on `isLoading` (session is sync); timeout fallback |
| 2 | `autoUpdate` reloads mid-sale, wipes cart | **High** | `registerType:'prompt'`, `skipWaiting:false`, reload only when cart empty |
| 3 | Offline deep links 404 without navigateFallback; caching Firestore endpoints corrupts sync | High | `navigateFallback:'index.html'` + denylist `/__/`, auth; never runtime-cache googleapis |
| 4 | Mistaking persistence for offline-checkout capability | High | Treat shell vs. data as separate; document checkout = online-required (v1) |

---

## ✅ Proposed Safe Implementation Strategy

**Ship a strictly-scoped, sale-safe PWA v1. Do NOT attempt offline checkout in this sprint.**

**Phase A — App Shell (low risk, high value):**
1. Add `vite-plugin-pwa` with **`registerType: 'prompt'`**, **`skipWaiting: false`**, a web-app manifest (installable on the counter tablet), and `navigateFallback: 'index.html'` with a denylist for `^/__/firebase/` and auth paths.
2. Precache only same-origin hashed build assets + `index.html`. **No runtime caching of `*.googleapis.com`.**
3. Verify the existing Cloud Functions proxy and Firebase Auth still work with the SW registered.

**Phase B — Sale-safe UX:**
4. Add a global **online/offline indicator**. **Disable the Pay button offline** with a clear banner; keep catalog/cart/customer browse fully usable offline (reads come from `persistentLocalCache`).
5. Reuse the **sync-banner pattern** for the SW update prompt: surface "เวอร์ชันใหม่" and only reload via explicit tap **when `cartLines.length === 0`**.
6. Harden auth boot: render the authed shell from the synchronous localStorage session without hanging on `isLoading`; add a timeout fallback.

**Phase C — Validation gate (before any real-money use):**
7. Simulate offline (DevTools): confirm (a) app **opens** and browses offline, (b) deep-link reload of `/admin/*` serves the shell, (c) Pay is **clearly blocked** offline (no silent failure, no double-ring), (d) a new deploy shows the update prompt and does **not** auto-reload mid-cart.

**Explicitly deferred (separate epic, needs its own design + approval):** true **offline sales** — client-generated bill IDs, server-side FIFO reconciliation via Cloud Function, oversell tolerance, and a write/conflict queue. This is where the real architectural risk lives and must not be smuggled into the PWA sprint.

---

## Request for Approval

The PWA is safe to build **as a shell + offline-browse** with checkout explicitly **online-required** (Phases A–C). The seductive-but-dangerous part — believing the PWA grants offline *sales* — is a trap the `runTransaction` checkout design closes off until we do a dedicated offline-write redesign.

**Khun Chat — do you approve proceeding with PWA v1 (App Shell + sale-safe UX, checkout online-required), and deferring true offline checkout to a separate epic?** Please also confirm two choices:
1. **Update strategy:** `prompt` with cart-empty-gated reload (recommended) — agreed?
2. **Offline checkout posture for v1:** block Pay offline with a clear banner (recommended), vs. attempt the larger offline-write redesign now?

I will not write implementation code until you approve.
