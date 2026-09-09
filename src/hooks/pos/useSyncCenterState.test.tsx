// @vitest-environment jsdom

import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryReversalStore } from '../../lib/pos/offline/reversalLocalStore';
import {
  type ActiveSyncScope,
  type SyncCenterReadResult,
} from '../../lib/pos/offline/syncCenterModel';
import {
  __resetCanonicalSyncContextForTests,
  __setCanonicalSyncContextForTests,
} from '../../lib/pos/offline/canonicalSyncContext';
import { enqueueVoidIntent } from '../../lib/pos/offline/voidIntentStore';
import { ingestAttestedPrivilegedAction } from '../../lib/pos/offline/privilegedEvidenceStore';
import { useSyncCenterState } from './useSyncCenterState';
import hookSource from './useSyncCenterState.ts?raw';

const auth = vi.hoisted(() => ({
  user: { role: 'manager' as 'manager' | 'staff' | 'admin' },
  session: {},
  branchId: 'A' as string | null,
  firebaseUser: { uid: 'u1' },
  deviceId: 'X',
}));

vi.mock('../../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: auth.user,
    session: auth.session,
    branchId: auth.branchId,
    firebaseUser: auth.firebaseUser,
  }),
}));

vi.mock('../../lib/pos/deviceId', () => ({
  getDeviceId: () => auth.deviceId,
}));

const NOW = 1_700_000_000_000;

function emptyRead(scope: ActiveSyncScope, over: Partial<SyncCenterReadResult> = {}): SyncCenterReadResult {
  return {
    scope,
    reversal: { ok: true, rows: [] },
    voidIntent: { ok: true, rows: [] },
    shiftClose: { ok: true, rows: [] },
    shiftOpen: { ok: true, rows: [] },
    saleIntent: { ok: true, rows: [] },
    privilegedEvidence: { ok: true, rows: [] },
    orchestrator: { lastCycle: null, webLocksAvailable: true, ch4AttemptExhaustedIds: [] },
    isOnline: true,
    ...over,
  };
}

function privilegedAttentionRow(adjudicationId: string, branchId: string) {
  return {
    schemaVersion: 1 as const,
    adjudicationId,
    localIntentId: 'intent-1',
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    evidenceBindingDigest: 'digest-1',
    actionId: 'VOID_PENDING_SALE' as const,
    targetOrderId: 'order-1',
    targetOrderUtc7Date: '2026-09-07',
    branchId,
    approvingManagerStaffId: 'mgr-1',
    oacId: 'oac-1',
    oacSchemaVersion: 1 as const,
    revocationEpochAtIssue: 0,
    managerAuthVersionAtIssue: 0,
    managerCredentialVersionAtIssue: 0,
    nonce: 'nonce-1',
    approvalProofDigest: 'proof-1',
    attestationAttemptCount: 1,
    approvalResult: 'APPROVED_LOCAL' as const,
    trustedApprovalLowerMs: NOW - 1000,
    trustedApprovalUpperMs: NOW,
    pendingExecutionExpiresAtMs: NOW + 100_000,
    syncStatus: 'MANUAL_ATTENTION' as const,
    manualReviewStatus: 'REQUIRED' as const,
    localTerminalReason: null,
    submissionClaims: 1,
    unresolvedClaimCount: 0,
    retryableFailureCount: 0,
    relayDeferrals: 0,
    deferredCycleCount: 0,
    nextAttemptAtMs: NOW,
    claimOwner: null,
    claimGeneration: null,
    createdAtMs: NOW - 5000,
    updatedAtMs: NOW,
    lastAttemptAtMs: NOW,
    lastDispositionKind: 'MANUAL_ATTENTION_REQUIRED' as const,
    lastRelayCallerStaffId: null,
    lastCallerDependentStaffId: null,
    integrityConflict: false,
    ingestStaffId: 'staff-1',
    ingestDeviceId: 'device-1',
    resultingVoidIntentId: null,
    serverVerdict: null,
    serverReason: 'server_review_flagged',
    serverAdjudicationId: 'srv-1',
    serverTargetOrderId: 'order-1',
    offlineExecutionId: null,
    outcomeKind: null,
    serverAdjudicatedAtMs: NOW,
    serverObservedAtMs: null,
    serverIdempotentReplay: false,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  __resetCanonicalSyncContextForTests();
  auth.user = { role: 'manager' };
  auth.branchId = 'A';
  auth.deviceId = 'X';
});

describe('useSyncCenterState', () => {
  beforeEach(() => {
    __setCanonicalSyncContextForTests('A', 'X');
  });

  it('N-S1 a void-store notification refreshes without remount', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) => emptyRead(scope));
    const store = createInMemoryReversalStore();
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: store,
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const afterMount = read.mock.calls.length;
    await enqueueVoidIntent(
      store,
      'ord-live',
      { branchId: 'A', deviceId: 'X', reason: 'x', voidedBy: 's' },
      NOW,
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(afterMount));
    expect(result.current.view.status).toBe('scoped');
  });

  it('N-S2 / N-S5 pending count tracks unifiedPending and survives offline', async () => {
    const nav = { onLine: false };
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, {
        isOnline: false,
        reversal: {
          ok: true,
          rows: [
            {
              id: 'r1',
              businessId: 'biz',
              sourceType: 'receiving',
              sourceId: 'src',
              action: 'void',
              branchId: 'A',
              reasonCode: 'x',
              createdAt: new Date(NOW).toISOString(),
              createdByStaffId: 's1',
              createdByRole: 'manager',
              idempotencyKey: 'k',
              localMutationId: 'm',
              localCorrection: { applied: true, reversed: false, stockDelta: [] },
              status: 'queued',
            },
          ],
        },
      }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: nav,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.isOnline).toBe(false);
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.unifiedPending).toBe(1);
    }
  });

  it('N-S6 unavailable channel forbids a clean last-check', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, { saleIntent: { ok: false, reason: 'unavailable' } }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.unavailableChannelCount).toBeGreaterThan(0);
      expect(result.current.view.aggregate.lastSyncCheckAtMs).toBeNull();
    }
  });

  it('N-S7 unmount releases the interval and ignores later reads', async () => {
    let readCount = 0;
    const read = vi.fn(async (scope: ActiveSyncScope) => {
      readCount += 1;
      return emptyRead(scope);
    });
    const { unmount } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(readCount).toBeGreaterThan(0));
    const before = readCount;
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readCount).toBe(before);
  });

  it('ALL branch fails closed with counts absent', async () => {
    auth.branchId = 'ALL';
    const read = vi.fn(async (scope: ActiveSyncScope) => emptyRead(scope));
    const { result } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => NOW,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view).toEqual({ status: 'scope_unavailable', reason: 'branch_all' });
    expect(read).not.toHaveBeenCalled();
  });

  it('strips lastCycle from a previous branch', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, {
        orchestrator: {
          lastCycle: {
            trigger: 'MANUAL_INVOCATION',
            startedAtMs: 1,
            durationMs: 5,
            completed: true,
            gateOutcome: 'ran',
            channels: [{ channel: 'sale_intent', status: 'ok' }],
          },
          webLocksAvailable: true,
          ch4AttemptExhaustedIds: [],
        },
      }),
    );
    let now = 10;
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({
        read,
        reversalStore: createInMemoryReversalStore(),
        now: () => now,
        intervalMs: 60_000,
        navigatorRef: { onLine: true },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    now = 50;
    auth.branchId = 'B';
    rerender();
    await waitFor(() => {
      expect(result.current.scope?.branchId).toBe('B');
    });
    await waitFor(() => {
      if (result.current.view.status === 'scoped') {
        expect(result.current.view.aggregate.lastSyncCheckAtMs).toBeNull();
      }
    });
  });
});

describe('useSyncCenterState — SEC-001 Packet E / E-2 privileged (non-channel) composition', () => {
  beforeEach(() => {
    __setCanonicalSyncContextForTests('A', 'X');
  });

  it('E2-H1 composes privileged attention into the aggregate; no manual-action callback is exposed', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, {
        privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
      }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toHaveLength(1);
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(1);
      expect(result.current.view.aggregate.unifiedAttention).toBe(1);
    }
    expect(Object.keys(result.current)).not.toContain('resolvePrivileged');
    expect(Object.keys(result.current)).not.toContain('retryPrivileged');
    expect(Object.keys(result.current)).not.toContain('approvePrivileged');
  });

  it('E2-H2 an unavailable privileged read is treated as empty/unavailable, not as an error for the rest of the page', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, { privilegedEvidence: { ok: false, reason: 'canonical_sync_context_unavailable' } }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toEqual([]);
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(0);
      expect(result.current.view.aggregate.privilegedAvailability).toBe('unavailable');
    }
  });

  it('E2-H3 a stale privileged read for the previous branch does not leak into the new branch view', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, {
        privilegedEvidence: {
          ok: true,
          rows: scope.branchId === 'A' ? [privilegedAttentionRow('a'.repeat(32), 'A')] : [],
        },
      }),
    );
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(1);
    }
    auth.branchId = 'B';
    __setCanonicalSyncContextForTests('B', 'X');
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));
    await waitFor(() => {
      if (result.current.view.status === 'scoped') {
        expect(result.current.view.aggregate.privilegedRows).toEqual([]);
        expect(result.current.view.aggregate.privilegedAttentionCount).toBe(0);
      }
    });
  });

  it("E2-H4 'ALL' branch fails closed for the whole page, privileged section included", async () => {
    auth.branchId = 'ALL';
    const read = vi.fn(async (scope: ActiveSyncScope) => emptyRead(scope));
    const { result } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view).toEqual({ status: 'scope_unavailable', reason: 'branch_all' });
    expect(read).not.toHaveBeenCalled();
  });

  it('E2-H5 missing canonical context is composed as an unavailable privileged section, not a thrown error', async () => {
    __resetCanonicalSyncContextForTests();
    const read = vi.fn(async (scope: ActiveSyncScope) =>
      emptyRead(scope, { privilegedEvidence: { ok: false, reason: 'canonical_sync_context_unavailable' } }),
    );
    const { result } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedAvailability).toBe('unavailable');
    }
  });

  it('E2-H6 a privileged-evidence store notification refreshes without remount', async () => {
    const read = vi.fn(async (scope: ActiveSyncScope) => emptyRead(scope));
    const store = createInMemoryReversalStore();
    const { result } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: store, now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const afterMount = read.mock.calls.length;
    await ingestAttestedPrivilegedAction(
      store,
      {
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
      },
      { ingestStaffId: 'staff-1', ingestDeviceId: 'device-1' },
      NOW,
    );
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(afterMount));
    expect(result.current.view.status).toBe('scoped');
  });
});

describe('useSyncCenterState — RC-E2-001 monotonic scope/read generation fence', () => {
  beforeEach(() => {
    __setCanonicalSyncContextForTests('A', 'X');
  });

  it('RC-E2-001-D1 an unresolved A read that resolves after switching to B must not apply', async () => {
    let capturedAScope: ActiveSyncScope | null = null;
    const defA = deferred<SyncCenterReadResult>();
    const read = vi.fn((scope: ActiveSyncScope) => {
      if (scope.branchId === 'A') {
        capturedAScope = scope;
        return defA.promise;
      }
      return Promise.resolve(emptyRead(scope));
    });
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(result.current.status).toBe('pending');

    auth.branchId = 'B';
    __setCanonicalSyncContextForTests('B', 'X');
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));
    // Still pending: the single async loop is still awaiting A's deferred read.
    expect(result.current.status).toBe('pending');

    defA.resolve(
      emptyRead(capturedAScope!, {
        privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toEqual([]);
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(0);
    }
    expect(read.mock.calls.some((c) => c[0].branchId === 'B')).toBe(true);
  });

  it('RC-E2-001-D2 a scope switch to B whose read rejects does not leave A privileged rows visible', async () => {
    const read = vi.fn((scope: ActiveSyncScope) => {
      if (scope.branchId === 'A') {
        return Promise.resolve(
          emptyRead(scope, {
            privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
          }),
        );
      }
      return Promise.reject(new Error('B read failed'));
    });
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(1);
    }

    auth.branchId = 'B';
    __setCanonicalSyncContextForTests('B', 'X');
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toEqual([]);
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(0);
      expect(result.current.view.aggregate.unavailableChannelCount).toBeGreaterThan(0);
    }
  });

  it('RC-E2-001-D3 A -> B -> B resolves -> B wins', async () => {
    const read = vi.fn((scope: ActiveSyncScope) =>
      Promise.resolve(
        emptyRead(scope, {
          privilegedEvidence: {
            ok: true,
            rows: scope.branchId === 'B' ? [privilegedAttentionRow('b'.repeat(32), 'B')] : [],
          },
        }),
      ),
    );
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    auth.branchId = 'B';
    __setCanonicalSyncContextForTests('B', 'X');
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toHaveLength(1);
      expect(result.current.view.aggregate.privilegedRows[0].id).toBe('b'.repeat(32));
    }
  });

  it('RC-E2-001-D4 rapid A -> B -> A: an in-flight first-A generation must not apply once back on the second A generation', async () => {
    let firstACapturedScope: ActiveSyncScope | null = null;
    let aReadCount = 0;
    const defFirstA = deferred<SyncCenterReadResult>();
    const read = vi.fn((scope: ActiveSyncScope) => {
      if (scope.branchId === 'A') {
        aReadCount += 1;
        if (aReadCount === 1) {
          firstACapturedScope = scope;
          return defFirstA.promise;
        }
        return Promise.resolve(emptyRead(scope));
      }
      return Promise.resolve(emptyRead(scope));
    });
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(result.current.status).toBe('pending');

    auth.branchId = 'B';
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));

    auth.branchId = 'A';
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('A'));
    // Still pending: the single async loop is still awaiting the FIRST A generation's read.
    expect(result.current.status).toBe('pending');

    defFirstA.resolve(
      emptyRead(firstACapturedScope!, {
        privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toEqual([]);
    }
    expect(aReadCount).toBeGreaterThanOrEqual(2);
  });

  it("RC-E2-001-D5 switching to 'ALL' clears privileged rows immediately, in the same render as the switch", async () => {
    const read = vi.fn((scope: ActiveSyncScope) =>
      Promise.resolve(
        emptyRead(scope, {
          privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
        }),
      ),
    );
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(1);
    }

    auth.branchId = 'ALL';
    rerender();
    // Immediate — no waitFor needed for the fail-closed transition itself.
    expect(result.current.view).toEqual({ status: 'scope_unavailable', reason: 'branch_all' });
  });

  it('RC-E2-001-D6 canonical context disappearing mid-lifecycle still fails closed for privileged rows', async () => {
    let callCount = 0;
    const read = vi.fn((scope: ActiveSyncScope) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          emptyRead(scope, {
            privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
          }),
        );
      }
      return Promise.resolve(
        emptyRead(scope, { privilegedEvidence: { ok: false, reason: 'canonical_sync_context_unavailable' } }),
      );
    });
    const { result } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(1);
    }

    __resetCanonicalSyncContextForTests();
    result.current.refresh();
    await waitFor(() => {
      if (result.current.view.status === 'scoped') {
        expect(result.current.view.aggregate.privilegedAvailability).toBe('unavailable');
      }
    });
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.privilegedRows).toEqual([]);
      expect(result.current.view.aggregate.privilegedAttentionCount).toBe(0);
    }
  });

  it('RC-E2-001-D7 unmount then a late-resolving read applies nothing', async () => {
    let capturedScope: ActiveSyncScope | null = null;
    const def = deferred<SyncCenterReadResult>();
    const read = vi.fn((scope: ActiveSyncScope) => {
      capturedScope = scope;
      return def.promise;
    });
    const { result, unmount } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(result.current.status).toBe('pending');

    unmount();
    def.resolve(
      emptyRead(capturedScope!, {
        privilegedEvidence: { ok: true, rows: [privilegedAttentionRow('a'.repeat(32), 'A')] },
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.status).toBe('pending');
  });

  it('RC-E2-001-D8 a rerun that arrives while a read is in flight after a scope change uses the live scope, not the one captured before the change', async () => {
    let capturedAScope: ActiveSyncScope | null = null;
    let bReadCount = 0;
    const defA = deferred<SyncCenterReadResult>();
    const read = vi.fn((scope: ActiveSyncScope) => {
      if (scope.branchId === 'A') {
        capturedAScope = scope;
        return defA.promise;
      }
      bReadCount += 1;
      return Promise.resolve(emptyRead(scope));
    });
    const { result, rerender } = renderHook(() =>
      useSyncCenterState({ read, reversalStore: createInMemoryReversalStore(), now: () => NOW, intervalMs: 60_000, navigatorRef: { onLine: true } }),
    );
    await waitFor(() => expect(read).toHaveBeenCalled());

    auth.branchId = 'B';
    __setCanonicalSyncContextForTests('B', 'X');
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));
    // A rerun requested while the stale A read is still in flight.
    result.current.refresh();

    defA.resolve(emptyRead(capturedAScope!));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(bReadCount).toBeGreaterThan(0);
    expect(result.current.scope?.branchId).toBe('B');
  });

  // RC-E2-001, requirement #6/#10 — an ordinary `rerender()` only ever
  // exercises committed renders. StrictMode is the strongest concurrency
  // harness available in this stack for proving render-phase purity: React
  // double-invokes the component's render body (and, once, its mount
  // effects) precisely to catch state corruption from a render pass that
  // never commits, or that runs more than once before committing.
  it('RC-E2-001-D9 StrictMode double-render/double-effect on mount does not corrupt the committed generation fence for a subsequent real scope change', async () => {
    const read = vi.fn((scope: ActiveSyncScope) =>
      Promise.resolve(
        emptyRead(scope, {
          privilegedEvidence: {
            ok: true,
            rows: scope.branchId === 'B' ? [privilegedAttentionRow('b'.repeat(32), 'B')] : [],
          },
        }),
      ),
    );
    const { result, rerender } = renderHook(
      () =>
        useSyncCenterState({
          read,
          reversalStore: createInMemoryReversalStore(),
          now: () => NOW,
          intervalMs: 60_000,
          navigatorRef: { onLine: true },
        }),
      { wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.view.status).toBe('scoped');
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.scopeBranchId).toBe('A');
      expect(result.current.view.aggregate.privilegedRows).toEqual([]);
    }

    auth.branchId = 'B';
    __setCanonicalSyncContextForTests('B', 'X');
    rerender();
    await waitFor(() => expect(result.current.scope?.branchId).toBe('B'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    if (result.current.view.status === 'scoped') {
      expect(result.current.view.aggregate.scopeBranchId).toBe('B');
      expect(result.current.view.aggregate.privilegedRows).toHaveLength(1);
      expect(result.current.view.aggregate.privilegedRows[0].id).toBe('b'.repeat(32));
    }
  });

  // RC-E2-001, requirements #8/#9 — a static purity check on the exact
  // render-derived fail-closed mask block (the "remediation logic"): it must
  // never call setView/setStatus and never write a committed-authority ref,
  // no matter how many times React invokes it before (or without) a commit.
  it('RC-E2-001-D10 the render-derived fail-closed mask block contains no state setter and no committed-authority ref write', () => {
    const maskStart = hookSource.indexOf('pure, render-derived fail-closed mask');
    const maskEnd = hookSource.indexOf('const applyView = useCallback');
    expect(maskStart).toBeGreaterThan(-1);
    expect(maskEnd).toBeGreaterThan(maskStart);
    const maskBlock = hookSource.slice(maskStart, maskEnd);
    expect(maskBlock).not.toMatch(/setView\(|setStatus\(/);
    expect(maskBlock).not.toMatch(/\.current\s*=[^=]/);
  });
});
