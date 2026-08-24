import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSalesDelta } from '../../lib/hooks/useLocalSalesDelta';
import {
  getInventorySnapshot,
  type InventorySnapshot,
} from '../../lib/pos/inventoryRepository';
import { applyLocalSalesDeltaToProducts } from '../../lib/pos/localSalesDelta';
import type { InventoryProvenance, PosProduct } from '../../lib/pos/types';
import type { ProductCategory } from '../../lib/types';

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
 *
 * Local-sales delta is composed here (not in the repository). Each `load()`
 * captures the retirement generation at request start. After an accepted-current
 * apply, only taint at or below that captured generation is cleared. A later
 * retirement (generation > captured) stays tainted and re-asserts
 * `pendingRetirementRefresh` so the POS empty-cart safe point can schedule the
 * next refresh. Superseded success and error paths still clear nothing.
 */
export function usePosInventory(branchId: string | null) {
  const [snapshot, setSnapshot] = useState<InventorySnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [pendingRetirementRefresh, setPendingRetirementRefresh] = useState(false);
  const [taintEpoch, setTaintEpoch] = useState(0);

  const requestId = useRef(0);
  /** productId → retirement generation that last tainted it */
  const retirementTaintRef = useRef<Map<string, number>>(new Map());
  const retirementGenerationRef = useRef(0);
  const lastSettlementSeqRef = useRef(0);

  const localSales = useLocalSalesDelta(branchId);

  const load = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!branchId) {
        setSnapshot(EMPTY_SNAPSHOT);
        setLoading(false);
        retirementTaintRef.current = new Map();
        retirementGenerationRef.current = 0;
        setPendingRetirementRefresh(false);
        setTaintEpoch((n) => n + 1);
        return;
      }
      const reqId = ++requestId.current;
      const capturedRetirementGeneration = retirementGenerationRef.current;
      if (mode === 'initial') setLoading(true);
      else setRefreshing(true);
      try {
        const next = await getInventorySnapshot(branchId);
        if (reqId !== requestId.current) return; // superseded — drop stale result; do NOT clear taint
        setSnapshot(next);
        setError(null);
        for (const [id, generation] of [...retirementTaintRef.current]) {
          if (generation <= capturedRetirementGeneration) {
            retirementTaintRef.current.delete(id);
          }
        }
        // Release this request's pending claim. Leftover later-generation taint
        // is re-asserted by the effect below so POSPage can observe a true edge.
        setPendingRetirementRefresh(false);
        setTaintEpoch((n) => n + 1);
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

  useEffect(() => {
    if (localSales.normalSettlementSeq === 0) return;
    if (localSales.normalSettlementSeq === lastSettlementSeqRef.current) return;
    lastSettlementSeqRef.current = localSales.normalSettlementSeq;
    const generation = ++retirementGenerationRef.current;
    for (const id of localSales.lastNormalSettlementProductIds) {
      retirementTaintRef.current.set(id, generation);
    }
    setTaintEpoch((n) => n + 1);
    setPendingRetirementRefresh(true);
  }, [localSales.normalSettlementSeq, localSales.lastNormalSettlementProductIds]);

  // Leftover later-generation taint must keep the pending signal. Re-asserting
  // after the apply-path release lets the existing POS empty-cart effect run
  // again without a timer or a mid-sale reshuffle.
  useEffect(() => {
    if (retirementTaintRef.current.size > 0) {
      setPendingRetirementRefresh(true);
    }
  }, [snapshot, taintEpoch]);

  /** Pull a fresh snapshot from the repository (cache → server) on demand. */
  const refreshInventory = useCallback(() => load('refresh'), [load]);

  const composedProducts = useMemo(
    () =>
      applyLocalSalesDeltaToProducts(
        snapshot.products,
        localSales.delta,
        new Set(retirementTaintRef.current.keys()),
      ),
    [snapshot.products, localSales.delta, taintEpoch],
  );

  const categories = useMemo<string[]>(
    () => ['', ...new Set(composedProducts.map((p) => p.category))],
    [composedProducts],
  );

  const provenance: InventoryProvenance | undefined = snapshot.provenance;

  return {
    products: composedProducts as PosProduct[],
    categories,
    richCategories: snapshot.categories as ProductCategory[],
    sorting: snapshot.sorting,
    quickMenus: snapshot.quickMenus,
    fromCache: snapshot.fromCache ?? false,
    provenance,
    loading,
    refreshing,
    error,
    refreshInventory,
    pendingRetirementRefresh,
  };
}
