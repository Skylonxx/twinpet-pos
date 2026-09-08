/**
 * SEC-001 Packet D / D-2 — durable privileged-evidence store.
 *
 * Owns the atomic ingest boundary, the durable monotone sweep-generation
 * allocator (OP-1), the re-validating claim CAS (OP-2), the disposition
 * apply CAS (OP-3), the deferred-counter batch write (OP-4), and the stable
 * D-3 read contract. No network call is ever made from inside a
 * `store.transact` callback (CL-D2-A05) — `sha256HexOfRows` (async) always
 * runs BEFORE or AFTER a transaction, never inside one.
 */

import { sha256HexOfRows } from '../../platform/durableStore/canonicalDigest';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import type {
  OfflineAdjudicationDisposition,
  OfflineAdjudicationResponse,
} from '../../auth/privilegedAction/offlineAdjudicationTransport';
import {
  OFFLINE_ADJUDICATION_PERMANENT_BYTE_REASONS,
  isOfflineAdjudicationAnomalyReason,
  isOfflineAdjudicationManualAttentionReason,
  isOfflineAdjudicationRejectionReason,
} from '../../auth/privilegedAction/privilegedActionTypes';
import type { ReversalLocalStore, ReversalStoreName, ReversalTxn } from './reversalLocalStore';
import type { VoidIntentRecord } from './voidIntentStore';
import {
  PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY,
  PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
  PRIVILEGED_EVIDENCE_RESERVED_KEYS,
  isPrivilegedEvidenceClaimFenced,
  isPrivilegedEvidenceTerminalStatus,
  parsePrivilegedEvidenceJournalRecordV1,
  type PrivilegedEvidenceDispositionKind,
  type PrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';
import { computePrivilegedEvidenceBackoffDelayMs } from './privilegedEvidenceScheduler';

type Row = PrivilegedEvidenceJournalRecordV1;

const STORE_NAME = 'privilegedEvidence' as const;
const RESERVED_KEY_SET = new Set<string>(PRIVILEGED_EVIDENCE_RESERVED_KEYS);

// ─── Digest ─────────────────────────────────────────────────────────────────

/** sha256 over adjudicationId || localIntentId || the three opaque byte fields. */
export async function computeEvidenceBindingDigest(fields: {
  attestationIdHex: string;
  localIntentId: string;
  paa1Base64: string;
  ssa1Base64: string;
  oacEnvelopeBytesBase64: string;
}): Promise<string> {
  return sha256HexOfRows([
    { encodedKey: 'adjudicationId', value: fields.attestationIdHex },
    { encodedKey: 'localIntentId', value: fields.localIntentId },
    { encodedKey: 'paa1Base64', value: fields.paa1Base64 },
    { encodedKey: 'ssa1Base64', value: fields.ssa1Base64 },
    { encodedKey: 'oacEnvelopeBytesBase64', value: fields.oacEnvelopeBytesBase64 },
  ]);
}

// ─── Enumeration (shared by OP-1 and the read contract) ────────────────────

function requireGetAllKeys(txn: ReversalTxn): Promise<string[]> {
  if (!txn.getAllKeys) throw new Error('privilegedEvidence store requires getAllKeys support');
  return txn.getAllKeys(STORE_NAME);
}

async function enumerateRows(txn: ReversalTxn): Promise<{ rows: Row[]; unreadableCount: number }> {
  const keys = await requireGetAllKeys(txn);
  const rows: Row[] = [];
  let unreadableCount = 0;
  for (const key of keys) {
    if (RESERVED_KEY_SET.has(key)) continue;
    const raw = await txn.get(STORE_NAME, key);
    const parsed = parsePrivilegedEvidenceJournalRecordV1(raw);
    if (parsed) rows.push(parsed);
    else unreadableCount += 1;
  }
  return { rows, unreadableCount };
}

function coerceStoredGeneration(raw: unknown): number {
  if (raw != null && typeof raw === 'object') {
    const g = (raw as { generation?: unknown }).generation;
    if (typeof g === 'number' && Number.isInteger(g) && g >= 0) return g;
  }
  return 0;
}

// ─── OP-1 — enumerate + allocate the sweep generation ──────────────────────

export interface PrivilegedEvidenceSweepEnumeration {
  generation: number;
  rows: Row[];
  unreadableCount: number;
}

/** One readwrite transaction. Self-healing floor from stored generation and max row claimGeneration (G1). */
export async function allocatePrivilegedSweepGeneration(
  store: ReversalLocalStore,
): Promise<PrivilegedEvidenceSweepEnumeration> {
  return store.transact([STORE_NAME], 'readwrite', async (txn) => {
    const { rows, unreadableCount } = await enumerateRows(txn);
    const storedRaw = await txn.get(STORE_NAME, PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY);
    const stored = coerceStoredGeneration(storedRaw);
    const rowsMax = rows.reduce((max, r) => Math.max(max, r.claimGeneration ?? 0), 0);
    const generation = Math.max(stored, rowsMax) + 1;
    await txn.put(STORE_NAME, PRIVILEGED_EVIDENCE_CLAIM_GENERATION_KEY, { generation });
    return { generation, rows, unreadableCount };
  });
}

// ─── Ingest — atomic CAS boundary ───────────────────────────────────────────

export type IngestOutcome =
  | { kind: 'created'; record: Row }
  | { kind: 'idempotent_noop'; record: Row }
  | { kind: 'binding_conflict'; record: Row }
  | { kind: 'unreadable' }
  | { kind: 'not_approved_local' }
  | { kind: 'duplicate_target'; record: Row }
  /**
   * SEC-001 Packet D / D-3, RC-D3-004 Ordering B — an active (non-terminal,
   * non-confirmed) legacy `voidIntent` already exists for this bound
   * `(branchId, targetOrderId)`. Refusing the fresh privileged row here is
   * the reverse half of the atomic no-bypass contract: the system must never
   * hold two mutually active authority paths (privileged + legacy) for the
   * same target at once. This is an in-memory outcome only — no journal
   * schema/parser/matrix change.
   */
  | { kind: 'legacy_conflict' };

export interface IngestContext {
  ingestStaffId: string;
  ingestDeviceId: string;
  /**
   * SEC-001 Packet D / D-3, GD-D3-002 OPTION A — opt-in atomic target-level
   * duplicate exclusion. When true, the fresh-row create branch first checks,
   * inside the SAME readwrite transaction, whether an OPEN privileged row
   * already exists for `(envelope.verifiedBranchId, envelope.targetOrderId)`
   * and returns `duplicate_target` instead of writing a second one. Omitted
   * or false preserves the landed pre-D-3 ingest behavior exactly.
   */
  expectNoOpenRowForTarget?: boolean;
}

/** GD-D3-002: open statuses that block a second privileged row for the same target. `SERVER_REJECTED` does not block. */
const OPEN_TARGET_EXCLUSION_STATUSES = new Set<Row['syncStatus']>([
  'PRIVILEGED_INTENT_QUEUED',
  'SYNCING',
  'SERVER_ACCEPTED',
  'MANUAL_ATTENTION',
]);

export type PrivilegedFenceProbe =
  | { kind: 'open'; record: Row }
  | { kind: 'clear' }
  | { kind: 'unreadable' };

/**
 * SEC-001 Packet D / D-3, RC-D3-002 / RC-D3-004 — exported ONLY so
 * `voidIntentStore.ts`'s atomic legacy fence
 * (`enqueueVoidIntentWithPrivilegedFence`) can probe the SAME enumeration
 * inside its own `[privilegedEvidence, voidIntents]` durable transaction,
 * instead of a second, separately-committed read (which would reopen the
 * RC-D3-004 TOCTOU window) and without duplicating the read/status logic.
 * `txn`'s transaction scope must already include `privilegedEvidence`.
 * Fails closed (`unreadable`) whenever ANY row in the store is
 * parser-invalid — the caller cannot tell which target an unreadable row
 * belonged to, so it must never be treated as "no open row" (RC-D3-002).
 */
export async function probeOpenPrivilegedRowForTargetInTxn(
  txn: ReversalTxn,
  branchId: string,
  targetOrderId: string,
): Promise<PrivilegedFenceProbe> {
  const { rows, unreadableCount } = await enumerateRows(txn);
  if (unreadableCount > 0) return { kind: 'unreadable' };
  for (const row of rows) {
    if (
      row.branchId === branchId &&
      row.targetOrderId === targetOrderId &&
      OPEN_TARGET_EXCLUSION_STATUSES.has(row.syncStatus)
    ) {
      return { kind: 'open', record: row };
    }
  }
  return { kind: 'clear' };
}

function buildFreshRecord(envelope: OfflineAttestationEnvelope, digest: string, ctx: IngestContext, nowMs: number): Row {
  return {
    schemaVersion: 1,
    adjudicationId: envelope.attestationIdHex,
    localIntentId: envelope.localIntentId,
    paa1Base64: envelope.paa1Base64,
    ssa1Base64: envelope.ssa1Base64,
    oacEnvelopeBytesBase64: envelope.oacEnvelopeBytesBase64,
    evidenceBindingDigest: digest,
    actionId: envelope.actionId,
    targetOrderId: envelope.targetOrderId,
    targetOrderUtc7Date: envelope.targetOrderUtc7Date,
    branchId: envelope.verifiedBranchId,
    approvingManagerStaffId: envelope.approvingManagerStaffId,
    oacId: envelope.evidenceSeed.oacId,
    oacSchemaVersion: 1,
    revocationEpochAtIssue: envelope.evidenceSeed.revocationEpochAtIssue,
    managerAuthVersionAtIssue: envelope.evidenceSeed.managerAuthVersionAtIssue,
    managerCredentialVersionAtIssue: envelope.evidenceSeed.managerCredentialVersionAtIssue,
    nonce: envelope.evidenceSeed.nonce,
    approvalProofDigest: envelope.evidenceSeed.approvalProofDigest,
    attestationAttemptCount: envelope.evidenceSeed.attemptCount,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: envelope.trustedApprovalLowerMs,
    trustedApprovalUpperMs: envelope.trustedApprovalUpperMs,
    pendingExecutionExpiresAtMs: envelope.pendingExecutionExpiresAtMs,
    syncStatus: 'PRIVILEGED_INTENT_QUEUED',
    manualReviewStatus: 'NOT_REQUIRED',
    localTerminalReason: null,
    submissionClaims: 0,
    unresolvedClaimCount: 0,
    retryableFailureCount: 0,
    relayDeferrals: 0,
    deferredCycleCount: 0,
    nextAttemptAtMs: nowMs,
    claimOwner: null,
    claimGeneration: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lastAttemptAtMs: null,
    lastDispositionKind: null,
    lastRelayCallerStaffId: null,
    lastCallerDependentStaffId: null,
    integrityConflict: false,
    ingestStaffId: ctx.ingestStaffId,
    ingestDeviceId: ctx.ingestDeviceId,
    resultingVoidIntentId: null,
    serverVerdict: null,
    serverReason: null,
    serverAdjudicationId: null,
    serverTargetOrderId: null,
    offlineExecutionId: null,
    outcomeKind: null,
    serverAdjudicatedAtMs: null,
    serverObservedAtMs: null,
    serverIdempotentReplay: null,
  };
}

/**
 * D-2's durable ingest API. `ingestAttestedPrivilegedAction`'s sole production
 * caller is the SEC-001 Packet D / D-3 adapter,
 * `projectPrivilegedOfflineAction` (`src/lib/pos/offline/projectPrivilegedOfflineAction.ts`).
 */
export async function ingestAttestedPrivilegedAction(
  store: ReversalLocalStore,
  envelope: OfflineAttestationEnvelope,
  ctx: IngestContext,
  nowMs: number,
): Promise<IngestOutcome> {
  if (envelope.evidenceSeed.approvalResult !== 'APPROVED_LOCAL') {
    return { kind: 'not_approved_local' };
  }
  const digest = await computeEvidenceBindingDigest(envelope);

  // RC-D3-004 Ordering B — the opted-in fresh-row path also needs to read
  // `voidIntents` (for the reverse legacy-conflict check below), so widen the
  // transaction scope ONLY for that opted-in caller. Every landed caller that
  // omits `expectNoOpenRowForTarget` keeps the exact original single-store
  // transaction scope and behavior.
  const stores: ReversalStoreName[] = ctx.expectNoOpenRowForTarget ? [STORE_NAME, 'voidIntents'] : [STORE_NAME];

  return store.transact(stores, 'readwrite', async (txn): Promise<IngestOutcome> => {
    const existingRaw = await txn.get<unknown>(STORE_NAME, envelope.attestationIdHex);
    if (existingRaw === undefined) {
      if (ctx.expectNoOpenRowForTarget) {
        // RC-D3-002 — fail closed before minting a fresh row whenever ANY
        // privileged row in the store is unreadable/corrupted.
        const probe = await probeOpenPrivilegedRowForTargetInTxn(txn, envelope.verifiedBranchId, envelope.targetOrderId);
        if (probe.kind === 'unreadable') return { kind: 'unreadable' };
        if (probe.kind === 'open') return { kind: 'duplicate_target', record: probe.record };

        // RC-D3-004 Ordering B — an active (non-terminal, non-confirmed)
        // legacy voidIntent for this exact bound target already exists.
        // Refuse to open a second, mutually active authority path.
        const legacyRaw = await txn.get<VoidIntentRecord>('voidIntents', envelope.targetOrderId);
        if (
          legacyRaw !== undefined &&
          legacyRaw.branchId === envelope.verifiedBranchId &&
          legacyRaw.status !== 'confirmed' &&
          legacyRaw.status !== 'terminal'
        ) {
          return { kind: 'legacy_conflict' };
        }
      }
      const record = buildFreshRecord(envelope, digest, ctx, nowMs);
      await txn.put(STORE_NAME, envelope.attestationIdHex, record);
      return { kind: 'created', record };
    }

    const existing = parsePrivilegedEvidenceJournalRecordV1(existingRaw);
    if (!existing) return { kind: 'unreadable' };

    const identical =
      existing.paa1Base64 === envelope.paa1Base64 &&
      existing.ssa1Base64 === envelope.ssa1Base64 &&
      existing.oacEnvelopeBytesBase64 === envelope.oacEnvelopeBytesBase64 &&
      existing.localIntentId === envelope.localIntentId &&
      existing.evidenceBindingDigest === digest;
    if (identical) return { kind: 'idempotent_noop', record: existing };

    // Fail closed. The ORIGINAL bytes are preserved verbatim; the new bytes are discarded, never merged.
    const conflicted: Row = {
      ...existing,
      integrityConflict: true,
      syncStatus: 'MANUAL_ATTENTION',
      manualReviewStatus: 'REQUIRED',
      localTerminalReason: 'journal_binding_conflict',
      lastDispositionKind: 'LOCAL_TERMINAL',
      claimOwner: null,
      claimGeneration: null,
      updatedAtMs: nowMs,
    };
    await txn.put(STORE_NAME, envelope.attestationIdHex, conflicted);
    return { kind: 'binding_conflict', record: conflicted };
  }).then((outcome) => {
    notifyPrivilegedEvidenceListeners(store);
    return outcome;
  });
}

// ─── OP-2 — re-validating claim CAS ─────────────────────────────────────────

export type ClaimOutcome =
  | { kind: 'claimed'; record: Row }
  | { kind: 'not_eligible' }
  | { kind: 'digest_mismatch'; record: Row };

export interface ClaimContext {
  deviceId: string;
  nowMs: number;
  /** Authenticated current relay staff id (RC-D2-003 claim-time provenance). */
  staffId: string;
}

/**
 * Re-reads and re-validates admission rules 2 (integrity/digest), 3 (F1
 * fencing), and 4 (retry ceiling) inside the transaction, per §3.4 of the
 * final local-store closure. `crypto.subtle` cannot be awaited inside an
 * active durable-store transaction (CL-D2-A05), so the digest is recomputed
 * from a fresh pre-read immediately before the CAS and compared
 * synchronously inside it.
 *
 * RC-D2-001 (TOCTOU): the pre-read snapshot and the digest computed from it
 * age across the `await computeEvidenceBindingDigest` gap. The writable CAS
 * re-verifies the five snapshot fields byte-for-byte against the live row
 * BEFORE trusting the digest comparison — comparing only
 * `row.evidenceBindingDigest === recomputedDigest` would pass even when the
 * live fields have drifted from the snapshot, provided the row's own stored
 * digest field happened not to be updated in step. A snapshot mismatch is
 * treated as a transient race, not corruption: nothing is written and a
 * later sweep retries from a fresh pre-read.
 */
export async function claimPrivilegedEvidenceRow(
  store: ReversalLocalStore,
  adjudicationId: string,
  generation: number,
  ctx: ClaimContext,
): Promise<ClaimOutcome> {
  const preRaw = await store.transact([STORE_NAME], 'readonly', (txn) => txn.get<unknown>(STORE_NAME, adjudicationId));
  const preRow = parsePrivilegedEvidenceJournalRecordV1(preRaw);
  if (!preRow) return { kind: 'not_eligible' };
  const snapshot = {
    adjudicationId: preRow.adjudicationId,
    localIntentId: preRow.localIntentId,
    paa1Base64: preRow.paa1Base64,
    ssa1Base64: preRow.ssa1Base64,
    oacEnvelopeBytesBase64: preRow.oacEnvelopeBytesBase64,
  };
  const recomputedDigest = await computeEvidenceBindingDigest({
    attestationIdHex: snapshot.adjudicationId,
    localIntentId: snapshot.localIntentId,
    paa1Base64: snapshot.paa1Base64,
    ssa1Base64: snapshot.ssa1Base64,
    oacEnvelopeBytesBase64: snapshot.oacEnvelopeBytesBase64,
  });

  return store.transact([STORE_NAME], 'readwrite', async (txn): Promise<ClaimOutcome> => {
    const raw = await txn.get<unknown>(STORE_NAME, adjudicationId);
    const row = parsePrivilegedEvidenceJournalRecordV1(raw);
    if (!row) return { kind: 'not_eligible' };

    // RC-D2-001: the live binding inputs must still match the pre-read
    // snapshot the digest above was computed from. No write, no claim.
    const snapshotStillLive =
      row.adjudicationId === snapshot.adjudicationId &&
      row.localIntentId === snapshot.localIntentId &&
      row.paa1Base64 === snapshot.paa1Base64 &&
      row.ssa1Base64 === snapshot.ssa1Base64 &&
      row.oacEnvelopeBytesBase64 === snapshot.oacEnvelopeBytesBase64;
    if (!snapshotStillLive) return { kind: 'not_eligible' };

    // rule 2
    if (row.integrityConflict) return { kind: 'not_eligible' };
    if (row.evidenceBindingDigest !== recomputedDigest) {
      const failed: Row = {
        ...row,
        syncStatus: 'MANUAL_ATTENTION',
        manualReviewStatus: 'REQUIRED',
        localTerminalReason: 'evidence_binding_digest_mismatch',
        lastDispositionKind: 'LOCAL_TERMINAL',
        claimOwner: null,
        claimGeneration: null,
        updatedAtMs: ctx.nowMs,
      };
      await txn.put(STORE_NAME, adjudicationId, failed);
      return { kind: 'digest_mismatch', record: failed };
    }

    // rule 3
    const statusAdmissible =
      row.syncStatus === 'PRIVILEGED_INTENT_QUEUED' ||
      (row.syncStatus === 'SYNCING' && isPrivilegedEvidenceClaimFenced(row.claimGeneration, generation));
    if (!statusAdmissible) return { kind: 'not_eligible' };

    // rule 4
    if (row.retryableFailureCount >= PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES) return { kind: 'not_eligible' };

    const wasClaimed = row.claimGeneration !== null;
    const claimed: Row = {
      ...row,
      syncStatus: 'SYNCING',
      // No disposition-kind matrix entry permits syncStatus === 'SYNCING':
      // lastDispositionKind describes the most recent disposition applied
      // to a row AT REST. Claiming starts a fresh in-flight episode, so it
      // is cleared here and re-set only by the next apply (OP-3).
      lastDispositionKind: null,
      claimOwner: `privileged-sweep:${ctx.deviceId}:${generation}`,
      claimGeneration: generation,
      submissionClaims: row.submissionClaims + 1,
      unresolvedClaimCount: wasClaimed ? row.unresolvedClaimCount + 1 : row.unresolvedClaimCount,
      deferredCycleCount: 0,
      updatedAtMs: ctx.nowMs,
      // RC-D2-003: claim-time relay/attempt provenance, local forensic
      // metadata only — never a signed evidence field. Atomic with the claim
      // CAS; never written on a failed/fenced claim.
      lastAttemptAtMs: ctx.nowMs,
      lastRelayCallerStaffId: ctx.staffId,
    };
    await txn.put(STORE_NAME, adjudicationId, claimed);
    return { kind: 'claimed', record: claimed };
  }).then((outcome) => {
    notifyPrivilegedEvidenceListeners(store);
    return outcome;
  });
}

// ─── OP-3 — disposition apply CAS ───────────────────────────────────────────

export type ApplyInput =
  | { kind: 'server'; response: OfflineAdjudicationResponse; disposition: OfflineAdjudicationDisposition }
  | { kind: 'transport_failure' }
  | { kind: 'local_submission_timeout' };

export interface ApplyContext {
  nowMs: number;
  staffId: string;
}

export type ApplyOutcome =
  | { kind: 'applied'; record: Row; dispositionKind: PrivilegedEvidenceDispositionKind }
  | { kind: 'fenced' };

type ApplyPatch = Partial<Row> & { dispositionKind: PrivilegedEvidenceDispositionKind };

/**
 * RC-D2-004: the disposition-carried subset of the Class III lifecycle
 * payload a retryable outcome may still validly persist. Defaults to all
 * null — the correct value whenever no `disposition` exists to consult
 * (transport failure / local timeout) — but is otherwise populated from the
 * canonical `disposition` itself, never hard-coded, so a genuinely
 * inconsistent synthetic disposition surfaces at the parser fence in
 * `applyPrivilegedEvidenceDisposition` rather than being silently nulled out
 * while still reporting `applied`.
 */
type RetryableCanonicalFields = Pick<Row, 'serverVerdict' | 'serverReason' | 'offlineExecutionId' | 'outcomeKind'>;

const NULL_RETRYABLE_CANONICAL_FIELDS: RetryableCanonicalFields = {
  serverVerdict: null,
  serverReason: null,
  offlineExecutionId: null,
  outcomeKind: null,
};

function retryableCanonicalFieldsFromDisposition(disposition: OfflineAdjudicationDisposition): RetryableCanonicalFields {
  return {
    serverVerdict: disposition.serverVerdict,
    serverReason: disposition.serverRejectionReason,
    offlineExecutionId: disposition.offlineExecutionId,
    outcomeKind: disposition.outcomeKind,
  };
}

function retryableApplyPatch(
  row: Row,
  dispositionKind: PrivilegedEvidenceDispositionKind,
  nowMs: number,
  lifecycle: { syncStatus: Row['syncStatus']; manualReviewStatus: Row['manualReviewStatus'] },
  canonical: RetryableCanonicalFields = NULL_RETRYABLE_CANONICAL_FIELDS,
): ApplyPatch {
  const nextRetryCount = row.retryableFailureCount + 1;
  if (nextRetryCount >= PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES) {
    // RC-D2-004: a local escalation to LOCAL_TERMINAL, but its Class III
    // fields still come from the supplied `canonical` payload, never
    // hard-coded to null. A real classifier retryable disposition's
    // canonical payload is already all-null, so this changes nothing for
    // production behavior — the row stays parser-valid and the ceiling
    // escalation still applies. A synthetic disposition carrying non-null
    // Class III fields is instead surfaced, unmutated, to the universal
    // parser-validity fence in `applyPrivilegedEvidenceDisposition`, which
    // rejects a LOCAL_TERMINAL row whose Class III fields aren't null rather
    // than silently discarding canonical data to force a write through.
    return {
      dispositionKind: 'LOCAL_TERMINAL',
      syncStatus: 'MANUAL_ATTENTION',
      manualReviewStatus: 'REQUIRED',
      localTerminalReason: 'attempt_ceiling_reached',
      retryableFailureCount: nextRetryCount,
      unresolvedClaimCount: 0,
      ...canonical,
      serverAdjudicationId: null,
      serverTargetOrderId: null,
      serverAdjudicatedAtMs: null,
      serverObservedAtMs: null,
      serverIdempotentReplay: null,
    };
  }
  return {
    dispositionKind,
    syncStatus: lifecycle.syncStatus,
    manualReviewStatus: lifecycle.manualReviewStatus,
    localTerminalReason: null,
    retryableFailureCount: nextRetryCount,
    unresolvedClaimCount: 0,
    nextAttemptAtMs: nowMs + computePrivilegedEvidenceBackoffDelayMs(nextRetryCount),
    ...canonical,
    serverAdjudicationId: null,
    serverTargetOrderId: null,
    serverAdjudicatedAtMs: null,
    serverObservedAtMs: null,
    serverIdempotentReplay: null,
  };
}

/** The retryable contract's own fixed lifecycle values — used only where no `disposition` exists to consult (transport failure / local timeout). */
const RETRYABLE_QUEUED_LIFECYCLE = { syncStatus: 'PRIVILEGED_INTENT_QUEUED', manualReviewStatus: 'NOT_REQUIRED' } as const;

type NonRetryableResponseFields = {
  serverAdjudicationId: string | null;
  serverTargetOrderId: string | null;
  serverAdjudicatedAtMs: number | null;
  serverObservedAtMs: number | null;
  serverIdempotentReplay: boolean | null;
};

/**
 * RC-D2-004: the response-only identifier bundle each response shape
 * actually carries, keyed by `response.kind` alone — never by what
 * `disposition` says. `ACCEPTED` / `REJECTED` / `MANUAL_ATTENTION_REQUIRED`
 * share one bundle (`adjudicationId`/`targetOrderId`/`serverAdjudicatedAtMs`/
 * `idempotent`); `ADJUDICATION_ANOMALY` swaps the timestamp for
 * `serverObservedAtMs`; `PROTOCOL_REJECTED` / `PROTOCOL_RETRYABLE` carry only
 * `serverObservedAtMs`; `RETRYABLE` carries neither. A deliberately
 * inconsistent (response, disposition) pair still only ever reads
 * response-only identifiers from this table — every lifecycle field comes
 * from `disposition` alone (see `computeApplyPatch`).
 */
function nonRetryableResponseFields(response: OfflineAdjudicationResponse): NonRetryableResponseFields {
  switch (response.kind) {
    case 'ACCEPTED':
    case 'REJECTED':
    case 'MANUAL_ATTENTION_REQUIRED':
      return {
        serverAdjudicationId: response.adjudicationId,
        serverTargetOrderId: response.targetOrderId,
        serverAdjudicatedAtMs: response.serverAdjudicatedAtMs,
        serverObservedAtMs: null,
        serverIdempotentReplay: response.idempotent,
      };
    case 'ADJUDICATION_ANOMALY':
      return {
        serverAdjudicationId: response.adjudicationId,
        serverTargetOrderId: response.targetOrderId,
        serverAdjudicatedAtMs: null,
        serverObservedAtMs: response.serverObservedAtMs,
        serverIdempotentReplay: null,
      };
    case 'PROTOCOL_REJECTED':
    case 'PROTOCOL_RETRYABLE':
      return {
        serverAdjudicationId: null,
        serverTargetOrderId: null,
        serverAdjudicatedAtMs: null,
        serverObservedAtMs: response.serverObservedAtMs,
        serverIdempotentReplay: null,
      };
    case 'RETRYABLE':
      return {
        serverAdjudicationId: null,
        serverTargetOrderId: null,
        serverAdjudicatedAtMs: null,
        serverObservedAtMs: null,
        serverIdempotentReplay: null,
      };
  }
}

/**
 * `OfflineAdjudicationDisposition.syncStatus` is typed against D-1A's full
 * 7-member vocabulary (it also carries the two LOCAL_AUTH_* pre-adjudication
 * statuses); `classifyOfflineAdjudicationResponse` only ever produces one of
 * D-2's 5 journal-legal statuses here. This narrows the type to match — it
 * asserts a classifier contract, not a value the row writer invents.
 */
function asJournalSyncStatus(status: OfflineAdjudicationDisposition['syncStatus']): Row['syncStatus'] {
  return status as Row['syncStatus'];
}

/**
 * RC-D2-004: `input.disposition` — the D-1B canonical classifier's output —
 * is the sole source for every lifecycle-policy field: retryable vs
 * terminal, `syncStatus`, `manualReviewStatus`, server verdict, reason
 * family, execution id, and outcome fields. `response` supplies ONLY
 * genuinely response-only data disposition does not carry: exact response
 * identifiers (`adjudicationId`/`targetOrderId`) and timestamps
 * (`nonRetryableResponseFields`). `disposition.syncStatus`, together with
 * which closed reason-family `disposition.serverRejectionReason` belongs to,
 * picks which of D-2's 12 local disposition-kind labels applies — `response`
 * is consulted only for the identifier bundle that label's parser matrix
 * requires, and only when the response shape in hand actually carries it. A
 * deliberately inconsistent (response, disposition) pair still yields every
 * lifecycle field from `disposition` alone; a `lastDispositionKind` is
 * chosen (or the row's own claimed disposition-kind labels intentionally
 * collapse, e.g. MANUAL_ATTENTION_REQUIRED / ADJUDICATION_ANOMALY /
 * PROTOCOL_REJECTED_PERMANENT all sharing `syncStatus: 'MANUAL_ATTENTION'`)
 * only once the identifiers that specific label's parser matrix requires are
 * actually present — never a value invented from `response`. When no label
 * fits, `null` signals the caller to fail closed rather than persist a row
 * `parsePrivilegedEvidenceJournalRecordV1` would reject.
 */
function computeApplyPatch(row: Row, input: ApplyInput, ctx: ApplyContext): ApplyPatch | null {
  if (input.kind === 'transport_failure') {
    return retryableApplyPatch(row, 'TRANSPORT_FAILURE', ctx.nowMs, RETRYABLE_QUEUED_LIFECYCLE);
  }
  if (input.kind === 'local_submission_timeout') {
    return retryableApplyPatch(row, 'LOCAL_SUBMISSION_TIMEOUT', ctx.nowMs, RETRYABLE_QUEUED_LIFECYCLE);
  }

  const { response, disposition } = input;

  if (!disposition.retryable) {
    const basePolicy = {
      syncStatus: asJournalSyncStatus(disposition.syncStatus),
      manualReviewStatus: disposition.manualReviewStatus,
      localTerminalReason: null,
      unresolvedClaimCount: 0,
      serverVerdict: disposition.serverVerdict,
      serverReason: disposition.serverRejectionReason,
      offlineExecutionId: disposition.offlineExecutionId,
      outcomeKind: disposition.outcomeKind,
    } as const;
    const fields = nonRetryableResponseFields(response);
    const reason = disposition.serverRejectionReason;

    if (
      disposition.syncStatus === 'SERVER_ACCEPTED' &&
      fields.serverAdjudicationId !== null &&
      fields.serverTargetOrderId !== null &&
      fields.serverAdjudicatedAtMs !== null &&
      fields.serverIdempotentReplay !== null
    ) {
      return {
        dispositionKind: 'ACCEPTED',
        ...basePolicy,
        serverAdjudicationId: fields.serverAdjudicationId,
        serverTargetOrderId: fields.serverTargetOrderId,
        serverAdjudicatedAtMs: fields.serverAdjudicatedAtMs,
        serverObservedAtMs: null,
        serverIdempotentReplay: fields.serverIdempotentReplay,
      };
    }

    if (
      disposition.syncStatus === 'SERVER_REJECTED' &&
      typeof reason === 'string' &&
      isOfflineAdjudicationRejectionReason(reason) &&
      fields.serverAdjudicationId !== null &&
      fields.serverTargetOrderId !== null &&
      fields.serverAdjudicatedAtMs !== null &&
      fields.serverIdempotentReplay !== null
    ) {
      return {
        dispositionKind: 'REJECTED',
        ...basePolicy,
        serverAdjudicationId: fields.serverAdjudicationId,
        serverTargetOrderId: fields.serverTargetOrderId,
        serverAdjudicatedAtMs: fields.serverAdjudicatedAtMs,
        serverObservedAtMs: null,
        serverIdempotentReplay: fields.serverIdempotentReplay,
      };
    }

    if (disposition.syncStatus === 'MANUAL_ATTENTION') {
      if (
        typeof reason === 'string' &&
        isOfflineAdjudicationManualAttentionReason(reason) &&
        fields.serverAdjudicationId !== null &&
        fields.serverTargetOrderId !== null &&
        fields.serverAdjudicatedAtMs !== null &&
        fields.serverIdempotentReplay !== null
      ) {
        return {
          dispositionKind: 'MANUAL_ATTENTION_REQUIRED',
          ...basePolicy,
          serverAdjudicationId: fields.serverAdjudicationId,
          serverTargetOrderId: fields.serverTargetOrderId,
          serverAdjudicatedAtMs: fields.serverAdjudicatedAtMs,
          serverObservedAtMs: null,
          serverIdempotentReplay: fields.serverIdempotentReplay,
        };
      }
      if (
        typeof reason === 'string' &&
        isOfflineAdjudicationAnomalyReason(reason) &&
        fields.serverAdjudicationId !== null &&
        fields.serverTargetOrderId !== null &&
        fields.serverObservedAtMs !== null
      ) {
        return {
          dispositionKind: 'ADJUDICATION_ANOMALY',
          ...basePolicy,
          serverAdjudicationId: fields.serverAdjudicationId,
          serverTargetOrderId: fields.serverTargetOrderId,
          serverAdjudicatedAtMs: null,
          serverObservedAtMs: fields.serverObservedAtMs,
          serverIdempotentReplay: null,
        };
      }
      if (
        typeof reason === 'string' &&
        (OFFLINE_ADJUDICATION_PERMANENT_BYTE_REASONS as readonly string[]).includes(reason) &&
        fields.serverObservedAtMs !== null
      ) {
        return {
          dispositionKind: 'PROTOCOL_REJECTED_PERMANENT',
          ...basePolicy,
          serverAdjudicationId: null,
          serverTargetOrderId: null,
          serverAdjudicatedAtMs: null,
          serverObservedAtMs: fields.serverObservedAtMs,
          serverIdempotentReplay: null,
        };
      }
    }

    // No label's parser matrix can be satisfied by what `response` actually
    // carries: fail closed (section 9) rather than persist an invalid row.
    return null;
  }

  // disposition.retryable === true. The counter/backoff mechanics
  // (retryableApplyPatch) are D-2-local scheduling policy, not part of the
  // canonical disposition's field set; `disposition.syncStatus` /
  // `manualReviewStatus` are consumed rather than duplicated as constants,
  // even though the real classifier always sets them to the same
  // PRIVILEGED_INTENT_QUEUED / NOT_REQUIRED pair for every retryable case.
  const retryableLifecycle = {
    syncStatus: asJournalSyncStatus(disposition.syncStatus),
    manualReviewStatus: disposition.manualReviewStatus,
  };
  // RC-D2-004: the complete disposition-carried Class III payload, consumed
  // (never hard-coded) for every retryable outcome below. `response.kind` /
  // `response.recoverability` select only the local label/scheduling/counter
  // behavior that follows; the lifecycle payload itself is identical for a
  // given `disposition` regardless of which retryable path it takes. The
  // final parser-validity fence in `applyPrivilegedEvidenceDisposition`
  // fails the write closed if a synthetic/inconsistent disposition makes
  // this payload incompatible with the selected disposition kind's matrix.
  const retryableCanonical = retryableCanonicalFieldsFromDisposition(disposition);
  switch (response.kind) {
    case 'RETRYABLE':
      return retryableApplyPatch(row, 'RETRYABLE', ctx.nowMs, retryableLifecycle, retryableCanonical);
    case 'PROTOCOL_RETRYABLE':
      return retryableApplyPatch(row, 'PROTOCOL_RETRYABLE', ctx.nowMs, retryableLifecycle, retryableCanonical);
    case 'PROTOCOL_REJECTED':
      // D-1B's disposition does not distinguish CALLER_DEPENDENT from
      // STATE_DEPENDENT (both classify simply as retryable) — D-2's local
      // relay-scheduling split reads `response.recoverability` for this,
      // never to decide retryable-vs-terminal (that came from `disposition`
      // above), and never to change the lifecycle payload itself.
      if (response.recoverability === 'CALLER_DEPENDENT') {
        return {
          dispositionKind: 'PROTOCOL_REJECTED_CALLER_DEPENDENT',
          syncStatus: asJournalSyncStatus(disposition.syncStatus),
          manualReviewStatus: disposition.manualReviewStatus,
          localTerminalReason: null,
          unresolvedClaimCount: 0,
          relayDeferrals: row.relayDeferrals + 1,
          lastCallerDependentStaffId: ctx.staffId,
          nextAttemptAtMs: ctx.nowMs,
          ...retryableCanonical,
          serverAdjudicationId: null,
          serverTargetOrderId: null,
          serverAdjudicatedAtMs: null,
          serverObservedAtMs: null,
          serverIdempotentReplay: null,
        };
      }
      return retryableApplyPatch(row, 'PROTOCOL_REJECTED_STATE_DEPENDENT', ctx.nowMs, retryableLifecycle, retryableCanonical);
    default:
      // A retryable disposition paired with a non-retryable-shaped response
      // is an inconsistent test pair; canonical disposition still wins.
      return retryableApplyPatch(row, 'RETRYABLE', ctx.nowMs, retryableLifecycle, retryableCanonical);
  }
}

/** OP-3. Fences on `syncStatus === 'SYNCING' AND claimGeneration === generation` — the same predicate for every outcome kind. */
export async function applyPrivilegedEvidenceDisposition(
  store: ReversalLocalStore,
  adjudicationId: string,
  generation: number,
  input: ApplyInput,
  ctx: ApplyContext,
): Promise<ApplyOutcome> {
  return store.transact([STORE_NAME], 'readwrite', async (txn): Promise<ApplyOutcome> => {
    const raw = await txn.get<unknown>(STORE_NAME, adjudicationId);
    const row = parsePrivilegedEvidenceJournalRecordV1(raw);
    if (!row) return { kind: 'fenced' };
    if (row.syncStatus !== 'SYNCING' || row.claimGeneration !== generation) return { kind: 'fenced' };

    const computed = computeApplyPatch(row, input, ctx);
    // RC-D2-004: no disposition-kind label's parser matrix could be
    // satisfied by what `response` actually carries — never persist a row
    // `parsePrivilegedEvidenceJournalRecordV1` would reject. The row stays
    // claimed under this generation; a later sweep generation's fencing
    // check re-admits it for a fresh attempt.
    if (computed === null) return { kind: 'fenced' };

    const { dispositionKind, ...patch } = computed;
    const next: Row = {
      ...row,
      ...patch,
      claimOwner: null,
      claimGeneration: null,
      lastAttemptAtMs: ctx.nowMs,
      updatedAtMs: ctx.nowMs,
      lastDispositionKind: dispositionKind,
    };

    // RC-D2-004: a universal write-side safety fence, not a second
    // classifier. `computeApplyPatch` now faithfully consumes whatever
    // `disposition` actually carries rather than hard-coding it away, so a
    // synthetic/inconsistent (response, disposition) pair can still
    // construct a row no disposition-kind's parser matrix admits. Such a row
    // must never be persisted, and must never be reported `applied` — fence
    // it exactly like `computed === null` above, without mutating `next` to
    // "make it parse".
    if (parsePrivilegedEvidenceJournalRecordV1(next) === null) return { kind: 'fenced' };

    await txn.put(STORE_NAME, adjudicationId, next);
    return { kind: 'applied', record: next, dispositionKind };
  }).then((outcome) => {
    notifyPrivilegedEvidenceListeners(store);
    return outcome;
  });
}

// ─── OP-4 — deferred-counter batch write ───────────────────────────────────

/** Not attempted at all on a durable-operation deadline (§3.5). */
export async function applyPrivilegedEvidenceDeferredCycleCounts(
  store: ReversalLocalStore,
  adjudicationIds: readonly string[],
): Promise<void> {
  if (adjudicationIds.length === 0) return;
  await store.transact([STORE_NAME], 'readwrite', async (txn) => {
    for (const id of adjudicationIds) {
      const raw = await txn.get<unknown>(STORE_NAME, id);
      const row = parsePrivilegedEvidenceJournalRecordV1(raw);
      if (!row) continue;
      await txn.put(STORE_NAME, id, { ...row, deferredCycleCount: row.deferredCycleCount + 1 });
    }
  });
  notifyPrivilegedEvidenceListeners(store);
}

// ─── Backoff clear (global_eligibility_reset sibling) ──────────────────────

export async function clearPrivilegedEvidenceBackoff(store: ReversalLocalStore, nowMs: number): Promise<void> {
  await store.transact([STORE_NAME], 'readwrite', async (txn) => {
    const keys = await requireGetAllKeys(txn);
    for (const key of keys) {
      if (RESERVED_KEY_SET.has(key)) continue;
      const raw = await txn.get<unknown>(STORE_NAME, key);
      const row = parsePrivilegedEvidenceJournalRecordV1(raw);
      if (!row) continue;
      if (isPrivilegedEvidenceTerminalStatus(row.syncStatus)) continue;
      if (row.retryableFailureCount >= PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES) continue;
      if (row.nextAttemptAtMs === 0) continue;
      await txn.put(STORE_NAME, key, { ...row, nextAttemptAtMs: 0, updatedAtMs: nowMs });
    }
  });
  notifyPrivilegedEvidenceListeners(store);
}

// ─── D-3 read contract ──────────────────────────────────────────────────────

export async function listPrivilegedEvidence(store: ReversalLocalStore): Promise<Row[]> {
  return store.transact([STORE_NAME], 'readonly', async (txn) => (await enumerateRows(txn)).rows);
}

export async function listPrivilegedEvidenceForBranch(
  store: ReversalLocalStore,
  branchId: string,
): Promise<{ rows: Row[]; unreadableCount: number }> {
  return store.transact([STORE_NAME], 'readonly', async (txn) => {
    const { rows, unreadableCount } = await enumerateRows(txn);
    return { rows: rows.filter((r) => r.branchId === branchId), unreadableCount };
  });
}

const listeners = new Set<(rows: Row[]) => void>();

/** Same-tab only, mirroring `subscribeVoidIntentStore`. */
export function subscribePrivilegedEvidenceStore(listener: (rows: Row[]) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyPrivilegedEvidenceListeners(store: ReversalLocalStore): void {
  if (listeners.size === 0) return;
  void listPrivilegedEvidence(store).then((rows) => {
    for (const fn of listeners) fn(rows);
  });
}

/** @internal test-only */
export function __resetPrivilegedEvidenceListenersForTests(): void {
  listeners.clear();
}
