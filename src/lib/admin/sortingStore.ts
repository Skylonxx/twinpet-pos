import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { DEV_POS_PRODUCTS } from '../pos/devProducts';
import {
  sortProductsByCustomOrder,
  stripCategoryFromBranchSettings,
  type SortableProduct,
} from '../pos/categoryService';
import type { Product, ProductBranchSetting } from '../types';

/**
 * Persistence layer for the admin Sorting Settings page. All writes are scoped
 * to a single `branchId` under `branchSettings[branchId]`, so each branch keeps
 * its own independent order / visibility without overwriting any other branch.
 * Pure sort/visibility logic lives in `pos/categoryService` (framework-agnostic).
 */

const DEV_KEY = 'twinpet-product-branch-settings';

/** Dev fallback: { [productId]: { [branchId]: ProductBranchSetting } }. */
type DevStore = Record<string, Record<string, ProductBranchSetting>>;

function readDev(): DevStore {
  try {
    const raw = localStorage.getItem(DEV_KEY);
    return raw ? (JSON.parse(raw) as DevStore) : {};
  } catch {
    return {};
  }
}

function writeDev(store: DevStore): void {
  localStorage.setItem(DEV_KEY, JSON.stringify(store));
}

function devSortableProducts(): SortableProduct[] {
  const store = readDev();
  return DEV_POS_PRODUCTS.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    branchSettings: store[p.id] ?? p.branchSettings,
  }));
}

/** Live list of active products reduced to the minimal `SortableProduct` shape. */
export function useSortableProducts(): { products: SortableProduct[]; loading: boolean } {
  const [products, setProducts] = useState<SortableProduct[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      setProducts(devSortableProducts());
      setLoading(false);
      return;
    }

    setLoading(true);
    const q = query(collection(db, collections.products), where('isActive', '==', true));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: SortableProduct[] = snap.docs
          .map((d) => ({ ...(d.data() as Product), id: d.id }))
          .filter((p) => p.name && !p.deletedAt)
          .map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            branchSettings: p.branchSettings,
          }));
        setProducts(list);
        setLoading(false);
      },
      () => setLoading(false),
    );

    return () => unsub();
  }, []);

  return { products, loading };
}

/**
 * Persists a new product ranking for one (branch, categoryKey): each id's index
 * becomes `branchSettings[branchId].sortOrders[categoryKey]`. Merge-writes so
 * other branches and other category ranks are preserved.
 */
export async function saveProductSortOrders(
  branchId: string,
  categoryKey: string,
  orderedProductIds: readonly string[],
): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDev();
    orderedProductIds.forEach((id, index) => {
      const branchMap = store[id] ?? {};
      const setting = branchMap[branchId] ?? { isVisibleInPos: true, sortOrders: {} };
      branchMap[branchId] = {
        ...setting,
        sortOrders: { ...setting.sortOrders, [categoryKey]: index },
      };
      store[id] = branchMap;
    });
    writeDev(store);
    return;
  }

  const batch = writeBatch(db);
  orderedProductIds.forEach((id, index) => {
    batch.set(
      doc(db!, collections.products, id),
      { branchSettings: { [branchId]: { sortOrders: { [categoryKey]: index } } } },
      { merge: true },
    );
  });
  await batch.commit();
}

/** Persists a product's POS visibility for ONE branch (merge-safe). */
export async function saveProductVisibility(
  branchId: string,
  productId: string,
  visible: boolean,
): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDev();
    const branchMap = store[productId] ?? {};
    const setting = branchMap[branchId] ?? { isVisibleInPos: true, sortOrders: {} };
    branchMap[branchId] = { ...setting, isVisibleInPos: visible };
    store[productId] = branchMap;
    writeDev(store);
    return;
  }

  await setDoc(
    doc(db, collections.products, productId),
    { branchSettings: { [branchId]: { isVisibleInPos: visible } } },
    { merge: true },
  );
}

/**
 * Cascade for a DELETED category: strips its key from every product's per-branch
 * `sortOrders`, across ALL branches, so no orphan rank entries linger.
 */
export async function cascadeDeleteCategory(categoryKey: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDev();
    let changed = false;
    for (const [productId, branchMap] of Object.entries(store)) {
      const next = stripCategoryFromBranchSettings(branchMap, categoryKey);
      if (next !== branchMap) {
        changed = true;
        store[productId] = next ?? {};
      }
    }
    if (changed) writeDev(store);
    return;
  }

  const snap = await getDocs(query(collection(db, collections.products)));
  const batch = writeBatch(db);
  let writes = 0;
  for (const d of snap.docs) {
    const data = d.data() as Product;
    const branchSettings = data.branchSettings ?? {};
    for (const [branchId, setting] of Object.entries(branchSettings)) {
      if (setting.sortOrders && categoryKey in setting.sortOrders) {
        batch.update(doc(db!, collections.products, d.id), {
          [`branchSettings.${branchId}.sortOrders.${categoryKey}`]: deleteField(),
        });
        writes += 1;
      }
    }
  }
  if (writes > 0) await batch.commit();
}

/**
 * Cascade for a DELETED (soft-deleted) product: clears its own branch settings
 * and compacts the remaining products' indexes for every (branch, categoryKey)
 * group it belonged to, so positions stay contiguous (0,1,2,…) with no gaps.
 */
export async function cascadeDeleteProduct(productId: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDev();
    if (store[productId]) {
      delete store[productId];
      writeDev(store);
    }
    return;
  }

  const selfSnap = await getDoc(doc(db, collections.products, productId));
  const selfData = selfSnap.exists() ? (selfSnap.data() as Product) : null;
  const selfBranchSettings = selfData?.branchSettings ?? {};

  // Collect the (branch, key) groups the deleted product participated in.
  const groups: Array<{ branchId: string; key: string }> = [];
  for (const [branchId, setting] of Object.entries(selfBranchSettings)) {
    for (const key of Object.keys(setting.sortOrders ?? {})) {
      groups.push({ branchId, key });
    }
  }

  const batch = writeBatch(db);
  let writes = 0;

  if (selfData?.branchSettings) {
    batch.update(doc(db!, collections.products, productId), { branchSettings: deleteField() });
    writes += 1;
  }

  if (groups.length > 0) {
    const snap = await getDocs(
      query(collection(db, collections.products), where('isActive', '==', true)),
    );
    const remaining: SortableProduct[] = snap.docs
      .map((d) => ({ ...(d.data() as Product), id: d.id }))
      .filter((p) => p.id !== productId && !p.deletedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        branchSettings: p.branchSettings,
      }));

    for (const { branchId, key } of groups) {
      const scoped = remaining.filter(
        (p) => typeof p.branchSettings?.[branchId]?.sortOrders?.[key] === 'number',
      );
      const ranked = sortProductsByCustomOrder(scoped, key, branchId);
      ranked.forEach((p, index) => {
        if (p.branchSettings?.[branchId]?.sortOrders?.[key] !== index) {
          batch.update(doc(db!, collections.products, p.id), {
            [`branchSettings.${branchId}.sortOrders.${key}`]: index,
          });
          writes += 1;
        }
      });
    }
  }

  if (writes > 0) await batch.commit();
}
