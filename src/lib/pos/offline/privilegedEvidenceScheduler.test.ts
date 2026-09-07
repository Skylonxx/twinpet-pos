import { describe, expect, it } from 'vitest';
import {
  comparePrivilegedEvidenceRows,
  computePrivilegedEvidenceBackoffDelayMs,
  isPrivilegedEvidenceRowAdmissible,
  sanitizeNextAttemptAtMs,
  selectAdmittedPrivilegedEvidenceRows,
} from './privilegedEvidenceScheduler';
import {
  PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES,
  PRIVILEGED_EVIDENCE_PER_CYCLE_CAP,
  PRIVILEGED_EVIDENCE_S_MAX,
  type PrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';

function row(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: 'a'.repeat(32),
    localIntentId: 'i1',
    paa1Base64: 'p',
    ssa1Base64: 's',
    oacEnvelopeBytesBase64: 'o',
    evidenceBindingDigest: 'd',
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
    nonce: 'n',
    approvalProofDigest: 'pf',
    attestationAttemptCount: 1,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: 1,
    trustedApprovalUpperMs: 2,
    pendingExecutionExpiresAtMs: 100,
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
    createdAtMs: 0,
    updatedAtMs: 0,
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

const baseInput = { branchId: 'LDP-001', staffId: 'staff-1', nowMs: 1_000, sweepGeneration: 5 };

describe('isPrivilegedEvidenceRowAdmissible — 7 rules', () => {
  it('admits an eligible queued row', () => {
    expect(isPrivilegedEvidenceRowAdmissible(row({ nextAttemptAtMs: 0 }), baseInput)).toBe(true);
  });

  it('rule 2: integrityConflict excludes the row', () => {
    expect(isPrivilegedEvidenceRowAdmissible(row({ integrityConflict: true }), baseInput)).toBe(false);
  });

  it('rule 3: a non-reclaimable SYNCING row is excluded; a reclaimable one is admitted', () => {
    const held = row({ syncStatus: 'SYNCING', claimGeneration: 5 });
    expect(isPrivilegedEvidenceRowAdmissible(held, baseInput)).toBe(false); // same generation, F1 does not hold
    const stale = row({ syncStatus: 'SYNCING', claimGeneration: 3 });
    expect(isPrivilegedEvidenceRowAdmissible(stale, { ...baseInput, sweepGeneration: 5 })).toBe(true); // 5 > 3
  });

  it('rule 4: retryableFailureCount at the ceiling is never admitted, even with S_MAX satisfied', () => {
    const r = row({ retryableFailureCount: PRIVILEGED_EVIDENCE_MAX_RETRYABLE_FAILURES, deferredCycleCount: 999 });
    expect(isPrivilegedEvidenceRowAdmissible(r, baseInput)).toBe(false);
  });

  it('rule 5: branch scoping — never drained cross-branch', () => {
    expect(isPrivilegedEvidenceRowAdmissible(row({ branchId: 'OTHER' }), baseInput)).toBe(false);
  });

  it('rule 6: relay suppression excludes the same staff, admits a different staff', () => {
    const suppressed = row({ lastCallerDependentStaffId: 'staff-1' });
    expect(isPrivilegedEvidenceRowAdmissible(suppressed, baseInput)).toBe(false);
    expect(isPrivilegedEvidenceRowAdmissible(suppressed, { ...baseInput, staffId: 'staff-2' })).toBe(true);
  });

  it('rule 7: nextAttemptAtMs in the future excludes the row until due', () => {
    expect(isPrivilegedEvidenceRowAdmissible(row({ nextAttemptAtMs: 5_000 }), baseInput)).toBe(false);
    expect(isPrivilegedEvidenceRowAdmissible(row({ nextAttemptAtMs: 500 }), baseInput)).toBe(true);
  });

  it('S_MAX force-admission overrides both relay suppression (6) and backoff (7)', () => {
    const suppressedAndBackedOff = row({
      lastCallerDependentStaffId: 'staff-1',
      nextAttemptAtMs: Number.POSITIVE_INFINITY,
      deferredCycleCount: PRIVILEGED_EVIDENCE_S_MAX,
    });
    expect(isPrivilegedEvidenceRowAdmissible(suppressedAndBackedOff, baseInput)).toBe(true);
  });

  it('malformed nextAttemptAtMs (NaN/+Infinity/negative) reads as 0 and cannot withhold indefinitely without S_MAX', () => {
    expect(sanitizeNextAttemptAtMs(NaN)).toBe(0);
    expect(sanitizeNextAttemptAtMs(Infinity)).toBe(0);
    expect(sanitizeNextAttemptAtMs(-1)).toBe(0);
    expect(isPrivilegedEvidenceRowAdmissible(row({ nextAttemptAtMs: NaN }), baseInput)).toBe(true);
  });
});

describe('comparePrivilegedEvidenceRows — deterministic total order', () => {
  it('orders by deferredCycleCount desc, retryableFailureCount asc, createdAtMs asc, adjudicationId asc', () => {
    const rows = [
      row({ adjudicationId: 'b'.repeat(32), deferredCycleCount: 1, retryableFailureCount: 0, createdAtMs: 5 }),
      row({ adjudicationId: 'a'.repeat(32), deferredCycleCount: 2, retryableFailureCount: 0, createdAtMs: 1 }),
      row({ adjudicationId: 'c'.repeat(32), deferredCycleCount: 2, retryableFailureCount: 1, createdAtMs: 1 }),
    ];
    const sorted = [...rows].sort(comparePrivilegedEvidenceRows);
    expect(sorted.map((r) => r.adjudicationId)).toEqual(['a'.repeat(32), 'c'.repeat(32), 'b'.repeat(32)]);
  });

  it('stays total and deterministic when every clock-derived field is garbage', () => {
    const rows = [
      row({ adjudicationId: 'b'.repeat(32), createdAtMs: NaN }),
      row({ adjudicationId: 'a'.repeat(32), createdAtMs: NaN }),
    ];
    const sorted = [...rows].sort(comparePrivilegedEvidenceRows);
    expect(sorted.map((r) => r.adjudicationId)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });
});

describe('selectAdmittedPrivilegedEvidenceRows', () => {
  it('caps admission at PRIVILEGED_EVIDENCE_PER_CYCLE_CAP and withholds the rest', () => {
    const rows = Array.from({ length: PRIVILEGED_EVIDENCE_PER_CYCLE_CAP + 5 }, (_, i) =>
      row({ adjudicationId: i.toString(16).padStart(32, '0') }),
    );
    const { admitted, withheld } = selectAdmittedPrivilegedEvidenceRows(rows, baseInput);
    expect(admitted).toHaveLength(PRIVILEGED_EVIDENCE_PER_CYCLE_CAP);
    expect(withheld).toHaveLength(5);
  });

  it('a newly ingested row (deferredCycleCount 0) cannot preempt an aging withheld row', () => {
    const aging = row({ adjudicationId: 'a'.repeat(32), deferredCycleCount: 3, nextAttemptAtMs: 0 });
    const fresh = row({ adjudicationId: 'b'.repeat(32), deferredCycleCount: 0, nextAttemptAtMs: 0 });
    const { admitted } = selectAdmittedPrivilegedEvidenceRows([fresh, aging], baseInput);
    expect(admitted.map((r) => r.adjudicationId)).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });

  it('terminal rows are never counted as withheld', () => {
    const terminal = row({ syncStatus: 'SERVER_ACCEPTED', lastDispositionKind: 'ACCEPTED' });
    const { withheld } = selectAdmittedPrivilegedEvidenceRows([terminal], baseInput);
    expect(withheld).toHaveLength(0);
  });
});

describe('computePrivilegedEvidenceBackoffDelayMs', () => {
  it('follows the documented exponential-with-cap schedule pre-jitter', () => {
    expect(computePrivilegedEvidenceBackoffDelayMs(1, () => 0.5)).toBe(5_000);
    expect(computePrivilegedEvidenceBackoffDelayMs(2, () => 0.5)).toBe(10_000);
    expect(computePrivilegedEvidenceBackoffDelayMs(7, () => 0.5)).toBe(300_000);
    expect(computePrivilegedEvidenceBackoffDelayMs(8, () => 0.5)).toBe(300_000);
  });

  it('keeps jitter within +/-20%', () => {
    const pre = 20_000;
    expect(computePrivilegedEvidenceBackoffDelayMs(3, () => 0)).toBe(Math.round(pre * 0.8));
    expect(computePrivilegedEvidenceBackoffDelayMs(3, () => 1)).toBe(Math.round(pre * 1.2));
  });
});
