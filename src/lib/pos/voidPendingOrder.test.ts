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
      { reason: 'ลูกค้าเปลี่ยนใจ', note: 'x', voidedBy: 'staff-1', branchId: 'LDP-001' },
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
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001' },
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
      { reason: 'x', voidedBy: 'staff-1', branchId: 'LDP-001' },
      NOW + 1,
      store,
    );
    expect(outcome).toEqual({ kind: 'blocked', reason: 'day_boundary_expired' });
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
