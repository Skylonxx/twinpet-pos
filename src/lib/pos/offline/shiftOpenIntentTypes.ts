/**
 * PK-1 — durable local open-intent for offline shift open.
 * Narrower than the close-intent journal: open only freezes identity + starting cash.
 *
 * Lifecycle:
 *   local_open_pending -> synced                 (confirmation-grade server proof only)
 *   local_open_pending -> rejected_manual_attention (definitive write/identity rejection)
 *
 * Remote create must remain exact W0 rules shape — offline metadata lives here / on the
 * client-built Shift snapshot only, never on the queued setDoc payload.
 */

export type ShiftOpenIntentStatus = 'local_open_pending' | 'synced' | 'rejected_manual_attention';

/** Caller-owned business fields only — never includes store-generated metadata. */
export type ShiftOpenIntentBusinessSnapshot = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  startingCash: number;
  /** Local device ownership; not written on W0 create (rules allowlist). */
  deviceId: string | null;
};

export type ShiftOpenIntentSnapshot = ShiftOpenIntentBusinessSnapshot & {
  /** Device clock at open time — owned by the intent store on initial create. */
  openedAtLocal: number;
};

export type ShiftOpenIntentEntry = ShiftOpenIntentSnapshot & {
  status: ShiftOpenIntentStatus;
  createdAtLocal: number;
  updatedAtLocal: number;
  lastErrorMessage: string | null;
};

export type OpenIntentErrorCode = 'unavailable' | 'quota' | 'conflict' | 'not_found' | 'tx_failed';

export type OpenIntentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: OpenIntentErrorCode; message?: string };

/** Aligns with the existing close-intent stale convention. */
export const SHIFT_OPEN_INTENT_STALE_AGE_MS = 10 * 60 * 1000;
