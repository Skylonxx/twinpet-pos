import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
  type Query,
} from 'firebase/firestore';
import { useCallback, useEffect, useState } from 'react';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { getDevReceivingItems, getDevReceivings } from '../receiving/devMock';
import type { Receiving, ReceivingItem } from '../types';
import type { ReceivingRecord } from './types';

function buildQuery(branchId: string, withOrderBy: boolean): Query {
  const base = collection(db!, collections.receivings);
  if (withOrderBy) {
    return query(base, where('branchId', '==', branchId), orderBy('receivedAt', 'desc'));
  }
  return query(base, where('branchId', '==', branchId));
}

function sortReceivings(list: Receiving[]): Receiving[] {
  return [...list].sort((a, b) => {
    const ad =
      a.receivedAt && typeof a.receivedAt === 'object' && 'toDate' in a.receivedAt
        ? a.receivedAt.toDate().getTime()
        : 0;
    const bd =
      b.receivedAt && typeof b.receivedAt === 'object' && 'toDate' in b.receivedAt
        ? b.receivedAt.toDate().getTime()
        : 0;
    return bd - ad;
  });
}

function toRecords(receivings: Receiving[], itemsMap: Map<string, ReceivingItem[]>): ReceivingRecord[] {
  return receivings.map((receiving) => ({
    receiving,
    items: itemsMap.get(receiving.id) ?? [],
  }));
}

export function useReceivingHistory(branchId: string | null) {
  const [records, setRecords] = useState<ReceivingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [itemsCache, setItemsCache] = useState<Map<string, ReceivingItem[]>>(new Map());
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => {
    if (!branchId) return;
    if (!isFirebaseConfigured || !db) {
      const receivings = getDevReceivings(branchId);
      setRecords(
        receivings.map((r) => ({
          receiving: r,
          items: getDevReceivingItems(r.id),
        })),
      );
      return;
    }
    setReloadToken((t) => t + 1);
  }, [branchId]);

  useEffect(() => {
    if (!branchId) {
      setRecords([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      const receivings = getDevReceivings(branchId);
      setRecords(
        receivings.map((r) => ({
          receiving: r,
          items: getDevReceivingItems(r.id),
        })),
      );
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;
    let unsub = () => {};
    let useOrderBy = true;

    const subscribe = (withOrderBy: boolean) => {
      unsub();
      unsub = onSnapshot(
        buildQuery(branchId, withOrderBy),
        (snap) => {
          const receivings = snap.docs.map((d) => ({ ...(d.data() as Receiving), id: d.id }));
          const sorted = withOrderBy ? receivings : sortReceivings(receivings);
          if (!cancelled) {
            setRecords((prev) => {
              const itemsMap = new Map(prev.map((r) => [r.receiving.id, r.items]));
              return toRecords(sorted, itemsMap);
            });
            setLoading(false);
            setError(null);
          }
        },
        (err) => {
          if (cancelled) return;
          const msg = err instanceof Error ? err.message : String(err);
          const missingIndex =
            msg.includes('index') ||
            msg.includes('FAILED_PRECONDITION') ||
            (err as { code?: string }).code === 'failed-precondition';
          if (useOrderBy && missingIndex) {
            useOrderBy = false;
            subscribe(false);
            return;
          }
          setError(err instanceof Error ? err : new Error(msg));
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

  const loadItems = useCallback(
    async (receivingId: string): Promise<ReceivingItem[]> => {
      if (itemsCache.has(receivingId)) return itemsCache.get(receivingId)!;

      if (!isFirebaseConfigured || !db) {
        const items = getDevReceivingItems(receivingId);
        setItemsCache((prev) => new Map(prev).set(receivingId, items));
        return items;
      }

      const snap = await getDocs(
        collection(db, collections.receivings, receivingId, collections.receivingItems),
      );
      const items = snap.docs.map((d) => ({ ...(d.data() as ReceivingItem), id: d.id }));
      setItemsCache((prev) => new Map(prev).set(receivingId, items));
      setRecords((prev) =>
        prev.map((r) => (r.receiving.id === receivingId ? { ...r, items } : r)),
      );
      return items;
    },
    [itemsCache],
  );

  const loadReceiving = useCallback(async (receivingId: string): Promise<Receiving | null> => {
    const cached = records.find((r) => r.receiving.id === receivingId)?.receiving;
    if (cached) return cached;

    if (!isFirebaseConfigured || !db) {
      return getDevReceivings().find((r) => r.id === receivingId) ?? null;
    }

    const snap = await getDoc(doc(db, collections.receivings, receivingId));
    if (!snap.exists()) return null;
    const receiving = { ...(snap.data() as Receiving), id: snap.id };
    setRecords((prev) => {
      if (prev.some((r) => r.receiving.id === receivingId)) {
        return prev.map((r) =>
          r.receiving.id === receivingId ? { ...r, receiving } : r,
        );
      }
      return [{ receiving, items: itemsCache.get(receivingId) ?? [] }, ...prev];
    });
    return receiving;
  }, [records, itemsCache]);

  return { records, loading, error, loadItems, loadReceiving, refresh };
}
