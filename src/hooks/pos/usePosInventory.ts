import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getInventorySnapshot,
  type InventorySnapshot,
} from '../../lib/pos/inventoryRepository';
import type { ProductCategory } from '../../lib/types';
import type { PosProduct } from '../../lib/pos/types';

const EMPTY_SNAPSHOT: InventorySnapshot = {
  products: [],
  categories: [],
  sorting: {},
  quickMenus: [],
};

/**
 * Static, pull-based POS inventory feed — the UI-facing half of the Repository
 * boundary. Fetches ONE point-in-time snapshot on mount (and on branch change),
 * then never mutates on its own: a backend price/rank edit cannot reshuffle the
 * grid mid-sale. The cashier pulls fresh data explicitly via `refreshInventory`.
 *
 * Drop-in for the live `usePosProducts` shape (`products`, `categories`,
 * `loading`, `error`) plus `richCategories` (replaces the live `useCategories`
 * listener) and the manual `refreshInventory` action. `products`/`richCategories`
 * keep a stable identity between refreshes, so the cart's tier-reprice effect
 * never churns on render.
 */
export function usePosInventory(branchId: string | null) {
  const [snapshot, setSnapshot] = useState<InventorySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Guards against a slow in-flight fetch resolving after the branch changed
  // (or the component unmounted) and clobbering newer state.
  const requestId = useRef(0);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!branchId) {
        setSnapshot(EMPTY_SNAPSHOT);
        setLoading(false);
        return;
      }
      const reqId = ++requestId.current;
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      try {
        const next = await getInventorySnapshot(branchId);
        if (reqId !== requestId.current) return; // superseded — drop stale result
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (reqId !== requestId.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (reqId === requestId.current) {
          if (mode === 'initial') setLoading(false);
          else setRefreshing(false);
        }
      }
    },
    [branchId],
  );

  useEffect(() => {
    void load('initial');
  }, [load]);

  /** Pull a fresh snapshot from the repository (cache → server) on demand. */
  const refreshInventory = useCallback(() => load('refresh'), [load]);

  // Distinct category strings, '' first ("all") — mirrors the legacy hook shape
  // so POSPage's category enrichment is unchanged.
  const categories = useMemo<string[]>(
    () => ['', ...new Set(snapshot.products.map((p) => p.category))],
    [snapshot.products],
  );

  return {
    products: snapshot.products as PosProduct[],
    categories,
    richCategories: snapshot.categories as ProductCategory[],
    /** Sharded product order per categoryKey — fed to `sortProductsByCustomOrder`. */
    sorting: snapshot.sorting,
    /** Admin virtual categories for this branch (POS shows the active ones). */
    quickMenus: snapshot.quickMenus,
    loading,
    refreshing,
    error,
    refreshInventory,
  };
}
