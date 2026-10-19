/**
 * Packet 7C-B1 (Option 2) — durable local close-intent for offline shift close.
 * Modeled on the sale-intent journal's store/result shape (`saleIntentJournalTypes.ts`),
 * but intentionally smaller: a single append-mostly record per `shiftId`, not an event log.
 *
 * Lifecycle (7C-B1 scope only):
 *   local_closed_pending -> synced                 (same-runtime observed ack only)
 *   local_closed_pending -> rejected_manual_attention (same-runtime observed rejection only)
 * Post-reload, a still-pending record simply stays `local_closed_pending` — it is never
 * auto-labeled `synced`/`rejected_manual_attention` after the creating runtime is gone.
 * Reliable post-reload ack/rejection reconciliation is Packet 7C-B2 (not implemented here).
 * Staleness (age-based "needs attention") is a pure, computed display concern
 * (see `isStaleClosePending`), not a stored transition.
 *
 * OBS-B1B — caller-owned business snapshot (17 fields) vs store-owned generated metadata
 * (`closedAtLocal`, `closeCorrelationId`). Logical entry field count is 23; historical
 * physical records may omit `closeCorrelationId` and are read-normalized to null only.
 */
export type ShiftCloseIntentStatus = 'local_closed_pending' | 'synced' | 'rejected_manual_attention';

/** Caller-owned business fields only — never includes store-generated metadata. */
export type ShiftCloseIntentBusinessSnapshot = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  startingCash: number;
  expectedCash: number;
  expectedQr: number;
  expectedKbank: number;
  expectedCard: number;
  expectedCredit: number;
  payInTotal: number;
  payOutTotal: number;
  totalBills: number;
  actualCashCount: number;
  variance: number;
  note: string;
  deviceId: string | null;
};

/**
 * Frozen close snapshot including store-owned generated metadata.
 * `closeCorrelationId` is `string | null` on the runtime/read view; historical physical
 * records may lack the key entirely (normalized to null on read only).
 */
export type ShiftCloseIntentSnapshot = ShiftCloseIntentBusinessSnapshot & {
  /** Device clock at close time — owned by the intent store on initial create. */
  closedAtLocal: number;
  /** Store-owned correlation id; null when secure UUID generation is unavailable. */
  closeCorrelationId: string | null;
};

export type ShiftCloseIntentEntry = ShiftCloseIntentSnapshot & {
  status: ShiftCloseIntentStatus;
  createdAtLocal: number;
  updatedAtLocal: number;
  lastErrorMessage: string | null;
};

export type CloseIntentErrorCode = 'unavailable' | 'quota' | 'conflict' | 'not_found' | 'tx_failed';

export type CloseIntentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CloseIntentErrorCode; message?: string };

/**
 * OBS-B2 — safe parallel caller-visible pointer-repair diagnostic.
 * Routing metadata only; never widens {@link CloseIntentResult}.
 */
export type PointerRepairOutcome =
  | { status: 'ok'; changed: boolean }
  | { status: 'skipped'; reason: 'device_id_unusable' }
  | {
      status: 'degraded';
      reason: 'pointer_read_failed' | 'pointer_write_failed' | 'pointer_invalid';
    };

/** Per-call Mechanism-B observer — void, never awaited, failure-isolated. */
export type PointerRepairObserver = (outcome: PointerRepairOutcome) => void;

/** Local notifier event after mandatory journal commit + pointer repair. */
export type ShiftCloseIntentObservabilityEvent = {
  entry: ShiftCloseIntentEntry;
  pointerRepair: PointerRepairOutcome;
};

/**
 * Recovery gate B2 — durable two-stage ONLINE close protocol. One attempt
 * record per shift, stored beside the close-intents (array key, like the
 * latest-by-device pointer):
 *
 *   prepared    written AND read back BEFORE the close transaction: identity
 *               plus an immutable correlation id only. It is NOT a close
 *               claim — no totals, never listed as a close intent, never a
 *               Z-report source, never blocks boot or a new open.
 *   finalized   after the W3 commit, ONE store transaction creates the
 *               `local_closed_pending` entry from the COMMITTED snapshot and
 *               deletes the attempt (never both, never neither).
 *   recovered   boot/reconnect sweep: the authoritative doc is closed with THIS
 *               correlation id → the entry is rebuilt from that doc and
 *               finalized exactly as above, then the existing reconciliation
 *               (journal `synced` + Variant C) runs once.
 *   superseded  the doc is closed by another correlation id — our attempt can
 *               no longer commit (W3 requires open → closed) → deleted, no Z.
 *   kept        doc open / missing / unreadable: stays `prepared` (the next
 *               close of the shift reuses its correlation id, so a late commit
 *               is recognised as this device's own). Never silently dropped.
 */
export type OnlineCloseAttemptRecord = {
  kind: 'onlineCloseAttempt';
  version: 1;
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  deviceId: string;
  /** Lowercase v4 UUID written as `closeCorrelationId` by the W3 close. */
  closeCorrelationId: string;
  preparedAtLocal: number;
};

export type OnlineCloseAttemptIdentity = Pick<
  OnlineCloseAttemptRecord,
  'shiftId' | 'branchId' | 'staffId' | 'staffName' | 'deviceId'
>;

/** `journaled` = this shift already has a close-intent entry (the close is already recorded). */
export type PrepareOnlineCloseResult =
  | { kind: 'prepared'; attempt: OnlineCloseAttemptRecord }
  | { kind: 'journaled'; entry: ShiftCloseIntentEntry };

/** Aligns with the existing `OLD_PENDING_AGE_MS` convention used by `selectDevicePendingSummary`. */
export const SHIFT_CLOSE_INTENT_STALE_AGE_MS = 10 * 60 * 1000;
