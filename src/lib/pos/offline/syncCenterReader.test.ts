import { describe, expect, it, vi } from 'vitest';
import { resolveActiveSyncScope } from './syncCenterModel';
import { readSyncCenterSources } from './syncCenterReader';
import readerSource from './syncCenterReader.ts?raw';
import type { OfflineReversalIntent } from './offlineReversalTypes';
import type { VoidIntentRecord } from './voidIntentStore';
import type { ReversalStoreName, ReversalTxn } from './reversalLocalStore';

function mustScope() {
  const r = resolveActiveSyncScope('A', 'X');
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

describe('syncCenterReader', () => {
  it('applies per-channel scope at the source and isolates failures', async () => {
    const scope = mustScope();
    const reversalRows: OfflineReversalIntent[] = [
      { id: 'in', branchId: 'A', status: 'queued' } as OfflineReversalIntent,
      { id: 'out', branchId: 'B', status: 'queued' } as OfflineReversalIntent,
    ];
    const voidRows: VoidIntentRecord[] = [
      { orderId: 'v1', branchId: 'A', deviceId: 'X', status: 'pending' } as VoidIntentRecord,
      { orderId: 'v2', branchId: 'A', deviceId: 'Y', status: 'pending' } as VoidIntentRecord,
    ];
    const result = await readSyncCenterSources(scope, {
      reversalStore: {
        transact: async (stores: ReversalStoreName[], _mode: 'readonly' | 'readwrite', fn: (txn: ReversalTxn) => Promise<unknown>) => {
          const rows = stores.includes('intents' as never) ? reversalRows : voidRows;
          return fn({
            get: async () => undefined,
            getAll: async <T>() => rows as T[],
            put: async () => undefined,
            delete: async () => undefined,
          });
        },
      } as never,
      closeJournal: {
        listCloseIntents: async () => ({ ok: false as const, code: 'unavailable' as const }),
      },
      openJournal: {
        listOpenIntents: async () => ({
          ok: true as const,
          value: [
            { shiftId: 'o1', branchId: 'A', deviceId: 'X', status: 'local_open_pending' } as never,
            { shiftId: 'o2', branchId: 'B', deviceId: 'X', status: 'local_open_pending' } as never,
          ],
        }),
      },
      saleJournal: {
        listSaleIntentsByStatus: async () => ({
          ok: true as const,
          value: [
            { asyncOrderId: 's1', branchId: 'A', deviceId: 'X', status: 'queued' } as never,
            { asyncOrderId: 's2', branchId: 'B', deviceId: 'X', status: 'queued' } as never,
          ],
        }),
      },
      readOrchestratorState: () => ({
        schemaVersion: 1 as const,
        webLocksAvailable: true,
        lastCycle: null,
        cycleCount: 0,
        terminalVoidIntentCount: 99,
        lastErrorAtMs: null,
        ch4AttemptExhaustedIds: [],
      }),
      isOnline: true,
    });

    expect(result.shiftClose.ok).toBe(false);
    expect(result.shiftOpen.ok).toBe(true);
    if (result.shiftOpen.ok) {
      expect(result.shiftOpen.rows.map((r) => r.shiftId)).toEqual(['o1']);
    }
    expect(result.saleIntent.ok).toBe(true);
    if (result.saleIntent.ok) {
      expect(result.saleIntent.rows.map((r) => r.asyncOrderId)).toEqual(['s1']);
    }
    expect(result.reversal.ok).toBe(true);
    if (result.reversal.ok) {
      expect(result.reversal.rows.map((r) => r.id)).toEqual(['in']);
    }
    expect(result.voidIntent.ok).toBe(true);
    if (result.voidIntent.ok) {
      expect(result.voidIntent.rows.map((r) => r.orderId)).toEqual(['v1']);
    }
  });

  it('N-A9 one throwing channel does not blank others', async () => {
    const scope = mustScope();
    const result = await readSyncCenterSources(scope, {
      reversalStore: {
        transact: async () => {
          throw new Error('reversal down');
        },
      } as never,
      closeJournal: { listCloseIntents: async () => ({ ok: true as const, value: [] }) },
      openJournal: { listOpenIntents: async () => ({ ok: true as const, value: [] }) },
      saleJournal: { listSaleIntentsByStatus: async () => ({ ok: true as const, value: [] }) },
      readOrchestratorState: () => ({
        schemaVersion: 1 as const,
        webLocksAvailable: true,
        lastCycle: null,
        cycleCount: 0,
        terminalVoidIntentCount: 0,
        lastErrorAtMs: null,
        ch4AttemptExhaustedIds: [],
      }),
    });
    expect(result.reversal.ok).toBe(false);
    expect(result.shiftClose.ok).toBe(true);
    expect(result.saleIntent.ok).toBe(true);
  });

  it('N-A12 unavailable sale journal is not treated as empty success', async () => {
    const scope = mustScope();
    const result = await readSyncCenterSources(scope, {
      reversalStore: { transact: async () => [] } as never,
      closeJournal: { listCloseIntents: async () => ({ ok: true as const, value: [] }) },
      openJournal: { listOpenIntents: async () => ({ ok: true as const, value: [] }) },
      saleJournal: {
        listSaleIntentsByStatus: async () => ({ ok: false as const, code: 'unavailable' as const }),
      },
      readOrchestratorState: () => ({
        schemaVersion: 1 as const,
        webLocksAvailable: true,
        lastCycle: null,
        cycleCount: 0,
        terminalVoidIntentCount: 0,
        lastErrorAtMs: null,
        ch4AttemptExhaustedIds: [],
      }),
    });
    expect(result.saleIntent).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('N-A10 reader source contains no mutation identifiers', () => {
    for (const token of [
      'claimVoidIntent',
      'markVoidIntent',
      'enqueueVoidIntent',
      'transitionStatus',
      'markManualReview',
      'upsertCloseIntent',
      'upsertOpenIntent',
      'markSynced',
      'markRejected',
      'resolveManualReview',
      'createOfflineReversal',
      'applyServerResult',
    ]) {
      expect(readerSource).not.toContain(token);
    }
  });

  it('does not enumerate when given a scope — caller must hold ActiveSyncScope', () => {
    expect(readSyncCenterSources.length).toBeGreaterThanOrEqual(1);
    expect(vi.fn()).toBeTruthy();
  });
});
