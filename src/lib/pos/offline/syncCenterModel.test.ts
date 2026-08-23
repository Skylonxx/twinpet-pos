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
  classifyReversalIntent,
  classifySaleIntentEntry,
  classifyTrustedResume,
  classifyVoidIntent,
  resolveActiveSyncScope,
  thaiReasonForVoidTerminal,
  type ActiveSyncScope,
  type SyncCenterReadResult,
} from './syncCenterModel';
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
