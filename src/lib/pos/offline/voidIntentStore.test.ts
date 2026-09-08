import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryReversalStore } from './reversalLocalStore';
import {
  claimVoidIntent,
  countTerminalVoidIntents,
  decideVoidPreflight,
  enqueueVoidIntent,
  enqueueVoidIntentWithPrivilegedFence,
  getVoidIntent,
  listClaimableVoidIntents,
  markVoidIntentConfirmed,
  markVoidIntentRetryable,
  markVoidIntentTerminal,
  subscribeVoidIntentStore,
  utcPlus7Date,
  __resetVoidIntentStoreListenersForTests,
  type VoidIntentRecord,
} from './voidIntentStore';
import { ingestAttestedPrivilegedAction } from './privilegedEvidenceStore';
import type { OfflineAttestationEnvelope } from '../../auth/privilegedAction/offlineAttestation';
import storeSource from './voidIntentStore.ts?raw';

const NOW = 1_700_000_000_000;

afterEach(() => {
  __resetVoidIntentStoreListenersForTests();
});

function input() {
  return {
    branchId: 'LDP-001',
    deviceId: 'dev-1',
    reason: 'ลูกค้าเปลี่ยนใจ',
    note: 'ทดสอบ',
    voidedBy: 'staff-1',
  };
}

describe('voidIntentStore source hygiene', () => {
  it('does not call indexedDB.open', () => {
    expect(storeSource).not.toMatch(/indexedDB\.open\s*\(/);
  });

  it('does not import Firestore', () => {
    expect(storeSource).not.toMatch(/from\s+['"]firebase\/firestore['"]/);
    expect(storeSource).not.toMatch(/from\s+['"]firebase['"]/);
  });
});

describe('utcPlus7Date', () => {
  it('matches calendar date of (ms + 7h) in UTC, not the device timezone', () => {
    // 2026-08-21 16:59:59.000Z → +7h = 2026-08-21 23:59:59 UTC → 2026-08-21
    expect(utcPlus7Date(Date.UTC(2026, 7, 21, 16, 59, 59))).toBe('2026-08-21');
    // 2026-08-21 17:00:00.000Z → +7h = 2026-08-22 00:00:00 UTC → 2026-08-22
    expect(utcPlus7Date(Date.UTC(2026, 7, 21, 17, 0, 0))).toBe('2026-08-22');
  });
});

describe('decideVoidPreflight', () => {
  it('blocks when offline', () => {
    expect(
      decideVoidPreflight({
        isOnline: false,
        nowMs: NOW,
        serverOrder: { exists: true, serverCreatedAtMs: NOW },
      }),
    ).toEqual({ action: 'block', reason: 'not_online' });
  });

  it('blocks PF-1 when the server document is absent', () => {
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: NOW,
        serverOrder: { exists: false, serverCreatedAtMs: null },
      }),
    ).toEqual({ action: 'block', reason: 'order_absent_server_side' });
  });

  it('blocks PF-1 when serverCreatedAt is null', () => {
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: NOW,
        serverOrder: { exists: true, serverCreatedAtMs: null },
      }),
    ).toEqual({ action: 'block', reason: 'order_absent_server_side' });
  });

  it('confirms when the server order is already voided', () => {
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: NOW,
        serverOrder: {
          exists: true,
          serverCreatedAtMs: NOW,
          status: 'voided',
        },
      }),
    ).toEqual({ action: 'confirm', reason: 'order_already_terminal' });
  });

  it('confirms when voidRequested is already true', () => {
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: NOW,
        serverOrder: {
          exists: true,
          serverCreatedAtMs: NOW,
          voidRequested: true,
        },
      }),
    ).toEqual({ action: 'confirm', reason: 'order_already_terminal' });
  });

  it('allows the same UTC+7 calendar date', () => {
    const created = Date.UTC(2026, 7, 21, 10, 0, 0);
    const now = Date.UTC(2026, 7, 21, 16, 0, 0);
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: now,
        serverOrder: { exists: true, serverCreatedAtMs: created },
      }),
    ).toEqual({ action: 'allow' });
  });

  it('blocks PF-2 when serverCreatedAt is the previous UTC+7 date', () => {
    const created = Date.UTC(2026, 7, 20, 10, 0, 0);
    const now = Date.UTC(2026, 7, 21, 10, 0, 0);
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: now,
        serverOrder: { exists: true, serverCreatedAtMs: created },
      }),
    ).toEqual({ action: 'block', reason: 'day_boundary_expired' });
  });

  it('blocks a queued-23:50 / drained-00:10 UTC+7 intent rather than allowing a doomed write', () => {
    const click = Date.UTC(2026, 7, 21, 16, 50, 0); // 23:50 UTC+7
    const drain = Date.UTC(2026, 7, 21, 17, 10, 0); // 00:10 UTC+7 next day
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: drain,
        serverOrder: { exists: true, serverCreatedAtMs: click },
      }),
    ).toEqual({ action: 'block', reason: 'day_boundary_expired' });
  });

  it('uses serverCreatedAt, not a client createdAt stand-in', () => {
    const serverCreated = Date.UTC(2026, 7, 20, 10, 0, 0);
    const clientCreated = Date.UTC(2026, 7, 21, 10, 0, 0);
    const now = clientCreated;
    const decision = decideVoidPreflight({
      isOnline: true,
      nowMs: now,
      serverOrder: { exists: true, serverCreatedAtMs: serverCreated },
    });
    expect(decision).toEqual({ action: 'block', reason: 'day_boundary_expired' });
  });
});

describe('voidIntentStore lifecycle', () => {
  it('enqueue creates pending with attempts 0', async () => {
    const store = createInMemoryReversalStore();
    const result = await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    expect(result.kind).toBe('created');
    expect(result.record.status).toBe('pending');
    expect(result.record.attempts).toBe(0);
    expect(result.record.nextEligibleAtMs).toBe(0);
    expect(result.record.voidedBy).toBe('staff-1');
  });

  it('claim flips pending to in_flight with owner and lease', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    const claimed = await claimVoidIntent(store, 'ord-1', 'owner-a', NOW, 60_000);
    expect(claimed?.status).toBe('in_flight');
    expect(claimed?.claimOwner).toBe('owner-a');
    expect(claimed?.claimExpiresAtMs).toBe(NOW + 60_000);
  });

  it('a live lease blocks a second claim', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await claimVoidIntent(store, 'ord-1', 'owner-a', NOW, 60_000);
    const second = await claimVoidIntent(store, 'ord-1', 'owner-b', NOW + 1_000, 60_000);
    expect(second).toBeNull();
  });

  it('an expired lease is re-claimable', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await claimVoidIntent(store, 'ord-1', 'owner-a', NOW, 1_000);
    const again = await claimVoidIntent(store, 'ord-1', 'owner-b', NOW + 2_000, 60_000);
    expect(again?.claimOwner).toBe('owner-b');
  });

  it('confirmed and terminal are not claimable', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await markVoidIntentConfirmed(store, 'ord-1', NOW);
    expect(await claimVoidIntent(store, 'ord-1', 'o', NOW)).toBeNull();

    await enqueueVoidIntent(store, 'ord-2', input(), NOW);
    await markVoidIntentTerminal(store, 'ord-2', 'day_boundary_expired', 'permission_denied', NOW);
    expect(await claimVoidIntent(store, 'ord-2', 'o', NOW)).toBeNull();
  });

  it('retryable failure returns to pending with attempts+1 and backoff', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await claimVoidIntent(store, 'ord-1', 'o', NOW);
    const next = await markVoidIntentRetryable(store, 'ord-1', 'transport', NOW + 5_000, NOW);
    expect(next?.status).toBe('pending');
    expect(next?.attempts).toBe(1);
    expect(next?.nextEligibleAtMs).toBe(NOW + 5_000);
    expect(await listClaimableVoidIntents(store, NOW + 1_000, { branchId: 'LDP-001', deviceId: 'dev-1' })).toEqual([]);
    expect(await listClaimableVoidIntents(store, NOW + 5_000, { branchId: 'LDP-001', deviceId: 'dev-1' })).toHaveLength(1);
  });

  it('attempts persist across a simulated reload (new store dump/rehydrate)', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await markVoidIntentRetryable(store, 'ord-1', 'transport', NOW + 1, NOW);
    const rec = await getVoidIntent(store, 'ord-1');
    expect(rec?.attempts).toBe(1);

    const dump = store.dump();
    const reloaded = createInMemoryReversalStore();
    await reloaded.transact(['voidIntents'], 'readwrite', async (txn) => {
      await txn.put('voidIntents', 'ord-1', dump.voidIntents['ord-1']);
    });
    expect((await getVoidIntent(reloaded, 'ord-1'))?.attempts).toBe(1);
  });

  it('duplicate enqueue on pending merges payload and does not reset attempts', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await markVoidIntentRetryable(store, 'ord-1', 'transport', NOW + 9_000, NOW);
    const second = await enqueueVoidIntent(
      store,
      'ord-1',
      { ...input(), reason: 'ราคาผิด', voidedBy: 'staff-1' },
      NOW + 1,
    );
    expect(second.kind).toBe('updated');
    expect(second.record.attempts).toBe(1);
    expect(second.record.reason).toBe('ราคาผิด');
    expect(second.record.nextEligibleAtMs).toBe(NOW + 9_000);
    expect(second.record.voidedBy).toBe('staff-1');
  });

  it('re-enqueue on confirmed is a no-op', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await markVoidIntentConfirmed(store, 'ord-1', NOW);
    const again = await enqueueVoidIntent(store, 'ord-1', input(), NOW + 1);
    expect(again.kind).toBe('confirmed_noop');
  });

  it('re-enqueue on terminal is a no-op that returns the terminal record', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await markVoidIntentTerminal(store, 'ord-1', 'day_boundary_expired', 'permission_denied', NOW);
    const again = await enqueueVoidIntent(store, 'ord-1', input(), NOW + 1);
    expect(again.kind).toBe('terminal_noop');
    if (again.kind === 'terminal_noop') {
      expect(again.record.terminalReason).toBe('day_boundary_expired');
    }
  });

  it('two concurrent claims yield exactly one claimed record', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    const [a, b] = await Promise.all([
      claimVoidIntent(store, 'ord-1', 'a', NOW),
      claimVoidIntent(store, 'ord-1', 'b', NOW),
    ]);
    const claimed = [a, b].filter(Boolean) as VoidIntentRecord[];
    expect(claimed).toHaveLength(1);
  });

  it('countTerminalVoidIntents reads durable terminal rows', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    await markVoidIntentTerminal(store, 'ord-1', 'authority_refused', 'permission_denied', NOW);
    expect(await countTerminalVoidIntents(store)).toBe(1);
  });
});

describe('voidIntentStore CH-5 claimable scope', () => {
  const scope = { branchId: 'LDP-001', deviceId: 'dev-1' };

  it('excludes a different branch and leaves that intent claimable for the matching branch later', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-a', { ...input(), branchId: 'LDP-001' }, NOW);
    await enqueueVoidIntent(store, 'ord-b', { ...input(), branchId: 'LDP-002' }, NOW);
    const branchA = await listClaimableVoidIntents(store, NOW, scope);
    expect(branchA.map((r) => r.orderId)).toEqual(['ord-a']);
    const branchB = await listClaimableVoidIntents(store, NOW, { branchId: 'LDP-002', deviceId: 'dev-1' });
    expect(branchB.map((r) => r.orderId)).toEqual(['ord-b']);
  });

  it('excludes a different device', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-a', { ...input(), deviceId: 'dev-1' }, NOW);
    await enqueueVoidIntent(store, 'ord-b', { ...input(), deviceId: 'dev-2' }, NOW);
    const rows = await listClaimableVoidIntents(store, NOW, scope);
    expect(rows.map((r) => r.orderId)).toEqual(['ord-a']);
  });

  it('composes branch/device scope with nextEligibleAt, terminal status, and a live lease', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-ok', input(), NOW);
    await enqueueVoidIntent(store, 'ord-wait', input(), NOW);
    await markVoidIntentRetryable(store, 'ord-wait', 'transport', NOW + 9_000, NOW);
    await enqueueVoidIntent(store, 'ord-term', input(), NOW);
    await markVoidIntentTerminal(store, 'ord-term', 'authority_refused', 'permission_denied', NOW);
    await enqueueVoidIntent(store, 'ord-lease', input(), NOW);
    await claimVoidIntent(store, 'ord-lease', 'owner-a', NOW, 60_000);
    await enqueueVoidIntent(
      store,
      'ord-other-branch',
      { ...input(), branchId: 'LDP-002' },
      NOW,
    );
    const rows = await listClaimableVoidIntents(store, NOW, scope);
    expect(rows.map((r) => r.orderId)).toEqual(['ord-ok']);
  });
});

describe('voidIntentStore same-tab subscription', () => {
  it('notifies listeners on terminalize and unsubscribes cleanly', async () => {
    const store = createInMemoryReversalStore();
    let hits = 0;
    const stop = subscribeVoidIntentStore(() => {
      hits += 1;
    });
    await enqueueVoidIntent(store, 'ord-1', input(), NOW);
    expect(hits).toBe(1);
    await markVoidIntentTerminal(store, 'ord-1', 'staff_identity_mismatch', 'permission_denied', NOW);
    expect(hits).toBe(2);
    stop();
    await enqueueVoidIntent(store, 'ord-2', input(), NOW);
    expect(hits).toBe(2);
  });
});

describe('enqueueVoidIntentWithPrivilegedFence — SEC-001 Packet D / D-3, RC-D3-004 atomic legacy fence', () => {
  const ingestCtx = { ingestStaffId: 'mgr-cashier', ingestDeviceId: 'device-1' };

  function privilegedEnvelope(over: Partial<OfflineAttestationEnvelope> = {}): OfflineAttestationEnvelope {
    return {
      attestationIdHex: 'a'.repeat(32),
      paa1Base64: 'PAA1',
      ssa1Base64: 'SSA1',
      oacEnvelopeBytesBase64: 'OAC1',
      verifiedBranchId: 'LDP-001',
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
      targetOrderId: 'ord-fence',
      targetOrderUtc7Date: '2026-08-21',
      approvingManagerStaffId: 'mgr-1',
      ...over,
    };
  }

  it('with an empty privileged journal, behaves exactly like enqueueVoidIntent (created)', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW);
    expect(outcome.kind).toBe('created');
    expect((await getVoidIntent(store, 'ord-fence'))?.branchId).toBe('LDP-001');
  });

  it('an open privileged row for the same bound (branch, target) blocks: privileged_conflict, zero voidIntent write', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, privilegedEnvelope(), ingestCtx, NOW);
    const outcome = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW);
    expect(outcome).toEqual({ kind: 'privileged_conflict' });
    expect(await getVoidIntent(store, 'ord-fence')).toBeUndefined();
  });

  it('an unreadable privileged row anywhere in the store blocks: unreadable, zero voidIntent write', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'corrupt-1', { garbage: true });
    });
    const outcome = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW);
    expect(outcome).toEqual({ kind: 'unreadable' });
    expect(await getVoidIntent(store, 'ord-fence')).toBeUndefined();
  });

  it('a privileged row on a different branch does not block', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, privilegedEnvelope({ verifiedBranchId: 'LDP-002' }), ingestCtx, NOW);
    const outcome = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW);
    expect(outcome.kind).toBe('created');
  });

  it('a privileged row for a different target order does not block', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, privilegedEnvelope({ targetOrderId: 'ord-other' }), ingestCtx, NOW);
    const outcome = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW);
    expect(outcome.kind).toBe('created');
  });

  it('preserves confirmed_noop / terminal_noop passthrough behavior from the shared enqueue logic', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-fence', input(), NOW);
    await markVoidIntentConfirmed(store, 'ord-fence', NOW + 1);
    const outcome = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW + 2);
    expect(outcome.kind).toBe('confirmed_noop');
  });

  it('notifies same-tab subscribers only on an actual created/updated write, not on a blocked outcome', async () => {
    const store = createInMemoryReversalStore();
    await ingestAttestedPrivilegedAction(store, privilegedEnvelope(), ingestCtx, NOW);
    let hits = 0;
    const stop = subscribeVoidIntentStore(() => {
      hits += 1;
    });
    const blocked = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-fence', input(), 'LDP-001', NOW);
    expect(blocked).toEqual({ kind: 'privileged_conflict' });
    expect(hits).toBe(0);
    const created = await enqueueVoidIntentWithPrivilegedFence(store, 'ord-other', input(), 'LDP-001', NOW);
    expect(created.kind).toBe('created');
    expect(hits).toBe(1);
    stop();
  });
});
