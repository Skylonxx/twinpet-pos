/**
 * Durable local rejection log — write/list API  [Phase 7B-H7-C]
 *
 * A FORENSIC, best-effort log of pre-queue fail-closed reversal-evidence rejections
 * (the `Transfer/ReceivingReversalEvidenceError` cases that F1/G1 made *visible* but
 * which are thrown BEFORE any offline intent is created, leaving no durable trail).
 *
 * This module is intentionally LATENT in H7-C: no production caller wires it yet. It
 * persists the H7-A `ReversalRejectionRecord` into the dedicated `rejections` IndexedDB
 * store (added in this slice) and reads it back, nothing more.
 *
 * HARD BOUNDARIES (forensic only, never a second gate):
 *   - Touches ONLY the `rejections` store. Never reads/writes `intents`/`stock`/
 *     `ledger`/`markers`, never mutates stock, never inspects queue state for any
 *     control decision.
 *   - `recordReversalRejection` is BEST-EFFORT and NEVER throws into the caller. A
 *     storage failure returns an outcome enum so a future catch-site can fire-and-forget
 *     the write AFTER the fail-closed F1/G1 message is already shown — a logging failure
 *     must never block or alter that UX, and the log is never a source of truth for stock.
 *   - No UI/page imports.
 */

import type { ReversalLocalStore } from './reversalLocalStore';
import type {
  ReversalRejectionRecord,
  ReversalRejectionSourceType,
} from '../../inventory/reversalRejectionRecord';

/**
 * Outcome of a best-effort rejection-log write:
 * - `recorded`    — the record was written.
 * - `duplicate`   — a row with the same content-addressed `recordId` already existed
 *                   (idempotent no-op). Note: under concurrent tabs a `get`-then-`put`
 *                   cannot guarantee exactly-once classification; an identical record is
 *                   simply re-`put` over itself, so no duplicate row results either way.
 * - `unavailable` — IndexedDB is unavailable (SSR/node) or the store could not be opened.
 * - `failed`      — any other storage failure (aborted transaction, quota, etc.).
 *
 * `unavailable` vs `failed` is a best-effort hint only — callers must treat every
 * non-`recorded`/`duplicate` value identically (the write did not durably succeed).
 */
export type RecordRejectionOutcome = 'recorded' | 'duplicate' | 'unavailable' | 'failed';

/** Lower-cased substrings that mark an "IndexedDB not available" failure (best-effort hint). */
function isUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('indexeddb') && msg.includes('unavailable');
}

/**
 * Best-effort, NON-THROWING write of a single rejection record into the `rejections`
 * store, keyed out-of-line by `record.recordId` (the H7-A deterministic content hash).
 * Identical normalized content → same `recordId` → idempotent overwrite (no duplicate
 * row); a genuinely distinct occurrence carries a different `createdAt` → different
 * `recordId` → a distinct row. Returns an outcome; never rejects.
 */
export async function recordReversalRejection(
  store: ReversalLocalStore,
  record: ReversalRejectionRecord,
): Promise<RecordRejectionOutcome> {
  try {
    return await store.transact(['rejections'], 'readwrite', async (txn) => {
      const existing = await txn.get<ReversalRejectionRecord>('rejections', record.recordId);
      if (existing !== undefined) return 'duplicate' as const;
      await txn.put('rejections', record.recordId, record);
      return 'recorded' as const;
    });
  } catch (err) {
    return isUnavailableError(err) ? 'unavailable' : 'failed';
  }
}

/**
 * List durable rejection records from THIS device's `rejections` store, newest-first by
 * `createdAt`. Optional in-memory filters by `sourceType` and/or `branchId`. Read-only;
 * forensic; does not consult queue state.
 */
export async function listReversalRejections(
  store: ReversalLocalStore,
  filter?: {
    sourceType?: ReversalRejectionSourceType;
    branchId?: string;
  },
): Promise<ReversalRejectionRecord[]> {
  return store.transact(['rejections'], 'readonly', async (txn) => {
    const all = await txn.getAll<ReversalRejectionRecord>('rejections');
    const filtered = all.filter(
      (r) =>
        (filter?.sourceType === undefined || r.sourceType === filter.sourceType) &&
        (filter?.branchId === undefined || r.branchId === filter.branchId),
    );
    // Newest-first by createdAt (inverse of the queue's oldest-first ordering): a
    // forensic log reads most-recent rejection first.
    return filtered.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  });
}
