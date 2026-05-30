import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock } from '../types';

/** One aggregated row: a product's stock summed across every branch. */
export type AllBranchesStockRow = {
  id: string;
  name: string;
  sku: string;
  category: string;
  /** Moving-average unit cost (Product.avgCost). */
  avgCost: number;
  /** Sum of `totalStockBase` across all branches that hold this product. */
  totalQty: number;
  /** How many branch stock rows contributed (i.e. branches carrying it). */
  branchCount: number;
  /** Valuation: totalQty × avgCost. */
  totalValue: number;
};

export type AllBranchesStockResult = {
  rows: AllBranchesStockRow[];
  /** Grand total quantity across every product and branch. */
  totalQty: number;
  /** Grand total valuation across every product and branch. */
  totalValue: number;
  productCount: number;
  loading: boolean;
  error: string | null;
};

/**
 * Consolidated, cross-branch stock aggregation for the Admin "ALL branches"
 * overview.
 *
 * This is a deliberately SEPARATE layer from the single-branch `useStockReport`
 * — it never touches that hook, so the branch-level report stays untouched.
 * It fetches active products once and sums each product's `totalStockBase`
 * across every branch via a `collectionGroup('productStocks')` query (the same
 * pattern the admin dashboard already uses). Valuation is `totalQty × avgCost`.
 *
 * Admin-only: the Firestore `productStocks` collection-group rule grants
 * unrestricted read to `isAdmin()`, so the unfiltered group query is allowed.
 */
export function useAllBranchesStock(): AllBranchesStockResult {
  const [rows, setRows] = useState<AllBranchesStockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      // No backend configured (dev/preview) — surface an empty, non-erroring view.
      if (!isFirebaseConfigured || !db) {
        if (!cancelled) {
          setRows([]);
          setLoading(false);
        }
        return;
      }

      try {
        // Active, non-deleted products provide the row set + names/costs.
        const productsSnap = await getDocs(
          query(collection(db, collections.products), where('isActive', '==', true)),
        );
        const products = productsSnap.docs
          .map((d) => ({ ...(d.data() as Product), id: d.id }))
          .filter((p) => !p.deletedAt);

        // Sum totalStockBase per product across EVERY branch.
        const aggByProduct = new Map<string, { qty: number; branches: number }>();
        const stockSnap = await getDocs(collectionGroup(db, collections.productStocks));
        for (const d of stockSnap.docs) {
          const productId = d.ref.parent.parent?.id;
          if (!productId) continue;
          const stock = d.data() as ProductStock;
          const prev = aggByProduct.get(productId) ?? { qty: 0, branches: 0 };
          aggByProduct.set(productId, {
            qty: prev.qty + (stock.totalStockBase ?? 0),
            branches: prev.branches + 1,
          });
        }

        const result: AllBranchesStockRow[] = products.map((p) => {
          const agg = aggByProduct.get(p.id);
          const totalQty = agg?.qty ?? 0;
          const avgCost = p.avgCost ?? 0;
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            category: p.category,
            avgCost,
            totalQty,
            branchCount: agg?.branches ?? 0,
            totalValue: totalQty * avgCost,
          };
        });

        // Highest valuation first — the executive view leads with what matters.
        result.sort((a, b) => b.totalValue - a.totalValue);

        if (!cancelled) {
          setRows(result);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'โหลดข้อมูลไม่สำเร็จ');
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const { totalQty, totalValue } = useMemo(
    () => ({
      totalQty: rows.reduce((s, r) => s + r.totalQty, 0),
      totalValue: rows.reduce((s, r) => s + r.totalValue, 0),
    }),
    [rows],
  );

  return { rows, totalQty, totalValue, productCount: rows.length, loading, error };
}
