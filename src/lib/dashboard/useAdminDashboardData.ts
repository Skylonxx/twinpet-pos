import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  collectionGroup,
  getDocs,
  query,
  Timestamp,
  where,
  type QueryConstraint,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Order, OrderItem, Payment, Product, ProductStock } from '../types';
import { getPeriodBounds, isWithinRange } from './periods';
import type {
  DashboardPaymentRecord,
  DashboardPeriod,
  DashboardSaleLine,
  StockMapEntry,
  UseDashboardDataResult,
} from './types';

/**
 * Admin variant of {@link useDashboardData}. Identical aggregation pipeline,
 * but the branch dimension is selectable: pass a specific `branchId` to scope
 * the queries, or the `'ALL'` sentinel to aggregate across every branch
 * (the `where('branchId', '==', …)` clause is dropped entirely in that case).
 */
export const ALL_BRANCHES = 'ALL' as const;
export type AdminBranchSelection = string | typeof ALL_BRANCHES;

function toDate(value: unknown): Date {
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as Timestamp).toDate === 'function'
  ) {
    return (value as Timestamp).toDate();
  }
  if (value instanceof Date) return value;
  return new Date();
}

function isValidSaleOrder(status: Order['status']): boolean {
  return status !== 'voided';
}

async function fetchOrders(
  branchId: AdminBranchSelection,
  fetchStart: Date,
  fetchEnd: Date,
): Promise<Order[]> {
  if (!db) return [];

  const mapDoc = (d: { id: string; data: () => unknown }): Order => ({
    ...(d.data() as Order),
    id: d.id,
  });

  const inRange = (o: Order) =>
    isValidSaleOrder(o.status) &&
    isWithinRange(toDate(o.createdAt), fetchStart, fetchEnd);

  // ALL → no branch filter: query the live `orders` collection by createdAt only.
  const branchClause: QueryConstraint[] =
    branchId === ALL_BRANCHES ? [] : [where('branchId', '==', branchId)];

  const snap = await getDocs(
    query(
      collection(db, collections.orders),
      ...branchClause,
      where('createdAt', '>=', Timestamp.fromDate(fetchStart)),
      where('createdAt', '<=', Timestamp.fromDate(fetchEnd)),
    ),
  );
  return snap.docs.map(mapDoc).filter(inRange);
}

async function fetchPayments(
  branchId: AdminBranchSelection,
  fetchStart: Date,
  fetchEnd: Date,
): Promise<DashboardPaymentRecord[]> {
  if (!db) return [];

  const mapPayment = (d: { id: string; data: () => unknown }): DashboardPaymentRecord => {
    const p = d.data() as Payment;
    return {
      orderId: p.orderId,
      method: p.method,
      amount: p.amount,
      createdAt: toDate(p.createdAt),
    };
  };

  // ALL → no branch filter: query the live `payments` collection by createdAt only.
  const branchClause: QueryConstraint[] =
    branchId === ALL_BRANCHES ? [] : [where('branchId', '==', branchId)];

  const snap = await getDocs(
    query(
      collection(db, collections.payments),
      ...branchClause,
      where('createdAt', '>=', Timestamp.fromDate(fetchStart)),
      where('createdAt', '<=', Timestamp.fromDate(fetchEnd)),
    ),
  );
  return snap.docs.map(mapPayment);
}

async function fetchStockMap(branchId: AdminBranchSelection): Promise<Map<string, StockMapEntry>> {
  if (!db) return new Map();

  const productsSnap = await getDocs(
    query(collection(db, collections.products), where('isActive', '==', true)),
  );

  const products = productsSnap.docs
    .map((d) => ({ ...(d.data() as Product), id: d.id }))
    .filter((p) => !p.deletedAt);

  // Per-product accumulator: across-branch sums when ALL, single branch otherwise.
  const stockAgg = new Map<string, { qty: number; reorderPoint: number; hasRow: boolean }>();

  const accumulate = (productId: string, row: ProductStock) => {
    const prev = stockAgg.get(productId) ?? { qty: 0, reorderPoint: 0, hasRow: false };
    stockAgg.set(productId, {
      qty: prev.qty + (row.totalStockBase ?? 0),
      reorderPoint: prev.reorderPoint + (row.reorderPoint ?? 0),
      hasRow: true,
    });
  };

  // ALL → query the whole productStocks collection group and accumulate every
  // branch's row per product. A specific branch filters by branchId.
  const stockClause: QueryConstraint[] =
    branchId === ALL_BRANCHES ? [] : [where('branchId', '==', branchId)];
  const stockSnap = await getDocs(
    query(collectionGroup(db, collections.productStocks), ...stockClause),
  );
  for (const d of stockSnap.docs) {
    const productId = d.ref.parent.parent?.id;
    if (!productId) continue;
    accumulate(productId, d.data() as ProductStock);
  }

  const stock = new Map<string, StockMapEntry>();
  for (const product of products) {
    const agg = stockAgg.get(product.id);
    stock.set(product.id, {
      qty: agg?.qty ?? 0,
      reorderPoint: agg?.hasRow ? agg.reorderPoint : product.reorderPoint ?? 0,
      name: product.name,
    });
  }

  return stock;
}

async function fetchOrderItems(orders: Order[]): Promise<DashboardSaleLine[]> {
  if (!db || orders.length === 0) return [];

  const itemSnaps = await Promise.all(
    orders.map((order) =>
      getDocs(collection(db!, collections.orders, order.id, collections.orderItems)),
    ),
  );

  const lines: DashboardSaleLine[] = [];

  orders.forEach((order, idx) => {
    const createdAt = toDate(order.createdAt);
    const customerName = order.customerSnap?.name ?? 'สมาชิกทั่วไป';

    itemSnaps[idx]?.docs.forEach((itemDoc) => {
      const item = itemDoc.data() as OrderItem;
      lines.push({
        orderId: order.id,
        createdAt,
        productId: item.productId,
        productName: item.productSnap.name,
        category: item.productSnap.category,
        customerName,
        revenue: item.lineTotal,
        cogs: item.fifoCost,
        qty: item.qty,
        paymentMethod: 'cash',
      });
    });
  });

  return lines;
}

export function useAdminDashboardData(
  branchId: AdminBranchSelection,
  period: DashboardPeriod,
): UseDashboardDataResult {
  const [saleLines, setSaleLines] = useState<DashboardSaleLine[]>([]);
  const [paymentRecords, setPaymentRecords] = useState<DashboardPaymentRecord[]>([]);
  const [stockMap, setStockMap] = useState(() => new Map<string, StockMapEntry>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Always use the real current date — never a mocked/hardcoded clock.
  const now = useMemo(() => new Date(), []);

  const bounds = useMemo(() => getPeriodBounds(period, now), [period, now]);

  useEffect(() => {
    // No Firebase available → strictly empty, never mock data.
    if (!isFirebaseConfigured || !db) {
      setSaleLines([]);
      setPaymentRecords([]);
      setStockMap(new Map());
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const { fetchStart, end: fetchEnd } = getPeriodBounds(period, now);

        const [orders, payments, stock] = await Promise.all([
          fetchOrders(branchId, fetchStart, fetchEnd),
          fetchPayments(branchId, fetchStart, fetchEnd),
          fetchStockMap(branchId),
        ]);

        const lines = await fetchOrderItems(orders);

        if (!cancelled) {
          setSaleLines(lines);
          setPaymentRecords(payments);
          setStockMap(stock);
        }
      } catch (err) {
        // On any failure (e.g. missing index) log and return empty — never mock.
        console.error('[admin-dashboard] load failed:', err);
        if (!cancelled) {
          setSaleLines([]);
          setPaymentRecords([]);
          setStockMap(new Map());
          setError(
            err instanceof Error ? err : new Error('ไม่สามารถโหลดข้อมูลแดชบอร์ดได้'),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [branchId, period, now]);

  return {
    saleLines,
    paymentRecords,
    stockMap,
    loading,
    error,
    now,
    bounds,
  };
}
