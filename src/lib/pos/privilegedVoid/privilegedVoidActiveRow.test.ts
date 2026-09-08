import { describe, expect, it } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore } from '../offline/reversalLocalStore';
import type { PrivilegedEvidenceJournalRecordV1 } from '../offline/privilegedEvidenceTypes';
import {
  isBlockingActiveRowStatus,
  listActiveRowSummariesForBranch,
  precheckActiveRowForTarget,
} from './privilegedVoidActiveRow';

function hex32(seed: number): string {
  return seed.toString(16).padStart(32, '0');
}

function baseRow(over: Partial<PrivilegedEvidenceJournalRecordV1>): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: hex32(1),
    localIntentId: 'local-1',
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    evidenceBindingDigest: 'DIGEST1',
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

function queuedRow(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}) {
  return baseRow({ syncStatus: 'PRIVILEGED_INTENT_QUEUED', ...over });
}

function syncingRow(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}) {
  return baseRow({
    syncStatus: 'SYNCING',
    claimOwner: 'privileged-sweep:device-1:1',
    claimGeneration: 1,
    ...over,
  });
}

function acceptedRow(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}) {
  return baseRow({
    syncStatus: 'SERVER_ACCEPTED',
    lastDispositionKind: 'ACCEPTED',
    serverVerdict: 'ACCEPTED',
    serverAdjudicatedAtMs: 5_000,
    serverAdjudicationId: 'server-adj-1',
    serverTargetOrderId: 'order-1',
    offlineExecutionId: 'exec-1',
    outcomeKind: 'VOID_APPLIED',
    serverIdempotentReplay: false,
    ...over,
  });
}

function rejectedRow(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}) {
  return baseRow({
    syncStatus: 'SERVER_REJECTED',
    lastDispositionKind: 'REJECTED',
    serverVerdict: 'REJECTED',
    serverReason: 'trusted_time_bounds_invalid',
    serverAdjudicatedAtMs: 5_000,
    serverAdjudicationId: 'server-adj-1',
    serverTargetOrderId: 'order-1',
    serverIdempotentReplay: false,
    ...over,
  });
}

function manualAttentionRow(over: Partial<PrivilegedEvidenceJournalRecordV1> = {}) {
  return baseRow({
    syncStatus: 'MANUAL_ATTENTION',
    manualReviewStatus: 'REQUIRED',
    lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
    serverReason: 'canonical_correlation_missing',
    serverAdjudicatedAtMs: 5_000,
    serverAdjudicationId: 'server-adj-1',
    serverTargetOrderId: 'order-1',
    serverIdempotentReplay: false,
    ...over,
  });
}

async function seed(store: ReversalLocalStore, row: PrivilegedEvidenceJournalRecordV1): Promise<void> {
  await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
    await txn.put('privilegedEvidence', row.adjudicationId, row);
  });
}

describe('precheckActiveRowForTarget', () => {
  it('clear: no row for the target', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-none');
    expect(outcome).toEqual({ kind: 'clear' });
  });

  it('active_open: a QUEUED row blocks a fresh approval', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, queuedRow());
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-1');
    expect(outcome.kind).toBe('active_open');
    if (outcome.kind !== 'active_open') throw new Error('unreachable');
    expect(outcome.row.targetOrderId).toBe('order-1');
    expect(outcome.row.syncStatus).toBe('PRIVILEGED_INTENT_QUEUED');
  });

  it('active_open: a SYNCING row also blocks', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, syncingRow());
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-1');
    expect(outcome.kind).toBe('active_open');
  });

  it('terminal_accepted: a SERVER_ACCEPTED row is read-only, not clear', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, acceptedRow());
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-1');
    expect(outcome.kind).toBe('terminal_accepted');
  });

  it('manual_attention: a MANUAL_ATTENTION row is surfaced distinctly', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, manualAttentionRow());
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-1');
    expect(outcome.kind).toBe('manual_attention');
  });

  it('terminal_rejected: a SERVER_REJECTED row never blocks (mirrors D-3 S1 pre-guard) but is still classified', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, rejectedRow());
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-1');
    expect(outcome.kind).toBe('terminal_rejected');
  });

  it('integrity_fault: an unreadable row anywhere in the branch fails the WHOLE branch closed, even for an unrelated target', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'garbage-key', { not: 'a valid record' });
    });
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-unrelated');
    expect(outcome).toEqual({ kind: 'integrity_fault' });
  });

  it('wrong-branch rows are excluded: a row for a different branch never blocks this branch\'s target', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, queuedRow({ adjudicationId: hex32(2), branchId: 'LDP-002', targetOrderId: 'order-1' }));
    const outcome = await precheckActiveRowForTarget(store, 'LDP-001', 'order-1');
    expect(outcome).toEqual({ kind: 'clear' });
  });

  it('a durable-store read failure fails closed to integrity_fault, never to clear', async () => {
    const throwingStore: ReversalLocalStore = {
      transact: async () => {
        throw new Error('indexeddb unavailable');
      },
    };
    const outcome = await precheckActiveRowForTarget(throwingStore, 'LDP-001', 'order-1');
    expect(outcome).toEqual({ kind: 'integrity_fault' });
  });
});

describe('listActiveRowSummariesForBranch', () => {
  it('projects only safe display fields — no evidence bytes, digests, or nonces', async () => {
    const store = createInMemoryReversalStore();
    await seed(store, acceptedRow());
    const { rows, unreadableCount } = await listActiveRowSummariesForBranch(store, 'LDP-001');
    expect(unreadableCount).toBe(0);
    expect(rows).toHaveLength(1);
    const row = rows[0]! as unknown as Record<string, unknown>;
    for (const forbidden of ['paa1Base64', 'ssa1Base64', 'oacEnvelopeBytesBase64', 'evidenceBindingDigest', 'nonce', 'approvalProofDigest']) {
      expect(Object.prototype.hasOwnProperty.call(row, forbidden)).toBe(false);
    }
  });
});

describe('isBlockingActiveRowStatus', () => {
  it('matches exactly the D-3 S1 pre-guard open-status set', () => {
    expect(isBlockingActiveRowStatus('PRIVILEGED_INTENT_QUEUED')).toBe(true);
    expect(isBlockingActiveRowStatus('SYNCING')).toBe(true);
    expect(isBlockingActiveRowStatus('SERVER_ACCEPTED')).toBe(true);
    expect(isBlockingActiveRowStatus('MANUAL_ATTENTION')).toBe(true);
    expect(isBlockingActiveRowStatus('SERVER_REJECTED')).toBe(false);
  });
});
