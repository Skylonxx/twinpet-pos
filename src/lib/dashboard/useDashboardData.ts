import { useEffect, useMemo, useState } from 'react';
import {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  query,
  Timestamp,
  where,
} from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Order, OrderItem, Payment, Product, ProductStock } from '../types';
import {
  getDevDashboardNow,
  getDevDashboardPayments,
  getDevDashboardSaleLines,
  getDevStockByProduct,
} from './devMock';
import { getPeriodBounds, isWithinRange } from './periods';
import type {
  DashboardPaymentRecord,
  DashboardPeriod,
  DashboardSaleLine,
  StockMapEntry,
  UseDashboardDataResult,
} from './types';

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

function isIndexError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('index') || msg.includes('FAILED_PRECONDITION');
}

function isValidSaleOrder(status: Order['status']): boolean {
  return status !== 'voided';
}

function applyMockData(): Pick<
  UseDashboardDataResult,
  'saleLines' | 'paymentRecords' | 'stockMap' | 'error'
> {
  return {
    saleLines: getDevDashboardSaleLines(),
    paymentRecords: getDevDashboardPayments(),
    stockMap: getDevStockByProduct(),
    error: null,
  };
}

async function fetchBranchOrders(
  branchId: string,
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

  try {
    const snap = await getDocs(
      query(
        collection(db, collections.orders),
        where('branchId', '==', branchId),
        where('createdAt', '>=', Timestamp.fromDate(fetchStart)),
        where('createdAt', '<=', Timestamp.fromDate(fetchEnd)),
      ),
    );
    return snap.docs.map(mapDoc).filter(inRange);
  } catch (err) {
    if (!isIndexError(err)) throw err;
    console.warn('[dashboard] orders composite index missing — client-side filter fallback');

    const snap = await getDocs(
      query(collection(db, collections.orders), where('branchId', '==', branchId)),
    );
    return snap.docs.map(mapDoc).filter(inRange);
  }
}

async function fetchBranchPayments(
  branchId: string,
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

  const inRange = (p: DashboardPaymentRecord) =>
    isWithinRange(p.createdAt, fetchStart, fetchEnd);

  try {
    const snap = await getDocs(
      query(
        collection(db, collections.payments),
        where('branchId', '==', branchId),
        where('createdAt', '>=', Timestamp.fromDate(fetchStart)),
        where('createdAt', '<=', Timestamp.fromDate(fetchEnd)),
      ),
    );
    return snap.docs.map(mapPayment);
  } catch (err) {
    if (!isIndexError(err)) throw err;
    console.warn('[dashboard] payments composite index missing — client-side filter fallback');

    const snap = await getDocs(
      query(collection(db, collections.payments), where('branchId', '==', branchId)),
    );
    return snap.docs.map(mapPayment).filter(inRange);
  }
}

async function fetchBranchStockMap(branchId: string): Promise<Map<string, StockMapEntry>> {
  if (!db) return new Map();

  const productsSnap = await getDocs(
    query(collection(db, collections.products), where('isActive', '==', true)),
  );

  const products = productsSnap.docs
    .map((d) => ({ ...(d.data() as Product), id: d.id }))
    .filter((p) => !p.deletedAt);

  const stockByProduct = new Map<string, ProductStock>();

  try {
    const stockSnap = await getDocs(
      query(collectionGroup(db, collections.productStocks), where('branchId', '==', branchId)),
    );
    for (const d of stockSnap.docs) {
      const productId = d.ref.parent.parent?.id;
      if (!productId) continue;
      stockByProduct.set(productId, d.data() as ProductStock);
    }
  } catch (err) {
    if (!isIndexError(err)) throw err;
    console.warn('[dashboard] productStocks collectionGroup fallback — per-product lookup');

    await Promise.all(
      products.map(async (product) => {
        const stockRef = doc(
          db!,
          collections.products,
          product.id,
          collections.productStocks,
          branchId,
        );
        const snap = await getDoc(stockRef);
        if (snap.exists()) {
          stockByProduct.set(product.id, snap.data() as ProductStock);
        }
      }),
    );
  }

  const stock = new Map<string, StockMapEntry>();
  for (const product of products) {
    const branchStock = stockByProduct.get(product.id);
    stock.set(product.id, {
      qty: branchStock?.totalStockBase ?? 0,
      reorderPoint: branchStock?.reorderPoint ?? product.reorderPoint ?? 0,
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

  const finiteOr = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  orders.forEach((order, idx) => {
    const createdAt = toDate(order.createdAt);
    const customerName = order.customerSnap?.name ?? 'สมาชิกทั่วไป';

    const items = (itemSnaps[idx]?.docs ?? []).map((d) => d.data() as OrderItem);
    // Authoritative order COGS: prefer the value persisted at sale time, else
    // fall back to the summed item fifoCost (NaN-guarded). Per-line COGS is then
    // reconciled to that total so dashboard breakdowns sum to the headline.
    const itemCogsSum = items.reduce((s, it) => s + finiteOr(it.fifoCost, 0), 0);
    const itemRevenueSum = items.reduce((s, it) => s + finiteOr(it.lineTotal, 0), 0);
    const orderCogs = finiteOr(order.cogs, itemCogsSum);
    const scale = itemCogsSum > 0 ? orderCogs / itemCogsSum : 0;

    items.forEach((item) => {
      const revenue = finiteOr(item.lineTotal, 0);
      const cogs =
        itemCogsSum > 0
          ? finiteOr(item.fifoCost, 0) * scale
          : itemRevenueSum > 0
            ? orderCogs * (revenue / itemRevenueSum)
            : 0;
      lines.push({
        orderId: order.id,
        createdAt,
        productId: item.productId,
        productName: item.productSnap.name,
        category: item.productSnap.category,
        customerName,
        revenue,
        cogs,
        qty: item.qty,
        paymentMethod: 'cash',
      });
    });
  });

  return lines;
}

export function useDashboardData(
  branchId: string | null,
  period: DashboardPeriod,
): UseDashboardDataResult {
  const [saleLines, setSaleLines] = useState<DashboardSaleLine[]>([]);
  const [paymentRecords, setPaymentRecords] = useState<DashboardPaymentRecord[]>([]);
  const [stockMap, setStockMap] = useState(() => new Map<string, StockMapEntry>());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const now = useMemo(
    () => (import.meta.env.DEV && !isFirebaseConfigured ? getDevDashboardNow() : new Date()),
    [],
  );

  const bounds = useMemo(
    () => (branchId ? getPeriodBounds(period, now) : null),
    [branchId, period, now],
  );

  useEffect(() => {
    if (!branchId) {
      setSaleLines([]);
      setPaymentRecords([]);
      setStockMap(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      const mock = applyMockData();
      setSaleLines(mock.saleLines);
      setPaymentRecords(mock.paymentRecords);
      setStockMap(mock.stockMap);
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
          fetchBranchOrders(branchId!, fetchStart, fetchEnd),
          fetchBranchPayments(branchId!, fetchStart, fetchEnd),
          fetchBranchStockMap(branchId!),
        ]);

        const lines = await fetchOrderItems(orders);

        if (!cancelled) {
          setSaleLines(lines);
          setPaymentRecords(payments);
          setStockMap(stock);
        }
      } catch (err) {
        console.error('[dashboard] load failed:', err);
        if (!cancelled) {
          const mock = applyMockData();
          setSaleLines(mock.saleLines);
          setPaymentRecords(mock.paymentRecords);
          setStockMap(mock.stockMap);
          setError(
            import.meta.env.DEV
              ? null
              : err instanceof Error
                ? err
                : new Error('ไม่สามารถโหลดข้อมูลแดชบอร์ดได้'),
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
