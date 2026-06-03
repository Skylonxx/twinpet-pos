import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { db, isFirebaseConfigured } from '../firebase';
import { getDeviceId } from '../pos/deviceId';
import { selectLocalLedger, type LocalSale } from '../pos/localLedger';
import type { AsyncOrder } from '../types';

/**
 * Subscribe to THIS terminal's local ledger of sales (Standalone POS —
 * Local-First). Mirrors {@link SyncIndicator}'s sanctioned bounded listener:
 * equality-only filters (no composite index) scoped to `branchId` + `deviceId`,
 * which `persistentLocalCache` answers instantly and offline — including a sale
 * the cashier just rang up but that has not yet flushed to the server.
 *
 * Returns the normalized, ordered {@link LocalSale}[] (voids / void-intents /
 * exceptions already excluded by {@link selectLocalLedger}). This is the single
 * source the terminal folds for its own drawer/shift totals and "today" revenue.
 *
 * Dev (no Firebase): there is no async-order cache to read, so this returns an
 * empty ledger and the legacy dev-mock shift store drives the drawer instead.
 */
export function useLocalLedger(branchId: string | null): LocalSale[] {
  const [sales, setSales] = useState<LocalSale[]>([]);

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
      },
      (err) => console.warn('[useLocalLedger] listener error', err),
    );
    return unsub;
  }, [branchId]);

  return sales;
}
