import { describe, expect, it } from 'vitest';
import {
  SYNC_CENTER_PRIVILEGED_STATUS_CLASSES,
  projectPrivilegedEvidenceForSyncCenter,
  type SyncCenterPrivilegedStatusClass,
} from './syncCenterPrivilegedProjection';
import type {
  PrivilegedEvidenceD2SyncStatus,
  PrivilegedEvidenceDispositionKind,
  PrivilegedEvidenceJournalRecordV1,
} from './privilegedEvidenceTypes';

const NOW = 1_700_000_000_000;

/** Builds a structurally-plausible 54-key row directly (no store/parser round-trip needed for a pure projector). */
function record(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: 'a'.repeat(32),
    localIntentId: 'intent-1',
    paa1Base64: 'PAA1-SECRET',
    ssa1Base64: 'SSA1-SECRET',
    oacEnvelopeBytesBase64: 'OAC-SECRET',
    evidenceBindingDigest: 'digest-secret',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    branchId: 'LDP-001',
    approvingManagerStaffId: 'mgr-secret-1',
    oacId: 'oac-1',
    oacSchemaVersion: 1,
    revocationEpochAtIssue: 0,
    managerAuthVersionAtIssue: 0,
    managerCredentialVersionAtIssue: 0,
    nonce: 'nonce-secret',
    approvalProofDigest: 'proof-secret',
    attestationAttemptCount: 1,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: NOW - 1000,
    trustedApprovalUpperMs: NOW,
    pendingExecutionExpiresAtMs: NOW + 100_000,
    syncStatus: 'PRIVILEGED_INTENT_QUEUED',
    manualReviewStatus: 'NOT_REQUIRED',
    localTerminalReason: null,
    submissionClaims: 0,
    unresolvedClaimCount: 0,
    retryableFailureCount: 0,
    relayDeferrals: 0,
    deferredCycleCount: 0,
    nextAttemptAtMs: NOW,
    claimOwner: null,
    claimGeneration: null,
    createdAtMs: NOW - 5000,
    updatedAtMs: NOW,
    lastAttemptAtMs: null,
    lastDispositionKind: null,
    lastRelayCallerStaffId: null,
    lastCallerDependentStaffId: null,
    integrityConflict: false,
    ingestStaffId: 'staff-secret-1',
    ingestDeviceId: 'device-secret-1',
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

const SENSITIVE_VALUES = [
  'PAA1-SECRET',
  'SSA1-SECRET',
  'OAC-SECRET',
  'digest-secret',
  'mgr-secret-1',
  'nonce-secret',
  'proof-secret',
  'staff-secret-1',
  'device-secret-1',
];

describe('projectPrivilegedEvidenceForSyncCenter — safe projection', () => {
  it('zero sensitive leaks: no known-secret substring anywhere in the projected output', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(record());
    const json = JSON.stringify(row);
    for (const secret of SENSITIVE_VALUES) {
      expect(json).not.toContain(secret);
    }
  });

  it('output shape exposes only the closed safe field set', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(record());
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'branchId',
        'targetOrderId',
        'createdAtMs',
        'updatedAtMs',
        'statusClass',
        'statusTh',
        'detailTh',
        'attentionClass',
        'contributesToAttentionCount',
        'integrityConflict',
      ].sort(),
    );
  });

  it('never spreads the durable record: forbidden Class I/II/III keys never appear on the output', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(record()) as unknown as Record<string, unknown>;
    for (const forbidden of [
      'paa1Base64',
      'ssa1Base64',
      'oacEnvelopeBytesBase64',
      'evidenceBindingDigest',
      'approvalProofDigest',
      'nonce',
      'approvingManagerStaffId',
      'ingestStaffId',
      'ingestDeviceId',
      'serverReason',
      'localTerminalReason',
      'lastRelayCallerStaffId',
      'lastCallerDependentStaffId',
      'claimOwner',
    ]) {
      expect(forbidden in row).toBe(false);
    }
  });

  const CASES: Array<{
    name: string;
    syncStatus: PrivilegedEvidenceD2SyncStatus;
    lastDispositionKind: PrivilegedEvidenceDispositionKind | null;
    expected: SyncCenterPrivilegedStatusClass;
    attention: boolean;
  }> = [
    { name: 'fresh queued', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: null, expected: 'queued', attention: false },
    { name: 'requeued after retryable', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: 'RETRYABLE', expected: 'waiting_retry', attention: false },
    { name: 'requeued after protocol-retryable', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: 'PROTOCOL_RETRYABLE', expected: 'waiting_retry', attention: false },
    { name: 'requeued after transport failure', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: 'TRANSPORT_FAILURE', expected: 'waiting_retry', attention: false },
    { name: 'requeued after state-dependent protocol rejection', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: 'PROTOCOL_REJECTED_STATE_DEPENDENT', expected: 'waiting_retry', attention: false },
    { name: 'requeued after caller-dependent protocol rejection', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: 'PROTOCOL_REJECTED_CALLER_DEPENDENT', expected: 'waiting_retry', attention: false },
    { name: 'requeued after local submission timeout', syncStatus: 'PRIVILEGED_INTENT_QUEUED', lastDispositionKind: 'LOCAL_SUBMISSION_TIMEOUT', expected: 'waiting_retry', attention: false },
    { name: 'in flight', syncStatus: 'SYNCING', lastDispositionKind: null, expected: 'syncing', attention: false },
    { name: 'server accepted', syncStatus: 'SERVER_ACCEPTED', lastDispositionKind: 'ACCEPTED', expected: 'accepted', attention: false },
    { name: 'server rejected', syncStatus: 'SERVER_REJECTED', lastDispositionKind: 'REJECTED', expected: 'rejected', attention: false },
    { name: 'manual attention required', syncStatus: 'MANUAL_ATTENTION', lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED', expected: 'manual_attention', attention: true },
    { name: 'adjudication anomaly', syncStatus: 'MANUAL_ATTENTION', lastDispositionKind: 'ADJUDICATION_ANOMALY', expected: 'uncertain', attention: true },
    { name: 'protocol rejected permanent', syncStatus: 'MANUAL_ATTENTION', lastDispositionKind: 'PROTOCOL_REJECTED_PERMANENT', expected: 'manual_attention', attention: true },
    { name: 'local terminal', syncStatus: 'MANUAL_ATTENTION', lastDispositionKind: 'LOCAL_TERMINAL', expected: 'manual_attention', attention: true },
  ];

  it.each(CASES)('total status mapping: $name -> $expected', ({ syncStatus, lastDispositionKind, expected, attention }) => {
    const row = projectPrivilegedEvidenceForSyncCenter(record({ syncStatus, lastDispositionKind }));
    expect(row.statusClass).toBe(expected);
    expect(row.contributesToAttentionCount).toBe(attention);
    expect(row.attentionClass).toBe(attention ? 'requires_attention' : 'none');
  });

  it('every declared status class is covered by the case table above', () => {
    const covered = new Set(CASES.map((c) => c.expected));
    for (const cls of SYNC_CENTER_PRIVILEGED_STATUS_CLASSES) {
      if (cls === 'unknown_fail_closed') continue;
      expect(covered.has(cls), cls).toBe(true);
    }
  });

  it('unknown/unrecognized syncStatus fails closed to unknown_fail_closed, never success', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(
      record({ syncStatus: 'NOT_A_REAL_STATUS' as unknown as PrivilegedEvidenceD2SyncStatus, lastDispositionKind: null }),
    );
    expect(row.statusClass).toBe('unknown_fail_closed');
    expect(row.contributesToAttentionCount).toBe(true);
    expect(row.statusTh).not.toMatch(/ยืนยัน|สำเร็จ|เสร็จสิ้น/);
  });

  it('SERVER_ACCEPTED paired with a non-ACCEPTED disposition fails closed rather than reporting success', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(
      record({ syncStatus: 'SERVER_ACCEPTED', lastDispositionKind: null }),
    );
    expect(row.statusClass).toBe('unknown_fail_closed');
  });

  it('SERVER_REJECTED paired with a non-REJECTED disposition fails closed', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(
      record({ syncStatus: 'SERVER_REJECTED', lastDispositionKind: 'ACCEPTED' }),
    );
    expect(row.statusClass).toBe('unknown_fail_closed');
  });

  it('MANUAL_ATTENTION with an unmapped disposition kind fails closed', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(
      record({ syncStatus: 'MANUAL_ATTENTION', lastDispositionKind: 'RETRYABLE' }),
    );
    expect(row.statusClass).toBe('unknown_fail_closed');
    expect(row.contributesToAttentionCount).toBe(true);
  });

  it('carries row identity, order reference, branch, and timestamps through for safe display', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(
      record({ adjudicationId: 'b'.repeat(32), targetOrderId: 'order-99', branchId: 'LDP-002', createdAtMs: 111, updatedAtMs: 222 }),
    );
    expect(row.id).toBe('b'.repeat(32));
    expect(row.targetOrderId).toBe('order-99');
    expect(row.branchId).toBe('LDP-002');
    expect(row.createdAtMs).toBe(111);
    expect(row.updatedAtMs).toBe(222);
  });

  it('surfaces integrityConflict as a safe boolean without the raw conflict reason', () => {
    const row = projectPrivilegedEvidenceForSyncCenter(
      record({
        syncStatus: 'MANUAL_ATTENTION',
        lastDispositionKind: 'LOCAL_TERMINAL',
        localTerminalReason: 'journal_binding_conflict',
        integrityConflict: true,
      }),
    );
    expect(row.integrityConflict).toBe(true);
    expect(JSON.stringify(row)).not.toContain('journal_binding_conflict');
  });

  it('detail copy never claims success/complete for any non-accepted status class', () => {
    for (const cls of SYNC_CENTER_PRIVILEGED_STATUS_CLASSES) {
      if (cls === 'accepted') continue;
      const row = projectPrivilegedEvidenceForSyncCenter(
        record(
          cls === 'unknown_fail_closed'
            ? { syncStatus: 'NOT_A_REAL_STATUS' as unknown as PrivilegedEvidenceD2SyncStatus, lastDispositionKind: null }
            : (() => {
                const c = CASES.find((x) => x.expected === cls)!;
                return { syncStatus: c.syncStatus, lastDispositionKind: c.lastDispositionKind };
              })(),
        ),
      );
      expect(row.statusTh + row.detailTh).not.toContain('ซิงก์แล้ว');
      expect(row.statusTh + row.detailTh).not.toContain('ซิงก์สำเร็จ');
      expect(row.statusTh + row.detailTh).not.toContain('ส่งข้อมูลเรียบร้อย');
    }
  });
});
