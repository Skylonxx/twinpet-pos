import { useCallback, useEffect, useState } from 'react';
import {
  loadSuspendedBills,
  saveSuspendedBills,
  type SuspendedBill,
} from './suspendedBills';

export function useSuspendedBills(branchId: string | null) {
  const [bills, setBills] = useState<SuspendedBill[]>([]);

  const reload = useCallback(() => {
    if (!branchId) {
      setBills([]);
      return;
    }
    setBills(loadSuspendedBills(branchId));
  }, [branchId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!branchId) return;
    const key = `twinpet-suspended-bills:${branchId}`;
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [branchId, reload]);

  const addBill = useCallback(
    (bill: SuspendedBill) => {
      if (!branchId) return;
      setBills((prev) => {
        const next = [bill, ...prev];
        saveSuspendedBills(branchId, next);
        return next;
      });
    },
    [branchId],
  );

  const removeBill = useCallback(
    (id: string) => {
      if (!branchId) return;
      setBills((prev) => {
        const next = prev.filter((b) => b.id !== id);
        saveSuspendedBills(branchId, next);
        return next;
      });
    },
    [branchId],
  );

  return {
    bills,
    count: bills.length,
    addBill,
    removeBill,
    reload,
  };
}
