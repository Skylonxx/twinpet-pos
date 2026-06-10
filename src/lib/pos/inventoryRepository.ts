/**
 * Inventory Repository — the strict boundary between Firestore's reactive layer
 * and the POS UI.
 *
 * Light Path contract: every read is a ONE-SHOT `getDocs`, never an
 * `onSnapshot`. The Firestore SDK (configured with `persistentLocalCache`, see
 * `firebase.ts`) transparently resolves these reads from the on-disk IndexedDB
 * cache when offline, and refreshes the cache from the server when online. The
 * caller therefore receives a static, point-in-time array — the UI cannot be
 * reactively reshuffled mid-sale by a backend price/rank edit; it only changes
 * when the caller explicitly asks for a new snapshot.
 *
 * The serialization boundary (`Product` → `PosProduct`, stripping every
 * Firestore `Timestamp`) is delegated to `posProductMapper`, so live and static
 * read paths emit identical primitive-only projections.
 */

import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocFromCache,
  getDocs,
  getDocsFromCache,
  query,
  where,
} from 'firebase/firestore';
import { getQuickMenus, type QuickMenu } from '../admin/quickMenuStore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductCategory } from '../types';
import { DEV_POS_PRODUCTS } from './devProducts';
import { readReversalOverlay } from './offline/reversalStockOverlay';
import { mergePosProducts, type StockEntry } from './posProductMapper';
import { getBranchSortOrders } from './productSorting';
import type { PosProduct } from './types';

/** Static, point-in-time view of a branch's sellable catalog. */
export type InventorySnapshot = {
  products: PosProduct[];
  categories: ProductCategory[];
  /** Sharded product ordering per `categoryKey` ('best-sellers' or a category id). */
  sorting: Record<string, string[]>;
  /** Admin-curated virtual categories (order-sorted; POS filters to active ones). */
  quickMenus: QuickMenu[];
  /** True if the snapshot was served from the local offline cache. */
  fromCache?: boolean;
};

function isIndexError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === 'failed-precondition' || code === 'unimplemented';
}

/** Dev / unconfigured-Firebase fallback: derive products + categories from seeds. */
function devProductsAndCategories(): Pick<InventorySnapshot, 'products' | 'categories'> {
  const categories: ProductCategory[] = [...new Set(DEV_POS_PRODUCTS.map((p) => p.category))].map(
    (cat) => ({ id: cat, name: cat }),
  );
  return { products: DEV_POS_PRODUCTS, categories };
}

function mapCategoryDoc(d: { id: string; data: () => Record<string, unknown> }): ProductCategory {
  const data = d.data();
  const id = String(data.id ?? d.id).trim();
  const name = String(data.name ?? id).trim();
  const entry: ProductCategory = { id, name };
  if (data.branchSettings && typeof data.branchSettings === 'object') {
    entry.branchSettings = data.branchSettings as ProductCategory['branchSettings'];
  }
  return entry;
}

function isOfflineLikeFirestoreError(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    const msg = err.message || '';
    if (code === 'unavailable') return true;
    if (msg.includes('ERR_INTERNET_DISCONNECTED')) return true;
    if (msg.includes('WebChannelConnection')) return true;
    if (msg.includes('transport errored')) return true;
    if (msg.includes('offline')) return true;
  }
  return false;
}

async function safeGetDocs(q: any): Promise<any> {
  try {
    return await getDocs(q);
  } catch (err) {
    if (isOfflineLikeFirestoreError(err)) {
      console.warn('[inventoryRepository] offline/transport error, falling back to cache', err);
      return await getDocsFromCache(q);
    }
    throw err;
  }
}

async function safeGetDoc(ref: any): Promise<any> {
  try {
    return await getDoc(ref);
  } catch (err) {
    if (isOfflineLikeFirestoreError(err)) {
      console.warn('[inventoryRepository] offline/transport error, falling back to cache', err);
      return await getDocFromCache(ref);
    }
    throw err;
  }
}

/** Read this branch's per-product stock + price overrides, keyed by productId. */
async function fetchStockByProduct(branchId: string, productIds: string[]): Promise<Map<string, StockEntry>> {
  const stockByProduct = new Map<string, StockEntry>();

  const apply = (productId: string | undefined, data: Record<string, unknown> | undefined) => {
    if (!productId) return;
    stockByProduct.set(productId, {
      stock: (data?.totalStockBase as number) ?? 0,
      overrideTierPrices: (data?.overrideTierPrices as Record<string, number>) ?? undefined,
    });
  };

  try {
    const stockQ = query(
      collectionGroup(db!, collections.productStocks),
      where('branchId', '==', branchId),
    );
    const snap = await safeGetDocs(stockQ);
    for (const d of snap.docs) apply(d.ref.parent.parent?.id, d.data());
    return stockByProduct;
  } catch (err) {
    if (!isIndexError(err)) throw err;
    // Collection-group index unavailable — fall back to per-product reads
    // (productStocks/{branchId} sub-doc). Matches the live hook's resilience.
    console.warn('[inventoryRepository] productStocks collectionGroup unavailable — per-product reads');
    await Promise.all(
      productIds.map(async (id) => {
        const stockRef = doc(db!, collections.products, id, collections.productStocks, branchId);
        const stockSnap = await safeGetDoc(stockRef);
        apply(id, stockSnap.exists() ? stockSnap.data() : undefined);
      }),
    );
    return stockByProduct;
  }
}

/**
 * Overlay pending offline-reversal deltas onto the Firestore stock map (mutates in
 * place). This is what makes the queue's IMMEDIATE local stock correction visible to
 * the POS grid — `visible stock = Firestore productStocks + pending reversal deltas`.
 * A product touched only by a reversal (absent from the Firestore map) is seeded from 0.
 */
function applyReversalOverlay(
  stockByProduct: Map<string, StockEntry>,
  overlay: Map<string, number>,
): void {
  for (const [productId, delta] of overlay) {
    const cur = stockByProduct.get(productId);
    stockByProduct.set(productId, {
      stock: (cur?.stock ?? 0) + delta,
      overrideTierPrices: cur?.overrideTierPrices,
    });
  }
}

/**
 * Resolve a fresh, static inventory snapshot for `branchId`. Reads come from the
 * SDK cache (offline) or server (online); either way the returned arrays are
 * detached, primitive-only, and safe to hand straight to the POS grid + cart.
 *
 * The Firestore stock is overlaid with any pending offline-reversal deltas
 * (`offline/reversalStockOverlay`) so a just-voided receiving/transfer is reflected
 * immediately — re-read on every refresh, keeping the Light Path point-in-time.
 */
export async function getInventorySnapshot(branchId: string): Promise<InventorySnapshot> {
  if (!isFirebaseConfigured || !db) {
    const { products, categories } = devProductsAndCategories();
    const reversalOverlay = await readReversalOverlay(branchId);
    return {
      products: reversalOverlay.size
        ? products.map((p) =>
            reversalOverlay.has(p.id) ? { ...p, stock: p.stock + reversalOverlay.get(p.id)! } : p,
          )
        : products,
      categories,
      sorting: await getBranchSortOrders(branchId),
      quickMenus: await getQuickMenus(branchId),
    };
  }

  const productQ = query(
    collection(db, collections.products),
    where('isActive', '==', true),
  );
  // Sharded sorting + quick menus are read here as part of the same static
  // snapshot, so the grid order is point-in-time too — no live listener on the
  // POS, Light Path intact.
  const [productSnap, categorySnap, sorting, quickMenus] = await Promise.all([
    safeGetDocs(productQ),
    safeGetDocs(collection(db, collections.categories)),
    getBranchSortOrders(branchId),
    getQuickMenus(branchId),
  ]);

  const rawProducts: Product[] = productSnap.docs
    .map((d: any) => ({ ...(d.data() as Product), id: d.id }))
    .filter((p: any) => !p.deletedAt);

  const [stockByProduct, reversalOverlay] = await Promise.all([
    fetchStockByProduct(branchId, rawProducts.map((p) => p.id)),
    readReversalOverlay(branchId),
  ]);
  applyReversalOverlay(stockByProduct, reversalOverlay);

  return {
    products: mergePosProducts(rawProducts, stockByProduct),
    categories: categorySnap.docs.map(mapCategoryDoc),
    sorting,
    quickMenus,
    fromCache: productSnap.metadata?.fromCache === true,
  };
}
