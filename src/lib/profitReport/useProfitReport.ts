import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import type { Order, OrderItem, Product } from '../types';
import { getDevProfitLines } from './devMock';
import { orderToProfitLines, resolveOrderFinancials, safeToDate } from './devMock';
import type { ProfitSaleLine } from './types';

/**
 * Order-level rollup line built purely from the order document — used as an
 * instant placeholder when an order's `orderItems` subcollection has not yet
 * surfaced (latency compensation right after a sale). Relies on the COGS/profit
 * persisted on the order; the next snapshot replaces it with real per-line rows.
 */
function orderRollupLine(order: Order): ProfitSaleLine | null {
  const { cogs, profit } = resolveOrderFinancials(order, []);
  const revenue = Number.isFinite(order.subtotal) ? order.subtotal : cogs + profit;
  if (!Number.isFinite(revenue)) return null;
  const created = safeToDate(order.createdAt);
  return {
    id: `${order.id}-rollup`,
    orderId: order.id,
    date: created.toISOString().slice(0, 10),
    time: created.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }),
    bill: order.billId || order.id,
    customer: order.customerSnap?.name ?? 'สมาชิกทั่วไป',
    productId: `__order__${order.id}`,
    productName: 'รวมทั้งบิล (กำลังโหลดรายการ)',
    productSku: '',
    category: 'อื่นๆ',
    emoji: '🧾',
    iconBg: '#EEEDFE',
    imageUrl: null,
    qty: 0,
    salePrice: revenue,
    revenue,
    cogs,
    profit,
    margin: revenue > 0 ? (profit / revenue) * 100 : 0,
  };
}

async function fetchOrderItems(orderId: string): Promise<OrderItem[]> {
  if (!db) return [];
  const snap = await getDocs(
    collection(db, collections.orders, orderId, collections.orderItems),
  );
  return snap.docs.map((d) => ({ ...(d.data() as OrderItem), id: d.id }));
}

async function fetchProductImageMap(productIds: string[]): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  const firestore = db;
  if (!firestore || productIds.length === 0) return map;
  await Promise.all(
    productIds.map(async (id) => {
      const snap = await getDoc(doc(firestore, collections.products, id));
      if (!snap.exists()) return;
      map.set(id, (snap.data() as Product).imageUrl ?? null);
    }),
  );
  return map;
}

export function useProfitReport(branchId: string | null) {
  const [lines, setLines] = useState<ProfitSaleLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!branchId) {
      setLines([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      setLoading(false);
      setLines(getDevProfitLines(branchId));
      return;
    }

    setLoading(true);
    setError(null);
    let cancelled = false;
    // Monotonic guard: only the newest snapshot's async result may publish, so a
    // slow earlier run can never overwrite a newer one (prevents flicker).
    let runSeq = 0;

    const q = query(
      collection(db, collections.orders),
      where('branchId', '==', branchId),
      orderBy('createdAt', 'desc'),
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        const myRun = ++runSeq;
        try {
          const orders = snap.docs.map((d) => ({ ...(d.data() as Order), id: d.id }));
          const active = orders.filter((o) => o.status !== 'voided');
          const itemSets = await Promise.all(
            active.map(async (order) => {
              const items = await fetchOrderItems(order.id);
              if (items.length === 0) {
                // Items haven't replicated yet — show an instant order-level
                // rollup from the persisted totals instead of dropping the bill.
                const rollup = orderRollupLine(order);
                return rollup ? [rollup] : [];
              }
              return orderToProfitLines(order, items);
            }),
          );
          const flat = itemSets.flat();
          const imageMap = await fetchProductImageMap([...new Set(flat.map((l) => l.productId))]);
          if (cancelled || myRun !== runSeq) return;
          setLines(
            flat.map((line) => ({
              ...line,
              imageUrl: imageMap.get(line.productId) ?? line.imageUrl ?? null,
            })),
          );
          setLoading(false);
        } catch (err) {
          if (!cancelled && myRun === runSeq) {
            setError(err instanceof Error ? err : new Error(String(err)));
            setLoading(false);
          }
        }
      },
      (err) => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [branchId]);

  return { lines, loading, error };
}
