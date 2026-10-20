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

/**
 * B2.2 — Variant C (W4 `syncState: 'synced'`) normalization progress of a
 * `synced` entry. `synced` means the CLOSE is server-confirmed; this field
 * says whether the separate W4 write is still owed:
 *   outstanding     the confirmed doc read `syncState: 'pending'` for THIS
 *                   device — W4 not yet proven written; retried by every sweep
 *   done            W4 written, or the doc already read `synced`
 *   not_applicable  no W4 owed by this device (doc not pending / other device)
 *   mismatch        on a retry the doc no longer matches this entry
 *                   (identity / correlation / totals): never written; terminal
 * Optional and additive: entries written before B2.2 lack it (`synced` +
 * absent = legacy, checked once by the sweep). Present-but-unknown fails
 * the entry's validation (fail closed, like a malformed correlation id).
 */
export type SyncStateNormalization = 'outstanding' | 'done' | 'not_applicable' | 'mismatch';

export type ShiftCloseIntentEntry = ShiftCloseIntentSnapshot & {
  status: ShiftCloseIntentStatus;
  createdAtLocal: number;
  updatedAtLocal: number;
  lastErrorMessage: string | null;
  syncStateNormalization?: SyncStateNormalization;
  /**
   * Gate B2.2-A / 006-C — legacy W4 check scheduling (a logical sequence
   * number, never a clock): written on a pre-B2.2 `synced` entry
   * (normalization absent) by the atomic legacy CLAIM transaction, BEFORE its
   * server read, so later sweeps pick the least-recently-checked entries first
   * (round robin). Never business data.
   * Gate 008-A — also the claim's fencing epoch, so it must be a positive SAFE
   * integer ({@link isValidLegacyClaimEpoch}). ABSENT = never checked (an
   * ordinary pre-006 entry, claimed normally). PRESENT but anything else (NaN,
   * ±Infinity, ≤ 0, fractional, > MAX_SAFE_INTEGER such as MAX_VALUE, a
   * string, null) = corrupt: the device's legacy claim is refused
   * (`epoch_invalid`) instead of guessing a successor. The entry itself stays
   * readable (it is not part of {@link ShiftCloseIntentEntry} validation).
   */
  syncStateNormalizationCheckSeq?: number;
  /**
   * Gate 006-C — local time of that claim. While it is within the claim lease
   * (and not in the future: clock skew never extends it) no other sweep —
   * another window or an overlapping trigger — claims the entry again.
   */
  syncStateNormalizationClaimedAtLocal?: number;
  /**
   * Gate 007-C — the sweep that holds the claim. With the claim's
   * `syncStateNormalizationCheckSeq` (strictly increasing per entry, so a
   * fencing epoch) it forms the {@link LegacyNormalizationClaimFence}: once a
   * newer claim replaced either, the older sweep can no longer renew the claim
   * nor record a result. Malformed / absent ⇒ no sweep holds it.
   * Gate 008-A: every claim REPLACES it with the claiming sweep's own
   * nonempty token (never inherited from the previous holder); a present
   * malformed value is simply overwritten by the next claim and can never
   * satisfy a fence.
   */
  syncStateNormalizationClaimOwner?: string;
};

/** Gate 007-C — proof that a sweep still holds a legacy W4 claim: its owner token and the claim epoch (check sequence). */
export type LegacyNormalizationClaimFence = { owner: string; epoch: number };

/** Gate 008-A — upper bound of a claim owner token (a sweep id, not data). */
export const LEGACY_CLAIM_OWNER_MAX_LENGTH = 256;

/** Gate 008-A — a fencing epoch: a positive safe integer (so `epoch + 1` is exact). */
export function isValidLegacyClaimEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

/** Gate 008-A — a claim owner: a nonblank string of bounded length. */
export function isValidLegacyClaimOwner(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= LEGACY_CLAIM_OWNER_MAX_LENGTH;
}

/**
 * Gate 008-A — why a legacy claim / renew / fenced record refused (nothing
 * was written, so no legacy server read or W4 may follow):
 *   owner_invalid    the caller's owner token is missing / blank / not a bounded string
 *   input_invalid    a non-finite / non-positive lease, a negative / non-integer limit
 *   fence_invalid    the caller's fence is not a valid owner + safe-integer epoch
 *   epoch_invalid    a legacy entry of this device carries a PRESENT corrupt check sequence
 *                    (claim) — or the claimed entry's stored epoch / owner is corrupt (renew / record)
 *   epoch_exhausted  the highest epoch is MAX_SAFE_INTEGER: no exact strictly larger successor exists
 */
export type LegacyClaimRefusal = 'owner_invalid' | 'input_invalid' | 'fence_invalid' | 'epoch_invalid' | 'epoch_exhausted';

export type CloseIntentErrorCode = 'unavailable' | 'quota' | 'conflict' | 'not_found' | 'tx_failed';

export type CloseIntentResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CloseIntentErrorCode; message?: string };

/** Gate 008-A — a legacy claim-path result: a store result, or a typed refusal (`conflict` + `reason`). */
export type LegacyClaimResult<T> =
  | CloseIntentResult<T>
  | { ok: false; code: 'conflict'; reason: LegacyClaimRefusal; message: string };

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
 *               deletes the attempt (never both, never neither). Gate 007-B:
 *               only a PRESENT, valid, non-tombstoned attempt whose shift /
 *               branch / staff / device / correlation id equal the proven
 *               snapshot's authorizes the entry; anything else is refused with
 *               a {@link FinalizeOnlineCloseRefusal} and nothing is written.
 *   recovered   boot/reconnect sweep: the authoritative doc is closed with THIS
 *               correlation id → the entry is rebuilt from that doc and
 *               finalized exactly as above, then the existing reconciliation
 *               (journal `synced` + Variant C) runs once.
 *   superseded  the doc is closed by another VALID (lowercase UUID v4)
 *               correlation id of the same branch/staff shift — our attempt
 *               can no longer commit (W3 requires open → closed) → RETAINED as
 *               a tombstone (`supersededAtLocal`), no Z, no further reads.
 *               Gate 006-B: an attempt is NEVER deleted except when its own
 *               entry is finalized (consumed in the same store transaction);
 *               a commit-observed attempt is never tombstoned (below).
 *   kept        doc open / missing / unreadable, or closed with an empty /
 *               malformed / absent correlation id (not proof of another close;
 *               gate B2.1-B): stays `prepared` (the next close of the shift
 *               reuses its correlation id, so a late commit is recognised as
 *               this device's own). Never silently dropped.
 *
 * Gate B2.1-A / 006-B: `commitObservedAtLocal` is written — and verified by a
 * read-back — when this runtime SAW its W3 transaction commit but could not
 * prove and journal it. Such an attempt is only ever finalized or kept for
 * manual attention. Because that write itself can fail, supersession is
 * non-destructive for EVERY attempt: an unrecorded observation can never lead
 * to the evidence being deleted after a restart.
 *
 * Both optional fields are additive. KEY PRESENCE decides (any value, even a
 * malformed or `undefined` one): a present `commitObservedAtLocal` ⇒ commit
 * observed (fail-safe: retained); a present `supersededAtLocal` without it ⇒
 * tombstone. A malformed value can therefore never make a known commit look
 * uncommitted.
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
  /** Optional, additive (see above). Present with ANY value ⇒ treated as commit observed. */
  commitObservedAtLocal?: number;
  /** Optional, additive (see above): retained-tombstone time of a superseded, never-committed attempt. */
  supersededAtLocal?: number;
};

export type OnlineCloseAttemptIdentity = Pick<
  OnlineCloseAttemptRecord,
  'shiftId' | 'branchId' | 'staffId' | 'staffName' | 'deviceId'
>;

/**
 * Gate 007-B — why `finalizeOnlineClose` refused (nothing was written or deleted):
 *   attempt_missing     no attempt and no entry — an absent attempt never authorizes a new entry
 *   attempt_unreadable  the stored attempt is malformed
 *   attempt_mismatch    the attempt's shift / branch / staff / device / correlation id differ
 *   attempt_superseded  the attempt is a retained supersession tombstone
 *   entry_unreadable    the stored close-intent is malformed
 *   entry_conflict      a DIFFERENT close-intent (totals / identity / correlation) exists
 *   snapshot_invalid    the snapshot would not form a valid close-intent
 */
export type FinalizeOnlineCloseRefusal =
  | 'attempt_missing'
  | 'attempt_unreadable'
  | 'attempt_mismatch'
  | 'attempt_superseded'
  | 'entry_unreadable'
  | 'entry_conflict'
  | 'snapshot_invalid';

/**
 * `consumedAttempt`: the owned attempt was deleted in this transaction
 * (`false` = idempotent re-finalize: the equal entry already existed and its
 * attempt was consumed earlier). A refusal is `conflict` + `reason`.
 */
export type FinalizeOnlineCloseResult =
  | { ok: true; value: ShiftCloseIntentEntry; consumedAttempt: boolean }
  | { ok: false; code: 'conflict'; reason: FinalizeOnlineCloseRefusal; message: string }
  | { ok: false; code: Exclude<CloseIntentErrorCode, 'conflict'>; message?: string };

/** `journaled` = this shift already has a close-intent entry (the close is already recorded). */
export type PrepareOnlineCloseResult =
  | { kind: 'prepared'; attempt: OnlineCloseAttemptRecord }
  | { kind: 'journaled'; entry: ShiftCloseIntentEntry };

/** Aligns with the existing `OLD_PENDING_AGE_MS` convention used by `selectDevicePendingSummary`. */
export const SHIFT_CLOSE_INTENT_STALE_AGE_MS = 10 * 60 * 1000;
