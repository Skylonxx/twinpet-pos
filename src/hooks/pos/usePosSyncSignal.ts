import { useEffect, useState } from 'react';
import { onSnapshot, type Timestamp } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../../lib/firebase';
import { syncStateDocRef } from '../../lib/pos/syncSignal';

export type PosSyncSignal = {
  /** Latest admin broadcast time (epoch ms), or null if the branch never rang. */
  lastForceUpdate: number | null;
  /**
   * True once the listener has delivered its FIRST snapshot. Consumers use this
   * to capture a baseline (so the signal already present at mount is never
   * mistaken for a fresh broadcast) before reacting to later changes.
   */
  initialized: boolean;
};

/**
 * Subscribes to the branch's sync-state doc and exposes the latest broadcast
 * timestamp. One document, one listener — the deliberate, lightweight exception
 * to the "no live listeners on the POS" rule. Returns epoch-ms primitives only;
 * the Firestore `Timestamp` never escapes this boundary.
 */
export function usePosSyncSignal(branchId: string | null): PosSyncSignal {
  const [lastForceUpdate, setLastForceUpdate] = useState<number | null>(null);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    // Reset baseline when the terminal's branch changes.
    setLastForceUpdate(null);
    setInitialized(false);

    if (!branchId || !isFirebaseConfigured || !db) return;

    const unsub = onSnapshot(
      syncStateDocRef(branchId),
      (snap) => {
        const ts = snap.exists()
          ? (snap.data()?.lastForceUpdate as Timestamp | null | undefined)
          : null;
        // Pending local writes report a null serverTimestamp; treat as "no value
        // yet" rather than crashing on a missing .toMillis().
        setLastForceUpdate(ts ? ts.toMillis() : null);
        setInitialized(true);
      },
      (err) => {
        console.warn('[usePosSyncSignal] sync_state listener error', err);
        setInitialized(true); // unblock consumers with a null (no-signal) baseline
      },
    );

    return unsub;
  }, [branchId]);

  return { lastForceUpdate, initialized };
}
