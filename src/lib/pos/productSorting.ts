import {
  arrayRemove,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  runTransaction,
  serverTimestamp,
  updateDoc,
  type CollectionReference,
  type DocumentReference,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';

/**
 * Sharded POS product ordering — 500-doc-proof replacement for the old
 * per-product `branchSettings.sortOrders` writes (which committed O(N) batched
 * writes and broke past Firestore's 500-write limit).
 *
 * Model: ONE document per `(branch, categoryKey)` at
 *   `pos_configs/branches/{branchId}/sorting/categories/{categoryKey}`
 * holding `{ order: string[], rev: number, updatedAt }`. A reorder / reset is a
 * single O(1) write of the whole array; create/delete cleanup is an atomic
 * `arrayRemove`. The reader (`sortProductsByCustomOrder`) is self-healing, so
 * the array is a presentation hint over the authoritative live product set —
 * ghosts and missing entries never corrupt the grid.
 *
 * `categoryKey` is `'best-sellers'` or a category id (matches the POS sort key).
 */

export type ProductSortOrder = { order: string[]; rev: number };

/** Thrown by {@link saveProductSortOrder} when another editor advanced `rev`. */
export class ConcurrentEditError extends Error {
  constructor() {
    super('Sorting order was changed by another editor');
    this.name = 'ConcurrentEditError';
  }
}

export function productSortingDocRef(branchId: string, categoryKey: string): DocumentReference {
  return doc(db!, 'pos_configs', 'branches', branchId, 'sorting', 'categories', categoryKey);
}

export function productSortingCollectionRef(branchId: string): CollectionReference {
  return collection(db!, 'pos_configs', 'branches', branchId, 'sorting', 'categories');
}

// ── Dev (no-Firebase) fallback: localStorage keyed by `${branchId}::${key}` ──
const DEV_SORT_KEY = 'twinpet-pos-sort-orders';
type DevSortStore = Record<string, ProductSortOrder>;
const devCompositeKey = (branchId: string, categoryKey: string) => `${branchId}::${categoryKey}`;

function readDevSort(): DevSortStore {
  try {
    const raw = localStorage.getItem(DEV_SORT_KEY);
    return raw ? (JSON.parse(raw) as DevSortStore) : {};
  } catch {
    return {};
  }
}

function writeDevSort(store: DevSortStore): void {
  localStorage.setItem(DEV_SORT_KEY, JSON.stringify(store));
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** All saved orders for a branch: `{ [categoryKey]: string[] }`. For the POS repo. */
export async function getBranchSortOrders(branchId: string): Promise<Record<string, string[]>> {
  if (!isFirebaseConfigured || !db) {
    const store = readDevSort();
    const prefix = `${branchId}::`;
    const out: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(store)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value.order ?? [];
    }
    return out;
  }
  let snap;
  try {
    snap = await getDocs(productSortingCollectionRef(branchId));
  } catch (err) {
    console.warn('[productSorting] getDocs failed, trying cache', err);
    snap = await getDocsFromCache(productSortingCollectionRef(branchId));
  }
  const out: Record<string, string[]> = {};
  for (const d of snap.docs) {
    const order = d.data().order;
    if (Array.isArray(order)) out[d.id] = order as string[];
  }
  return out;
}

/** A single `(branch, categoryKey)` order + its `rev` (for the admin editor). */
export async function getProductSortOrder(
  branchId: string,
  categoryKey: string,
): Promise<ProductSortOrder> {
  if (!isFirebaseConfigured || !db) {
    const entry = readDevSort()[devCompositeKey(branchId, categoryKey)];
    return { order: entry?.order ?? [], rev: entry?.rev ?? 0 };
  }
  let snap;
  try {
    snap = await getDoc(productSortingDocRef(branchId, categoryKey));
  } catch (err) {
    console.warn('[productSorting] getDoc failed, trying cache', err);
    snap = await getDocFromCache(productSortingDocRef(branchId, categoryKey));
  }
  if (!snap.exists()) return { order: [], rev: 0 };
  const data = snap.data();
  return {
    order: Array.isArray(data.order) ? (data.order as string[]) : [],
    rev: typeof data.rev === 'number' ? data.rev : 0,
  };
}

// ── Writes ────────────────────────────────────────────────────────────────────

/**
 * Persist a full ordering for one `(branch, categoryKey)` in a single O(1) write.
 * Runs in a transaction with an optimistic-concurrency guard: pass the `rev` you
 * loaded as `expectedRev` and the write throws {@link ConcurrentEditError} if
 * another editor advanced it in the meantime. Omit `expectedRev` to force-write
 * (used by the A–Z mass reset). Returns the new `rev`.
 */
export async function saveProductSortOrder(
  branchId: string,
  categoryKey: string,
  orderedIds: readonly string[],
  expectedRev?: number,
): Promise<number> {
  if (!isFirebaseConfigured || !db) {
    const store = readDevSort();
    const key = devCompositeKey(branchId, categoryKey);
    const current = store[key]?.rev ?? 0;
    if (expectedRev != null && current !== expectedRev) throw new ConcurrentEditError();
    const nextRev = current + 1;
    store[key] = { order: [...orderedIds], rev: nextRev };
    writeDevSort(store);
    return nextRev;
  }

  const ref = productSortingDocRef(branchId, categoryKey);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() && typeof snap.data().rev === 'number' ? (snap.data().rev as number) : 0;
    if (expectedRev != null && current !== expectedRev) throw new ConcurrentEditError();
    const nextRev = current + 1;
    tx.set(ref, { order: [...orderedIds], rev: nextRev, updatedAt: serverTimestamp() });
    return nextRev;
  });
}

/**
 * Atomic best-effort cleanup when a product is (soft-)deleted: `arrayRemove` its
 * id from every `(branch, categoryKey)` order it appears in. The self-healing
 * reader already ignores ghosts, so this is an optimization, not a correctness
 * requirement — hence best-effort. Bounded by branches × that branch's category
 * docs, far under any batch limit.
 */
export async function removeProductFromAllSorting(productId: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDevSort();
    let changed = false;
    for (const [key, value] of Object.entries(store)) {
      if (value.order?.includes(productId)) {
        store[key] = { order: value.order.filter((id) => id !== productId), rev: value.rev ?? 0 };
        changed = true;
      }
    }
    if (changed) writeDevSort(store);
    return;
  }

  const branchesSnap = await getDocs(collection(db, collections.branches));
  await Promise.all(
    branchesSnap.docs.map(async (b) => {
      // Skip branches this user can't access (rules deny the read) — cleanup is
      // best-effort and the reader self-heals ghosts elsewhere.
      const colSnap = await getDocs(productSortingCollectionRef(b.id)).catch(() => null);
      if (!colSnap) return;
      await Promise.all(
        colSnap.docs.map(async (d) => {
          const order = d.data().order;
          if (Array.isArray(order) && order.includes(productId)) {
            await updateDoc(d.ref, { order: arrayRemove(productId) }).catch(() => {});
          }
        }),
      );
    }),
  );
}

/**
 * Cleanup when a category is deleted globally: drop its `(branch, categoryKey)`
 * order doc on every branch. `deleteDoc` on a missing doc is a no-op.
 */
export async function deleteCategorySortingEverywhere(categoryKey: string): Promise<void> {
  if (!isFirebaseConfigured || !db) {
    const store = readDevSort();
    let changed = false;
    for (const key of Object.keys(store)) {
      if (key.endsWith(`::${categoryKey}`)) {
        delete store[key];
        changed = true;
      }
    }
    if (changed) writeDevSort(store);
    return;
  }

  const branchesSnap = await getDocs(collection(db, collections.branches));
  await Promise.all(
    branchesSnap.docs.map((b) =>
      deleteDoc(productSortingDocRef(b.id, categoryKey)).catch(() => {}),
    ),
  );
}
