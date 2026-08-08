/**
 * PK-1 — open-intent reconciliation against a confirmation-grade remote read.
 * No Firestore import — reader / optional reissue are injected for unit tests.
 */
import type { ShiftOpenIntentJournal } from './shiftOpenIntentStore';
import { normalizeRemoteCreateState } from './shiftOpenIntentStore';
import type { ShiftOpenIntentEntry } from './shiftOpenIntentTypes';

export type ShiftOpenConfirmationDoc = {
  exists: boolean;
  status?: string;
  /** Must be a resolved server Timestamp (has `.toDate()`), never a local estimate. */
  openedAt?: unknown;
  branchId?: string;
  staffId?: string;
  staffName?: string;
  startingCash?: number;
};

export type ShiftOpenConfirmationRead =
  | { ok: true; doc: ShiftOpenConfirmationDoc }
  | { ok: false };

export type ShiftOpenConfirmationReader = (shiftId: string) => Promise<ShiftOpenConfirmationRead>;

/**
 * Re-queue W0 create only when the safe-reissue predicate permits it.
 * Implementations must still CAS-claim before issuing setDoc.
 * Returns whether a new create write was actually enqueued.
 */
export type ShiftOpenWriteReissuer = (
  entry: ShiftOpenIntentEntry,
) => Promise<'issued' | 'skipped'>;

export type ReconcileOpenOutcome =
  | 'confirmed'
  | 'still_pending'
  | 'identity_mismatch'
  | 'unreachable';

export type ReconcileShiftOpenIntentDeps = {
  journal: ShiftOpenIntentJournal;
  readConfirmation: ShiftOpenConfirmationReader;
  deviceId: string;
  /** Optional — used by boot/reconnect when a create was never claimed/issued. */
  reissueOpenWrite?: ShiftOpenWriteReissuer;
};

export type ReconcileShiftOpenIntentResult = {
  shiftId: string;
  outcome: ReconcileOpenOutcome;
  openedAtServer?: Date;
  reissued?: boolean;
};

/** In-process single-flight — complements durable CAS for concurrent sweeps. */
const reconcileInflight = new Map<string, Promise<ReconcileShiftOpenIntentResult>>();

function isResolvedServerTimestamp(value: unknown): value is { toDate: () => Date } {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  );
}

function identityMatches(entry: ShiftOpenIntentEntry, doc: ShiftOpenConfirmationDoc): boolean {
  return (
    doc.branchId === entry.branchId &&
    doc.staffId === entry.staffId &&
    doc.staffName === entry.staffName &&
    doc.startingCash === entry.startingCash
  );
}

/**
 * Exact safe-reissue predicate (M1):
 * - intent still `local_open_pending`
 * - confirmation-grade read proves server doc absent
 * - durable `remoteCreateState === 'none'` (no outstanding create claim)
 *
 * Server absence alone is NOT sufficient — Firestore may still own a queued mutation.
 */
export function canSafelyReissueShiftOpenCreate(entry: ShiftOpenIntentEntry): boolean {
  return (
    entry.status === 'local_open_pending' &&
    normalizeRemoteCreateState(entry.remoteCreateState) === 'none'
  );
}

/**
 * Reconcile ONE `local_open_pending` journal entry. Idempotent and safe to call repeatedly.
 */
export async function reconcileShiftOpenIntent(
  entry: ShiftOpenIntentEntry,
  deps: ReconcileShiftOpenIntentDeps,
): Promise<ReconcileShiftOpenIntentResult> {
  const existing = reconcileInflight.get(entry.shiftId);
  if (existing) return existing;

  const run = reconcileShiftOpenIntentUnsynchronized(entry, deps).finally(() => {
    if (reconcileInflight.get(entry.shiftId) === run) {
      reconcileInflight.delete(entry.shiftId);
    }
  });
  reconcileInflight.set(entry.shiftId, run);
  return run;
}

async function reconcileShiftOpenIntentUnsynchronized(
  entry: ShiftOpenIntentEntry,
  deps: ReconcileShiftOpenIntentDeps,
): Promise<ReconcileShiftOpenIntentResult> {
  if (entry.status !== 'local_open_pending') {
    return {
      shiftId: entry.shiftId,
      outcome: entry.status === 'synced' ? 'confirmed' : 'still_pending',
    };
  }

  if (entry.deviceId !== deps.deviceId) {
    return { shiftId: entry.shiftId, outcome: 'still_pending' };
  }

  let read: ShiftOpenConfirmationRead;
  try {
    read = await deps.readConfirmation(entry.shiftId);
  } catch {
    read = { ok: false };
  }

  if (!read.ok) {
    return { shiftId: entry.shiftId, outcome: 'unreachable' };
  }

  const { doc } = read;
  if (!doc.exists) {
    let reissued = false;
    // Refresh durable create state before deciding — entry snapshot may be stale.
    const latest = await deps.journal.getOpenIntent(entry.shiftId);
    const liveEntry =
      latest.ok && latest.value ? latest.value : { ...entry, remoteCreateState: entry.remoteCreateState };

    if (deps.reissueOpenWrite && canSafelyReissueShiftOpenCreate(liveEntry)) {
      try {
        const issueResult = await deps.reissueOpenWrite(liveEntry);
        // Only an explicit `issued` counts — `skipped`/void must not claim a write storm.
        reissued = issueResult === 'issued';
      } catch {
        // Best-effort reissue — stay pending for the next sweep.
      }
    }
    return { shiftId: entry.shiftId, outcome: 'still_pending', reissued };
  }

  if (doc.status !== 'open' || !isResolvedServerTimestamp(doc.openedAt)) {
    return { shiftId: entry.shiftId, outcome: 'still_pending' };
  }

  if (!identityMatches(entry, doc)) {
    const rejectResult = await deps.journal.markRejectedManualAttention(
      entry.shiftId,
      'Confirmed remote shift identity does not match the frozen local open snapshot.',
    );
    if (!rejectResult.ok) {
      return { shiftId: entry.shiftId, outcome: 'unreachable' };
    }
    return { shiftId: entry.shiftId, outcome: 'identity_mismatch' };
  }

  const syncedResult = await deps.journal.markSynced(entry.shiftId);
  if (!syncedResult.ok) {
    return { shiftId: entry.shiftId, outcome: 'unreachable' };
  }

  return {
    shiftId: entry.shiftId,
    outcome: 'confirmed',
    openedAtServer: doc.openedAt.toDate(),
  };
}

/**
 * Sweep every THIS-device `local_open_pending` intent.
 * Used by app-boot and browser `online` — same function, same semantics.
 */
export async function runShiftOpenReconciliationSweep(
  deps: ReconcileShiftOpenIntentDeps,
): Promise<ReconcileShiftOpenIntentResult[]> {
  const listed = await deps.journal.listOpenIntents();
  if (!listed.ok) return [];

  const pending = listed.value.filter(
    (entry) => entry.status === 'local_open_pending' && entry.deviceId === deps.deviceId,
  );

  const results: ReconcileShiftOpenIntentResult[] = [];
  for (const entry of pending) {
    results.push(await reconcileShiftOpenIntent(entry, deps));
  }
  return results;
}
