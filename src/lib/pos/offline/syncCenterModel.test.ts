import { describe, expect, it } from 'vitest';
import { CHANNEL_ORDER } from './syncOrchestrator';
import type { OfflineReversalIntent } from './offlineReversalTypes';
import type { SaleIntentEntry } from './saleIntentJournalTypes';
import type { ShiftCloseIntentEntry } from './shiftCloseIntentTypes';
import type { ShiftOpenIntentEntry } from './shiftOpenIntentTypes';
import type { VoidIntentRecord, VoidTerminalReason } from './voidIntentStore';
import {
  SYNC_CENTER_CHANNEL_ORDER,
  VOID_TERMINAL_REASON_TH,
  aggregateForbidsClean,
  buildSyncCenterAggregate,
  calculateSyncCenterAttentionCount,
  classifyReversalIntent,
  classifySaleIntentEntry,
  classifyTrustedResume,
  classifyVoidIntent,
  resolveActiveSyncScope,
  thaiReasonForVoidTerminal,
  type ActiveSyncScope,
  type SyncCenterReadResult,
} from './syncCenterModel';
import type { PrivilegedEvidenceJournalRecordV1 } from './privilegedEvidenceTypes';
import modelSource from './syncCenterModel.ts?raw';
import readerSource from './syncCenterReader.ts?raw';
import authoritySource from './syncCenterAuthority.ts?raw';
import actionsSource from './syncCenterActions.ts?raw';
import hookSource from '../../../hooks/pos/useSyncCenterState.ts?raw';
import barSource from '../../../components/SyncStatusBar.tsx?raw';
import pageSource from '../../../pages/SyncCenterPage.tsx?raw';
import manualSource from '../../../pages/ManualReviewOpsPage.tsx?raw';
import salesSource from '../../../pages/SalesHistoryPage.tsx?raw';

const NOW = 1_700_000_000_000;

function mustScope(branchId: string, deviceId: string): ActiveSyncScope {
  const resolved = resolveActiveSyncScope(branchId, deviceId);
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.scope;
}

function reversal(over: Partial<OfflineReversalIntent> & Pick<OfflineReversalIntent, 'id' | 'branchId' | 'status'>): OfflineReversalIntent {
  return {
    businessId: 'biz',
    sourceType: 'receiving',
    sourceId: 'src',
    action: 'void',
    reasonCode: 'x',
    createdAt: new Date(NOW).toISOString(),
    createdByStaffId: 's1',
    createdByRole: 'manager',
    idempotencyKey: 'k',
    localMutationId: 'm',
    localCorrection: { applied: true, reversed: false, stockDelta: [] },
    ...over,
  };
}

function voidRec(over: Partial<VoidIntentRecord> & Pick<VoidIntentRecord, 'orderId' | 'branchId' | 'deviceId' | 'status'>): VoidIntentRecord {
  return {
    reason: 'x',
    note: null,
    voidedBy: 's',
    attempts: 1,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    nextEligibleAtMs: 0,
    claimOwner: null,
    claimExpiresAtMs: null,
    lastErrorClass: null,
    lastErrorAtMs: null,
    terminalReason: null,
    confirmedAtMs: null,
    observedServerCreatedAtMs: null,
    schemaVersion: 1,
    ...over,
  };
}

function closeEntry(over: Partial<ShiftCloseIntentEntry> & Pick<ShiftCloseIntentEntry, 'shiftId' | 'branchId' | 'deviceId' | 'status'>): ShiftCloseIntentEntry {
  return {
    staffId: 's',
    staffName: 'S',
    startingCash: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    payInTotal: 0,
    payOutTotal: 0,
    totalBills: 0,
    actualCashCount: 0,
    variance: 0,
    note: '',
    closedAtLocal: NOW,
    closeCorrelationId: null,
    createdAtLocal: NOW,
    updatedAtLocal: NOW,
    lastErrorMessage: null,
    ...over,
  };
}

function openEntry(over: Partial<ShiftOpenIntentEntry> & Pick<ShiftOpenIntentEntry, 'shiftId' | 'branchId' | 'deviceId' | 'status'>): ShiftOpenIntentEntry {
  return {
    staffId: 's',
    staffName: 'S',
    startingCash: 0,
    openedAtLocal: NOW,
    remoteCreateState: 'none',
    createdAtLocal: NOW,
    updatedAtLocal: NOW,
    lastErrorMessage: null,
    ...over,
  };
}

function sale(over: Partial<SaleIntentEntry> & Pick<SaleIntentEntry, 'asyncOrderId' | 'branchId' | 'deviceId' | 'status'>): SaleIntentEntry {
  return {
    localQueueId: 'l',
    idempotencyKey: 'i',
    billId: over.billId ?? over.asyncOrderId,
    shiftId: 'sh',
    staffId: 's',
    createdAtLocal: NOW,
    createdAtIso: new Date(NOW).toISOString(),
    payloadVersion: 1,
    salePayload: null,
    payloadStrippedAt: null,
    totalAmount: 1,
    retryCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    rejectedAt: null,
    serverAcknowledgedAt: null,
    settledObservedAt: null,
    manualReviewReason: null,
    conflictState: null,
    supersededBy: null,
    nextEventSeq: 1,
    updatedAtLocal: new Date(NOW).toISOString(),
    ...over,
  };
}

function emptyRead(scope: ActiveSyncScope, over: Partial<SyncCenterReadResult> = {}): SyncCenterReadResult {
  return {
    scope,
    reversal: { ok: true, rows: [] },
    voidIntent: { ok: true, rows: [] },
    shiftClose: { ok: true, rows: [] },
    shiftOpen: { ok: true, rows: [] },
    saleIntent: { ok: true, rows: [] },
    orchestrator: { lastCycle: null, webLocksAvailable: true, ch4AttemptExhaustedIds: [] },
    isOnline: true,
    ...over,
  };
}

function privilegedRecord(
  over: Partial<PrivilegedEvidenceJournalRecordV1> &
    Pick<PrivilegedEvidenceJournalRecordV1, 'adjudicationId' | 'branchId'>,
): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    localIntentId: 'intent-1',
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    evidenceBindingDigest: 'digest-1',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
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

describe('syncCenterModel', () => {
  it('N-R1-1 resolveActiveSyncScope is the only producer and rejects empty/ALL/no device', () => {
    expect(resolveActiveSyncScope(null, 'X').ok).toBe(false);
    expect(resolveActiveSyncScope('', 'X')).toEqual({ ok: false, reason: 'no_branch' });
    expect(resolveActiveSyncScope('ALL', 'X')).toEqual({ ok: false, reason: 'branch_all' });
    expect(resolveActiveSyncScope('A', null)).toEqual({ ok: false, reason: 'no_device' });
    expect(resolveActiveSyncScope('A', '')).toEqual({ ok: false, reason: 'no_device' });
    expect(modelSource.match(/Symbol\('twinpet\.ActiveSyncScope'\)/g)?.length).toBe(1);
  });

  it('N-A1 five channels in CHANNEL_ORDER even when empty', () => {
    expect([...SYNC_CENTER_CHANNEL_ORDER]).toEqual([...CHANNEL_ORDER]);
    const agg = buildSyncCenterAggregate(emptyRead(mustScope('A', 'X')), NOW);
    expect(agg.channels.map((c) => c.channel)).toEqual([...CHANNEL_ORDER]);
    expect(agg.unifiedPending).toBe(0);
    expect(agg.unifiedAttention).toBe(0);
  });

  it('N-A2 pending formula across readable channels; trusted_resume contributes 0', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        reversal: { ok: true, rows: [reversal({ id: 'r1', branchId: 'A', status: 'queued' })] },
        voidIntent: { ok: true, rows: [voidRec({ orderId: 'v1', branchId: 'A', deviceId: 'X', status: 'pending' })] },
        shiftClose: {
          ok: true,
          rows: [closeEntry({ shiftId: 'c1', branchId: 'A', deviceId: 'X', status: 'local_closed_pending' })],
        },
        shiftOpen: {
          ok: true,
          rows: [openEntry({ shiftId: 'o1', branchId: 'A', deviceId: null, status: 'local_open_pending' })],
        },
        saleIntent: {
          ok: true,
          rows: [sale({ asyncOrderId: 's1', branchId: 'A', deviceId: 'X', status: 'queued' })],
        },
        orchestrator: {
          lastCycle: {
            trigger: 'MANUAL_INVOCATION',
            startedAtMs: NOW,
            durationMs: 10,
            completed: true,
            gateOutcome: 'ran',
            channels: [{ channel: 'trusted_resume', status: 'failed', errorClass: 'orchestration_error' }],
          },
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
      }),
      NOW,
    );
    expect(agg.unifiedPending).toBe(5);
    expect(agg.channels.find((c) => c.channel === 'trusted_resume')?.pending).toBe(0);
  });

  it('N-A3 attention counts in-scope only; trusted_resume failed cycle does not inflate attention', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        reversal: {
          ok: true,
          rows: [reversal({ id: 'r1', branchId: 'A', status: 'manual_review_required' })],
        },
        voidIntent: {
          ok: true,
          rows: [
            voidRec({
              orderId: 'v1',
              branchId: 'A',
              deviceId: 'X',
              status: 'terminal',
              terminalReason: 'authority_refused',
            }),
          ],
        },
        orchestrator: {
          lastCycle: {
            trigger: 'BOUNDED_INTERVAL',
            startedAtMs: NOW,
            durationMs: 5,
            completed: true,
            gateOutcome: 'ran',
            channels: [{ channel: 'trusted_resume', status: 'failed' }],
          },
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
      }),
      NOW,
    );
    expect(agg.unifiedAttention).toBe(2);
    expect(agg.channels.find((c) => c.channel === 'trusted_resume')?.attention).toBe(0);
  });

  it('N-A4 lastSyncCheckAtMs follows the check-time predicate', () => {
    const scope = mustScope('A', 'X');
    expect(buildSyncCenterAggregate(emptyRead(scope), NOW).lastSyncCheckAtMs).toBeNull();
    const ran = emptyRead(scope, {
      orchestrator: {
        lastCycle: {
          trigger: 'MANUAL_INVOCATION',
          startedAtMs: 100,
          durationMs: 7,
          completed: true,
          gateOutcome: 'ran',
          channels: [{ channel: 'sale_intent', status: 'ok' }],
        },
        webLocksAvailable: true,
        ch4AttemptExhaustedIds: [],
      },
    });
    expect(buildSyncCenterAggregate(ran, NOW).lastSyncCheckAtMs).toBe(107);
    const failed = emptyRead(scope, {
      orchestrator: {
        lastCycle: {
          trigger: 'MANUAL_INVOCATION',
          startedAtMs: 100,
          durationMs: 7,
          completed: true,
          gateOutcome: 'ran',
          channels: [{ channel: 'trusted_resume', status: 'failed' }],
        },
        webLocksAvailable: true,
        ch4AttemptExhaustedIds: [],
      },
    });
    expect(buildSyncCenterAggregate(failed, NOW).lastSyncCheckAtMs).toBeNull();
  });

  it('N-A5 unknown never counts as pending/attention; unavailable forbids clean', () => {
    const scope = mustScope('A', 'X');
    const classified = classifyReversalIntent(
      reversal({ id: 'r1', branchId: 'A', status: 'queued' }),
      scope,
      [],
      NOW,
    );
    expect(classified.inScope).toBe(true);
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { reversal: { ok: false, reason: 'boom' } }),
      NOW,
    );
    expect(agg.unavailableChannelCount).toBeGreaterThan(0);
    expect(aggregateForbidsClean(agg)).toBe(true);
    expect(classifyTrustedResume(null).unavailableReason).toBe('ไม่ทราบสถานะ');
  });

  it('N-A6 de-duplicates reversal that is both manual_review and exhausted', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        reversal: {
          ok: true,
          rows: [reversal({ id: 'r1', branchId: 'A', status: 'manual_review_required' })],
        },
        orchestrator: {
          lastCycle: null,
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: ['offline_reversal:r1'],
        },
      }),
      NOW,
    );
    expect(agg.unifiedAttention).toBe(1);
    expect(agg.unifiedPending).toBe(0);
    expect(agg.rows.filter((r) => r.id === 'r1')).toHaveLength(1);
  });

  it('N-A7 / N-R1-2 cross-branch rows are excluded; null-device shift is included', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        reversal: {
          ok: true,
          rows: [
            reversal({ id: 'ra', branchId: 'A', status: 'queued' }),
            reversal({ id: 'rb', branchId: 'B', status: 'queued' }),
          ],
        },
        shiftClose: {
          ok: true,
          rows: [closeEntry({ shiftId: 'c-null', branchId: 'A', deviceId: null, status: 'local_closed_pending' })],
        },
      }),
      NOW,
    );
    expect(agg.rows.some((r) => r.id === 'rb')).toBe(false);
    const nullRow = agg.rows.find((r) => r.id === 'close:c-null');
    expect(nullRow?.scopeKind).toBe('branch');
    expect(nullRow?.deviceId).toBeNull();
  });

  it('N-R1-6 exhausted out-of-scope id contributes 0', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        reversal: { ok: true, rows: [reversal({ id: 'in', branchId: 'A', status: 'queued' })] },
        orchestrator: {
          lastCycle: null,
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: ['offline_reversal:other'],
        },
      }),
      NOW,
    );
    expect(agg.unifiedAttention).toBe(0);
  });

  it('N-R1-7 PK-4 counting path does not mention terminalVoidIntentCount', () => {
    for (const src of [modelSource, readerSource, authoritySource, actionsSource, hookSource, barSource, pageSource]) {
      expect(src).not.toMatch(/terminalVoidIntentCount/);
    }
  });

  it('N-R1-9 same device different branch sale is excluded', () => {
    const scope = mustScope('A', 'X');
    const result = classifySaleIntentEntry(
      sale({ asyncOrderId: 's1', branchId: 'B', deviceId: 'X', status: 'queued' }),
      scope,
      NOW,
    );
    expect(result.inScope).toBe(false);
  });

  it('N-A11 shift never reports in_flight', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        shiftClose: {
          ok: true,
          rows: [closeEntry({ shiftId: 'c1', branchId: 'A', deviceId: 'X', status: 'local_closed_pending' })],
        },
      }),
      NOW,
    );
    expect(agg.channels.find((c) => c.channel === 'shift_intent')?.inFlight).toBe(0);
    expect(agg.rows.every((r) => r.channel !== 'shift_intent' || r.state !== 'in_flight')).toBe(true);
  });

  it('N-R1-16 S2 drops hand-built out-of-scope rows', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        reversal: { ok: true, rows: [reversal({ id: 'b', branchId: 'B', status: 'queued' })] },
      }),
      NOW,
    );
    expect(agg.outOfScopeDroppedCount).toBe(1);
    expect(agg.unifiedPending).toBe(0);
  });

  it('N-U1 void terminal Thai strings match ManualReviewOpsPage; SalesHistory keeps all seven reason cases', () => {
    const reasons = Object.keys(VOID_TERMINAL_REASON_TH) as VoidTerminalReason[];
    for (const reason of reasons) {
      const th = thaiReasonForVoidTerminal(reason);
      expect(manualSource).toContain(`if (reason === '${reason}') return '${th}'`);
      expect(salesSource).toContain(`case '${reason}':`);
      expect(modelSource).toContain(th);
    }
    expect(salesSource).toContain('function voidTerminalThai');
  });

  it('N-A8 PK-4 sources contain no indexedDB identifier', () => {
    for (const src of [modelSource, readerSource, authoritySource, actionsSource, hookSource, barSource, pageSource]) {
      expect(src).not.toMatch(/indexedDB/);
    }
  });

  it('waiting_retry is a pending substate, not attention', () => {
    const scope = mustScope('A', 'X');
    const result = classifyVoidIntent(
      voidRec({
        orderId: 'v1',
        branchId: 'A',
        deviceId: 'X',
        status: 'pending',
        nextEligibleAtMs: NOW + 10_000,
      }),
      scope,
      NOW,
    );
    expect(result.inScope && result.row.state).toBe('waiting_retry');
  });
});

describe('syncCenterModel — SEC-001 Packet E / E-2 privileged (non-channel) aggregation', () => {
  it('calculateSyncCenterAttentionCount is a pure sum, exactly once', () => {
    expect(calculateSyncCenterAttentionCount(0, 0)).toBe(0);
    expect(calculateSyncCenterAttentionCount(3, 2)).toBe(5);
    expect(calculateSyncCenterAttentionCount(0, 4)).toBe(4);
  });

  it('E2-M1 channel attention only: privileged section absent leaves unifiedAttention unchanged', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        voidIntent: {
          ok: true,
          rows: [voidRec({ orderId: 'v1', branchId: 'A', deviceId: 'X', status: 'terminal', terminalReason: 'authority_refused' })],
        },
      }),
      NOW,
    );
    expect(agg.unifiedAttention).toBe(1);
    expect(agg.privilegedRows).toEqual([]);
    expect(agg.privilegedAttentionCount).toBe(0);
    expect(agg.privilegedAvailability).toBe('ok');
  });

  it('E2-M2 privileged count only: zero channel attention, one privileged attention row', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'A',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(agg.unifiedAttention).toBe(1);
    expect(agg.privilegedAttentionCount).toBe(1);
    expect(agg.privilegedRows).toHaveLength(1);
  });

  it('E2-M3 combined count adds channel and privileged attention exactly once', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        voidIntent: {
          ok: true,
          rows: [voidRec({ orderId: 'v1', branchId: 'A', deviceId: 'X', status: 'terminal', terminalReason: 'authority_refused' })],
        },
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'A',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'ADJUDICATION_ANOMALY',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(agg.unifiedAttention).toBe(2);
  });

  it('E2-M4 non-attention privileged statuses (queued/syncing/accepted/rejected) contribute zero', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({ adjudicationId: 'a'.repeat(32), branchId: 'A', syncStatus: 'PRIVILEGED_INTENT_QUEUED' }),
            privilegedRecord({ adjudicationId: 'b'.repeat(32), branchId: 'A', syncStatus: 'SYNCING' }),
            privilegedRecord({
              adjudicationId: 'c'.repeat(32),
              branchId: 'A',
              syncStatus: 'SERVER_ACCEPTED',
              lastDispositionKind: 'ACCEPTED',
            }),
            privilegedRecord({
              adjudicationId: 'd'.repeat(32),
              branchId: 'A',
              syncStatus: 'SERVER_REJECTED',
              lastDispositionKind: 'REJECTED',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(agg.privilegedAttentionCount).toBe(0);
    expect(agg.unifiedAttention).toBe(0);
    expect(agg.privilegedRows).toHaveLength(4);
  });

  it('E2-M5 multiple privileged attention rows all count', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'A',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
            }),
            privilegedRecord({
              adjudicationId: 'b'.repeat(32),
              branchId: 'A',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'LOCAL_TERMINAL',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(agg.privilegedAttentionCount).toBe(2);
    expect(agg.unifiedAttention).toBe(2);
  });

  it('E2-M6 same durable row (same adjudicationId) appearing twice is never double-counted', () => {
    const scope = mustScope('A', 'X');
    const dup = privilegedRecord({
      adjudicationId: 'a'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
    });
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [dup, { ...dup }] } }),
      NOW,
    );
    expect(agg.privilegedRows).toHaveLength(1);
    expect(agg.privilegedAttentionCount).toBe(1);
  });

  it('E2-M7 a status transition away from attention removes it from the count', () => {
    const scope = mustScope('A', 'X');
    const attentionAgg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'A',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(attentionAgg.privilegedAttentionCount).toBe(1);
    const resolvedAgg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'A',
              syncStatus: 'SERVER_REJECTED',
              lastDispositionKind: 'REJECTED',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(resolvedAgg.privilegedAttentionCount).toBe(0);
  });

  it('E2-M8 branch scope isolation: cross-branch privileged rows are excluded from this view', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'B',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(agg.privilegedRows).toEqual([]);
    expect(agg.privilegedAttentionCount).toBe(0);
  });

  it('E2-M9 unavailable privileged read fails closed: empty rows, zero attention, unavailable flag set', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: false, reason: 'canonical_sync_context_unavailable' } }),
      NOW,
    );
    expect(agg.privilegedRows).toEqual([]);
    expect(agg.privilegedAttentionCount).toBe(0);
    expect(agg.privilegedAvailability).toBe('unavailable');
    expect(agg.privilegedUnavailableReason).not.toBeNull();
  });

  it('RC-E2-003-1 newer SERVER_REJECTED beats older MANUAL_ATTENTION regardless of input order', () => {
    const scope = mustScope('A', 'X');
    const older = privilegedRecord({
      adjudicationId: 'a'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW - 1000,
    });
    const newer = privilegedRecord({
      adjudicationId: 'a'.repeat(32),
      branchId: 'A',
      syncStatus: 'SERVER_REJECTED',
      lastDispositionKind: 'REJECTED',
      updatedAtMs: NOW,
    });
    const forward = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [older, newer] } }),
      NOW,
    );
    const reversed = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [newer, older] } }),
      NOW,
    );
    for (const agg of [forward, reversed]) {
      expect(agg.privilegedRows).toHaveLength(1);
      expect(agg.privilegedRows[0].statusClass).toBe('rejected');
      expect(agg.privilegedAttentionCount).toBe(0);
    }
  });

  it('RC-E2-003-2 newer MANUAL_ATTENTION beats older non-attention status regardless of input order; stale non-attention cannot hide it', () => {
    const scope = mustScope('A', 'X');
    const older = privilegedRecord({
      adjudicationId: 'b'.repeat(32),
      branchId: 'A',
      syncStatus: 'PRIVILEGED_INTENT_QUEUED',
      updatedAtMs: NOW - 1000,
    });
    const newer = privilegedRecord({
      adjudicationId: 'b'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW,
    });
    const forward = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [older, newer] } }),
      NOW,
    );
    const reversed = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [newer, older] } }),
      NOW,
    );
    for (const agg of [forward, reversed]) {
      expect(agg.privilegedRows).toHaveLength(1);
      expect(agg.privilegedRows[0].statusClass).toBe('manual_attention');
      expect(agg.privilegedAttentionCount).toBe(1);
    }
  });

  it('RC-E2-003-3 equal-timestamp equivalent duplicates collapse to one row without double counting', () => {
    const scope = mustScope('A', 'X');
    const dup = privilegedRecord({
      adjudicationId: 'c'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW,
    });
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [dup, { ...dup }] } }),
      NOW,
    );
    expect(agg.privilegedRows).toHaveLength(1);
    expect(agg.privilegedAttentionCount).toBe(1);
    expect(agg.unifiedAttention).toBe(1);
  });

  it('RC-E2-003-4 equal-timestamp conflicting status fails closed deterministically, identically regardless of input order', () => {
    const scope = mustScope('A', 'X');
    const variantA = privilegedRecord({
      adjudicationId: 'd'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW,
    });
    const variantB = privilegedRecord({
      adjudicationId: 'd'.repeat(32),
      branchId: 'A',
      syncStatus: 'SERVER_REJECTED',
      lastDispositionKind: 'REJECTED',
      updatedAtMs: NOW,
    });
    const forward = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [variantA, variantB] } }),
      NOW,
    );
    const reversed = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [variantB, variantA] } }),
      NOW,
    );
    expect(forward.privilegedRows).toEqual(reversed.privilegedRows);
    expect(forward.privilegedRows).toHaveLength(1);
    expect(forward.privilegedRows[0].statusClass).toBe('unknown_fail_closed');
    expect(forward.privilegedRows[0].integrityConflict).toBe(true);
    expect(forward.privilegedRows[0].contributesToAttentionCount).toBe(true);
    expect(forward.privilegedAttentionCount).toBe(1);
  });

  it('RC-E2-003-5 a duplicate ID never doubles the unified attention count, even with three copies', () => {
    const scope = mustScope('A', 'X');
    const dup = privilegedRecord({
      adjudicationId: 'e'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW,
    });
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [dup, { ...dup }, { ...dup }] } }),
      NOW,
    );
    expect(agg.privilegedRows).toHaveLength(1);
    expect(agg.privilegedAttentionCount).toBe(1);
    expect(agg.unifiedAttention).toBe(1);
  });

  it('RC-E2-003-6 branch filtering is preserved alongside duplicate resolution', () => {
    const scope = mustScope('A', 'X');
    const dupA = privilegedRecord({
      adjudicationId: 'f'.repeat(32),
      branchId: 'A',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW,
    });
    const otherBranch = privilegedRecord({
      adjudicationId: 'g'.repeat(32),
      branchId: 'B',
      syncStatus: 'MANUAL_ATTENTION',
      lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
      updatedAtMs: NOW + 1,
    });
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { privilegedEvidence: { ok: true, rows: [dupA, { ...dupA }, otherBranch] } }),
      NOW,
    );
    expect(agg.privilegedRows).toHaveLength(1);
    expect(agg.privilegedRows[0].id).toBe('f'.repeat(32));
  });

  it('RC-E2-002-M1 exact otherwise-clean regression: all channels healthy, zero rows, successful last cycle, privileged unavailable', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: { ok: false, reason: 'canonical_sync_context_unavailable' },
        orchestrator: {
          lastCycle: {
            trigger: 'MANUAL_INVOCATION',
            startedAtMs: 100,
            durationMs: 7,
            completed: true,
            gateOutcome: 'ran',
            channels: [{ channel: 'sale_intent', status: 'ok' }],
          },
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
      }),
      NOW,
    );
    // 1. privileged section unavailable
    expect(agg.privilegedAvailability).toBe('unavailable');
    // 2. global unavailable/source-unavailable summary truthful and non-zero,
    // while unavailableChannelCount keeps meaning ordinary channels only
    expect(agg.unavailableChannelCount).toBe(0);
    expect(agg.privilegedUnavailableCount).toBe(1);
    expect(agg.unavailableSourceCount).toBe(1);
    // 3. global clean predicate false
    expect(aggregateForbidsClean(agg)).toBe(true);
    // 5/6. attention stays 0 and is not proof of source completeness
    expect(agg.unifiedAttention).toBe(0);
    // 7/8. no privileged pseudo-channel; CHANNEL_ORDER unchanged
    expect(agg.channels.map((c) => c.channel)).toEqual([...SYNC_CENTER_CHANNEL_ORDER]);
    expect(agg.rows).toEqual([]);
  });

  it('RC-E2-002-M2 privileged available and all channels ok: unavailableSourceCount is 0 and clean can be true', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        orchestrator: {
          lastCycle: {
            trigger: 'MANUAL_INVOCATION',
            startedAtMs: 100,
            durationMs: 7,
            completed: true,
            gateOutcome: 'ran',
            channels: [{ channel: 'sale_intent', status: 'ok' }],
          },
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
      }),
      NOW,
    );
    expect(agg.privilegedAvailability).toBe('ok');
    expect(agg.unavailableSourceCount).toBe(0);
    expect(aggregateForbidsClean(agg)).toBe(false);
  });

  it('RC-E2-002-M3 an unavailable ordinary channel alongside a healthy privileged section still sums correctly', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, { saleIntent: { ok: false, reason: 'unavailable' } }),
      NOW,
    );
    expect(agg.unavailableChannelCount).toBe(1);
    expect(agg.privilegedUnavailableCount).toBe(0);
    expect(agg.unavailableSourceCount).toBe(1);
  });

  it('E2-M10 privileged evidence never spreads into the ordinary channel rows/CHANNEL_ORDER', () => {
    const scope = mustScope('A', 'X');
    const agg = buildSyncCenterAggregate(
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: [
            privilegedRecord({
              adjudicationId: 'a'.repeat(32),
              branchId: 'A',
              syncStatus: 'MANUAL_ATTENTION',
              lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED',
            }),
          ],
        },
      }),
      NOW,
    );
    expect(agg.rows).toEqual([]);
    expect(agg.channels.map((c) => c.channel)).toEqual([...SYNC_CENTER_CHANNEL_ORDER]);
  });
});
