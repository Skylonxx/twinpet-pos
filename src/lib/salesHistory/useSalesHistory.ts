import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  type Query,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from '../pos/deviceId';
import type { AsyncOrder, Order, OrderItem, Payment } from '../types';
import { buildPendingOverlay, mergeWithOverlay } from './asyncOverlay';
import { getDevSalesRecords, resetDevSalesRecords } from './devMock';
import { orderCreatedAt, type SaleRecord } from './types';

function logSalesHistoryError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'unknown';

  console.error(`[SalesHistory] ${context}`, {
    code,
    message,
    err,
  });

  if (
    message.includes('index') ||
    message.includes('FAILED_PRECONDITION') ||
    code === 'failed-precondition'
  ) {
    console.error(
      '[SalesHistory] อาจต้องสร้าง Firestore Index สำหรับ orders (branchId + createdAt) — ดูลิงก์ใน error message ด้านบน หรือใช้ query แบบ fallback',
    );
  }
}

async function fetchPaymentsForOrders(orderIds: string[]): Promise<Map<string, Payment[]>> {
  const map = new Map<string, Payment[]>();
  if (!db || !orderIds.length) return map;

  const chunkSize = 10;
  for (let i = 0; i < orderIds.length; i += chunkSize) {
    const chunk = orderIds.slice(i, i + chunkSize);
    try {
      const snap = await getDocs(
        query(collection(db, collections.payments), where('orderId', 'in', chunk)),
      );
      snap.forEach((d) => {
        const payment = { ...(d.data() as Payment), id: d.id };
        const list = map.get(payment.orderId) ?? [];
        list.push(payment);
        map.set(payment.orderId, list);
      });
    } catch (err) {
      logSalesHistoryError('โหลด payments ไม่สำเร็จ', err);
      throw err;
    }
  }

  return map;
}

async function fetchOrderItems(orderId: string): Promise<OrderItem[]> {
  if (!db) return [];
  const snap = await getDocs(collection(db, collections.orders, orderId, collections.orderItems));
  return snap.docs.map((d) => ({ ...(d.data() as OrderItem), id: d.id }));
}

function buildOrdersQuery(branchId: string, withOrderBy: boolean): Query {
  const base = collection(db!, collections.orders);
  if (withOrderBy) {
    return query(base, where('branchId', '==', branchId), orderBy('createdAt', 'desc'));
  }
  return query(base, where('branchId', '==', branchId));
}

function mapSnapshotToRecords(
  orders: Order[],
  paymentMap: Map<string, Payment[]>,
  prev: SaleRecord[],
): SaleRecord[] {
  const prevItems = new Map(prev.map((r) => [r.order.id, r.items]));
  return orders.map((order) => ({
    order,
    payments: paymentMap.get(order.id) ?? [],
    items: prevItems.get(order.id) ?? [],
  }));
}

export function useSalesHistory(branchId: string | null) {
  const [records, setRecords] = useState<SaleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [itemsCache, setItemsCache] = useState<Map<string, OrderItem[]>>(new Map());
  const [reloadToken, setReloadToken] = useState(0);
  // Hybrid overlay: this device's still-pending `asyncOrders` (not yet in the
  // canonical `orders` projection), surfaced as `pendingSync` rows.
  const [pendingRecords, setPendingRecords] = useState<SaleRecord[]>([]);
  // Ids of this device's `asyncOrders` carrying a `voidRequested` intent — used to
  // flag SETTLED canonical rows whose void hasn't been reconciled yet (Phase 7b).
  const [voidIntentIds, setVoidIntentIds] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(() => {
    if (!branchId) {
      setRecords([]);
      return;
    }
    if (!isFirebaseConfigured || !db) {
      setRecords(resetDevSalesRecords(branchId));
      return;
    }
    setReloadToken((t) => t + 1);
  }, [branchId]);

  useEffect(() => {
    if (!branchId) {
      setRecords([]);
      setLoading(false);
      setError(null);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setLoading(false);
      setError(null);
      setRecords(getDevSalesRecords(branchId));
      return;
    }

    setLoading(true);
    setError(null);

    let cancelled = false;
    let unsub = () => {};
    let useOrderBy = true;

    const subscribe = (withOrderBy: boolean) => {
      unsub();
      const q = buildOrdersQuery(branchId, withOrderBy);

      console.info(
        `[SalesHistory] เริ่ม subscribe orders — branchId=${branchId}, orderBy=${withOrderBy}`,
      );

      unsub = onSnapshot(
        q,
        async (snap) => {
          try {
            const orders = snap.docs.map((d) => ({ ...(d.data() as Order), id: d.id }));
            console.info(`[SalesHistory] โหลด orders สำเร็จ: ${orders.length} รายการ`);

            const paymentMap = await fetchPaymentsForOrders(orders.map((o) => o.id));
            if (cancelled) return;

            setRecords((prev) => mapSnapshotToRecords(orders, paymentMap, prev));
            setError(null);
            setLoading(false);
          } catch (err) {
            logSalesHistoryError('ประมวลผล orders snapshot ไม่สำเร็จ', err);
            if (!cancelled) {
              setError(err instanceof Error ? err : new Error(String(err)));
              setLoading(false);
            }
          }
        },
        (err) => {
          logSalesHistoryError('subscribe orders ไม่สำเร็จ', err);

          if (cancelled) return;

          const message = err instanceof Error ? err.message : String(err);
          const missingIndex =
            message.includes('index') ||
            message.includes('FAILED_PRECONDITION') ||
            (err as { code?: string }).code === 'failed-precondition';

          if (useOrderBy && missingIndex) {
            console.warn('[SalesHistory] ใช้ fallback query (branchId เท่านั้น) เนื่องจากไม่มี composite index');
            useOrderBy = false;
            subscribe(false);
            return;
          }

          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        },
      );
    };

    subscribe(true);

    return () => {
      cancelled = true;
      unsub();
    };
  }, [branchId, reloadToken]);

  // Pending-overlay listener — bounded, equality-only (no composite index),
  // scoped to THIS device like SyncIndicator. Resolves from persistentLocalCache,
  // so a sale the cashier just rang up appears in history instantly, even offline.
  useEffect(() => {
    if (!branchId || !isFirebaseConfigured || !db) {
      setPendingRecords([]);
      setVoidIntentIds(new Set());
      return;
    }
    // ONE bounded listener over this device's asyncOrders (like useLocalLedger).
    // We derive BOTH the pending overlay AND the void-intent set from it.
    const q = query(
      collection(db, 'asyncOrders'),
      where('branchId', '==', branchId),
      where('deviceId', '==', getDeviceId()),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const orders = snap.docs.map((d) => ({ ...(d.data() as AsyncOrder), id: d.id }));
        setPendingRecords(buildPendingOverlay(orders));
        setVoidIntentIds(new Set(orders.filter((o) => o.voidRequested === true).map((o) => o.id)));
      },
      (err) => console.warn('[SalesHistory] async-overlay listener error', err),
    );
    return unsub;
  }, [branchId]);

  const loadItems = useCallback(
    async (orderId: string): Promise<OrderItem[]> => {
      if (itemsCache.has(orderId)) {
        return itemsCache.get(orderId)!;
      }

      // Pending-overlay rows carry their lines inline — there is no canonical
      // `orders/{id}` subcollection to fetch yet.
      const pending = pendingRecords.find((r) => r.order.id === orderId);
      if (pending) return pending.items;

      if (!isFirebaseConfigured || !db) {
        const rec = records.find((r) => r.order.id === orderId);
        return rec?.items ?? [];
      }

      try {
        const items = await fetchOrderItems(orderId);
        setItemsCache((prev) => new Map(prev).set(orderId, items));
        setRecords((prev) =>
          prev.map((r) => (r.order.id === orderId ? { ...r, items } : r)),
        );
        return items;
      } catch (err) {
        logSalesHistoryError(`โหลด orderItems ไม่สำเร็จ (orderId=${orderId})`, err);
        throw err;
      }
    },
    [itemsCache, records, pendingRecords],
  );

  const syncDevRecords = useCallback(() => {
    if (branchId) setRecords(getDevSalesRecords(branchId));
  }, [branchId]);

  const sortedRecords = useMemo(() => {
    const merged = mergeWithOverlay(records, pendingRecords).map((r) =>
      // Flag settled canonical rows whose void-intent is not yet reconciled
      // (canonical still non-voided). Pending/already-voided rows are unaffected.
      voidIntentIds.has(r.order.id) && r.order.status !== 'voided'
        ? { ...r, voidPendingSync: true }
        : r,
    );
    return merged.sort(
      (a, b) => orderCreatedAt(b.order).getTime() - orderCreatedAt(a.order).getTime(),
    );
  }, [records, pendingRecords, voidIntentIds]);

  return {
    records: sortedRecords,
    loading,
    error,
    loadItems,
    syncDevRecords,
    refresh,
  };
}
