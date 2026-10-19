/**
 * Packet 7C-B2 — close-intent reconciliation. Pure, injectable reconciliation
 * of THIS device's own `local_closed_pending` close-intents against a
 * confirmation-grade remote read. No Firestore import here — the reader and
 * (optional) normalizer are injected, so this module is unit-testable without
 * touching the network or IndexedDB.
 *
 * Fixes the 7C-B1 "perpetual pending" gap: `closedOffline`/`syncState` never
 * reconciled after a confirmed server `closedAt`. See the architecture report
 * (`...packet-7c-b2-close-intent-reconciliation-architecture-report.md`) and
 * the Codex architecture review for the guardrails this module encodes.
 */
// `ShiftCloseIntentJournal` is the public API type declared/exported by the
// store module; `ShiftCloseIntentEntry` is a data type that lives in the types
// module (the store only imports it internally, never re-exports it) — so each
// is imported from its true source to satisfy build-mode TypeScript (TS2459).
import type { ShiftCloseIntentJournal } from './shiftCloseIntentStore';
import type {
  OnlineCloseAttemptRecord,
  PointerRepairOutcome,
  ShiftCloseIntentBusinessSnapshot,
  ShiftCloseIntentEntry,
} from './shiftCloseIntentTypes';
import type { ShiftSyncState } from '../../types';

/** Read-only, confirmation-grade shape of the fields this packet reconciles against. */
export type ShiftCloseConfirmationDoc = {
  exists: boolean;
  status?: string;
  /** Must be a resolved server `Timestamp` (has `.toDate()`), never a local estimate. */
  closedAt?: unknown;
  closedOffline?: boolean;
  syncState?: ShiftSyncState;
  deviceId?: string | null;
  branchId?: string;
  staffId?: string;
  startingCash?: number;
  actualCashCount?: number;
  variance?: number;
  expectedCash?: number;
  expectedQr?: number;
  expectedKbank?: number;
  expectedCard?: number;
  expectedCredit?: number;
  payInTotal?: number;
  payOutTotal?: number;
  totalBills?: number;
  note?: string;
  /** Recovery gate B2: the W3 close's attempt identity (absent on legacy/foreign closes). */
  closeCorrelationId?: string | null;
};

/** `ok: false` means the read could not be trusted (offline/unreachable/error) — never a rejection signal. */
export type ShiftCloseConfirmationRead =
  | { ok: true; doc: ShiftCloseConfirmationDoc }
  | { ok: false };

/**
 * Injected confirmation-grade reader. MUST bypass any local cache/pending-write
 * overlay (e.g. `getDocFromServer`, or a listener requiring both
 * `hasPendingWrites === false` AND `fromCache === false`) — see the
 * SERVER-CONFIRMATION CONTRACT. Never resolves from a cached/estimated read.
 */
export type ShiftCloseConfirmationReader = (shiftId: string) => Promise<ShiftCloseConfirmationRead>;

/** Variant C — best-effort, single-field `syncState: 'synced'` normalization write. Never throws to the caller. */
export type ShiftCloseNormalizer = (shiftId: string) => Promise<void>;

export type ReconcileOutcome = 'confirmed' | 'still_pending' | 'identity_mismatch' | 'unreachable';

export type ReconcileShiftCloseIntentDeps = {
  journal: ShiftCloseIntentJournal;
  readConfirmation: ShiftCloseConfirmationReader;
  /** Omit to run Variant A (local-only, no doc write). */
  normalizeSyncState?: ShiftCloseNormalizer;
  /** This device's id — reconciliation is scoped to intents this device authored. */
  deviceId: string;
};

export type ReconcileShiftCloseIntentResult = {
  shiftId: string;
  outcome: ReconcileOutcome;
  /** Resolved server close time — present only when `outcome === 'confirmed'`. */
  closedAtServer?: Date;
  /** Whether the Variant C normalization write was attempted and succeeded. */
  normalized?: boolean;
  /**
   * OBS-B2 pointer-repair outcome from the status-transition path, when a
   * journal markSynced / markRejectedManualAttention ran. Observability only —
   * never settlement truth; absence means no status transition wrote.
   */
  pointerRepair?: PointerRepairOutcome;
};

function isResolvedServerTimestamp(value: unknown): value is { toDate: () => Date } {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as { toDate?: unknown }).toDate === 'function'
  );
}

/**
 * Full frozen-identity match (Codex guardrail): branch/staff/device plus every
 * drawer-relevant total. Never adjudicates a mismatch — only flags it.
 */
function identityMatches(entry: ShiftCloseIntentEntry, doc: ShiftCloseConfirmationDoc): boolean {
  return (
    doc.branchId === entry.branchId &&
    doc.staffId === entry.staffId &&
    doc.deviceId === entry.deviceId &&
    doc.startingCash === entry.startingCash &&
    doc.actualCashCount === entry.actualCashCount &&
    doc.variance === entry.variance &&
    doc.expectedCash === entry.expectedCash &&
    doc.expectedQr === entry.expectedQr &&
    doc.expectedKbank === entry.expectedKbank &&
    doc.expectedCard === entry.expectedCard &&
    doc.expectedCredit === entry.expectedCredit &&
    doc.payInTotal === entry.payInTotal &&
    doc.payOutTotal === entry.payOutTotal &&
    doc.totalBills === entry.totalBills &&
    doc.note === entry.note
  );
}

/**
 * Reconcile ONE `local_closed_pending` journal entry. Idempotent and safe to
 * call repeatedly: a non-pending entry (already `synced`/`rejected_manual_attention`)
 * is a no-op read with no network call and no further journal/doc write.
 */
export async function reconcileShiftCloseIntent(
  entry: ShiftCloseIntentEntry,
  deps: ReconcileShiftCloseIntentDeps,
): Promise<ReconcileShiftCloseIntentResult> {
  if (entry.status !== 'local_closed_pending') {
    return {
      shiftId: entry.shiftId,
      outcome: entry.status === 'synced' ? 'confirmed' : 'still_pending',
    };
  }

  // Device scoping — this device only ever reconciles intents it authored.
  if (entry.deviceId !== deps.deviceId) {
    return { shiftId: entry.shiftId, outcome: 'still_pending' };
  }

  let read: ShiftCloseConfirmationRead;
  try {
    read = await deps.readConfirmation(entry.shiftId);
  } catch {
    read = { ok: false };
  }

  if (!read.ok) {
    return { shiftId: entry.shiftId, outcome: 'unreachable' };
  }

  const { doc } = read;
  if (!doc.exists || doc.status !== 'closed' || !isResolvedServerTimestamp(doc.closedAt)) {
    // Not yet closed on the server / closedAt still an unresolved estimate —
    // never fabricate confirmation or rejection from this shape.
    return { shiftId: entry.shiftId, outcome: 'still_pending' };
  }

  if (!identityMatches(entry, doc)) {
    // The store API returns a structured `{ ok }` result (it fails-soft on
    // IndexedDB unavailable/quota/tx failure rather than throwing). If the
    // local manual-attention write did NOT persist, we must not report the
    // transition as completed — the server proof of mismatch is real, but the
    // local journal is still pending, so classify as retryable `unreachable`
    // (the next sweep re-detects the mismatch and re-attempts the write).
    let pointerRepair: PointerRepairOutcome | undefined;
    const rejectResult = await deps.journal.markRejectedManualAttention(
      entry.shiftId,
      'Confirmed remote shift identity does not match the frozen local close snapshot.',
      (outcome) => {
        pointerRepair = outcome;
      },
    );
    if (!rejectResult.ok) {
      return { shiftId: entry.shiftId, outcome: 'unreachable', pointerRepair };
    }
    return { shiftId: entry.shiftId, outcome: 'identity_mismatch', pointerRepair };
  }

  // Server proof is confirmation-grade, but the cashier-facing "confirmed"
  // state must be backed by a persisted local journal transition. If
  // `markSynced` did not persist, do not claim `confirmed` and do NOT proceed
  // to the Variant C doc normalization (which would write `syncState:'synced'`
  // to Firestore while the local journal is still `local_closed_pending` — the
  // exact local/remote inconsistency Codex Finding 5 warns against). Classify
  // as retryable `unreachable` instead.
  let pointerRepair: PointerRepairOutcome | undefined;
  const syncedResult = await deps.journal.markSynced(entry.shiftId, (outcome) => {
    pointerRepair = outcome;
  });
  if (!syncedResult.ok) {
    return { shiftId: entry.shiftId, outcome: 'unreachable', pointerRepair };
  }

  let normalized: boolean | undefined;
  if (deps.normalizeSyncState && doc.syncState === 'pending' && doc.deviceId === deps.deviceId) {
    try {
      await deps.normalizeSyncState(entry.shiftId);
      normalized = true;
    } catch {
      // Best-effort, no-guaranteed-retry (Codex guardrail): the journal already
      // carries the confirmed truth; a failed normalization write is not retried
      // by this packet and must not be overclaimed as eventually-consistent.
      normalized = false;
    }
  }

  return {
    shiftId: entry.shiftId,
    outcome: 'confirmed',
    closedAtServer: doc.closedAt.toDate(),
    normalized,
    pointerRepair,
  };
}

// ── Recovery gate B2: prepared ONLINE close attempts ──────────────────────

export type OnlineCloseRecoveryOutcome =
  /** The doc is closed with THIS attempt's correlation id; the journal entry now exists. */
  | 'recovered'
  /** The doc is closed by another correlation id: this attempt can never commit; deleted. */
  | 'superseded'
  /** Open / missing: not closed (yet). Kept — never a close claim, never a Z source. */
  | 'not_closed'
  /** Read or journal write failed. Kept; retried on the next trigger. */
  | 'unreachable'
  /** Closed with this id but the doc cannot be trusted as this close (identity/fields). Kept; no claim. */
  | 'manual_attention';

export type OnlineCloseRecoveryResult = {
  shiftId: string;
  outcome: OnlineCloseRecoveryOutcome;
  entry?: ShiftCloseIntentEntry;
};

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Strict rebuild of the COMMITTED business snapshot from the authoritative
 * closed doc (the W3 close writes every one of these fields). Any missing or
 * non-numeric field → `null`: never reconstruct a Z from guessed values.
 */
function snapshotFromCommittedDoc(
  attempt: OnlineCloseAttemptRecord,
  doc: ShiftCloseConfirmationDoc,
): ShiftCloseIntentBusinessSnapshot | null {
  const nums = [
    doc.startingCash,
    doc.expectedCash,
    doc.expectedQr,
    doc.expectedKbank,
    doc.expectedCard,
    doc.expectedCredit,
    doc.payInTotal,
    doc.payOutTotal,
    doc.totalBills,
    doc.actualCashCount,
    doc.variance,
  ];
  if (!nums.every(finiteNumber) || typeof doc.note !== 'string') return null;
  return {
    shiftId: attempt.shiftId,
    branchId: attempt.branchId,
    staffId: attempt.staffId,
    staffName: attempt.staffName,
    startingCash: doc.startingCash as number,
    expectedCash: doc.expectedCash as number,
    expectedQr: doc.expectedQr as number,
    expectedKbank: doc.expectedKbank as number,
    expectedCard: doc.expectedCard as number,
    expectedCredit: doc.expectedCredit as number,
    payInTotal: doc.payInTotal as number,
    payOutTotal: doc.payOutTotal as number,
    totalBills: doc.totalBills as number,
    actualCashCount: doc.actualCashCount as number,
    variance: doc.variance as number,
    note: doc.note,
    deviceId: attempt.deviceId,
  };
}

/**
 * Resolve ONE prepared online close attempt against a confirmation-grade read.
 * Never invents a close: only a doc closed with THIS correlation id (and this
 * branch/staff/device) is journaled, from the doc's own committed values.
 * Idempotent: the journal finalize is a no-op for an equal existing entry.
 * Never throws.
 */
export async function recoverOnlineCloseAttempt(
  attempt: OnlineCloseAttemptRecord,
  deps: Pick<ReconcileShiftCloseIntentDeps, 'journal' | 'readConfirmation' | 'deviceId'>,
): Promise<OnlineCloseRecoveryResult> {
  const shiftId = attempt.shiftId;
  if (attempt.deviceId !== deps.deviceId) return { shiftId, outcome: 'not_closed' };
  let read: ShiftCloseConfirmationRead;
  try {
    read = await deps.readConfirmation(shiftId);
  } catch {
    read = { ok: false };
  }
  if (!read.ok) return { shiftId, outcome: 'unreachable' };
  const { doc } = read;
  if (!doc.exists || doc.status !== 'closed') return { shiftId, outcome: 'not_closed' };
  if (doc.closeCorrelationId !== attempt.closeCorrelationId) {
    // Closed by another operation: W3 only closes an OPEN doc, so this attempt
    // can never commit now — definitive, safe to drop (no Z, no journal entry).
    try {
      await deps.journal.discardOnlineCloseAttempt(shiftId, attempt.closeCorrelationId);
    } catch {
      return { shiftId, outcome: 'unreachable' };
    }
    return { shiftId, outcome: 'superseded' };
  }
  if (!isResolvedServerTimestamp(doc.closedAt)) return { shiftId, outcome: 'unreachable' };
  if (doc.branchId !== attempt.branchId || doc.staffId !== attempt.staffId || doc.deviceId !== attempt.deviceId) {
    return { shiftId, outcome: 'manual_attention' };
  }
  const snapshot = snapshotFromCommittedDoc(attempt, doc);
  if (!snapshot) return { shiftId, outcome: 'manual_attention' };
  let finalized: Awaited<ReturnType<ReconcileShiftCloseIntentDeps['journal']['finalizeOnlineClose']>>;
  try {
    finalized = await deps.journal.finalizeOnlineClose(snapshot, attempt.closeCorrelationId);
  } catch {
    return { shiftId, outcome: 'unreachable' };
  }
  if (!finalized.ok) {
    return { shiftId, outcome: finalized.code === 'conflict' ? 'manual_attention' : 'unreachable' };
  }
  return { shiftId, outcome: 'recovered', entry: finalized.value };
}

/** Every THIS-device prepared attempt through {@link recoverOnlineCloseAttempt}. Never throws. */
export async function recoverOnlineCloseAttempts(
  deps: Pick<ReconcileShiftCloseIntentDeps, 'journal' | 'readConfirmation' | 'deviceId'>,
): Promise<OnlineCloseRecoveryResult[]> {
  let listed: Awaited<ReturnType<ReconcileShiftCloseIntentDeps['journal']['listOnlineCloseAttempts']>>;
  try {
    listed = await deps.journal.listOnlineCloseAttempts();
  } catch {
    return [];
  }
  if (!listed.ok) return [];
  const results: OnlineCloseRecoveryResult[] = [];
  for (const attempt of listed.value) {
    if (attempt.deviceId !== deps.deviceId) continue;
    results.push(await recoverOnlineCloseAttempt(attempt, deps));
  }
  return results;
}

/**
 * Sweep every THIS-device `local_closed_pending` intent through {@link reconcileShiftCloseIntent}.
 * Used by both the app-boot sweep and the reconnect (`online`) sweep in `POSPage.tsx`
 * (and the sync orchestrator) — same function, so behavior is identical regardless of trigger. Never throws;
 * a failed `listCloseIntents()` read just yields no work for this pass (retried
 * on the next trigger).
 */
export async function runShiftCloseReconciliationSweep(
  deps: ReconcileShiftCloseIntentDeps,
): Promise<ReconcileShiftCloseIntentResult[]> {
  // Recovery gate B2: first turn every prepared online close that DID commit
  // into its journal entry, so the loop below reconciles it (synced + Variant C)
  // exactly like any other pending close.
  await recoverOnlineCloseAttempts(deps);
  const listed = await deps.journal.listCloseIntents();
  if (!listed.ok) return [];

  const pending = listed.value.filter(
    (entry) => entry.status === 'local_closed_pending' && entry.deviceId === deps.deviceId,
  );

  const results: ReconcileShiftCloseIntentResult[] = [];
  for (const entry of pending) {
    results.push(await reconcileShiftCloseIntent(entry, deps));
  }
  return results;
}
