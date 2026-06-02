import { collection, doc, onSnapshot, query, setDoc, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { DEV_POS_PRODUCTS } from '../pos/devProducts';
import type { SortableProduct } from '../pos/categoryService';
import {
  deleteCategorySortingEverywhere,
  removeProductFromAllSorting,
} from '../pos/productSorting';
import type { Product, ProductBranchSetting } from '../types';

/**
 * Persistence layer for the admin Sorting Settings page.
 *
 * Product ORDER now lives in sharded `(branch, categoryKey)` documents (see
 * `lib/pos/productSorting`) — O(1) writes, immune to the 500-write batch limit.
 * This module keeps the pieces that stay on the product document under the
 * hybrid model: the live product list and per-branch VISIBILITY
 * (`branchSettings[branchId].isVisibleInPos`). Order reads/writes are delegated
 * to `productSorting`.
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

/** Persists a product's POS visibility for ONE branch (merge-safe). Stays on the
 *  product document — single write, never near the batch limit (hybrid model). */
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
 * Cascade for a (soft-)DELETED product: atomic `arrayRemove` of its id from every
 * sharded sorting order it appears in. The self-healing reader already ignores
 * ghosts, so this is cleanup, not correctness — and it is O(branches), never a
 * 500-write batch.
 */
export async function cascadeDeleteProduct(productId: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDev();
    if (store[productId]) {
      delete store[productId];
      writeDev(store);
    }
  }
  await removeProductFromAllSorting(productId);
}

/**
 * Cascade for a DELETED category: drop its sharded order doc on every branch.
 * Replaces the old O(N) per-product `deleteField` sweep.
 */
export async function cascadeDeleteCategory(categoryKey: string): Promise<void> {
  await deleteCategorySortingEverywhere(categoryKey);
}
