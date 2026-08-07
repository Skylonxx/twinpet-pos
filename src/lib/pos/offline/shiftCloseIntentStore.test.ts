// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import {
  SHIFT_CLOSE_INTENT_STORAGE_COMPAT_FLOOR,
  createInMemoryShiftCloseIntentJournal,
  createInMemoryShiftCloseIntentStore,
  createShiftCloseIntentJournal,
  getLatestCloseIntentForDevice,
  isStaleClosePending,
  latestByDevicePointerKey,
  snapshotsEqual,
} from './shiftCloseIntentStore';
import type { ShiftCloseIntentSnapshot } from './shiftCloseIntentTypes';
import { SHIFT_CLOSE_INTENT_STALE_AGE_MS } from './shiftCloseIntentTypes';

const fixedNow = () => Date.parse('2026-07-09T12:00:00.000Z');

function makeSnapshot(overrides: Partial<ShiftCloseIntentSnapshot> = {}): ShiftCloseIntentSnapshot {
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
    closedAtLocal: fixedNow(),
    deviceId: 'dev-1',
    ...overrides,
  };
}

function makeJournal() {
  return createInMemoryShiftCloseIntentJournal({ now: fixedNow });
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
    await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-2', closedAtLocal: fixedNow() + 1 }));
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
    const store = createInMemoryShiftCloseIntentStore();
    const journal = createInMemoryShiftCloseIntentJournal({ store, now: fixedNow });
    await journal.upsertCloseIntent(makeSnapshot());
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
    await journal.upsertCloseIntent(makeSnapshot({ closedAtLocal: fixedNow() }));
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
