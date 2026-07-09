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
 */
export type ShiftCloseIntentStatus = 'local_closed_pending' | 'synced' | 'rejected_manual_attention';

/** The frozen terminal-authoritative close snapshot, keyed by `shiftId`. */
export type ShiftCloseIntentSnapshot = {
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
  /** Device clock at close time — the only time this record can honestly claim. */
  closedAtLocal: number;
  deviceId: string | null;
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

/** Aligns with the existing `OLD_PENDING_AGE_MS` convention used by `selectDevicePendingSummary`. */
export const SHIFT_CLOSE_INTENT_STALE_AGE_MS = 10 * 60 * 1000;
