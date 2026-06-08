# DEFECT-UAT-001: Offline Product Grid Empty After Navigation

## 1. Defect Summary
When the POS operates offline (network disconnected) and a cashier navigates away from the POS screen (e.g. to Sales History) and returns, the product grid appears completely empty. Console logs show expected `ERR_INTERNET_DISCONNECTED` errors but the cache fallback fails silently, leaving the UI empty without explanation.

## 2. Root Cause Analysis
### Firestore Initialization
- **Finding**: Safe. `src/lib/firebase.ts` correctly initializes Firestore using `initializeFirestore` with `persistentLocalCache`, `persistentMultipleTabManager`, and `CACHE_SIZE_UNLIMITED` using the explicit `FIRESTORE_DATABASE_ID`. Cache behavior itself is configured perfectly.

### Product Fetch / Cache Fallback (The True Root Cause)
- **Finding**: The bug is in how `getDocs` behaves when the network drops unexpectedly and the SDK returns a transport error before detecting a full offline state.
- **Exact Mechanism**:
  1. The POS uses a point-in-time pull model (`usePosInventory` hook calling `getInventorySnapshot` in `inventoryRepository.ts`).
  2. `getInventorySnapshot` uses `Promise.all([getDocs(productQ), getDocs(categories), ...])`.
  3. When navigating away, `POSPage` unmounts. When returning, `POSPage` remounts and `usePosInventory` initializes with `EMPTY_SNAPSHOT` (`products: []`).
  4. It calls `load('initial')` which fires `getInventorySnapshot()`.
  5. Because the client is offline, the network transport errors (`ERR_INTERNET_DISCONNECTED`) and `getDocs()` throws a `FirebaseError` instead of falling back to cache automatically.
  6. `getInventorySnapshot` throws, catching the error in `usePosInventory`.
  7. `usePosInventory` sets `error = true` but retains the `snapshot` as `EMPTY_SNAPSHOT`.
  8. The `POSPage` UI sees `products.length === 0` and renders an empty grid. The cached data is ignored.

## 3. Patch Implementation
### Files Changed
- `src/lib/pos/inventoryRepository.ts`
- `src/lib/pos/productSorting.ts`
- `src/lib/admin/quickMenuStore.ts`
- `src/hooks/pos/usePosInventory.ts`
- `src/pages/POSPage.tsx`

### Patch Summary
1. **Cache Fallback Wrappers with Error Classification**: Implemented `isOfflineLikeFirestoreError` to correctly classify network transport errors (`ERR_INTERNET_DISCONNECTED`, `unavailable`, `offline`, `WebChannelConnection`). The fallback to `getDocsFromCache()` is *strictly limited* to these offline-like errors.
2. **Preserved Firestore Index/Security Errors**: Non-offline errors (like `permission-denied` or `failed-precondition`) bypass the cache fallback and are thrown directly to the caller. This ensures that the POS UI accurately renders real errors instead of hiding them behind a stale cache, and preserves the intended per-product fallback in `fetchStockByProduct` when a collection-group index is missing.
3. **`fromCache` Flag**: Modified `InventorySnapshot` to surface whether the data was loaded from cache (`productSnap.metadata?.fromCache === true`).
4. **Empty/Offline State UI**: Updated `POSPage.tsx` to handle the empty state distinctively:
   - If cache fallback succeeds but the user is offline: "ออฟไลน์ แสดงข้อมูลสินค้าล่าสุดในเครื่อง" (Yellow alert).
   - If the cache is truly empty and offline: "ไม่มีข้อมูลสินค้าในเครื่อง ต้องเชื่อมต่ออินเทอร์เน็ตเพื่อโหลดครั้งแรก" (Red alert).
   - If a real Firestore/system error occurs: "ข้อผิดพลาดของระบบ: [error message]" (Red alert).
   - If the server snapshot is genuinely empty: "ยังไม่มีข้อมูลสินค้าในระบบ".

## 4. Testing & Evidence
### Automated Build
```
> twinpet-pos@0.0.0 build
> tsc -b && vite build

vite v8.0.14 building client environment for production...
Generating .flowbite-react\class-list.json file...
transforming...✓ 547 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                             1.42 kB │ gzip:   0.62 kB
dist/assets/index-BZB99B3B.css            339.23 kB │ gzip:  52.50 kB
dist/assets/rolldown-runtime-Bh1tDfsg.js    0.56 kB │ gzip:   0.36 kB
dist/assets/react-router-BVImBSaZ.js       42.27 kB │ gzip:  15.07 kB
dist/assets/vendor-ech4Bep8.js            117.86 kB │ gzip:  33.73 kB
dist/assets/charts-xn6RU_C7.js            177.58 kB │ gzip:  61.51 kB
dist/assets/react-vendor-CzRZBWxH.js      250.54 kB │ gzip:  80.54 kB
dist/assets/firebase-BY1e-tG2.js          465.05 kB │ gzip: 140.03 kB
dist/assets/index-DPtoczwR.js             946.26 kB │ gzip: 216.18 kB

✓ built in 727ms
```

### Playwright E2E
```
Running 1 test using 1 worker
  1 passed (3.6s)
```

### Manual Verification Status
- **Status**: DEFERRED
- **Reason**: Automated AI environment cannot toggle `navigator.onLine` or simulate flaky network requests. DEFECT-UAT-001 is ready for human re-test only after Codex approves patch.
- **Human Re-test Instructions**:
  1. Load POS online.
  2. Confirm products are visible.
  3. Disconnect network.
  4. Navigate away from POS, then back to POS.
  5. Verify cached product grid is still visible, with a yellow offline indicator.

## 5. Security & Rule Impact
- No Firebase rules or Cloud Functions were modified.
- No changes to checkout, payment, or void flows.
- No changes to `pos-db` database isolation.
- Missing indices or permission errors now explicitly bypass cache fallback.

## 6. Developer Self-Review Before Codex
```markdown
- [x] **Scope implemented**: Defect patched with targeted offline fallback.
- [x] **Broad fallback risk fixed**: Cache fallback restricted strictly to offline/transport errors.
- [x] **Failed-precondition/index fallback preserved**: Index errors bypass cache and trigger per-product stock fetching.
- [x] **Build output captured**: Yes, build runs successfully and output is embedded.
- [x] **Latest-report corrected**: Accurately reflects code changes.
- [x] **Manual offline verification still deferred**: Acknowledged.
- [x] **No native storage implementation**: Capacitor plugins were NOT used.
- [x] **Files changed**: `inventoryRepository.ts`, `productSorting.ts`, `quickMenuStore.ts`, `usePosInventory.ts`, `POSPage.tsx`.
- [x] **Forbidden files untouched**: All rules, functions, tests, unrelated components, android/, ios/, `stash@{0}`.
- [x] **Ready for Codex review**: Yes
```
