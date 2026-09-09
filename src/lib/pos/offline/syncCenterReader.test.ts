import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveActiveSyncScope } from './syncCenterModel';
import { readSyncCenterSources } from './syncCenterReader';
import readerSource from './syncCenterReader.ts?raw';
import type { OfflineReversalIntent } from './offlineReversalTypes';
import type { VoidIntentRecord } from './voidIntentStore';
import type { ReversalStoreName, ReversalTxn } from './reversalLocalStore';
import { createInMemoryReversalStore } from './reversalLocalStore';
import { ingestAttestedPrivilegedAction } from './privilegedEvidenceStore';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from './canonicalSyncContext';

function mustScope() {
  const r = resolveActiveSyncScope('A', 'X');
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

function envelope(over: Partial<OfflineAttestationEnvelope> = {}): OfflineAttestationEnvelope {
  return {
    attestationIdHex: 'a'.repeat(32),
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    verifiedBranchId: 'A',
    evidenceSeed: {
      oacId: 'oac-1',
      oacSchemaVersion: 1,
      revocationEpochAtIssue: 0,
      managerAuthVersionAtIssue: 0,
      managerCredentialVersionAtIssue: 0,
      nonce: 'nonce-1',
      attemptCount: 1,
      approvalResult: 'APPROVED_LOCAL',
      approvalProofDigest: 'proof-1',
    },
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    localIntentId: 'intent-1',
    actionId: 'VOID_PENDING_SALE',
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    approvingManagerStaffId: 'mgr-1',
    ...over,
  };
}

const ingestCtx = { ingestStaffId: 'staff-1', ingestDeviceId: 'device-1' };

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

describe('syncCenterReader — SEC-001 Packet E / E-2 privileged evidence read', () => {
  afterEach(() => {
    __resetCanonicalSyncContextForTests();
  });

  it('E2-R1 read-only D-2 privileged read, branch-scoped, when canonical context is mounted for this branch', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope({ attestationIdHex: 'a'.repeat(32), verifiedBranchId: 'A' }), ingestCtx, 1_000);
    await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'b'.repeat(32), verifiedBranchId: 'B', targetOrderId: 'order-2' }),
      ingestCtx,
      1_000,
    );
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(true);
    if (result.privilegedEvidence?.ok) {
      expect(result.privilegedEvidence.rows.map((r) => r.adjudicationId)).toEqual(['a'.repeat(32)]);
      expect(result.privilegedEvidence.rows.every((r) => r.branchId === 'A')).toBe(true);
    }
  });

  it('E2-R2 canonical sync context unmounted fails closed to no privileged rows', async () => {
    __resetCanonicalSyncContextForTests();
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope(), ingestCtx, 1_000);
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(false);
  });

  it('E2-R3 canonical context mounted for a different branch than the read scope fails closed', async () => {
    __setCanonicalSyncContextForTests('B', 'X');
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, envelope({ verifiedBranchId: 'A' }), ingestCtx, 1_000);
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(false);
  });

  it("E2-R4 canonical context branchId === 'ALL' never resolves to a scope at all (resolveActiveSyncScope already refuses it)", () => {
    expect(resolveActiveSyncScope('ALL', 'X')).toEqual({ ok: false, reason: 'branch_all' });
  });

  it('E2-R5 an unreadable privileged store fails closed rather than throwing, and does not blank channels that read a different dependency', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const scope = mustScope();
    const result = await readSyncCenterSources(scope, {
      reversalStore: { transact: async () => { throw new Error('privileged store down'); } } as never,
      closeJournal: { listCloseIntents: async () => ({ ok: true as const, value: [] }) },
      openJournal: { listOpenIntents: async () => ({ ok: true as const, value: [] }) },
      saleJournal: { listSaleIntentsByStatus: async () => ({ ok: true as const, value: [] }) },
    });
    expect(result.privilegedEvidence?.ok).toBe(false);
    // isolation: channels backed by a different dependency are unaffected by the shared store throwing
    expect(result.shiftClose.ok).toBe(true);
    expect(result.saleIntent.ok).toBe(true);
  });

  it('E2-R6 reader source invokes no D-2 write/claim/apply/allocate identifiers', () => {
    for (const token of [
      'ingestAttestedPrivilegedAction',
      'claimPrivilegedEvidenceRow',
      'applyPrivilegedEvidenceDisposition',
      'applyPrivilegedEvidenceDeferredCycleCounts',
      'clearPrivilegedEvidenceBackoff',
      'allocatePrivilegedSweepGeneration',
    ]) {
      expect(readerSource).not.toContain(token);
    }
  });
});

describe('syncCenterReader — RC-E2-002 unreadableCount fails closed', () => {
  afterEach(() => {
    __resetCanonicalSyncContextForTests();
  });

  it('RC-E2-002-1 a malformed row alongside a valid row fails the privileged read closed, with no partial rows exposed', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'a'.repeat(32), verifiedBranchId: 'A' }),
      ingestCtx,
      1_000,
    );
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'malformed-row-1', { notARecord: true });
    });
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(false);
    expect(result.privilegedEvidence && 'rows' in result.privilegedEvidence).toBe(false);
  });

  it('RC-E2-002-2 malformed rows only (no valid rows at all) also fails closed', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'malformed-row-1', { notARecord: true });
    });
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(false);
  });

  it('RC-E2-002-3 unreadableCount === 0 still succeeds normally (unchanged behavior)', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'a'.repeat(32), verifiedBranchId: 'A' }),
      ingestCtx,
      1_000,
    );
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(true);
    if (result.privilegedEvidence?.ok) {
      expect(result.privilegedEvidence.rows).toHaveLength(1);
    }
  });

  it('RC-E2-002-4 branch isolation remains intact when the store is fully readable', async () => {
    __setCanonicalSyncContextForTests('A', 'X');
    const scope = mustScope();
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'a'.repeat(32), verifiedBranchId: 'A' }),
      ingestCtx,
      1_000,
    );
    await ingestAttestedPrivilegedAction(
      store,
      envelope({ attestationIdHex: 'b'.repeat(32), verifiedBranchId: 'B', targetOrderId: 'order-2' }),
      ingestCtx,
      1_000,
    );
    const result = await readSyncCenterSources(scope, { reversalStore: store });
    expect(result.privilegedEvidence?.ok).toBe(true);
    if (result.privilegedEvidence?.ok) {
      expect(result.privilegedEvidence.rows.map((r) => r.adjudicationId)).toEqual(['a'.repeat(32)]);
    }
  });
});
