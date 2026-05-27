import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, orderBy, query, where } from 'firebase/firestore';
import { collections, db, isFirebaseConfigured } from '../firebase';
import { devGetTransfers } from './transferDevMock';
import type { InventoryTransfer } from './transferTypes';

function sortByCreatedDesc(rows: InventoryTransfer[]): InventoryTransfer[] {
  return [...rows].sort((a, b) => {
    const ta = a.createdAt?.toDate?.()?.getTime() ?? 0;
    const tb = b.createdAt?.toDate?.()?.getTime() ?? 0;
    return tb - ta;
  });
}

function mergeUnique(rows: InventoryTransfer[]): InventoryTransfer[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

export function useInventoryTransfers(branchId: string | null) {
  const [transfers, setTransfers] = useState<InventoryTransfer[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!branchId) {
      setTransfers([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      if (!isFirebaseConfigured || !db) {
        setTransfers(devGetTransfers(branchId));
        return;
      }

      const fromQ = query(
        collection(db, collections.inventoryTransfers),
        where('fromBranchId', '==', branchId),
        orderBy('createdAt', 'desc'),
      );
      const toQ = query(
        collection(db, collections.inventoryTransfers),
        where('toBranchId', '==', branchId),
        orderBy('createdAt', 'desc'),
      );

      try {
        const [fromSnap, toSnap] = await Promise.all([getDocs(fromQ), getDocs(toQ)]);
        const merged = mergeUnique([
          ...fromSnap.docs.map((d) => ({ ...(d.data() as InventoryTransfer), id: d.id })),
          ...toSnap.docs.map((d) => ({ ...(d.data() as InventoryTransfer), id: d.id })),
        ]);
        setTransfers(sortByCreatedDesc(merged));
      } catch (err) {
        console.error('Error loading inventory transfers:', err);

        const fallbackSnap = await getDocs(collection(db, collections.inventoryTransfers));
        const filtered = fallbackSnap.docs
          .map((d) => ({ ...(d.data() as InventoryTransfer), id: d.id }))
          .filter((t) => t.fromBranchId === branchId || t.toBranchId === branchId);
        setTransfers(sortByCreatedDesc(filtered));
      }
    } catch (err) {
      console.error('Error loading inventory transfers:', err);
      setTransfers([]);
    } finally {
      setLoading(false);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  return { transfers, loading, reload: load };
}
