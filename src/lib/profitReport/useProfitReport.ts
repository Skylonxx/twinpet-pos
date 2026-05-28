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
import { orderToProfitLines } from './devMock';
import type { ProfitSaleLine } from './types';

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

    const q = query(
      collection(db, collections.orders),
      where('branchId', '==', branchId),
      orderBy('createdAt', 'desc'),
    );

    const unsub = onSnapshot(
      q,
      async (snap) => {
        try {
          const orders = snap.docs.map((d) => ({ ...(d.data() as Order), id: d.id }));
          const active = orders.filter((o) => o.status !== 'voided');
          const itemSets = await Promise.all(
            active.map(async (order) => {
              const items = await fetchOrderItems(order.id);
              return orderToProfitLines(order, items);
            }),
          );
          const flat = itemSets.flat();
          const imageMap = await fetchProductImageMap([...new Set(flat.map((l) => l.productId))]);
          if (cancelled) return;
          setLines(
            flat.map((line) => ({
              ...line,
              imageUrl: imageMap.get(line.productId) ?? null,
            })),
          );
          setLoading(false);
        } catch (err) {
          if (!cancelled) {
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
