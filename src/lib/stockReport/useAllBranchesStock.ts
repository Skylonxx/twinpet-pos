import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { fetchAllBranches } from '../admin/branchManagement';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Product, ProductStock } from '../types';
import { stockStatus, type StockStatus } from './types';

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
  /** Company-wide reorder point — summed across branches (falls back to the
   *  product's global reorderPoint when no branch rows exist). */
  reorderPoint: number;
  /** Valuation: totalQty × avgCost. */
  totalValue: number;
  /** Company-wide stock status derived from totalQty vs reorderPoint. */
  status: StockStatus;
  /** When true the product is excluded from low/critical/OOS alert metrics. */
  muteAlerts: boolean;
};

/** Total stock valuation held by one branch (feeds the donut chart). */
export type BranchStockValue = {
  branchId: string;
  branchName: string;
  value: number;
  qty: number;
};

export type AllBranchesStockResult = {
  rows: AllBranchesStockRow[];
  /** Per-branch valuation, highest first. */
  branchValues: BranchStockValue[];
  /** Products below their reorder point (status !== 'ok'), worst first. */
  lowStock: AllBranchesStockRow[];
  /** Grand total quantity across every product and branch. */
  totalQty: number;
  /** Grand total valuation across every product and branch. */
  totalValue: number;
  productCount: number;
  /** Branches that currently hold any stock for an active product. */
  branchCount: number;
  lowStockCount: number;
  criticalCount: number;
  oosCount: number;
  loading: boolean;
  error: string | null;
};

const EMPTY: Omit<AllBranchesStockResult, 'loading' | 'error'> = {
  rows: [],
  branchValues: [],
  lowStock: [],
  totalQty: 0,
  totalValue: 0,
  productCount: 0,
  branchCount: 0,
  lowStockCount: 0,
  criticalCount: 0,
  oosCount: 0,
};

/**
 * Consolidated, cross-branch stock aggregation for the Admin "ALL branches"
 * executive overview.
 *
 * This is a deliberately SEPARATE layer from the single-branch `useStockReport`
 * — it never touches that hook, so the branch-level report stays untouched.
 * It fetches active products once and sums each product's `totalStockBase`
 * across every branch via a `collectionGroup('productStocks')` query (the same
 * pattern the admin dashboard already uses), while also rolling up:
 *   • per-branch total valuation (for the "value by branch" donut), and
 *   • company-wide low-stock status (totalQty vs summed reorder points).
 *
 * Admin-only: the Firestore `productStocks` collection-group rule grants
 * unrestricted read to `isAdmin()`, so the unfiltered group query is allowed.
 */
export function useAllBranchesStock(): AllBranchesStockResult {
  const [data, setData] =
    useState<Omit<AllBranchesStockResult, 'loading' | 'error'>>(EMPTY);
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
          setData(EMPTY);
          setLoading(false);
        }
        return;
      }

      try {
        const [productsSnap, stockSnap, branchList] = await Promise.all([
          getDocs(query(collection(db, collections.products), where('isActive', '==', true))),
          getDocs(collectionGroup(db, collections.productStocks)),
          fetchAllBranches(),
        ]);

        const products = productsSnap.docs
          .map((d) => ({ ...(d.data() as Product), id: d.id }))
          .filter((p) => !p.deletedAt);

        const costById = new Map(products.map((p) => [p.id, p.avgCost ?? 0]));
        const branchNameById = new Map(
          branchList.map((b) => [b.id, b.name?.trim() || b.id]),
        );

        // Per-product and per-branch accumulators (active products only, so the
        // branch breakdown sums exactly to the grand total).
        const productAgg = new Map<string, { qty: number; branches: number; reorder: number }>();
        const branchAgg = new Map<string, { value: number; qty: number }>();

        for (const docSnap of stockSnap.docs) {
          const productId = docSnap.ref.parent.parent?.id;
          if (!productId || !costById.has(productId)) continue;

          const stock = docSnap.data() as ProductStock;
          const qty = stock.totalStockBase ?? 0;
          const cost = costById.get(productId) ?? 0;
          const branchId = stock.branchId || docSnap.id;

          const pPrev = productAgg.get(productId) ?? { qty: 0, branches: 0, reorder: 0 };
          productAgg.set(productId, {
            qty: pPrev.qty + qty,
            branches: pPrev.branches + 1,
            reorder: pPrev.reorder + (stock.reorderPoint ?? 0),
          });

          const bPrev = branchAgg.get(branchId) ?? { value: 0, qty: 0 };
          branchAgg.set(branchId, {
            value: bPrev.value + qty * cost,
            qty: bPrev.qty + qty,
          });
        }

        const rows: AllBranchesStockRow[] = products.map((p) => {
          const agg = productAgg.get(p.id);
          const totalQty = agg?.qty ?? 0;
          const avgCost = p.avgCost ?? 0;
          const reorderPoint = agg && agg.branches > 0 ? agg.reorder : p.reorderPoint ?? 0;
          return {
            id: p.id,
            name: p.name,
            sku: p.sku,
            category: p.category,
            avgCost,
            totalQty,
            branchCount: agg?.branches ?? 0,
            reorderPoint,
            totalValue: totalQty * avgCost,
            status: stockStatus(totalQty, reorderPoint),
            muteAlerts: p.muteAlerts ?? false,
          };
        });

        // Highest valuation first — the executive view leads with what matters.
        rows.sort((a, b) => b.totalValue - a.totalValue);

        const branchValues: BranchStockValue[] = [...branchAgg.entries()]
          .map(([branchId, agg]) => ({
            branchId,
            branchName: branchNameById.get(branchId) || branchId,
            value: agg.value,
            qty: agg.qty,
          }))
          .sort((a, b) => b.value - a.value);

        // Muted products are normal stock for valuation, but never raise alerts.
        const lowStock = rows
          .filter((r) => r.status !== 'ok' && !r.muteAlerts)
          .sort((a, b) => a.totalQty - b.totalQty);

        const totalQty = rows.reduce((s, r) => s + r.totalQty, 0);
        const totalValue = rows.reduce((s, r) => s + r.totalValue, 0);

        if (!cancelled) {
          setData({
            rows,
            branchValues,
            lowStock,
            totalQty,
            totalValue,
            productCount: rows.length,
            branchCount: branchValues.length,
            lowStockCount: lowStock.length,
            criticalCount: rows.filter((r) => r.status === 'critical' && !r.muteAlerts).length,
            oosCount: rows.filter((r) => r.status === 'oos' && !r.muteAlerts).length,
          });
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

  return useMemo(() => ({ ...data, loading, error }), [data, loading, error]);
}
