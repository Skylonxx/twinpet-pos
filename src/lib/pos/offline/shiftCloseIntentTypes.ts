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

/** Aligns with the existing `OLD_PENDING_AGE_MS` convention used by `selectDevicePendingSummary`. */
export const SHIFT_CLOSE_INTENT_STALE_AGE_MS = 10 * 60 * 1000;
