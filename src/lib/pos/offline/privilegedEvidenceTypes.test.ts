import { describe, expect, it } from 'vitest';
import {
  PRIVILEGED_EVIDENCE_DISPOSITION_KINDS,
  PRIVILEGED_EVIDENCE_JOURNAL_RECORD_KEY_COUNT,
  PRIVILEGED_EVIDENCE_LOCAL_TERMINAL_REASONS,
  isLegalPrivilegedEvidenceTransition,
  isPrivilegedEvidenceClaimFenced,
  parsePrivilegedEvidenceJournalRecordV1,
  type PrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';

function validRecord(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: 'a'.repeat(32),
    localIntentId: 'intent-1',
    paa1Base64: 'PAA1BYTES',
    ssa1Base64: 'SSA1BYTES',
    oacEnvelopeBytesBase64: 'OACBYTES',
    evidenceBindingDigest: 'digest-1',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    branchId: 'LDP-001',
    approvingManagerStaffId: 'mgr-1',
    oacId: 'oac-1',
    oacSchemaVersion: 1,
    revocationEpochAtIssue: 0,
    managerAuthVersionAtIssue: 0,
    managerCredentialVersionAtIssue: 0,
    nonce: 'nonce-1',
    approvalProofDigest: 'proof-1',
    attestationAttemptCount: 1,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    syncStatus: 'PRIVILEGED_INTENT_QUEUED',
    manualReviewStatus: 'NOT_REQUIRED',
    localTerminalReason: null,
    submissionClaims: 0,
    unresolvedClaimCount: 0,
    retryableFailureCount: 0,
    relayDeferrals: 0,
    deferredCycleCount: 0,
    nextAttemptAtMs: 0,
    claimOwner: null,
    claimGeneration: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    lastAttemptAtMs: null,
    lastDispositionKind: null,
    lastRelayCallerStaffId: null,
    lastCallerDependentStaffId: null,
    integrityConflict: false,
    ingestStaffId: 'staff-1',
    ingestDeviceId: 'device-1',
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
    ...over,
  };
}

describe('privilegedEvidenceTypes — cardinalities', () => {
  it('54-key schema, 12 disposition kinds, 4 local terminal reasons', () => {
    expect(PRIVILEGED_EVIDENCE_JOURNAL_RECORD_KEY_COUNT).toBe(54);
    expect(PRIVILEGED_EVIDENCE_DISPOSITION_KINDS).toHaveLength(12);
    expect(PRIVILEGED_EVIDENCE_LOCAL_TERMINAL_REASONS).toHaveLength(4);
  });
});

describe('parsePrivilegedEvidenceJournalRecordV1 — schema shape', () => {
  it('accepts a valid queued record round-trip with byte-exact fields', () => {
    const rec = validRecord();
    const parsed = parsePrivilegedEvidenceJournalRecordV1(rec);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(rec);
    expect(parsed!.paa1Base64).toBe(rec.paa1Base64);
  });

  it('rejects a record with an unknown extra key', () => {
    const raw = { ...validRecord(), extraKey: 'x' };
    expect(parsePrivilegedEvidenceJournalRecordV1(raw)).toBeNull();
  });

  it('rejects a record missing a required key', () => {
    const raw = validRecord() as unknown as Record<string, unknown>;
    delete raw.serverReason;
    expect(parsePrivilegedEvidenceJournalRecordV1(raw)).toBeNull();
  });

  it('rejects wrong schemaVersion', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ schemaVersion: 2 as 1 }))).toBeNull();
  });

  it('rejects a zero adjudicationId and a non-hex adjudicationId', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ adjudicationId: '0'.repeat(32) }))).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ adjudicationId: 'Z'.repeat(32) }))).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ adjudicationId: 'a'.repeat(31) }))).toBeNull();
  });

  it('rejects branchId === ALL', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ branchId: 'ALL' }))).toBeNull();
  });

  it('rejects approvalResult other than APPROVED_LOCAL', () => {
    expect(
      parsePrivilegedEvidenceJournalRecordV1(validRecord({ approvalResult: 'DENIED_STALE' as 'APPROVED_LOCAL' })),
    ).toBeNull();
  });

  it('rejects trustedApprovalUpperMs < trustedApprovalLowerMs', () => {
    expect(
      parsePrivilegedEvidenceJournalRecordV1(validRecord({ trustedApprovalLowerMs: 5_000, trustedApprovalUpperMs: 1_000 })),
    ).toBeNull();
  });

  it('rejects retryableFailureCount above the ceiling', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ retryableFailureCount: 9 }))).toBeNull();
  });

  it('rejects negative or non-integer counters', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ submissionClaims: -1 }))).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ deferredCycleCount: 1.5 }))).toBeNull();
  });

  it('accepts NaN / +Infinity / negative nextAttemptAtMs at the parser (scheduler sanitizes at read)', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ nextAttemptAtMs: NaN }))).not.toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ nextAttemptAtMs: Infinity }))).not.toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ nextAttemptAtMs: -5 }))).not.toBeNull();
  });

  it('claim-field totality: SYNCING requires both claimOwner and claimGeneration non-null', () => {
    expect(
      parsePrivilegedEvidenceJournalRecordV1(
        validRecord({ syncStatus: 'SYNCING', claimOwner: 'o', claimGeneration: null }),
      ),
    ).toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1(
        validRecord({ syncStatus: 'SYNCING', claimOwner: null, claimGeneration: 1 }),
      ),
    ).toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1(validRecord({ syncStatus: 'PRIVILEGED_INTENT_QUEUED', claimOwner: 'o', claimGeneration: 1 })),
    ).toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1(validRecord({ syncStatus: 'SYNCING', claimOwner: 'o', claimGeneration: 3 })),
    ).not.toBeNull();
  });

  it('resultingVoidIntentId must be exactly null', () => {
    expect(
      parsePrivilegedEvidenceJournalRecordV1(validRecord({ resultingVoidIntentId: 'x' as unknown as null })),
    ).toBeNull();
  });

  it('conservation invariant: submissionClaims >= retryableFailureCount + relayDeferrals + unresolvedClaimCount', () => {
    expect(
      parsePrivilegedEvidenceJournalRecordV1(
        validRecord({ submissionClaims: 1, retryableFailureCount: 0, relayDeferrals: 0, unresolvedClaimCount: 2 }),
      ),
    ).toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1(
        validRecord({ submissionClaims: 3, retryableFailureCount: 1, relayDeferrals: 1, unresolvedClaimCount: 1 }),
      ),
    ).not.toBeNull();
  });
});

describe('parsePrivilegedEvidenceJournalRecordV1 — per-disposition-kind field matrix', () => {
  it('ACCEPTED requires the exact non-null/null field set', () => {
    const rec = validRecord({
      syncStatus: 'SERVER_ACCEPTED',
      lastDispositionKind: 'ACCEPTED',
      serverVerdict: 'ACCEPTED',
      serverAdjudicationId: 'adj-1',
      serverTargetOrderId: 'order-1',
      offlineExecutionId: 'exec-1',
      outcomeKind: 'VOID_APPLIED',
      serverAdjudicatedAtMs: 5_000,
      serverIdempotentReplay: false,
    });
    expect(parsePrivilegedEvidenceJournalRecordV1(rec)).not.toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, serverReason: 'x' })).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, offlineExecutionId: null })).toBeNull();
    // Everything else about the row stays valid for the accepted family, so
    // the rejection is attributable to the manual-review invariant alone.
    // `classifyOfflineAdjudicationResponse` emits SERVER_ACCEPTED only with
    // 'NOT_REQUIRED'; the other two vocabulary members invert the signal.
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, manualReviewStatus: 'REQUIRED' })).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, manualReviewStatus: 'RESOLVED' })).toBeNull();
  });

  it('REJECTED requires a valid rejection reason and rejects a wrong-family reason', () => {
    const rec = validRecord({
      syncStatus: 'SERVER_REJECTED',
      manualReviewStatus: 'REQUIRED',
      lastDispositionKind: 'REJECTED',
      serverVerdict: 'REJECTED',
      serverReason: 'target_already_voided',
      serverAdjudicationId: 'adj-1',
      serverTargetOrderId: 'order-1',
      serverAdjudicatedAtMs: 5_000,
      serverIdempotentReplay: false,
    });
    expect(parsePrivilegedEvidenceJournalRecordV1(rec)).not.toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1({ ...rec, serverReason: 'canonical_correlation_missing' }),
    ).toBeNull(); // manual-attention family, not rejection family
    // Same attribution argument as the ACCEPTED case above: the classifier
    // emits SERVER_REJECTED only with 'REQUIRED' — the void did not happen, so
    // a human must reconcile the bill.
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, manualReviewStatus: 'NOT_REQUIRED' })).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, manualReviewStatus: 'RESOLVED' })).toBeNull();
  });

  it('ADJUDICATION_ANOMALY writes serverObservedAtMs and never serverAdjudicatedAtMs or a verdict', () => {
    const rec = validRecord({
      syncStatus: 'MANUAL_ATTENTION',
      manualReviewStatus: 'REQUIRED',
      lastDispositionKind: 'ADJUDICATION_ANOMALY',
      serverReason: 'adjudication_record_unreadable',
      serverAdjudicationId: 'adj-1',
      serverTargetOrderId: 'order-1',
      serverObservedAtMs: 5_000,
    });
    expect(parsePrivilegedEvidenceJournalRecordV1(rec)).not.toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1({ ...rec, serverAdjudicatedAtMs: 1, serverObservedAtMs: null }),
    ).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, serverVerdict: 'ACCEPTED' })).toBeNull();
  });

  it('PROTOCOL_REJECTED_PERMANENT carries no adjudicationId/targetOrderId', () => {
    const rec = validRecord({
      syncStatus: 'MANUAL_ATTENTION',
      manualReviewStatus: 'REQUIRED',
      lastDispositionKind: 'PROTOCOL_REJECTED_PERMANENT',
      serverReason: 'attestation_malformed',
      serverObservedAtMs: 5_000,
    });
    expect(parsePrivilegedEvidenceJournalRecordV1(rec)).not.toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, serverAdjudicationId: 'adj-1' })).toBeNull();
  });

  it('retryable/queued kinds require every server field null and manualReviewStatus NOT_REQUIRED', () => {
    for (const kind of [
      'PROTOCOL_REJECTED_STATE_DEPENDENT',
      'PROTOCOL_REJECTED_CALLER_DEPENDENT',
      'RETRYABLE',
      'PROTOCOL_RETRYABLE',
      'TRANSPORT_FAILURE',
      'LOCAL_SUBMISSION_TIMEOUT',
    ] as const) {
      const rec = validRecord({ syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: kind });
      expect(parsePrivilegedEvidenceJournalRecordV1(rec)).not.toBeNull();
      expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, serverVerdict: 'ACCEPTED' })).toBeNull();
      // Everything else about the row stays valid for the queued family, so
      // the rejection is attributable to the manual-review invariant alone.
      expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, manualReviewStatus: 'RESOLVED' })).toBeNull();
      expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, manualReviewStatus: 'REQUIRED' })).toBeNull();
    }
  });

  it('LOCAL_TERMINAL requires a local terminal reason and MANUAL_ATTENTION', () => {
    const rec = validRecord({
      syncStatus: 'MANUAL_ATTENTION',
      manualReviewStatus: 'REQUIRED',
      lastDispositionKind: 'LOCAL_TERMINAL',
      localTerminalReason: 'attempt_ceiling_reached',
    });
    expect(parsePrivilegedEvidenceJournalRecordV1(rec)).not.toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1({ ...rec, localTerminalReason: null })).toBeNull();
  });

  it('localTerminalReason non-null iff lastDispositionKind === LOCAL_TERMINAL', () => {
    expect(
      parsePrivilegedEvidenceJournalRecordV1(
        validRecord({ localTerminalReason: 'attempt_ceiling_reached', lastDispositionKind: null }),
      ),
    ).toBeNull();
  });

  it('serverVerdict may only be non-null under ACCEPTED / REJECTED', () => {
    const rec = validRecord({
      syncStatus: 'MANUAL_ATTENTION',
      manualReviewStatus: 'REQUIRED',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      serverReason: 'canonical_correlation_missing',
      serverAdjudicationId: 'adj-1',
      serverTargetOrderId: 'order-1',
      serverAdjudicatedAtMs: 5_000,
      serverIdempotentReplay: false,
      serverVerdict: 'ACCEPTED',
    });
    expect(parsePrivilegedEvidenceJournalRecordV1(rec)).toBeNull();
  });

  it('no disposition ever applied requires queued/syncing and every server + local-terminal field null', () => {
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord())).not.toBeNull();
    expect(
      parsePrivilegedEvidenceJournalRecordV1(validRecord({ syncStatus: 'SERVER_ACCEPTED', lastDispositionKind: null })),
    ).toBeNull();
    // The manual-review invariant is keyed on syncStatus, so it also reaches a
    // queued row no disposition has been applied to yet.
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ manualReviewStatus: 'RESOLVED' }))).toBeNull();
    expect(parsePrivilegedEvidenceJournalRecordV1(validRecord({ manualReviewStatus: 'REQUIRED' }))).toBeNull();
  });
});

describe('isLegalPrivilegedEvidenceTransition', () => {
  it('accepts exactly the closed transition set', () => {
    expect(isLegalPrivilegedEvidenceTransition(null, 'PRIVILEGED_INTENT_QUEUED')).toBe(true);
    expect(isLegalPrivilegedEvidenceTransition('PRIVILEGED_INTENT_QUEUED', 'SYNCING')).toBe(true);
    expect(isLegalPrivilegedEvidenceTransition('SYNCING', 'SERVER_ACCEPTED')).toBe(true);
    expect(isLegalPrivilegedEvidenceTransition('SYNCING', 'SERVER_REJECTED')).toBe(true);
    expect(isLegalPrivilegedEvidenceTransition('SYNCING', 'MANUAL_ATTENTION')).toBe(true);
    expect(isLegalPrivilegedEvidenceTransition('PRIVILEGED_INTENT_QUEUED', 'MANUAL_ATTENTION')).toBe(true);
  });

  it('rejects transitions out of any terminal state', () => {
    expect(isLegalPrivilegedEvidenceTransition('SERVER_ACCEPTED', 'PRIVILEGED_INTENT_QUEUED')).toBe(false);
    expect(isLegalPrivilegedEvidenceTransition('SERVER_REJECTED', 'SYNCING')).toBe(false);
    expect(isLegalPrivilegedEvidenceTransition('MANUAL_ATTENTION', 'PRIVILEGED_INTENT_QUEUED')).toBe(false);
  });
});

describe('isPrivilegedEvidenceClaimFenced (F1)', () => {
  it('a null claimGeneration is always fenced-open (reclaimable)', () => {
    expect(isPrivilegedEvidenceClaimFenced(null, 1)).toBe(true);
  });

  it('reclaimable iff the current sweep generation is strictly greater', () => {
    expect(isPrivilegedEvidenceClaimFenced(5, 6)).toBe(true);
    expect(isPrivilegedEvidenceClaimFenced(5, 5)).toBe(false);
    expect(isPrivilegedEvidenceClaimFenced(5, 4)).toBe(false);
  });

  it('has no owner term and no clock term — pure integer comparison', () => {
    // Same inputs -> same output regardless of any external state.
    for (let i = 0; i < 5; i += 1) {
      expect(isPrivilegedEvidenceClaimFenced(10, 11)).toBe(true);
    }
  });
});
