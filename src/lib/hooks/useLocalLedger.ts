import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from '../pos/deviceId';
import { selectLocalLedger, type LocalSale } from '../pos/localLedger';
import type { AsyncOrder } from '../types';

export type LocalLedgerState = {
  /** The normalized, ordered ledger — what the drawer folds (unaffected by `loaded`). */
  sales: LocalSale[];
  /**
   * Packet 022 — true only once THIS branch's listener has delivered a snapshot
   * and has not errored since. False before the first answer, after a listener
   * error, after a branch change until the new branch answers, and in dev (no
   * Firebase): an unloaded `sales` is "unknown", never "no sales".
   */
  loaded: boolean;
};

/**
 * Subscribe to THIS terminal's local ledger of sales (Standalone POS —
 * Local-First). Mirrors {@link SyncIndicator}'s sanctioned bounded listener:
 * equality-only filters (no composite index) scoped to `branchId` + `deviceId`,
 * which `persistentLocalCache` answers instantly and offline — including a sale
 * the cashier just rang up but that has not yet flushed to the server.
 *
 * Returns the normalized, ordered {@link LocalSale}[] (voids / void-intents /
 * exceptions already excluded by {@link selectLocalLedger}) plus whether that
 * list is the listener's answer. This is the single source the terminal folds
 * for its own drawer/shift totals and "today" revenue.
 *
 * Dev (no Firebase): there is no async-order cache to read, so this returns an
 * empty, never-loaded ledger and the legacy dev-mock shift store drives the
 * drawer instead.
 */
export function useLocalLedger(branchId: string | null): LocalLedgerState {
  const [sales, setSales] = useState<LocalSale[]>([]);
  const [loadedBranchId, setLoadedBranchId] = useState<string | null>(null);

  useEffect(() => {
    if (!branchId || !isFirebaseConfigured || !db) {
      setSales([]);
      return;
    }
    const deviceId = getDeviceId();
    const q = query(
      collection(db, 'asyncOrders'),
      where('branchId', '==', branchId),
      where('deviceId', '==', deviceId),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const orders = snap.docs.map((d) => ({ ...(d.data() as AsyncOrder), id: d.id }));
        setSales(selectLocalLedger(orders));
        setLoadedBranchId(branchId);
      },
      (err) => {
        console.warn('[useLocalLedger] listener error', err);
        // A failed listener no longer tracks new sales.
        setLoadedBranchId((cur) => (cur === branchId ? null : cur));
      },
    );
    return () => {
      unsub();
      setLoadedBranchId(null);
    };
  }, [branchId]);

  return { sales, loaded: branchId !== null && loadedBranchId === branchId };
}
