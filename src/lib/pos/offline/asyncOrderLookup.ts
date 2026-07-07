import { doc, getDocFromServer } from 'firebase/firestore';
import { db, isFirebaseConfigured } from '../../firebase';

export type AsyncOrderLookupResult = { exists: boolean };

/**
 * Read-only, existence-only `asyncOrders` server lookup, injectable into the
 * Packet 3A-1 sweep runner's `lookupAsyncOrder` dependency. Returns null when
 * Firebase is not configured or `db` is unavailable (mirrors the observer's
 * no-op pattern — no permanent journal state in dev).
 *
 * `getDocFromServer` is mandatory here, not a style choice: `db` is initialized
 * with `persistentLocalCache`, so a cache-first `getDoc` could return this same
 * terminal's own pending, unflushed write and falsely report existence before
 * the server has ever seen it. `getDocFromServer` bypasses that cache entirely.
 *
 * Errors are intentionally NOT caught here — they propagate raw so the sweep
 * runner's existing `normalizeLookupError` is the single place that classifies
 * `permission-denied` / `unauthenticated` / `unavailable` / unknown outcomes.
 */
export function createAsyncOrderServerLookup(): ((asyncOrderId: string) => Promise<AsyncOrderLookupResult>) | null {
  if (!isFirebaseConfigured || !db) return null;
  const firestore = db;

  return async (asyncOrderId: string): Promise<AsyncOrderLookupResult> => {
    const snap = await getDocFromServer(doc(firestore, 'asyncOrders', asyncOrderId));
    return { exists: snap.exists() };
  };
}
