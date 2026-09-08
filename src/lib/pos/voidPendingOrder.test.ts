import { describe, test, expect } from 'vitest';
import { createInMemoryReversalStore } from './offline/reversalLocalStore';
import {
  enqueueVoidIntent,
  getVoidIntent,
} from './offline/voidIntentStore';
import {
  buildPendingVoidFields,
  classifyVoidWriteError,
  decideVoidPreflight,
  drainOneVoidIntent,
  requestPendingVoid,
  utcPlus7Date,
} from './voidPendingOrder';
import voidPendingSource from './voidPendingOrder.ts?raw';
import {
  applyPrivilegedEvidenceDisposition,
  claimPrivilegedEvidenceRow,
  ingestAttestedPrivilegedAction,
  listPrivilegedEvidence,
} from './offline/privilegedEvidenceStore';
import { classifyOfflineAdjudicationResponse } from '../auth/privilegedAction/offlineAdjudicationTransport';
import type { OfflineAdjudicationResponse } from '../auth/privilegedAction/offlineAdjudicationTransport';
import type { OfflineAttestationEnvelope } from '../auth/privilegedAction/offlineAttestation';

describe('buildPendingVoidFields', () => {
  test('sets the queueable void-intent flags', () => {
    const fields = buildPendingVoidFields({ reason: 'ลูกค้าเปลี่ยนใจ', voidedBy: 'staff-1' });
    expect(fields).toEqual({
      voidRequested: true,
      status: 'voided',
      voidReason: 'ลูกค้าเปลี่ยนใจ',
      voidedBy: 'staff-1',
    });
  });

  test('combines reason + note as "reason — note"', () => {
    const fields = buildPendingVoidFields({
      reason: 'สินค้าผิด',
      note: 'หยิบผิดรส',
      voidedBy: 'staff-1',
    });
    expect(fields.voidReason).toBe('สินค้าผิด — หยิบผิดรส');
  });

  test('trims the note and ignores a whitespace-only note', () => {
    expect(
      buildPendingVoidFields({ reason: 'ราคาผิด', note: '  ', voidedBy: 's' }).voidReason,
    ).toBe('ราคาผิด');
    expect(
      buildPendingVoidFields({ reason: 'ราคาผิด', note: '  พิมพ์ผิด  ', voidedBy: 's' }).voidReason,
    ).toBe('ราคาผิด — พิมพ์ผิด');
  });

  test('always flags voidRequested + status voided (drives the tombstone + ledger exclusion)', () => {
    const fields = buildPendingVoidFields({ reason: 'x', voidedBy: 'y' });
    expect(fields.voidRequested).toBe(true);
    expect(fields.status).toBe('voided');
  });
});

const NOW = Date.UTC(2026, 7, 21, 10, 0, 0);

function enqueueInput() {
  return {
    branchId: 'LDP-001',
    deviceId: 'dev-1',
    reason: 'ลูกค้าเปลี่ยนใจ',
    note: 'ทดสอบ',
    voidedBy: 'staff-original',
  };
}

describe('voidPendingOrder source: seven-field write + voidedBy replay', () => {
  test('the Firestore merge enumerates exactly the seven permitted keys', () => {
    expect(voidPendingSource).toMatch(/voidRequested/);
    expect(voidPendingSource).toMatch(/status: 'voided'/);
    expect(voidPendingSource).toMatch(/voidReason/);
    expect(voidPendingSource).toMatch(/voidedBy: rec\.voidedBy/);
    expect(voidPendingSource).toMatch(/deviceId: getDeviceId\(\)/);
    expect(voidPendingSource).toMatch(/voidedAt: serverTimestamp\(\)/);
    expect(voidPendingSource).toMatch(/updatedAt: serverTimestamp\(\)/);
    expect(voidPendingSource).toMatch(/Seven permitted keys only/);
  });
});

describe('requestPendingVoid outcomes', () => {
  test('durable enqueue happens first and returns queued when Firebase is unavailable', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-q',
      { reason: 'ลูกค้าเปลี่ยนใจ', note: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'queued' });
    const rec = await getVoidIntent(store, 'ord-q');
    expect(rec?.status).toBe('pending');
    expect(rec?.attempts).toBe(0);
  });

  test('re-request of a confirmed intent is confirmed', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-c', enqueueInput(), NOW);
    const first = await drainOneVoidIntent('ord-c', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW, status: 'voided' },
      }),
      writeVoid: async () => {
        throw new Error('must not write');
      },
    });
    expect(first).toBe('confirmed');
    const outcome = await requestPendingVoid(
      'ord-c',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW + 1,
      store,
    );
    expect(outcome).toEqual({ kind: 'confirmed' });
  });

  test('re-request of a terminal intent returns blocked with the stored reason', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-t', enqueueInput(), NOW);
    await drainOneVoidIntent('ord-t', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: Date.UTC(2026, 7, 20, 10, 0, 0) },
      }),
      writeVoid: async () => {
        throw new Error('must not write');
      },
    });
    const outcome = await requestPendingVoid(
      'ord-t',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW + 1,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'day_boundary_expired' });
  });
});

describe('requestPendingVoid — GD-D3-003 legacy no-bypass fence', () => {
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

  const ingestCtx = { ingestStaffId: 'mgr-cashier', ingestDeviceId: 'device-1' };

  async function seedPrivilegedRow(
    store: ReturnType<typeof createInMemoryReversalStore>,
    status: 'PRIVILEGED_INTENT_QUEUED' | 'SYNCING' | 'SERVER_ACCEPTED' | 'SERVER_REJECTED' | 'MANUAL_ATTENTION',
  ): Promise<void> {
    const env = privilegedEnvelope();
    await ingestAttestedPrivilegedAction(store, env, ingestCtx, NOW);
    if (status === 'PRIVILEGED_INTENT_QUEUED') return;
    const claim = await claimPrivilegedEvidenceRow(store, env.attestationIdHex, 1, {
      deviceId: 'device-1',
      nowMs: NOW,
      staffId: 'mgr-cashier',
    });
    if (claim.kind !== 'claimed') throw new Error('setup: claim failed');
    if (status === 'SYNCING') return;

    if (status === 'SERVER_ACCEPTED') {
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'ACCEPTED',
        adjudicationId: env.attestationIdHex,
        targetOrderId: env.targetOrderId,
        offlineExecutionId: 'exec-1',
        outcomeKind: 'VOID_APPLIED',
        idempotent: false,
        serverAdjudicatedAtMs: NOW,
      };
      await applyPrivilegedEvidenceDisposition(
        store,
        env.attestationIdHex,
        1,
        { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
        { nowMs: NOW, staffId: 'mgr-cashier' },
      );
      return;
    }

    if (status === 'SERVER_REJECTED') {
      const response: OfflineAdjudicationResponse = {
        family: 'ADJUDICATION',
        kind: 'REJECTED',
        adjudicationId: env.attestationIdHex,
        targetOrderId: env.targetOrderId,
        rejectionReason: 'trusted_time_bounds_invalid',
        terminal: true,
        idempotent: false,
        serverAdjudicatedAtMs: NOW,
      };
      await applyPrivilegedEvidenceDisposition(
        store,
        env.attestationIdHex,
        1,
        { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
        { nowMs: NOW, staffId: 'mgr-cashier' },
      );
      return;
    }

    // MANUAL_ATTENTION
    const response: OfflineAdjudicationResponse = {
      family: 'ADJUDICATION',
      kind: 'MANUAL_ATTENTION_REQUIRED',
      adjudicationId: env.attestationIdHex,
      targetOrderId: env.targetOrderId,
      manualAttentionReason: 'canonical_correlation_missing',
      terminal: true,
      idempotent: false,
      serverAdjudicatedAtMs: NOW,
    };
    await applyPrivilegedEvidenceDisposition(
      store,
      env.attestationIdHex,
      1,
      { kind: 'server', response, disposition: classifyOfflineAdjudicationResponse(response) },
      { nowMs: NOW, staffId: 'mgr-cashier' },
    );
  }

  test('an empty privileged journal leaves existing behavior unchanged', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-fence',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'queued' });
    expect((await getVoidIntent(store, 'ord-fence'))?.status).toBe('pending');
  });

  test.each([
    ['PRIVILEGED_INTENT_QUEUED'],
    ['SYNCING'],
    ['SERVER_ACCEPTED'],
    ['MANUAL_ATTENTION'],
  ] as const)('an open %s privileged row blocks the legacy path, no legacy void intent created', async (status) => {
    const store = createInMemoryReversalStore();
    await seedPrivilegedRow(store, status);
    const outcome = await requestPendingVoid(
      'ord-fence',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-fence')).toBeUndefined();
  });

  test('SERVER_REJECTED does not block the legacy path', async () => {
    const store = createInMemoryReversalStore();
    await seedPrivilegedRow(store, 'SERVER_REJECTED');
    const outcome = await requestPendingVoid(
      'ord-fence',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'queued' });
    expect((await getVoidIntent(store, 'ord-fence'))?.status).toBe('pending');
  });

  test('a different target order is never blocked', async () => {
    const store = createInMemoryReversalStore();
    await seedPrivilegedRow(store, 'SYNCING');
    const outcome = await requestPendingVoid(
      'ord-other',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'queued' });
  });

  test('a privileged journal read error fails closed and creates no legacy void intent', async () => {
    const throwingStore = {
      transact: async () => {
        throw new Error('durable read failure');
      },
    };
    const outcome = await requestPendingVoid(
      'ord-fence',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      throwingStore,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
  });
});

describe('requestPendingVoid — RC-D3-003 target-branch binding', () => {
  test('branch-A order + current branch-B fails closed before any legacy write', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-cross-branch',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-002', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-cross-branch')).toBeUndefined();
  });

  test('target branch equal to current branch proceeds normally', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-match',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'queued' });
    expect((await getVoidIntent(store, 'ord-match'))?.branchId).toBe('LDP-001');
  });

  test('current branch ALL fails closed', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-all-current',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'ALL', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-all-current')).toBeUndefined();
  });

  test('target order branch ALL fails closed', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-all-target',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'ALL' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-all-target')).toBeUndefined();
  });

  test('an empty/absent target order branch fails closed', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-empty-target',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: '' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-empty-target')).toBeUndefined();
  });
});

describe('requestPendingVoid — RC-D3-002 unreadable privileged state fails closed', () => {
  test('an unreadable privileged row blocks the legacy enqueue, zero legacy write', async () => {
    const store = createInMemoryReversalStore();
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'corrupt-1', { garbage: true });
    });
    const outcome = await requestPendingVoid(
      'ord-corrupt',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-corrupt')).toBeUndefined();
  });
});

describe('requestPendingVoid / ingestAttestedPrivilegedAction — RC-D3-004 atomic no-bypass race', () => {
  const ingestCtx = { ingestStaffId: 'mgr-cashier', ingestDeviceId: 'device-1' };

  function raceEnvelope(): OfflineAttestationEnvelope {
    return {
      attestationIdHex: 'f'.repeat(32),
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
        nonce: 'nonce-race',
        attemptCount: 1,
        approvalResult: 'APPROVED_LOCAL',
        approvalProofDigest: 'proof-race',
      },
      trustedApprovalLowerMs: 1_000,
      trustedApprovalUpperMs: 2_000,
      pendingExecutionExpiresAtMs: 100_000,
      localIntentId: 'intent-race',
      actionId: 'VOID_PENDING_SALE',
      targetOrderId: 'ord-race',
      targetOrderUtc7Date: '2026-08-21',
      approvingManagerStaffId: 'mgr-1',
    };
  }

  test('Ordering A — privileged projection commits first: legacy enqueue blocks, zero legacy write', async () => {
    const store = createInMemoryReversalStore();
    const ingestOutcome = await ingestAttestedPrivilegedAction(
      store,
      raceEnvelope(),
      { ...ingestCtx, expectNoOpenRowForTarget: true },
      NOW,
    );
    expect(ingestOutcome.kind).toBe('created');

    const outcome = await requestPendingVoid(
      'ord-race',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'authority_refused' });
    expect(await getVoidIntent(store, 'ord-race')).toBeUndefined();
  });

  test('Ordering B — legacy enqueue commits first: the reverse D-2 opted-in check refuses the privileged row', async () => {
    const store = createInMemoryReversalStore();
    const outcome = await requestPendingVoid(
      'ord-race',
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
      NOW,
      store,
    );
    expect(outcome).toEqual({ kind: 'queued' });
    expect((await getVoidIntent(store, 'ord-race'))?.status).toBe('pending');

    const ingestOutcome = await ingestAttestedPrivilegedAction(
      store,
      raceEnvelope(),
      { ...ingestCtx, expectNoOpenRowForTarget: true },
      NOW + 1,
    );
    expect(ingestOutcome).toEqual({ kind: 'legacy_conflict' });
    expect(await listPrivilegedEvidence(store)).toHaveLength(0);
  });

  test('true concurrency: exactly one authority path wins, never both', async () => {
    const store = createInMemoryReversalStore();
    const [ingestOutcome, voidOutcome] = await Promise.all([
      ingestAttestedPrivilegedAction(store, raceEnvelope(), { ...ingestCtx, expectNoOpenRowForTarget: true }, NOW),
      requestPendingVoid(
        'ord-race',
        { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001', targetOrderBranchId: 'LDP-001' },
        NOW,
        store,
      ),
    ]);

    const privilegedRows = await listPrivilegedEvidence(store);
    const voidIntent = await getVoidIntent(store, 'ord-race');
    const privilegedWon = ingestOutcome.kind === 'created';
    const legacyWon = voidOutcome.kind === 'queued' || voidOutcome.kind === 'confirmed';

    // Exactly one authority path landed a live record — never both, never neither.
    expect(privilegedWon !== legacyWon).toBe(true);
    if (privilegedWon) {
      expect(privilegedRows).toHaveLength(1);
      expect(voidIntent).toBeUndefined();
      expect(ingestOutcome.kind).toBe('created');
    } else {
      expect(privilegedRows).toHaveLength(0);
      expect(voidIntent).not.toBeUndefined();
      expect(ingestOutcome).toEqual({ kind: 'legacy_conflict' });
    }
  });
});

describe('drainOneVoidIntent preflight', () => {
  test('PF-1 absent document issues no write and does not increment attempts', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    let writes = 0;
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: false, serverCreatedAtMs: null },
      }),
      writeVoid: async () => {
        writes += 1;
      },
    });
    expect(result).toBe('deferred');
    expect(writes).toBe(0);
    expect((await getVoidIntent(store, 'ord-1'))?.attempts).toBe(0);
    expect((await getVoidIntent(store, 'ord-1'))?.status).toBe('pending');
  });

  test('PF-1 null serverCreatedAt issues no write', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    let writes = 0;
    await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: null },
      }),
      writeVoid: async () => {
        writes += 1;
      },
    });
    expect(writes).toBe(0);
  });

  test('PF-1 recovery: later appearance of the server order is allowed and written', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 0,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: false, serverCreatedAtMs: null },
      }),
      writeVoid: async () => {
        throw new Error('must not write yet');
      },
    });
    let writes = 0;
    const second = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW + 1,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW },
      }),
      writeVoid: async (rec) => {
        writes += 1;
        expect(rec.voidedBy).toBe('staff-original');
      },
    });
    expect(second).toBe('confirmed');
    expect(writes).toBe(1);
  });

  test('PF-2 expired UTC+7 day is terminal and issues no write', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    let writes = 0;
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: Date.UTC(2026, 7, 22, 10, 0, 0),
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW },
      }),
      writeVoid: async () => {
        writes += 1;
      },
    });
    expect(result).toBe('terminal');
    expect(writes).toBe(0);
    expect((await getVoidIntent(store, 'ord-1'))?.terminalReason).toBe('day_boundary_expired');
  });

  test('queued 23:50 / drained 00:10 UTC+7 does not issue a doomed write', async () => {
    const click = Date.UTC(2026, 7, 21, 16, 50, 0);
    const drain = Date.UTC(2026, 7, 21, 17, 10, 0);
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), click);
    let writes = 0;
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: drain,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: click },
      }),
      writeVoid: async () => {
        writes += 1;
      },
    });
    expect(utcPlus7Date(click)).not.toBe(utcPlus7Date(drain));
    expect(result).toBe('terminal');
    expect(writes).toBe(0);
  });

  test('same UTC+7 date is allowed and writes once with original voidedBy', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    const seen: string[] = [];
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: Date.UTC(2026, 7, 21, 16, 0, 0),
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW },
      }),
      writeVoid: async (rec) => {
        seen.push(rec.voidedBy);
      },
    });
    expect(result).toBe('confirmed');
    expect(seen).toEqual(['staff-original']);
  });

  test('permission-denied near UTC+7 midnight becomes day_boundary_expired', async () => {
    const created = Date.UTC(2026, 7, 21, 10, 0, 0);
    const nearMidnight = Date.UTC(2026, 7, 21, 16, 59, 30);
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), created);
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: nearMidnight,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: created },
      }),
      writeVoid: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      },
    });
    expect(result).toBe('terminal');
    expect((await getVoidIntent(store, 'ord-1'))?.terminalReason).toBe('day_boundary_expired');
  });

  test('permission-denied far from the boundary becomes authority_refused', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW },
      }),
      writeVoid: async () => {
        throw Object.assign(new Error('denied'), { code: 'permission-denied' });
      },
    });
    expect(result).toBe('terminal');
    expect((await getVoidIntent(store, 'ord-1'))?.terminalReason).toBe('authority_refused');
  });

  test('unknown write errors are retryable, never terminal', async () => {
    expect(classifyVoidWriteError(new Error('weird'))).toBe('unknown');
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      maxAttempts: 8,
      backoffMs: () => 1,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW },
      }),
      writeVoid: async () => {
        throw new Error('weird');
      },
    });
    expect(result).toBe('retryable');
    expect((await getVoidIntent(store, 'ord-1'))?.status).toBe('pending');
    expect((await getVoidIntent(store, 'ord-1'))?.attempts).toBe(1);
  });

  test('already voided server order confirms without a second write', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    let writes = 0;
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW, voidRequested: true },
      }),
      writeVoid: async () => {
        writes += 1;
      },
    });
    expect(result).toBe('confirmed');
    expect(writes).toBe(0);
  });

  test('decideVoidPreflight truth table stays aligned with drain', () => {
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: NOW,
        serverOrder: { exists: true, serverCreatedAtMs: NOW },
      }),
    ).toEqual({ action: 'allow' });
    expect(
      decideVoidPreflight({
        isOnline: true,
        nowMs: NOW,
        serverOrder: { exists: false, serverCreatedAtMs: null },
      }),
    ).toEqual({ action: 'block', reason: 'order_absent_server_side' });
  });
});

describe('drainOneVoidIntent staff identity confinement', () => {
  test('staff mismatch is terminal before any Firestore write and preserves original voidedBy', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    let writes = 0;
    let reads = 0;
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-other',
      intervalMs: 120_000,
      readServer: async () => {
        reads += 1;
        return { kind: 'ok', order: { exists: true, serverCreatedAtMs: NOW } };
      },
      writeVoid: async () => {
        writes += 1;
      },
    });
    expect(result).toBe('terminal');
    expect(writes).toBe(0);
    expect(reads).toBe(0);
    const rec = await getVoidIntent(store, 'ord-1');
    expect(rec?.status).toBe('terminal');
    expect(rec?.terminalReason).toBe('staff_identity_mismatch');
    expect(rec?.voidedBy).toBe('staff-original');
  });

  test('matching current staff identity proceeds to the eligible write path', async () => {
    const store = createInMemoryReversalStore();
    await enqueueVoidIntent(store, 'ord-1', enqueueInput(), NOW);
    const seen: string[] = [];
    const result = await drainOneVoidIntent('ord-1', {
      store,
      nowMs: NOW,
      isOnline: true,
      owner: 't',
      currentStaffId: 'staff-original',
      intervalMs: 120_000,
      readServer: async () => ({
        kind: 'ok',
        order: { exists: true, serverCreatedAtMs: NOW },
      }),
      writeVoid: async (rec) => {
        seen.push(rec.voidedBy);
      },
    });
    expect(result).toBe('confirmed');
    expect(seen).toEqual(['staff-original']);
    expect((await getVoidIntent(store, 'ord-1'))?.voidedBy).toBe('staff-original');
  });
});
