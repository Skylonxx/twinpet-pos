import { useEffect, useRef, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../../lib/firebase';
import { getDeviceId } from '../../lib/pos/deviceId';

/**
 * Pending-sync indicator for the POS top bar. Subscribes to THIS device's
 * `asyncOrders` that are still `pending_reconcile` for the active branch. The
 * query resolves from `persistentLocalCache` offline (incl. locally-queued
 * writes), so the cashier always sees how many sales are waiting to sync. When
 * they flush and the reconciler settles them, the count drops to 0 and a brief
 * "synced" checkmark shows before the indicator hides.
 *
 * One tiny, bounded listener (pending-only) — the sanctioned exception to the
 * POS's otherwise listener-free "Light Path".
 */
export default function SyncIndicator({ branchId }: { branchId: string | null }) {
  const [pending, setPending] = useState(0);
  const [justSynced, setJustSynced] = useState(false);
  const prevPending = useRef(0);

  useEffect(() => {
    if (!branchId || !isFirebaseConfigured || !db) {
      setPending(0);
      return;
    }
    const deviceId = getDeviceId();
    // Equality-only filters (no composite index needed); branchId keeps it within
    // the caller's read scope per firestore.rules.
    const q = query(
      collection(db, 'asyncOrders'),
      where('branchId', '==', branchId),
      where('deviceId', '==', deviceId),
      where('reconcileStatus', '==', 'pending_reconcile'),
    );
    const unsub = onSnapshot(
      q,
      (snap) => setPending(snap.size),
      (err) => console.warn('[SyncIndicator] listener error', err),
    );
    return unsub;
  }, [branchId]);

  // Show a transient checkmark when the queue drains to zero.
  useEffect(() => {
    if (prevPending.current > 0 && pending === 0) {
      setJustSynced(true);
      const t = window.setTimeout(() => setJustSynced(false), 3000);
      prevPending.current = pending;
      return () => window.clearTimeout(t);
    }
    prevPending.current = pending;
  }, [pending]);

  if (pending > 0) {
    return (
      <div
        className="pos-sync-indicator pos-sync-indicator--pending"
        title="บิลที่บันทึกในเครื่อง กำลังรอซิงก์ขึ้นเซิร์ฟเวอร์"
        role="status"
        aria-live="polite"
      >
        <i className="ti ti-cloud-up" aria-hidden="true" />
        <span>⏳ {pending} บิลรอซิงก์</span>
      </div>
    );
  }

  if (justSynced) {
    return (
      <div
        className="pos-sync-indicator pos-sync-indicator--synced"
        title="ซิงก์ข้อมูลการขายขึ้นเซิร์ฟเวอร์เรียบร้อย"
        role="status"
        aria-live="polite"
      >
        <i className="ti ti-cloud-check" aria-hidden="true" />
        <span>✓ ซิงก์แล้ว</span>
      </div>
    );
  }

  return null;
}
