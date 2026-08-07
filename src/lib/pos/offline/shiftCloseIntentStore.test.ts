// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  SHIFT_CLOSE_INTENT_STORAGE_COMPAT_FLOOR,
  createInMemoryShiftCloseIntentJournal,
  createInMemoryShiftCloseIntentStore,
  createShiftCloseIntentJournal,
  generateShiftCloseCorrelationId,
  getLatestCloseIntentForDevice,
  isStaleClosePending,
  isValidLowercaseUuidV4,
  latestByDevicePointerKey,
  resetShiftCloseIntentNotifierForTests,
  snapshotsEqual,
  subscribeShiftCloseIntentNotifier,
} from './shiftCloseIntentStore';
import type { ShiftCloseIntentBusinessSnapshot } from './shiftCloseIntentTypes';
import { SHIFT_CLOSE_INTENT_STALE_AGE_MS } from './shiftCloseIntentTypes';

const fixedNow = () => Date.parse('2026-07-09T12:00:00.000Z');
const FIXED_CORR_ID = '11111111-1111-4111-8111-111111111111';

function makeSnapshot(
  overrides: Partial<ShiftCloseIntentBusinessSnapshot> = {},
): ShiftCloseIntentBusinessSnapshot {
  return {
    shiftId: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
    startingCash: 500,
    expectedCash: 1000,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    payInTotal: 0,
    payOutTotal: 0,
    totalBills: 3,
    actualCashCount: 1500,
    variance: 0,
    note: '',
    deviceId: 'dev-1',
    ...overrides,
  };
}

function makeJournal(
  overrides: {
    now?: () => number;
    generateCloseCorrelationId?: () => string | null;
    store?: ReturnType<typeof createInMemoryShiftCloseIntentStore>;
  } = {},
) {
  return createInMemoryShiftCloseIntentJournal({
    now: overrides.now ?? fixedNow,
    generateCloseCorrelationId:
      overrides.generateCloseCorrelationId ?? (() => FIXED_CORR_ID),
    store: overrides.store,
  });
}

function makeValidPointer(
  overrides: Partial<{
    kind: string;
    version: number;
    deviceId: string;
    shiftId: string;
    closedAtLocal: number;
  }> = {},
) {
  return {
    kind: 'latestCloseIntentByDevice' as const,
    version: 1,
    deviceId: 'dev-1',
    shiftId: 'shift-1',
    closedAtLocal: fixedNow(),
    ...overrides,
  };
}

type InstrumentedStore = ReturnType<typeof createInMemoryShiftCloseIntentStore> & {
  getCount: number;
  getAllCount: number;
  putCount: number;
};

function createInstrumentedStore(): InstrumentedStore {
  const base = createInMemoryShiftCloseIntentStore();
  const instrumented: InstrumentedStore = {
    getCount: 0,
    getAllCount: 0,
    putCount: 0,
    dump: () => base.dump(),
    async transact(stores, mode, fn) {
      return base.transact(stores, mode, async (txn) =>
        fn({
          get: async (store, key) => {
            instrumented.getCount += 1;
            return txn.get(store, key);
          },
          getAll: async (store) => {
            instrumented.getAllCount += 1;
            return txn.getAll(store);
          },
          put: async (store, key, value) => {
            instrumented.putCount += 1;
            return txn.put(store, key, value);
          },
        }),
      );
    },
  };
  return instrumented;
}

async function seedPointer(
  store: ReturnType<typeof createInMemoryShiftCloseIntentStore>,
  deviceId: string,
  pointer: unknown,
) {
  await store.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
    await txn.put('shiftCloseIntents', latestByDevicePointerKey(deviceId), pointer);
  });
}

async function seedRawRecord(
  store: ReturnType<typeof createInMemoryShiftCloseIntentStore>,
  key: IDBValidKey,
  value: unknown,
) {
  await store.transact(['shiftCloseIntents'], 'readwrite', async (txn) => {
    await txn.put('shiftCloseIntents', key, value);
  });
}

describe('upsertCloseIntent', () => {
  test('creates a durable local_closed_pending record keyed by shiftId', async () => {
    const journal = makeJournal();
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.shiftId).toBe('shift-1');
    expect(res.value.status).toBe('local_closed_pending');
    expect(res.value.createdAtLocal).toBe(fixedNow());
  });

  test('second identical upsert for the same shiftId is idempotent (no duplicate / no conflict)', async () => {
    const journal = makeJournal();
    const snapshot = makeSnapshot();
    const first = await journal.upsertCloseIntent(snapshot);
    const second = await journal.upsertCloseIntent(snapshot);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const all = await journal.listCloseIntents();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(1);
  });

  test('a different snapshot for the same shiftId is NOT silently overwritten — returns conflict', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    const conflicting = await journal.upsertCloseIntent(makeSnapshot({ actualCashCount: 999 }));
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('conflict');

    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok).toBe(true);
    if (!stored.ok || !stored.value) return;
    expect(stored.value.actualCashCount).toBe(1500); // unchanged — original snapshot preserved
  });
});

describe('status transitions (same-runtime only)', () => {
  test('markSynced transitions a pending record to synced', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    const res = await journal.markSynced('shift-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('synced');
  });

  test('markRejectedManualAttention transitions a pending record and records the reason', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    const res = await journal.markRejectedManualAttention('shift-1', 'permission-denied');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('rejected_manual_attention');
    expect(res.value.lastErrorMessage).toBe('permission-denied');
  });

  test('marking a status on a shiftId with no record returns not_found', async () => {
    const journal = makeJournal();
    const res = await journal.markSynced('nonexistent-shift');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('not_found');
  });
});

describe('durable-store-unavailable — fail fast, no cache-only fallback', () => {
  test('IndexedDB unavailable returns an unavailable result (not thrown, not silently ignored)', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error test override
    delete globalThis.indexedDB;
    const journal = createShiftCloseIntentJournal();
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('unavailable');
    globalThis.indexedDB = original;
  });

  test('QuotaExceededError maps to a quota result without throwing', async () => {
    const quotaStore = {
      transact: async () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    };
    const journal = createInMemoryShiftCloseIntentJournal({ store: quotaStore, now: fixedNow });
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('quota');
  });
});

describe('snapshotsEqual', () => {
  test('true for identical snapshots', () => {
    expect(snapshotsEqual(makeSnapshot(), makeSnapshot())).toBe(true);
  });

  test('false when any field differs', () => {
    expect(snapshotsEqual(makeSnapshot(), makeSnapshot({ variance: 5 }))).toBe(false);
  });
});

describe('isStaleClosePending — purely computed, never stored', () => {
  test('false while under the stale-age threshold', () => {
    const entry = { status: 'local_closed_pending' as const, closedAtLocal: fixedNow() };
    expect(isStaleClosePending(entry, fixedNow() + SHIFT_CLOSE_INTENT_STALE_AGE_MS - 1)).toBe(false);
  });

  test('true once the pending record ages past the threshold', () => {
    const entry = { status: 'local_closed_pending' as const, closedAtLocal: fixedNow() };
    expect(isStaleClosePending(entry, fixedNow() + SHIFT_CLOSE_INTENT_STALE_AGE_MS)).toBe(true);
  });

  test('never stale once synced — no post-hoc "acknowledged but also stale" claim', () => {
    const entry = { status: 'synced' as const, closedAtLocal: fixedNow() };
    expect(isStaleClosePending(entry, fixedNow() + 100 * SHIFT_CLOSE_INTENT_STALE_AGE_MS)).toBe(false);
  });
});

describe('OBS-B0 compat floor marker', () => {
  test('SHIFT_CLOSE_INTENT_STORAGE_COMPAT_FLOOR is exact value 1', () => {
    expect(SHIFT_CLOSE_INTENT_STORAGE_COMPAT_FLOOR).toBe(1);
  });
});

describe('OBS-B0 listCloseIntents metadata filtering / corruption fail-closed', () => {
  test('all-valid historical entries still list successfully', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-1' }));
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-2' }));
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(2);
    expect(listed.value.every((e) => e.status === 'local_closed_pending')).toBe(true);
  });

  test('recognized valid pointer metadata is excluded; valid entries returned', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(store, 'dev-1', makeValidPointer());
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.shiftId).toBe('shift-1');
    expect(listed.value.some((e) => 'kind' in (e as object))).toBe(false);
  });

  test('pointer-like record with malformed required v1 field fails closed', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(store, 'dev-1', makeValidPointer({ shiftId: '' }));
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    if (listed.code !== 'unreadable_record') return;
    expect(listed.reason).toBe('malformed_pointer');
    expect(listed.unknownRecordCount).toBe(1);
    expect(JSON.stringify(listed)).not.toContain('latestCloseIntentByDevice');
  });

  test('pointer-like record with unsupported version fails closed on list (reader distinguishes separately)', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(store, 'dev-1', makeValidPointer({ version: 2 }));
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    if (listed.code !== 'unreadable_record') return;
    expect(listed.reason).toBe('malformed_pointer');
  });

  test('unknown record fails closed for the whole list', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    // Non-object / foreign-kind values are unknown — plain objects without `kind`
    // are classified as malformed_entry candidates instead.
    await seedRawRecord(store, 'weird-key', { kind: 'foreignMetadata', hello: 'world' });
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    if (listed.code !== 'unreadable_record') return;
    expect(listed.reason).toBe('unknown_record');
    expect(listed.unknownRecordCount).toBe(1);
    expect(JSON.stringify(listed)).not.toContain('hello');
    expect(JSON.stringify(listed)).not.toContain('foreignMetadata');
  });

  test('malformed entry fails closed for the whole list', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedRawRecord(store, 'shift-bad', {
      shiftId: 'shift-bad',
      branchId: 'LDP-001',
      // missing required snapshot/entry fields
      status: 'local_closed_pending',
    });
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    if (listed.code !== 'unreadable_record') return;
    expect(listed.reason).toBe('malformed_entry');
    expect(listed.unknownRecordCount).toBe(1);
  });

  test('corruption plus valid entries yields no partial success list', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-ok' }));
    await seedRawRecord(store, 'shift-bad', { not: 'an-entry' });
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    expect('value' in listed).toBe(false);
  });

  test('no raw corrupt value appears in returned operational error', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await seedRawRecord(store, 'secret-key', {
      kind: 'latestCloseIntentByDevice',
      version: 1,
      deviceId: 'dev-1',
      shiftId: '',
      closedAtLocal: fixedNow(),
      secretPayload: 'SHOULD_NOT_LEAK',
    });
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('secretPayload');
    expect(serialized).not.toContain('stack');
  });

  test('getCloseIntent(stringShiftId) keyed behavior remains unchanged', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value?.shiftId).toBe('shift-1');
    expect(stored.value?.actualCashCount).toBe(1500);

    const missing = await journal.getCloseIntent('no-such-shift');
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value).toBeUndefined();
  });

  test('list/read path causes zero writes or backfills', async () => {
    const store = createInstrumentedStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    const putsAfterWrite = store.putCount;
    await seedPointer(store, 'dev-1', makeValidPointer());
    const putsAfterSeed = store.putCount;

    const before = JSON.stringify(store.dump());
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(true);
    const afterList = JSON.stringify(store.dump());
    expect(afterList).toBe(before);
    expect(store.putCount).toBe(putsAfterSeed);

    const keyed = await journal.getCloseIntent('shift-1');
    expect(keyed.ok).toBe(true);
    expect(JSON.stringify(store.dump())).toBe(before);
    expect(store.putCount).toBe(putsAfterSeed);
    expect(putsAfterWrite).toBeGreaterThan(0);
  });
});

describe('OBS-B0 bounded reader substrate', () => {
  test('pointer absent -> none', async () => {
    // Seed an entry without going through upsert's post-commit pointer repair,
    // so the bounded reader can still observe a true pointer-absent `none`.
    const store = createInMemoryShiftCloseIntentStore();
    await seedRawRecord(store, 'shift-1', {
      ...makeSnapshot(),
      closedAtLocal: fixedNow(),
      closeCorrelationId: FIXED_CORR_ID,
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    });
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'none' });
  });

  test('valid pointer + valid target -> ok with one entry', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(store, 'dev-1', makeValidPointer());
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.entry.shiftId).toBe('shift-1');
    expect(result.entry.deviceId).toBe('dev-1');
  });

  test('two-read ceiling cannot be exceeded; no getAll/enumeration', async () => {
    const store = createInstrumentedStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(store, 'dev-1', makeValidPointer());
    store.getCount = 0;
    store.getAllCount = 0;
    store.putCount = 0;

    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result.status).toBe('ok');
    expect(store.getCount).toBeLessThanOrEqual(2);
    expect(store.getCount).toBe(2);
    expect(store.getAllCount).toBe(0);
    expect(store.putCount).toBe(0);
  });

  test('pointer invalid -> unreadable pointer_invalid', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedPointer(store, 'dev-1', { kind: 'latestCloseIntentByDevice', version: 'nope' });
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_invalid' });
  });

  test('version > supported -> unreadable pointer_version_unsupported', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedPointer(
      store,
      'dev-1',
      makeValidPointer({
        version: 2,
        deviceId: 'dev-1',
        shiftId: 'shift-1',
        closedAtLocal: fixedNow(),
      }),
    );
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_version_unsupported' });
  });

  test('target missing -> unreadable pointer_target_missing', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedPointer(store, 'dev-1', makeValidPointer({ shiftId: 'missing-shift' }));
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_target_missing' });
  });

  test('pointer/target device mismatch -> unreadable pointer_device_mismatch', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot({ deviceId: 'dev-other' }));
    await seedPointer(store, 'dev-1', makeValidPointer({ deviceId: 'dev-1', shiftId: 'shift-1' }));
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_device_mismatch' });
  });

  test('target invalid -> unreadable pointer_target_invalid', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedRawRecord(store, 'shift-1', { shiftId: 'shift-1', status: 'local_closed_pending' });
    await seedPointer(store, 'dev-1', makeValidPointer());
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_target_invalid' });
  });

  test('invalid timestamp/coherence -> unreadable pointer_timestamp_invalid', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(
      store,
      'dev-1',
      makeValidPointer({ closedAtLocal: fixedNow() + 999_000 }),
    );
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_timestamp_invalid' });
  });

  test('storage read failure -> unreadable storage_unavailable', async () => {
    const failingStore = {
      transact: async () => {
        throw new Error('IndexedDB unavailable');
      },
    };
    const result = await getLatestCloseIntentForDevice('dev-1', { store: failingStore });
    expect(result).toEqual({ status: 'unreadable', reason: 'storage_unavailable' });
  });

  test('unusable device identity -> unreadable device_identity_unavailable', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const result = await getLatestCloseIntentForDevice('', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'device_identity_unavailable' });
  });

  test('reader produces zero writes and no read repair', async () => {
    const store = createInstrumentedStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedPointer(store, 'dev-1', makeValidPointer());
    const before = JSON.stringify(store.dump());
    store.putCount = 0;

    const ok = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(ok.status).toBe('ok');
    expect(store.putCount).toBe(0);
    expect(JSON.stringify(store.dump())).toBe(before);

    const missing = await getLatestCloseIntentForDevice('dev-1', { store });
    // still no write after a second read
    expect(missing.status).toBe('ok');
    expect(store.putCount).toBe(0);
    expect(JSON.stringify(store.dump())).toBe(before);

    // missing-target path also must not repair
    await seedPointer(store, 'dev-2', makeValidPointer({ deviceId: 'dev-2', shiftId: 'gone' }));
    const putsBeforeMissing = store.putCount;
    const unread = await getLatestCloseIntentForDevice('dev-2', { store });
    expect(unread).toEqual({ status: 'unreadable', reason: 'pointer_target_missing' });
    expect(store.putCount).toBe(putsBeforeMissing);
  });

  test('none only means pointer absent — never collapses corruption/degraded cases', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedPointer(store, 'dev-1', makeValidPointer({ version: 2 }));
    const unsupported = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(unsupported.status).toBe('unreadable');
    expect(unsupported).not.toEqual({ status: 'none' });

    const empty = await getLatestCloseIntentForDevice('no-pointer-device', { store });
    expect(empty).toEqual({ status: 'none' });
  });
});

describe('OBS-B1B client-writer / generated metadata', () => {
  test('B1B-T1: initial create captures closedAtLocal and mints one lowercase v4 correlation id', async () => {
    let mintCount = 0;
    const journal = makeJournal({
      generateCloseCorrelationId: () => {
        mintCount += 1;
        return FIXED_CORR_ID;
      },
    });
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.closedAtLocal).toBe(fixedNow());
    expect(res.value.closeCorrelationId).toBe(FIXED_CORR_ID);
    expect(isValidLowercaseUuidV4(res.value.closeCorrelationId)).toBe(true);
    expect(mintCount).toBe(1);

    const dump = journal.dump().shiftCloseIntents['shift-1'] as Record<string, unknown>;
    expect(dump.closedAtLocal).toBe(fixedNow());
    expect(dump.closeCorrelationId).toBe(FIXED_CORR_ID);
  });

  test('B1B-T2: getRandomValues fallback returns lowercase v4 without Math.random', () => {
    const originalCrypto = globalThis.crypto;
    const mathSpy = vi.spyOn(Math, 'random');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) bytes[i] = i;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (arr: Uint8Array) => {
          arr.set(bytes.subarray(0, arr.length));
          return arr;
        },
      },
    });
    try {
      const id = generateShiftCloseCorrelationId();
      expect(id).not.toBeNull();
      expect(isValidLowercaseUuidV4(id)).toBe(true);
      expect(mathSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
      mathSpy.mockRestore();
    }
  });

  test('B1B-T3: no secure UUID source returns null and journal create still succeeds', async () => {
    const journal = makeJournal({ generateCloseCorrelationId: () => null });
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.closeCorrelationId).toBeNull();
    expect(res.value.status).toBe('local_closed_pending');
  });

  test('B1B-T4: equal retry reuses generated metadata without remint or put', async () => {
    const store = createInstrumentedStore();
    let mintCount = 0;
    let clock = fixedNow();
    const journal = makeJournal({
      store,
      now: () => clock,
      generateCloseCorrelationId: () => {
        mintCount += 1;
        return FIXED_CORR_ID;
      },
    });
    const first = await journal.upsertCloseIntent(makeSnapshot());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const putsAfterCreate = store.putCount;
    clock = fixedNow() + 60_000;
    const second = await journal.upsertCloseIntent(makeSnapshot());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.closedAtLocal).toBe(first.value.closedAtLocal);
    expect(second.value.closeCorrelationId).toBe(first.value.closeCorrelationId);
    expect(mintCount).toBe(1);
    expect(store.putCount).toBe(putsAfterCreate);
  });

  test('B1B-T5: unequal retry still conflicts and does not overwrite', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    const conflicting = await journal.upsertCloseIntent(makeSnapshot({ actualCashCount: 999 }));
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) return;
    expect(conflicting.code).toBe('conflict');
    const stored = await journal.getCloseIntent('shift-1');
    expect(stored.ok && stored.value?.actualCashCount).toBe(1500);
    expect(stored.ok && stored.value?.closeCorrelationId).toBe(FIXED_CORR_ID);
  });

  test('B1B-T6: business equality is exactly 17 caller fields; generated metadata excluded', () => {
    const a = makeSnapshot();
    const b = makeSnapshot();
    expect(Object.keys(a)).toHaveLength(17);
    expect(snapshotsEqual(a, b)).toBe(true);
    // Same business fields with different generated metadata on entry-shaped objects still equal.
    const entryLikeA = {
      ...a,
      closedAtLocal: 1,
      closeCorrelationId: FIXED_CORR_ID,
      status: 'local_closed_pending' as const,
      createdAtLocal: 1,
      updatedAtLocal: 1,
      lastErrorMessage: null,
    };
    const entryLikeB = {
      ...b,
      closedAtLocal: 999,
      closeCorrelationId: '22222222-2222-4222-8222-222222222222',
      status: 'synced' as const,
      createdAtLocal: 2,
      updatedAtLocal: 2,
      lastErrorMessage: 'x',
    };
    expect(snapshotsEqual(entryLikeA, entryLikeB)).toBe(true);
    expect(snapshotsEqual(a, makeSnapshot({ note: 'different' }))).toBe(false);
  });

  test('B1B-T7: historical physical absence reads as null with no writeback/backfill', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    const historical: Record<string, unknown> = {
      ...makeSnapshot(),
      closedAtLocal: fixedNow(),
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    };
    expect('closeCorrelationId' in historical).toBe(false);
    await seedRawRecord(store, 'shift-1', historical);
    const putsBefore = store.putCount;

    const got = await journal.getCloseIntent('shift-1');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.closeCorrelationId).toBeNull();

    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value[0]?.closeCorrelationId).toBeNull();

    const physical = store.dump().shiftCloseIntents['shift-1'] as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
    expect(store.putCount).toBe(putsBefore);
  });

  test('B1B-T8: markSynced / rejected path preserves generated metadata and does not backfill absence', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    await journal.upsertCloseIntent(makeSnapshot());
    const before = await journal.getCloseIntent('shift-1');
    expect(before.ok && before.value?.closeCorrelationId).toBe(FIXED_CORR_ID);
    expect(before.ok && before.value?.closedAtLocal).toBe(fixedNow());

    const synced = await journal.markSynced('shift-1');
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.closeCorrelationId).toBe(FIXED_CORR_ID);
    expect(synced.value.closedAtLocal).toBe(fixedNow());

    // Historical absence path
    const store2 = createInstrumentedStore();
    const journal2 = makeJournal({ store: store2 });
    const historical: Record<string, unknown> = {
      ...makeSnapshot({ shiftId: 'shift-hist' }),
      closedAtLocal: fixedNow(),
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    };
    await seedRawRecord(store2, 'shift-hist', historical);
    const rejected = await journal2.markRejectedManualAttention('shift-hist', 'x');
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.closeCorrelationId).toBeNull();
    expect(rejected.value.closedAtLocal).toBe(fixedNow());
    const physical = store2.dump().shiftCloseIntents['shift-hist'] as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
  });

  test('B1B-T9: malformed present correlation fails closed and is never coerced to null', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = makeJournal({ store });
    await seedRawRecord(store, 'shift-bad-corr', {
      ...makeSnapshot({ shiftId: 'shift-bad-corr' }),
      closedAtLocal: fixedNow(),
      closeCorrelationId: 'NOT-A-UUID',
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    });
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    if (listed.code !== 'unreadable_record') return;
    expect(listed.reason).toBe('malformed_entry');
  });

  test('B1B-T10: unknown/malformed fail-closed behavior remains (OBS-B0)', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = makeJournal({ store });
    await journal.upsertCloseIntent(makeSnapshot());
    await seedRawRecord(store, 'weird-key', { kind: 'foreignMetadata', hello: 'world' });
    const listed = await journal.listCloseIntents();
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.code).toBe('unreadable_record');
    if (listed.code !== 'unreadable_record') return;
    expect(listed.reason).toBe('unknown_record');
  });

  test('default generateShiftCloseCorrelationId prefers randomUUID when available', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {
        randomUUID: () => 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
        getRandomValues: () => {
          throw new Error('should not call getRandomValues when randomUUID exists');
        },
      },
    });
    try {
      expect(generateShiftCloseCorrelationId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });

  test('default generateShiftCloseCorrelationId returns null when crypto is unavailable', () => {
    const originalCrypto = globalThis.crypto;
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(generateShiftCloseCorrelationId()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: originalCrypto,
      });
    }
  });
});

describe('OBS-B1B Remediation-1 F-01 — keyed get / status fail-closed', () => {
  const MALFORMED_CORRELATION_CASES: { label: string; value: unknown }[] = [
    { label: 'uppercase UUID', value: 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE' },
    { label: 'wrong version nibble', value: '11111111-1111-5111-8111-111111111111' },
    { label: 'wrong variant nibble', value: '11111111-1111-4111-c111-111111111111' },
    { label: 'wrong length', value: '11111111-1111-4111-8111-11111111111' },
    { label: 'empty string', value: '' },
    { label: 'non-string', value: 42 },
  ];

  function makeValidEntryFields(
    overrides: Partial<ShiftCloseIntentBusinessSnapshot> & { shiftId?: string } = {},
  ): Record<string, unknown> {
    return {
      ...makeSnapshot(overrides),
      closedAtLocal: fixedNow(),
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    };
  }

  test('F01-T1: keyed get valid current non-null v4 -> success', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    const got = await journal.getCloseIntent('shift-1');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.closeCorrelationId).toBe(FIXED_CORR_ID);
    expect(isValidLowercaseUuidV4(got.value?.closeCorrelationId)).toBe(true);
  });

  test('F01-T2: keyed get historical physical absence -> success / null / raw still absent', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    const historical = makeValidEntryFields();
    expect('closeCorrelationId' in historical).toBe(false);
    await seedRawRecord(store, 'shift-1', historical);
    const putsBefore = store.putCount;

    const got = await journal.getCloseIntent('shift-1');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.closeCorrelationId).toBeNull();

    const physical = store.dump().shiftCloseIntents['shift-1'] as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
    expect(store.putCount).toBe(putsBefore);
  });

  test.each(MALFORMED_CORRELATION_CASES)(
    'F01-T3..T8: keyed get $label -> fail closed',
    async ({ value }) => {
      const store = createInstrumentedStore();
      const journal = makeJournal({ store });
      const shiftId = 'shift-malformed-get';
      const raw = {
        ...makeValidEntryFields({ shiftId }),
        closeCorrelationId: value,
      };
      await seedRawRecord(store, shiftId, raw);
      const before = JSON.stringify(store.dump().shiftCloseIntents[shiftId]);
      const putsBefore = store.putCount;

      const got = await journal.getCloseIntent(shiftId);
      expect(got.ok).toBe(false);
      if (got.ok) return;
      expect(got.code).toBe('conflict');
      expect(store.putCount).toBe(putsBefore);
      expect(JSON.stringify(store.dump().shiftCloseIntents[shiftId])).toBe(before);
    },
  );

  test.each(MALFORMED_CORRELATION_CASES)(
    'F01-T9: markSynced $label -> fail closed, put 0, raw unchanged',
    async ({ value }) => {
      const store = createInstrumentedStore();
      const journal = makeJournal({ store });
      const shiftId = 'shift-malformed-synced';
      const raw = {
        ...makeValidEntryFields({ shiftId }),
        closeCorrelationId: value,
      };
      await seedRawRecord(store, shiftId, raw);
      const before = JSON.stringify(store.dump().shiftCloseIntents[shiftId]);
      store.putCount = 0;

      const res = await journal.markSynced(shiftId);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('conflict');
      expect(store.putCount).toBe(0);
      expect(JSON.stringify(store.dump().shiftCloseIntents[shiftId])).toBe(before);
    },
  );

  test.each(MALFORMED_CORRELATION_CASES)(
    'F01-T10: markRejectedManualAttention $label -> fail closed, put 0, raw unchanged',
    async ({ value }) => {
      const store = createInstrumentedStore();
      const journal = makeJournal({ store });
      const shiftId = 'shift-malformed-rejected';
      const raw = {
        ...makeValidEntryFields({ shiftId }),
        closeCorrelationId: value,
      };
      await seedRawRecord(store, shiftId, raw);
      const before = JSON.stringify(store.dump().shiftCloseIntents[shiftId]);
      store.putCount = 0;

      const res = await journal.markRejectedManualAttention(shiftId, 'manual');
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.code).toBe('conflict');
      expect(store.putCount).toBe(0);
      expect(JSON.stringify(store.dump().shiftCloseIntents[shiftId])).toBe(before);
    },
  );

  test('F01-T11: markSynced historical physical absence allowed; physical key stays absent', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    const historical = makeValidEntryFields({ shiftId: 'shift-hist-synced' });
    expect('closeCorrelationId' in historical).toBe(false);
    await seedRawRecord(store, 'shift-hist-synced', historical);

    const synced = await journal.markSynced('shift-hist-synced');
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.status).toBe('synced');
    expect(synced.value.closeCorrelationId).toBeNull();
    expect(synced.value.closedAtLocal).toBe(fixedNow());

    const physical = store.dump().shiftCloseIntents['shift-hist-synced'] as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
    expect(physical.status).toBe('synced');
  });

  test('F01-T12: markRejectedManualAttention historical physical absence allowed; physical key stays absent', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    const historical = makeValidEntryFields({ shiftId: 'shift-hist-rejected' });
    expect('closeCorrelationId' in historical).toBe(false);
    await seedRawRecord(store, 'shift-hist-rejected', historical);

    const rejected = await journal.markRejectedManualAttention('shift-hist-rejected', 'x');
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('rejected_manual_attention');
    expect(rejected.value.closeCorrelationId).toBeNull();
    expect(rejected.value.closedAtLocal).toBe(fixedNow());

    const physical = store.dump().shiftCloseIntents['shift-hist-rejected'] as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
    expect(physical.status).toBe('rejected_manual_attention');
    expect(physical.lastErrorMessage).toBe('x');
  });

  test('F01-T13: both status paths preserve exact valid non-null correlation', async () => {
    const journalSynced = makeJournal();
    await journalSynced.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-preserve-synced' }));
    const synced = await journalSynced.markSynced('shift-preserve-synced');
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.closeCorrelationId).toBe(FIXED_CORR_ID);
    expect(synced.value.closedAtLocal).toBe(fixedNow());
    const dumpSynced = journalSynced.dump().shiftCloseIntents[
      'shift-preserve-synced'
    ] as Record<string, unknown>;
    expect(dumpSynced.closeCorrelationId).toBe(FIXED_CORR_ID);

    const journalRejected = makeJournal();
    await journalRejected.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-preserve-rejected' }));
    const rejected = await journalRejected.markRejectedManualAttention(
      'shift-preserve-rejected',
      'denied',
    );
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.closeCorrelationId).toBe(FIXED_CORR_ID);
    expect(rejected.value.closedAtLocal).toBe(fixedNow());
    const dumpRejected = journalRejected.dump().shiftCloseIntents[
      'shift-preserve-rejected'
    ] as Record<string, unknown>;
    expect(dumpRejected.closeCorrelationId).toBe(FIXED_CORR_ID);
  });
});

describe('OBS-B2 pointer repair + notifier', () => {
  afterEach(() => {
    resetShiftCloseIntentNotifierForTests();
    vi.restoreAllMocks();
  });

  test('P-01: initial create commits entry before pointer repair', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    const outcomes: unknown[] = [];
    const res = await journal.upsertCloseIntent(makeSnapshot(), (o) => outcomes.push(o));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Entry put happens in mandatory txn; pointer put is a separate later put.
    expect(store.putCount).toBeGreaterThanOrEqual(2);
    expect(store.dump().shiftCloseIntents['shift-1']).toMatchObject({
      shiftId: 'shift-1',
      status: 'local_closed_pending',
    });
    expect(outcomes[0]).toEqual({ status: 'ok', changed: true });
  });

  test('P-02: pointer create outcome ok/changed true when needed', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = makeJournal({ store });
    let outcome: unknown;
    const res = await journal.upsertCloseIntent(makeSnapshot(), (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    expect(outcome).toEqual({ status: 'ok', changed: true });
    const dump = store.dump().shiftCloseIntents;
    const pointerEntry = Object.entries(dump).find(
      ([, v]) =>
        v != null &&
        typeof v === 'object' &&
        (v as { kind?: string }).kind === 'latestCloseIntentByDevice',
    );
    expect(pointerEntry?.[1]).toEqual(makeValidPointer());
  });

  test('P-03: equal retry can return changed false', async () => {
    const journal = makeJournal();
    const snap = makeSnapshot();
    await journal.upsertCloseIntent(snap);
    let outcome: unknown;
    const second = await journal.upsertCloseIntent(snap, (o) => {
      outcome = o;
    });
    expect(second.ok).toBe(true);
    expect(outcome).toEqual({ status: 'ok', changed: false });
  });

  test('P-04: pointer repair failure does not change business success', async () => {
    const base = createInMemoryShiftCloseIntentStore();
    let pointerPuts = 0;
    const store: typeof base = {
      dump: () => base.dump(),
      async transact(stores, mode, fn) {
        return base.transact(stores, mode, async (txn) =>
          fn({
            get: (s, k) => txn.get(s, k),
            getAll: (s) => txn.getAll(s),
            put: async (s, k, v) => {
              if (Array.isArray(k)) {
                pointerPuts += 1;
                throw new Error('pointer put boom');
              }
              return txn.put(s, k, v);
            },
          }),
        );
      },
    };
    const journal = makeJournal({ store });
    let outcome: unknown;
    const res = await journal.upsertCloseIntent(makeSnapshot(), (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.shiftId).toBe('shift-1');
    expect(outcome).toEqual({ status: 'degraded', reason: 'pointer_write_failed' });
    expect(pointerPuts).toBeGreaterThanOrEqual(1);
  });

  test('P-05: markSynced pointer repair path', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    let outcome: unknown;
    const res = await journal.markSynced('shift-1', (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('synced');
    expect(outcome).toEqual({ status: 'ok', changed: false });
  });

  test('P-06: markRejectedManualAttention pointer repair path', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    let outcome: unknown;
    const res = await journal.markRejectedManualAttention('shift-1', 'denied', (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('rejected_manual_attention');
    expect(outcome).toEqual({ status: 'ok', changed: false });
  });

  test('P-07: malformed pointer is repaired (overwrite) without failing business', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = makeJournal({ store });
    await seedPointer(store, 'dev-1', makeValidPointer({ shiftId: '' }));
    let outcome: unknown;
    const res = await journal.upsertCloseIntent(makeSnapshot(), (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    expect(outcome).toEqual({ status: 'ok', changed: true });
  });

  test('P-08: target missing/mismatch remains distinct from none on bounded reader', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedPointer(store, 'dev-1', makeValidPointer({ shiftId: 'missing' }));
    const missing = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(missing).toEqual({ status: 'unreadable', reason: 'pointer_target_missing' });
    expect(missing).not.toEqual({ status: 'none' });
  });

  test('P-09: unsupported pointer version reachable on bounded reader', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    await seedPointer(store, 'dev-1', makeValidPointer({ version: 2 }));
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result).toEqual({ status: 'unreadable', reason: 'pointer_version_unsupported' });
  });

  test('P-10: bounded reader max two conceptual gets', async () => {
    const store = createInstrumentedStore();
    const journal = makeJournal({ store });
    await journal.upsertCloseIntent(makeSnapshot());
    store.getCount = 0;
    store.getAllCount = 0;
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result.status).toBe('ok');
    expect(store.getCount).toBe(2);
    expect(store.getAllCount).toBe(0);
  });

  test('P-11: historical absence compatible / no correlation backfill on status+pointer', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = makeJournal({ store });
    const historical = {
      ...makeSnapshot({ shiftId: 'shift-hist' }),
      closedAtLocal: fixedNow(),
      status: 'local_closed_pending' as const,
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    };
    expect('closeCorrelationId' in historical).toBe(false);
    await seedRawRecord(store, 'shift-hist', historical);
    const synced = await journal.markSynced('shift-hist');
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.closeCorrelationId).toBeNull();
    const physical = store.dump().shiftCloseIntents['shift-hist'] as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
  });

  test('P-12: local notifier deterministic dispatch', async () => {
    const seen: unknown[] = [];
    subscribeShiftCloseIntentNotifier((ev) => {
      seen.push(ev.pointerRepair);
    });
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    expect(seen).toEqual([{ status: 'ok', changed: true }]);
  });

  test('P-13: subscriber failure isolated', async () => {
    const second: unknown[] = [];
    subscribeShiftCloseIntentNotifier(() => {
      throw new Error('subscriber boom');
    });
    subscribeShiftCloseIntentNotifier((ev) => {
      second.push(ev.pointerRepair);
    });
    const journal = makeJournal();
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(true);
    expect(second).toEqual([{ status: 'ok', changed: true }]);
  });

  test('P-14: no duplicate local dispatch for same document path', async () => {
    let calls = 0;
    subscribeShiftCloseIntentNotifier(() => {
      calls += 1;
    });
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    expect(calls).toBe(1);
  });

  test('P-15: BroadcastChannel on ok+changed only', async () => {
    const posts: unknown[] = [];
    const FakeBC = vi.fn().mockImplementation(function (this: {
      postMessage: (d: unknown) => void;
      close: () => void;
      onmessage: null;
      onmessageerror: null;
    }) {
      this.postMessage = (d: unknown) => {
        posts.push(d);
      };
      this.close = () => undefined;
      this.onmessage = null;
      this.onmessageerror = null;
    });
    vi.stubGlobal('BroadcastChannel', FakeBC);
    resetShiftCloseIntentNotifierForTests();
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    expect(posts.length).toBe(1);
    expect(posts[0]).toMatchObject({
      version: 1,
      type: 'shiftCloseIntentPointerChanged',
      shiftId: 'shift-1',
      deviceId: 'dev-1',
    });
  });

  test('P-16: no broadcast on changed false', async () => {
    const posts: unknown[] = [];
    const FakeBC = vi.fn().mockImplementation(function (this: {
      postMessage: (d: unknown) => void;
      close: () => void;
      onmessage: null;
      onmessageerror: null;
    }) {
      this.postMessage = (d: unknown) => {
        posts.push(d);
      };
      this.close = () => undefined;
      this.onmessage = null;
      this.onmessageerror = null;
    });
    vi.stubGlobal('BroadcastChannel', FakeBC);
    resetShiftCloseIntentNotifierForTests();
    const journal = makeJournal();
    const snap = makeSnapshot();
    await journal.upsertCloseIntent(snap);
    posts.length = 0;
    await journal.upsertCloseIntent(snap);
    expect(posts.length).toBe(0);
  });

  test('P-17: no broadcast on pointer error', async () => {
    const posts: unknown[] = [];
    const FakeBC = vi.fn().mockImplementation(function (this: {
      postMessage: (d: unknown) => void;
      close: () => void;
      onmessage: null;
      onmessageerror: null;
    }) {
      this.postMessage = (d: unknown) => {
        posts.push(d);
      };
      this.close = () => undefined;
      this.onmessage = null;
      this.onmessageerror = null;
    });
    vi.stubGlobal('BroadcastChannel', FakeBC);
    resetShiftCloseIntentNotifierForTests();

    const base = createInMemoryShiftCloseIntentStore();
    const store: typeof base = {
      dump: () => base.dump(),
      async transact(stores, mode, fn) {
        return base.transact(stores, mode, async (txn) =>
          fn({
            get: (s, k) => txn.get(s, k),
            getAll: (s) => txn.getAll(s),
            put: async (s, k, v) => {
              if (Array.isArray(k)) throw new Error('pointer put boom');
              return txn.put(s, k, v);
            },
          }),
        );
      },
    };
    const journal = makeJournal({ store });
    const res = await journal.upsertCloseIntent(makeSnapshot());
    expect(res.ok).toBe(true);
    expect(posts.length).toBe(0);
  });

  test('P-18: no background/read repair on getLatestCloseIntentForDevice', async () => {
    const store = createInstrumentedStore();
    await seedRawRecord(store, 'shift-1', {
      ...makeSnapshot(),
      closedAtLocal: fixedNow(),
      closeCorrelationId: FIXED_CORR_ID,
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    });
    await seedPointer(store, 'dev-1', makeValidPointer({ shiftId: 'gone' }));
    store.putCount = 0;
    const result = await getLatestCloseIntentForDevice('dev-1', { store });
    expect(result.status).toBe('unreadable');
    expect(store.putCount).toBe(0);
  });

  test('device_id_unusable skips pointer repair', async () => {
    let outcome: unknown;
    const journal = makeJournal();
    const res = await journal.upsertCloseIntent(makeSnapshot({ deviceId: null }), (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    expect(outcome).toEqual({ status: 'skipped', reason: 'device_id_unusable' });
  });

  test('pointer_invalid when device-scoped pointer payload mismatches device', async () => {
    const store = createInMemoryShiftCloseIntentStore();
    const journal = makeJournal({ store });
    await seedPointer(store, 'dev-1', makeValidPointer({ deviceId: 'other-device' }));
    let outcome: unknown;
    const res = await journal.upsertCloseIntent(makeSnapshot(), (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    expect(outcome).toEqual({ status: 'degraded', reason: 'pointer_invalid' });
  });

  test('conflict path performs no pointer repair / no notifier', async () => {
    let notifierCalls = 0;
    subscribeShiftCloseIntentNotifier(() => {
      notifierCalls += 1;
    });
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    notifierCalls = 0;
    let observed = false;
    const conflict = await journal.upsertCloseIntent(makeSnapshot({ actualCashCount: 1 }), () => {
      observed = true;
    });
    expect(conflict.ok).toBe(false);
    expect(observed).toBe(false);
    expect(notifierCalls).toBe(0);
  });
});
