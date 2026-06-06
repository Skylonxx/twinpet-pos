import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { shouldStartExceptionsQuery } from './adminGate';
import { mapExceptionRow, type ReconExceptionRow } from './exceptionRows';

export type ExceptionsState = {
  rows: ReconExceptionRow[];
  loading: boolean;
  error: string | null;
};

/**
 * Live, read-only subscription to async orders stuck in `reconcileStatus ==
 * 'exception'`. EQUALITY-ONLY query (single `where`, no `orderBy`) → needs NO
 * composite index. Display ordering (newest failure first) is done in-memory.
 *
 * SECURITY: `enabled` is the admin-derived gate. When `enabled` is false (a
 * non-admin), the effect short-circuits via `shouldStartExceptionsQuery` and
 * NO Firestore subscription/read is ever started. The page NEVER writes
 * asyncOrders — repair goes only through the secured `retryReconcile` callable.
 */
export function useReconciliationExceptions(enabled: boolean): ExceptionsState {
  const [state, setState] = useState<ExceptionsState>({ rows: [], loading: enabled, error: null });

  useEffect(() => {
    if (!shouldStartExceptionsQuery(enabled, isFirebaseConfigured, !!db)) {
      setState({ rows: [], loading: false, error: null });
      return;
    }
    const q = query(collection(db!, 'asyncOrders'), where('reconcileStatus', '==', 'exception'));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows = snap.docs
          .map((d) => mapExceptionRow(d.id, d.data() as Record<string, unknown>))
          .sort((a, b) => (b.lastErrorAtMs ?? 0) - (a.lastErrorAtMs ?? 0));
        setState({ rows, loading: false, error: null });
      },
      (err) => {
        setState({ rows: [], loading: false, error: err instanceof Error ? err.message : String(err) });
      },
    );
    return unsub;
  }, [enabled]);

  return state;
}
