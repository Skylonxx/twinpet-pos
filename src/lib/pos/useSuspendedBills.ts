import { useCallback, useEffect, useState } from 'react';
import {
  getCommittedDurableStore,
  isLegacySuspendedBillsFrozen,
  isNativeCommittedDurableStore,
} from '../platform/durableStore/bootDurableStore';
import {
  loadSuspendedBills,
  saveSuspendedBills,
  type SuspendedBill,
} from './suspendedBills';

export type SuspendedBillsStatus = 'loading' | 'ready' | 'error';

async function loadNativeBills(branchId: string): Promise<SuspendedBill[]> {
  const port = getCommittedDurableStore('twinpet-suspended-bills');
  if (!port) return [];
  return port.transact(['bills'], 'readonly', async (txn) => {
    const keys = await txn.getAllKeys('bills');
    const bills: SuspendedBill[] = [];
    for (const key of keys) {
      if (!Array.isArray(key) || key[0] !== branchId) continue;
      const bill = await txn.get<SuspendedBill>('bills', key);
      if (bill) bills.push(bill);
    }
    return bills;
  });
}

async function saveNativeBill(branchId: string, bill: SuspendedBill): Promise<void> {
  const port = getCommittedDurableStore('twinpet-suspended-bills');
  if (!port) throw new Error('native suspended-bills store unavailable');
  await port.transact(['bills'], 'readwrite', async (txn) => {
    await txn.put('bills', [branchId, bill.id], bill);
  });
}

async function deleteNativeBill(branchId: string, id: string): Promise<void> {
  const port = getCommittedDurableStore('twinpet-suspended-bills');
  if (!port) throw new Error('native suspended-bills store unavailable');
  await port.transact(['bills'], 'readwrite', async (txn) => {
    await txn.delete('bills', [branchId, id]);
  });
}

export function useSuspendedBills(branchId: string | null) {
  const [bills, setBills] = useState<SuspendedBill[]>([]);
  const [status, setStatus] = useState<SuspendedBillsStatus>('loading');
  const native = isNativeCommittedDurableStore() && isLegacySuspendedBillsFrozen();

  const reload = useCallback(() => {
    if (!branchId) {
      setBills([]);
      setStatus('ready');
      return;
    }
    if (!native) {
      setBills(loadSuspendedBills(branchId));
      setStatus('ready');
      return;
    }
    setStatus('loading');
    void loadNativeBills(branchId)
      .then((next) => {
        setBills(next);
        setStatus('ready');
      })
      .catch(() => {
        setBills([]);
        setStatus('error');
      });
  }, [branchId, native]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!branchId || native) return;
    const key = `twinpet-suspended-bills:${branchId}`;
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [branchId, native, reload]);

  const addBill = useCallback(
    async (bill: SuspendedBill) => {
      if (!branchId) return;
      if (!native) {
        const next = [bill, ...loadSuspendedBills(branchId)];
        try {
          saveSuspendedBills(branchId, next);
        } catch (err) {
          setStatus('error');
          throw err;
        }
        setBills(next);
        setStatus('ready');
        return;
      }
      try {
        await saveNativeBill(branchId, bill);
        const next = await loadNativeBills(branchId);
        setBills(next);
        setStatus('ready');
      } catch (err) {
        setStatus('error');
        throw err;
      }
    },
    [branchId, native],
  );

  const removeBill = useCallback(
    async (id: string) => {
      if (!branchId) return;
      if (!native) {
        const next = loadSuspendedBills(branchId).filter((b) => b.id !== id);
        try {
          saveSuspendedBills(branchId, next);
        } catch (err) {
          setStatus('error');
          throw err;
        }
        setBills(next);
        setStatus('ready');
        return;
      }
      try {
        await deleteNativeBill(branchId, id);
        const next = await loadNativeBills(branchId);
        setBills(next);
        setStatus('ready');
      } catch (err) {
        setStatus('error');
        throw err;
      }
    },
    [branchId, native],
  );

  return {
    bills,
    count: bills.length,
    status,
    addBill,
    removeBill,
    reload,
  };
}
