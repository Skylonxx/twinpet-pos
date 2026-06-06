import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../firebase';
import { mapExceptionRow, type ReconExceptionRow } from './exceptionRows';

export type ExceptionsState = {
  rows: ReconExceptionRow[];
  loading: boolean;
  error: string | null;
};

/**
 * Live, read-only subscription to async orders stuck in `reconcileStatus ==
 * 'exception'`. EQUALITY-ONLY query (single `where`, no `orderBy`) → needs NO
 * composite index. Admin-readable per firestore.rules. Display ordering (newest
 * failure first) is done in-memory to keep the query index-free.
 *
 * The page NEVER writes asyncOrders — repair goes only through the secured
 * `retryReconcile` callable.
 */
export function useReconciliationExceptions(): ExceptionsState {
  const [state, setState] = useState<ExceptionsState>({ rows: [], loading: true, error: null });

  useEffect(() => {
    if (!isFirebaseConfigured || !db) {
      setState({ rows: [], loading: false, error: null });
      return;
    }
    const q = query(collection(db, 'asyncOrders'), where('reconcileStatus', '==', 'exception'));
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
  }, []);

  return state;
}
