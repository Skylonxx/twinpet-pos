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
import {
  generateShiftCloseCorrelationId,
  isCommitObservedAttempt,
  isSupersededAttempt,
  isValidLowercaseUuidV4,
  snapshotsEqual,
  type ShiftCloseIntentJournal,
} from './shiftCloseIntentStore';
import type {
  CloseIntentResult,
  LegacyNormalizationClaimFence,
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
  /**
   * Gate B2.2-A: `syncState` is PRESENT but neither `'pending'` nor `'synced'`
   * (`syncState` is then `undefined`). Never read as "nothing owed".
   */
  syncStateMalformed?: boolean;
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
  /**
   * Gate B2.1-B: `closeCorrelationId` is PRESENT but not a string (e.g. `null`
   * or a number — W3 Rules deny both); `closeCorrelationId` is then `null`, so
   * this flag is what separates it from a legitimately ABSENT id.
   */
  closeCorrelationIdMalformed?: boolean;
};

/**
 * Raw shift-doc data → {@link ShiftCloseConfirmationDoc}. Pure type narrowing
 * only — no defaults, no coercion: a wrongly-typed field becomes `undefined`
 * (or `null` for ids), which every consumer treats as missing. Shared by the
 * confirmation reader and the in-transaction own-correlation retry.
 */
export function shiftCloseConfirmationDocFromData(data: Record<string, unknown>): ShiftCloseConfirmationDoc {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const syncState = data.syncState;
  const syncStateKnown = syncState === 'pending' || syncState === 'synced';
  return {
    exists: true,
    status: str(data.status),
    closedAt: data.closedAt,
    closedOffline: typeof data.closedOffline === 'boolean' ? data.closedOffline : undefined,
    syncState: syncStateKnown ? syncState : undefined,
    ...(syncState !== undefined && !syncStateKnown ? { syncStateMalformed: true } : {}),
    deviceId: typeof data.deviceId === 'string' ? data.deviceId : null,
    branchId: str(data.branchId),
    staffId: str(data.staffId),
    startingCash: num(data.startingCash),
    actualCashCount: num(data.actualCashCount),
    variance: num(data.variance),
    expectedCash: num(data.expectedCash),
    expectedQr: num(data.expectedQr),
    expectedKbank: num(data.expectedKbank),
    expectedCard: num(data.expectedCard),
    expectedCredit: num(data.expectedCredit),
    payInTotal: num(data.payInTotal),
    payOutTotal: num(data.payOutTotal),
    totalBills: num(data.totalBills),
    note: str(data.note),
    closeCorrelationId: typeof data.closeCorrelationId === 'string' ? data.closeCorrelationId : null,
    ...('closeCorrelationId' in data && typeof data.closeCorrelationId !== 'string'
      ? { closeCorrelationIdMalformed: true }
      : {}),
  };
}

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

/**
 * Gate 007-C — what the doc must still be AT THE W4 COMMIT: this close
 * (correlation id; `null` = a pre-correlation close without one) of this device.
 */
export type ShiftCloseNormalizeExpectation = { closeCorrelationId: string | null; deviceId: string };

/**
 * Gate 007-C — the remote W4 result, decided inside one server transaction:
 *   written              this call made the ONE effective `pending → synced` transition
 *   already_synced       the transaction read the doc already `synced` (another worker's W4) — nothing written
 *   precondition_failed  the doc is no longer this pending close of this device — nothing written
 * A commit rejected because the doc changed under it (e.g. another worker's
 * W4 landed first) THROWS — a failed W4, never one of the above.
 * `void` (an older normalizer) reads as `written`.
 */
export type ShiftCloseNormalizeOutcome = 'written' | 'already_synced' | 'precondition_failed';

/**
 * Gate 007-C — the W4 decision taken INSIDE the normalizer's server
 * transaction, on the doc as read by that transaction (`undefined` = missing):
 * `write` only for the `closed`, `pending` doc of `expected` (correlation id +
 * device; absent `expected` skips that check). Pure, so the Rules emulator
 * suite runs the very same decision in a real client transaction.
 */
export function shiftCloseNormalizationDecision(
  data: Record<string, unknown> | undefined,
  expected?: ShiftCloseNormalizeExpectation,
): 'write' | Exclude<ShiftCloseNormalizeOutcome, 'written'> {
  if (!data || data.status !== 'closed') return 'precondition_failed';
  if (expected) {
    const corr = 'closeCorrelationId' in data ? data.closeCorrelationId : null;
    if (data.deviceId !== expected.deviceId || corr !== expected.closeCorrelationId) return 'precondition_failed';
  }
  if (data.syncState === 'synced') return 'already_synced';
  return data.syncState === 'pending' ? 'write' : 'precondition_failed';
}

/** Variant C — single-field `syncState: 'synced'` normalization write. A throw = W4 failed (retried later). */
export type ShiftCloseNormalizer = (
  shiftId: string,
  expected?: ShiftCloseNormalizeExpectation,
) => Promise<void | ShiftCloseNormalizeOutcome>;

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
   * Gate 006-C: after a successful W4, whether the local `done` record was
   * DURABLY written (a structured `ok: false` / throw is `false`, never
   * reported as done; the next sweep re-checks the doc and records it).
   */
  normalizationRecorded?: boolean;
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
 * Full frozen-identity match (Codex guardrail): close correlation id,
 * branch/staff/device plus every drawer-relevant total. Never adjudicates a
 * mismatch — only flags it. B2: the correlation id must be EQUAL (a non-null
 * id on either side must match exactly; only a pre-correlation entry, null,
 * matches a doc without one), so identical totals of a DIFFERENT close can
 * never certify this entry.
 */
function identityMatches(entry: ShiftCloseIntentEntry, doc: ShiftCloseConfirmationDoc): boolean {
  return (
    (doc.closeCorrelationId ?? null) === (entry.closeCorrelationId ?? null) &&
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
 * Gate 006-A — does a closed, resolved doc confirm THIS journal entry? An
 * entry carrying a correlation id (every close this client journals) is
 * confirmed ONLY through the shared strict parser {@link parseCommittedOwnClose}
 * (closed, same valid correlation, branch / staff / device, resolved
 * `closedAt`, finite totals, note, consistent variance) AND equality of every
 * business field with the entry — so the cashier-facing "confirmed" badge and
 * every W4 decision rest on the same proof as a Z. A pre-correlation (null)
 * entry keeps the historical full-identity match ({@link identityMatches}).
 *   `unresolved`  `closedAt` cannot be resolved to a valid time: retry later
 */
function confirmsEntry(entry: ShiftCloseIntentEntry, doc: ShiftCloseConfirmationDoc): 'match' | 'mismatch' | 'unresolved' {
  if (entry.closeCorrelationId === null || entry.deviceId === null) {
    return identityMatches(entry, doc) ? 'match' : 'mismatch';
  }
  const parsed = parseCommittedOwnClose(
    {
      shiftId: entry.shiftId,
      branchId: entry.branchId,
      staffId: entry.staffId,
      staffName: entry.staffName,
      deviceId: entry.deviceId,
      closeCorrelationId: entry.closeCorrelationId,
    },
    doc,
  );
  if (!parsed.ok) return parsed.reason === 'closed_at_unresolved' ? 'unresolved' : 'mismatch';
  return snapshotsEqual(parsed.snapshot, entry) ? 'match' : 'mismatch';
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

  const confirmation = confirmsEntry(entry, doc);
  if (confirmation === 'unresolved') return { shiftId: entry.shiftId, outcome: 'still_pending' };
  if (confirmation === 'mismatch') {
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
  //
  // B2.2: the same journal write records whether the Variant C (W4) write is
  // still OWED (`outstanding`). The close stays confirmed; W4 is marked `done`
  // only after its authoritative write succeeded, so a W4 failure or a crash
  // anywhere before that leaves durable state the next sweep retries
  // ({@link retryOutstandingNormalizations}).
  //
  // B2.2-A: a PRESENT but malformed `syncState` is not proof that nothing is
  // owed — it is recorded `outstanding` (retained; the retry reports it as
  // `manual_attention` and never writes W4 over it), not `not_applicable`.
  const owesW4 = doc.syncState === 'pending' && doc.deviceId === deps.deviceId;
  let pointerRepair: PointerRepairOutcome | undefined;
  const syncedResult = await deps.journal.markSynced(
    entry.shiftId,
    (outcome) => {
      pointerRepair = outcome;
    },
    owesW4 || doc.syncStateMalformed ? 'outstanding' : doc.syncState === 'synced' ? 'done' : 'not_applicable',
  );
  if (!syncedResult.ok) {
    return { shiftId: entry.shiftId, outcome: 'unreachable', pointerRepair };
  }

  let normalized: boolean | undefined;
  let normalizationRecorded: boolean | undefined;
  if (owesW4 && deps.normalizeSyncState) {
    const w4 = await writeNormalization(entry, { ...deps, normalizeSyncState: deps.normalizeSyncState });
    normalized = w4.remote === 'written' || w4.remote === 'already_synced';
    normalizationRecorded = normalized && w4.recorded;
  }

  return {
    shiftId: entry.shiftId,
    outcome: 'confirmed',
    closedAtServer: doc.closedAt.toDate(),
    normalized,
    ...(normalizationRecorded !== undefined ? { normalizationRecorded } : {}),
    pointerRepair,
  };
}

/** Gate 007-C — one remote W4 API attempt, as observed by its caller. */
export type RemoteW4Result = ShiftCloseNormalizeOutcome | 'failed';

/** ONE remote W4 API attempt, conditioned on this close of this device. Never throws. */
async function callNormalizer(
  entry: Pick<ShiftCloseIntentEntry, 'shiftId' | 'closeCorrelationId'>,
  normalize: ShiftCloseNormalizer,
  deviceId: string,
): Promise<RemoteW4Result> {
  try {
    const outcome = await normalize(entry.shiftId, { closeCorrelationId: entry.closeCorrelationId, deviceId });
    return outcome ?? 'written';
  } catch {
    return 'failed';
  }
}

/**
 * ONE W4 attempt for a confirmed close of this device; once the server state
 * is `synced` (`written` by this call, or `already_synced` at its commit)
 * records `done`. A failed / refused W4 leaves `outstanding` (retried later).
 * Gate 006-C: the `done` write's structured result is checked — `recorded`
 * false when W4 landed but `done` did not persist (harmless: the next retry
 * reads the doc as `synced` and records `done` without writing W4 again).
 * Never throws.
 */
async function writeNormalization(
  entry: Pick<ShiftCloseIntentEntry, 'shiftId' | 'closeCorrelationId'>,
  deps: Pick<ReconcileShiftCloseIntentDeps, 'journal' | 'deviceId'> & { normalizeSyncState: ShiftCloseNormalizer },
): Promise<{ remote: RemoteW4Result; recorded: boolean }> {
  const remote = await callNormalizer(entry, deps.normalizeSyncState, deps.deviceId);
  if (remote !== 'written' && remote !== 'already_synced') return { remote, recorded: false };
  return { remote, recorded: await persistNormalization(deps.journal, entry, 'done') };
}

/** `true` ONLY when the store confirmed the write (a fail-soft `ok: false` or a throw is `false`). */
async function persistNormalization(
  journal: ShiftCloseIntentJournal,
  entry: Pick<ShiftCloseIntentEntry, 'shiftId' | 'closeCorrelationId'>,
  state: 'done' | 'mismatch' | 'not_applicable',
): Promise<boolean> {
  try {
    const r = await journal.setSyncStateNormalization(entry.shiftId, entry.closeCorrelationId, state);
    return r.ok;
  } catch {
    return false;
  }
}

/** Bound on pre-B2.2 (`synced`, no normalization field) entries checked per sweep. */
export const LEGACY_NORMALIZATION_CHECKS_PER_SWEEP = 10;

export type NormalizationRetryOutcome =
  /** W4 written now. */
  | 'normalized'
  /** The doc already reads `synced` (an earlier W4 landed): recorded `done`, nothing written. */
  | 'already_normalized'
  /** The doc no longer matches this entry (correlation / identity / totals): recorded `mismatch`, nothing written. */
  | 'mismatch'
  /** Nothing owed by this device (legacy entry whose doc is not pending for it). */
  | 'not_applicable'
  /**
   * B2.2-A: the matching doc's `syncState` is present but malformed — never
   * classified terminal, never written; the entry keeps its state (retained).
   */
  | 'manual_attention'
  /**
   * Gate 006-C: the server state was observed (and for a pending doc, W4 may
   * have landed) but the local terminal record (`done` / `mismatch` /
   * `not_applicable`) did NOT persist — nothing is claimed; re-evaluated later.
   */
  | 'local_write_failed'
  /**
   * Gate 006-C: legacy entry NOT checked — this sweep's legacy claim could not
   * be durably recorded, so no fairness progress can be promised; nothing read.
   * Gate 007-C: also when the claim could not be RE-verified before W4 (store
   * failure) — then nothing is written.
   */
  | 'claim_failed'
  /**
   * Gate 007-C: this sweep's legacy claim was replaced by a newer claim (its
   * lease expired while this sweep waited) — this sweep records nothing and,
   * if it had not yet attempted W4, attempts none; the newer owner settles it.
   */
  | 'claim_lost'
  /** Read failed, doc not a resolved close, W4 failed / refused, or no normalizer: kept `outstanding`, retried later. */
  | 'retry_later';

export type NormalizationRetryResult = {
  shiftId: string;
  outcome: NormalizationRetryOutcome;
  /**
   * Gate 007-C: present iff this sweep made a remote W4 API attempt for the
   * entry; `written` is the only result that made the effective transition.
   */
  remoteW4?: RemoteW4Result;
};

/** Gate 006-C: a claimed legacy entry is not re-claimed by another sweep / window within this lease. */
export const LEGACY_NORMALIZATION_CLAIM_LEASE_MS = 60_000;

function legacyCheckSeq(e: ShiftCloseIntentEntry): number {
  const v = e.syncStateNormalizationCheckSeq;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * B2.2 — retry every THIS-device `synced` entry whose W4 is still owed
 * (`outstanding`), plus up to {@link LEGACY_NORMALIZATION_CHECKS_PER_SWEEP}
 * pre-B2.2 `synced` entries (field absent). One read and at most one W4 per
 * entry per sweep — no busy loop; the boot / `online` / sync orchestrator
 * triggers provide the retries. Only a confirmation-grade read of THIS close
 * (shared strict parser for correlation-bearing entries, still `pending`, this
 * device) is normalized; anything else is never written. Never throws.
 *
 * Gate 006-C — durable, honest legacy fairness. The legacy batch is CLAIMED
 * in ONE local readwrite transaction (`claimLegacyNormalizationChecks`):
 * least-recently-checked first by a persisted logical sequence (never a wall
 * clock), each claimed entry stamped `max(seq) + 1` and leased for
 * {@link LEGACY_NORMALIZATION_CLAIM_LEASE_MS} BEFORE its server read. Only
 * entries in a claim that DURABLY committed are read; if the claim fails
 * (structured `ok: false` or a throw) NO legacy entry is read or written in
 * this sweep (each candidate is reported `claim_failed`) — progress is never
 * promised on volatile memory. Guarantees, while the local store can commit
 * that claim: with N legacy candidates every one is read at least once in any
 * ⌈N / 10⌉ consecutive sweeps that each start after the previous sweep's
 * leases expired, across restarts; overlapping sweeps (another window, an
 * overlapping trigger) claim DISJOINT entries (IndexedDB serializes the
 * readwrite claims). With a permanently failing local store no legacy progress
 * is possible at all — that is reported, not hidden. Per sweep: ≤10 legacy
 * server reads, ≤10 legacy W4 attempts, one claim transaction.
 *
 * Gate 007-C — a claim is FENCED: it carries this sweep's owner token and a
 * new epoch (the check sequence, strictly increasing per entry). A lease can
 * expire while this sweep still waits on the server (60 s), so a newer sweep
 * may re-claim the entry; from then on the older sweep's fence no longer
 * matches. Before its W4 the sweep re-verifies and renews its claim in one
 * local transaction (`claim_lost` → no W4), and its terminal record is a
 * fenced compare-and-set (`claim_lost` → nothing recorded). Neither local
 * check can stop an older sweep whose W4 was ALREADY in flight when it lost
 * the claim, so the remote W4 is itself conditional: one server transaction
 * reads the doc and writes only a `pending` doc of this close and device, and
 * its commit is evaluated against the doc as it is THEN (W4 Rules: only
 * `pending → synced`). Overlapping sweeps can therefore make more than one W4
 * API ATTEMPT, but at most ONE effective transition; a loser either reads
 * `synced` (`already_synced`) or is rejected at commit (`failed` →
 * `retry_later`) — never `written`, never `normalized`. Outstanding
 * (non-legacy) entries are not claimed; they rely on the same conditional W4.
 */
export async function retryOutstandingNormalizations(
  deps: ReconcileShiftCloseIntentDeps,
  /** Shifts whose W4 was already attempted in this pass (by their reconcile) — not retried again now. */
  skipShiftIds: ReadonlySet<string> = new Set(),
): Promise<NormalizationRetryResult[]> {
  return (await retryNormalizationsDetailed(deps, skipShiftIds)).results;
}

async function retryNormalizationsDetailed(
  deps: ReconcileShiftCloseIntentDeps,
  skipShiftIds: ReadonlySet<string>,
): Promise<{ journalReadable: boolean; results: NormalizationRetryResult[] }> {
  let listed: Awaited<ReturnType<ShiftCloseIntentJournal['listCloseIntents']>>;
  try {
    listed = await deps.journal.listCloseIntents();
  } catch {
    return { journalReadable: false, results: [] };
  }
  if (!listed.ok) return { journalReadable: false, results: [] };
  const mine = listed.value.filter(
    (e) => e.status === 'synced' && e.deviceId === deps.deviceId && !skipShiftIds.has(e.shiftId),
  );
  const outstanding = mine.filter((e) => e.syncStateNormalization === 'outstanding');
  const legacyAll = mine.filter((e) => e.syncStateNormalization === undefined);

  const results: NormalizationRetryResult[] = [];
  let legacy: ShiftCloseIntentEntry[] = [];
  const owner = newClaimOwnerToken();
  if (legacyAll.length > 0) {
    let claim: Awaited<ReturnType<ShiftCloseIntentJournal['claimLegacyNormalizationChecks']>>;
    try {
      claim = await deps.journal.claimLegacyNormalizationChecks({
        deviceId: deps.deviceId,
        skipShiftIds: [...skipShiftIds],
        limit: LEGACY_NORMALIZATION_CHECKS_PER_SWEEP,
        leaseMs: LEGACY_NORMALIZATION_CLAIM_LEASE_MS,
        owner,
      });
    } catch (err) {
      claim = { ok: false, code: 'tx_failed', message: err instanceof Error ? err.message : String(err) };
    }
    if (claim.ok) {
      legacy = claim.value;
    } else {
      // Fail closed: report the entries a claim would have selected; read / write none.
      const wouldClaim = [...legacyAll]
        .sort(
          (a, b) =>
            legacyCheckSeq(a) - legacyCheckSeq(b) ||
            b.closedAtLocal - a.closedAtLocal ||
            (a.shiftId < b.shiftId ? -1 : a.shiftId > b.shiftId ? 1 : 0),
        )
        .slice(0, LEGACY_NORMALIZATION_CHECKS_PER_SWEEP);
      for (const e of wouldClaim) results.push({ shiftId: e.shiftId, outcome: 'claim_failed' });
    }
  }

  for (const entry of outstanding) {
    results.push({ shiftId: entry.shiftId, ...(await retryNormalization(entry, deps, null)) });
  }
  for (const entry of legacy) {
    // The claim just committed with THIS owner and the entry's new epoch.
    const fence = { owner, epoch: legacyCheckSeq(entry) };
    results.push({ shiftId: entry.shiftId, ...(await retryNormalization(entry, deps, fence)) });
  }
  return { journalReadable: true, results };
}

let claimOwnerCounter = 0;
/** Gate 007-C — a per-sweep claim owner token (identification only, not a secret). */
function newClaimOwnerToken(): string {
  claimOwnerCounter += 1;
  return `sweep-${generateShiftCloseCorrelationId() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}-${claimOwnerCounter}`;
}

type FencedStep = 'ok' | 'claim_lost' | 'failed';

/** `ok` ONLY when the store confirmed it (a fail-soft `ok: false` or a throw is `failed`). */
async function fencedStep(run: () => Promise<CloseIntentResult<string>>, okValue: string): Promise<FencedStep> {
  try {
    const r = await run();
    if (!r.ok) return 'failed';
    return r.value === okValue ? 'ok' : 'claim_lost';
  } catch {
    return 'failed';
  }
}

/**
 * One read and at most one W4 for an outstanding (`fence` null) or a CLAIMED
 * legacy entry. Gate 007-C: for a claimed entry every local write is fenced
 * and the claim is re-verified + renewed immediately before the W4.
 */
async function retryNormalization(
  entry: ShiftCloseIntentEntry,
  deps: ReconcileShiftCloseIntentDeps,
  fence: LegacyNormalizationClaimFence | null,
): Promise<Omit<NormalizationRetryResult, 'shiftId'>> {
  let read: ShiftCloseConfirmationRead;
  try {
    read = await deps.readConfirmation(entry.shiftId);
  } catch {
    read = { ok: false };
  }
  if (!read.ok) return { outcome: 'retry_later' };
  const { doc } = read;
  if (!doc.exists || doc.status !== 'closed' || !isResolvedServerTimestamp(doc.closedAt)) return { outcome: 'retry_later' };
  // Gate 006-C: a terminal outcome is reported only once its local record persisted.
  // Gate 007-C: for a claimed entry, only while this sweep still holds the claim.
  const record = async (
    state: 'done' | 'mismatch' | 'not_applicable',
    outcome: NormalizationRetryOutcome,
  ): Promise<NormalizationRetryOutcome> => {
    if (!fence) return (await persistNormalization(deps.journal, entry, state)) ? outcome : 'local_write_failed';
    const step = await fencedStep(
      () => deps.journal.recordLegacyNormalization(entry.shiftId, entry.closeCorrelationId, state, fence),
      'recorded',
    );
    return step === 'ok' ? outcome : step === 'claim_lost' ? 'claim_lost' : 'local_write_failed';
  };
  const confirmation = confirmsEntry(entry, doc);
  if (confirmation === 'unresolved') return { outcome: 'retry_later' };
  if (confirmation === 'mismatch') return { outcome: await record('mismatch', 'mismatch') };
  // B2.2-A: unexpected sync marker — not terminal without proof, never written.
  if (doc.syncStateMalformed) return { outcome: 'manual_attention' };
  if (doc.syncState === 'synced') return { outcome: await record('done', 'already_normalized') };
  if (doc.syncState !== 'pending' || doc.deviceId !== deps.deviceId) {
    return { outcome: await record('not_applicable', 'not_applicable') };
  }
  if (!deps.normalizeSyncState) return { outcome: 'retry_later' };
  if (fence) {
    // The read may have outlived the lease: W4 only if the claim is still ours.
    const owned = await fencedStep(() => deps.journal.renewLegacyNormalizationClaim(entry.shiftId, fence), 'owned');
    if (owned === 'claim_lost') return { outcome: 'claim_lost' };
    if (owned === 'failed') return { outcome: 'claim_failed' };
  }
  const remoteW4 = await callNormalizer(entry, deps.normalizeSyncState, deps.deviceId);
  if (remoteW4 !== 'written' && remoteW4 !== 'already_synced') return { outcome: 'retry_later', remoteW4 };
  return { outcome: await record('done', remoteW4 === 'written' ? 'normalized' : 'already_normalized'), remoteW4 };
}

// ── Recovery gate B2: prepared ONLINE close attempts ──────────────────────

export type OnlineCloseRecoveryOutcome =
  /** The doc is closed with THIS attempt's correlation id; the journal entry now exists. */
  | 'recovered'
  /**
   * The doc is closed by another VALID correlation id of the same shift run:
   * this attempt can never commit. Gate 006-B: RETAINED as a tombstone (never
   * deleted), no Z, no further server reads for it.
   */
  | 'superseded'
  /** Open / missing: not closed (yet). Kept — never a close claim, never a Z source. */
  | 'not_closed'
  /** Read or journal write failed. Kept; retried on the next trigger. */
  | 'unreachable'
  /**
   * Kept; no claim: closed with this id but the doc cannot be trusted as this
   * close (identity/fields), OR closed with an empty / malformed / absent
   * correlation id (B2.1-B: not proof of another close), OR closed by another
   * id although this attempt's commit was observed (B2.1-A).
   */
  | 'manual_attention';

export type OnlineCloseRecoveryResult = {
  shiftId: string;
  outcome: OnlineCloseRecoveryOutcome;
  entry?: ShiftCloseIntentEntry;
};

function finiteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** The identity a W3 close of THIS device's attempt committed under. */
export type OwnCloseIdentity = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  deviceId: string;
  closeCorrelationId: string;
};

export type CommittedOwnCloseParse =
  | { ok: true; snapshot: ShiftCloseIntentBusinessSnapshot; closedAt: Date }
  | {
      ok: false;
      /**
       * not_closed           doc missing / not `closed`
       * other_correlation    closed by ANOTHER VALID (lowercase UUID v4) id, with
       *                      a resolved `closedAt` and this attempt's branch +
       *                      staff — proof this attempt can never commit
       * missing_correlation  closed WITHOUT a correlation id (legitimate for
       *                      historical / UUID-less clients, but not provably
       *                      another close of THIS attempt's shift run)
       * invalid_correlation  closed with an empty / non-UUID / non-string id
       *                      (W3 Rules deny those: corrupt or out-of-band)
       * closed_at_unresolved `closedAt` is not a resolved server Timestamp
       * identity_mismatch    branch / staff / device differ from the attempt
       * malformed_fields     a mandatory committed field is missing / non-finite
       * inconsistent_fields  variance ≠ actualCashCount − expected drawer
       */
      reason:
        | 'not_closed'
        | 'other_correlation'
        | 'missing_correlation'
        | 'invalid_correlation'
        | 'closed_at_unresolved'
        | 'identity_mismatch'
        | 'malformed_fields'
        | 'inconsistent_fields';
    };

/**
 * B2.1 — THE strict parser of a server-confirmed close committed by THIS
 * device's attempt. Shared by the in-transaction own-correlation retry, the
 * cached-closed retry and the restart / reconnect sweep, so no path can build
 * a journal entry or a Z from anything else.
 *
 * Mandatory (each is written by the W3 close and is needed by the journal /
 * Z / Variant C — none is defaulted, coerced or zero-filled):
 *  - `status === 'closed'` and `closeCorrelationId` === the attempt's id
 *    (proves THIS commit, not another close of the shift)
 *  - `closedAt` a resolved server Timestamp (authoritative close time)
 *  - `branchId`, `staffId`, `deviceId` === the attempt (deviceId gates Variant C)
 *  - finite `startingCash`, `expectedCash`, `expectedQr`, `expectedKbank`,
 *    `expectedCard`, `expectedCredit`, `payInTotal`, `payOutTotal`,
 *    `totalBills`, `actualCashCount`, `variance` (every Z / journal total)
 *  - string `note`
 *  - `variance === actualCashCount − (startingCash + expectedCash + payInTotal
 *    − payOutTotal)`, the exact expression W3 wrote it with
 *    (`calcShiftDrawerExpected`), so totals that disagree are rejected.
 * `staffName` comes from the attempt (W3 never writes it). Only used for
 * own-correlation recovery — historical / foreign closes never pass through it.
 */
export function parseCommittedOwnClose(identity: OwnCloseIdentity, doc: ShiftCloseConfirmationDoc): CommittedOwnCloseParse {
  if (!doc.exists || doc.status !== 'closed') return { ok: false, reason: 'not_closed' };
  if (!isValidLowercaseUuidV4(identity.closeCorrelationId)) return { ok: false, reason: 'invalid_correlation' };
  if (doc.closeCorrelationIdMalformed || doc.closeCorrelationId !== identity.closeCorrelationId) {
    // B2.1-B: only a DISTINCT VALID id of the same shift run proves supersession.
    const raw: unknown = doc.closeCorrelationId;
    if (doc.closeCorrelationIdMalformed) return { ok: false, reason: 'invalid_correlation' };
    if (raw === undefined || raw === null) return { ok: false, reason: 'missing_correlation' };
    if (!isValidLowercaseUuidV4(raw)) return { ok: false, reason: 'invalid_correlation' };
    if (!isResolvedServerTimestamp(doc.closedAt)) return { ok: false, reason: 'closed_at_unresolved' };
    if (doc.branchId !== identity.branchId || doc.staffId !== identity.staffId) {
      return { ok: false, reason: 'identity_mismatch' };
    }
    return { ok: false, reason: 'other_correlation' };
  }
  if (!isResolvedServerTimestamp(doc.closedAt)) return { ok: false, reason: 'closed_at_unresolved' };
  if (doc.branchId !== identity.branchId || doc.staffId !== identity.staffId || doc.deviceId !== identity.deviceId) {
    return { ok: false, reason: 'identity_mismatch' };
  }
  const {
    startingCash, expectedCash, expectedQr, expectedKbank, expectedCard, expectedCredit,
    payInTotal, payOutTotal, totalBills, actualCashCount, variance, note,
  } = doc;
  if (
    !finiteNumber(startingCash) || !finiteNumber(expectedCash) || !finiteNumber(expectedQr) ||
    !finiteNumber(expectedKbank) || !finiteNumber(expectedCard) || !finiteNumber(expectedCredit) ||
    !finiteNumber(payInTotal) || !finiteNumber(payOutTotal) || !finiteNumber(totalBills) ||
    !finiteNumber(actualCashCount) || !finiteNumber(variance) || typeof note !== 'string'
  ) {
    return { ok: false, reason: 'malformed_fields' };
  }
  if (variance !== actualCashCount - (startingCash + expectedCash + payInTotal - payOutTotal)) {
    return { ok: false, reason: 'inconsistent_fields' };
  }
  let closedAt: Date;
  try {
    closedAt = doc.closedAt.toDate();
  } catch {
    return { ok: false, reason: 'closed_at_unresolved' };
  }
  if (!(closedAt instanceof Date) || Number.isNaN(closedAt.getTime())) return { ok: false, reason: 'closed_at_unresolved' };
  return {
    ok: true,
    closedAt,
    snapshot: {
      shiftId: identity.shiftId,
      branchId: identity.branchId,
      staffId: identity.staffId,
      staffName: identity.staffName,
      startingCash,
      expectedCash,
      expectedQr,
      expectedKbank,
      expectedCard,
      expectedCredit,
      payInTotal,
      payOutTotal,
      totalBills,
      actualCashCount,
      variance,
      note,
      deviceId: identity.deviceId,
    },
  };
}

/**
 * Resolve ONE prepared online close attempt against a confirmation-grade read.
 * Never invents a close: only a doc that {@link parseCommittedOwnClose}
 * accepts is journaled, from the doc's own committed values. Idempotent: the
 * journal finalize is a no-op for an equal existing entry. Never throws.
 */
export async function recoverOnlineCloseAttempt(
  attempt: OnlineCloseAttemptRecord,
  deps: Pick<ReconcileShiftCloseIntentDeps, 'journal' | 'readConfirmation' | 'deviceId'>,
): Promise<OnlineCloseRecoveryResult> {
  const shiftId = attempt.shiftId;
  if (attempt.deviceId !== deps.deviceId) return { shiftId, outcome: 'not_closed' };
  // Gate 006-B: an already-tombstoned (never commit-observed) attempt is settled.
  if (isSupersededAttempt(attempt)) return { shiftId, outcome: 'superseded' };
  let read: ShiftCloseConfirmationRead;
  try {
    read = await deps.readConfirmation(shiftId);
  } catch {
    read = { ok: false };
  }
  if (!read.ok) return { shiftId, outcome: 'unreachable' };
  const parsed = parseCommittedOwnClose(attempt, read.doc);
  if (!parsed.ok) {
    if (parsed.reason === 'not_closed') return { shiftId, outcome: 'not_closed' };
    if (parsed.reason === 'closed_at_unresolved') return { shiftId, outcome: 'unreachable' };
    if (parsed.reason === 'other_correlation' && !isCommitObservedAttempt(attempt)) {
      // Closed by another VALID close of the same shift run: W3 only closes an
      // OPEN doc, so this attempt can never commit now (no Z, no journal
      // entry). Gate 006-B: NON-destructive — the store re-reads the DURABLE
      // attempt and tombstones it only if it is not commit-observed there
      // either; a contradiction with a known commit is manual attention.
      let superseded: Awaited<ReturnType<ShiftCloseIntentJournal['supersedeOnlineCloseAttempt']>>;
      try {
        superseded = await deps.journal.supersedeOnlineCloseAttempt(shiftId, attempt.closeCorrelationId);
      } catch {
        return { shiftId, outcome: 'unreachable' };
      }
      if (!superseded.ok) return { shiftId, outcome: 'unreachable' };
      return { shiftId, outcome: superseded.value === 'commit_observed' ? 'manual_attention' : 'superseded' };
    }
    // missing / invalid correlation, observed-commit contradiction, identity /
    // field defects: retained for investigation — never deleted, never a Z.
    return { shiftId, outcome: 'manual_attention' };
  }
  const { snapshot } = parsed;
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
 *
 * Gate 007-C — the resolved value is still the array of pending-close
 * results (backward compatible); its non-enumerable `normalization` property
 * carries the W4 normalization outcome of the same sweep, so a caller can
 * observe `claim_failed` / `local_write_failed` / an unreadable journal and
 * the count still owed instead of losing them. Joined callers share it.
 */
export function runShiftCloseReconciliationSweep(
  deps: ReconcileShiftCloseIntentDeps,
): Promise<ShiftCloseSweepResult> {
  // Gate 006-C — single-flight per device in this process: an overlapping
  // boot / `online` / orchestrator trigger JOINS the running sweep (same
  // result) instead of re-reading and re-attempting W4 for the same entries.
  // A sweep older than SWEEP_JOIN_MAX_MS (e.g. a server read that never
  // settles) is not joined, so one stuck sweep can never stall all later ones.
  // Across windows / processes the legacy batch is made disjoint by the
  // transactional claim. Gate 007-C: a sweep that outlives its claim lease is
  // fenced (see retryOutstandingNormalizations), and any remaining overlap is
  // bounded by the conditional W4 (one server transaction whose commit W4
  // Rules evaluate: only one pending → synced write can take effect).
  const nowMs = Date.now();
  const running = sweepsInFlight.get(deps.deviceId);
  if (running && nowMs >= running.startedAt && nowMs - running.startedAt < SWEEP_JOIN_MAX_MS) return running.promise;
  const promise = runSweepOnce(deps).finally(() => {
    if (sweepsInFlight.get(deps.deviceId)?.promise === promise) sweepsInFlight.delete(deps.deviceId);
  });
  sweepsInFlight.set(deps.deviceId, { promise, startedAt: nowMs });
  return promise;
}

/** Gate 006-C: an in-flight sweep is joined only while younger than this. */
const SWEEP_JOIN_MAX_MS = 60_000;
const sweepsInFlight = new Map<string, { promise: Promise<ShiftCloseSweepResult>; startedAt: number }>();

/**
 * Gate 007-C — the W4 normalization outcome of one sweep.
 *   status  `ok`                  every step reached a truthful, persisted state (or was left to retry)
 *           `degraded`            a claim / local record could not be persisted (`claim_failed`,
 *                                 `local_write_failed`, a pending-close W4 whose `done` did not
 *                                 persist) or the owed count could not be read
 *           `journal_unreadable`  the close-intent journal could not be listed: nothing was checked
 *   results  the retry results (outstanding + claimed legacy), with `remoteW4` per API attempt
 *   counts   per outcome
 *   owed     after the sweep: this device's `synced` closes whose W4 is still `outstanding` or never
 *            checked (legacy); `null` when it could not be read
 */
export type ShiftCloseNormalizationSummary = {
  status: 'ok' | 'degraded' | 'journal_unreadable';
  results: NormalizationRetryResult[];
  counts: Partial<Record<NormalizationRetryOutcome, number>>;
  owed: number | null;
};

export type ShiftCloseSweepResult = ReconcileShiftCloseIntentResult[] & {
  readonly normalization: ShiftCloseNormalizationSummary;
};

function sweepResult(results: ReconcileShiftCloseIntentResult[], normalization: ShiftCloseNormalizationSummary): ShiftCloseSweepResult {
  // Non-enumerable: existing callers / `toEqual` still see a plain array.
  return Object.defineProperty(results, 'normalization', { value: normalization, enumerable: false }) as ShiftCloseSweepResult;
}

/**
 * Gate 007-C — the one line a caller reports for a summary that needs
 * attention (`null` = nothing to report). Stable for an unchanged state, so a
 * caller can de-duplicate repeated reports.
 */
export function shiftCloseNormalizationIssue(summary: ShiftCloseNormalizationSummary | undefined): string | null {
  if (!summary || summary.status === 'ok') return null;
  if (summary.status === 'journal_unreadable') return 'journal_unreadable';
  const parts = (['claim_failed', 'local_write_failed'] as const)
    .filter((o) => (summary.counts[o] ?? 0) > 0)
    .map((o) => `${o}=${summary.counts[o]}`);
  if (summary.owed === null) parts.push('owed_unreadable');
  return parts.length > 0 ? parts.join(',') : 'done_unrecorded';
}

async function countOwedNormalizations(deps: ReconcileShiftCloseIntentDeps): Promise<number | null> {
  try {
    const listed = await deps.journal.listCloseIntents();
    if (!listed.ok) return null;
    return listed.value.filter(
      (e) =>
        e.status === 'synced' &&
        e.deviceId === deps.deviceId &&
        (e.syncStateNormalization === 'outstanding' || e.syncStateNormalization === undefined),
    ).length;
  } catch {
    return null;
  }
}

async function runSweepOnce(deps: ReconcileShiftCloseIntentDeps): Promise<ShiftCloseSweepResult> {
  // Recovery gate B2: first turn every prepared online close that DID commit
  // into its journal entry, so the loop below reconciles it (synced + Variant C)
  // exactly like any other pending close.
  await recoverOnlineCloseAttempts(deps);
  const listed = await deps.journal.listCloseIntents();
  if (!listed.ok) {
    return sweepResult([], { status: 'journal_unreadable', results: [], counts: {}, owed: null });
  }

  const pending = listed.value.filter(
    (entry) => entry.status === 'local_closed_pending' && entry.deviceId === deps.deviceId,
  );

  const results: ReconcileShiftCloseIntentResult[] = [];
  for (const entry of pending) {
    results.push(await reconcileShiftCloseIntent(entry, deps));
  }
  // B2.2: confirmed closes whose Variant C (W4) write is still owed — at most
  // one W4 attempt per close per sweep (just-reconciled ones already had theirs).
  const retried = await retryNormalizationsDetailed(deps, new Set(pending.map((e) => e.shiftId)));
  const counts: Partial<Record<NormalizationRetryOutcome, number>> = {};
  for (const r of retried.results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  const owed = retried.journalReadable ? await countOwedNormalizations(deps) : null;
  const degraded =
    (counts.claim_failed ?? 0) > 0 ||
    (counts.local_write_failed ?? 0) > 0 ||
    results.some((r) => r.normalized === true && r.normalizationRecorded === false) ||
    owed === null;
  return sweepResult(results, {
    status: !retried.journalReadable ? 'journal_unreadable' : degraded ? 'degraded' : 'ok',
    results: retried.results,
    counts,
    owed,
  });
}
