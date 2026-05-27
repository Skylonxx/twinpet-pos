import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { devGetAdjustments } from './devMock';
import type { InventoryAdjustment } from './types';

function sortByCreatedDesc(rows: InventoryAdjustment[]): InventoryAdjustment[] {
  return [...rows].sort((a, b) => {
    const ta = a.createdAt?.toDate?.()?.getTime() ?? 0;
    const tb = b.createdAt?.toDate?.()?.getTime() ?? 0;
    return tb - ta;
  });
}

export function useInventoryAdjustments(branchId: string | null) {
  const [adjustments, setAdjustments] = useState<InventoryAdjustment[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!branchId) {
      setAdjustments([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (!isFirebaseConfigured || !db) {
        setAdjustments(devGetAdjustments(branchId));
        return;
      }

      const q = query(
        collection(db, collections.inventoryAdjustments),
        where('branchId', '==', branchId),
        orderBy('createdAt', 'desc'),
      );
      const snap = await getDocs(q);
      setAdjustments(
        snap.docs.map((d) => ({ ...(d.data() as InventoryAdjustment), id: d.id })),
      );
    } catch (err) {
      console.error('Error loading inventory adjustments:', err);

      try {
        const fallbackQ = query(
          collection(db!, collections.inventoryAdjustments),
          where('branchId', '==', branchId),
        );
        const snap = await getDocs(fallbackQ);
        setAdjustments(
          sortByCreatedDesc(
            snap.docs.map((d) => ({ ...(d.data() as InventoryAdjustment), id: d.id })),
          ),
        );
      } catch (fallbackErr) {
        console.error('Error loading inventory adjustments:', fallbackErr);
        setAdjustments([]);
      }
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { adjustments, loading, reload: load };
}
