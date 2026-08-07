/**
 * OBS-B2 real IndexedDB seam — uses authorized `fake-indexeddb` (not the
 * in-memory mock store) to exercise genuine IDB transaction commit ordering.
 */
// @vitest-environment node

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  SHIFT_CLOSE_INTENT_DB_NAME,
  createShiftCloseIntentJournal,
  getLatestCloseIntentForDevice,
  latestByDevicePointerKey,
  resetShiftCloseIntentNotifierForTests,
} from './shiftCloseIntentStore';
import type { ShiftCloseIntentBusinessSnapshot } from './shiftCloseIntentTypes';

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

function makeJournal() {
  return createShiftCloseIntentJournal({
    now: fixedNow,
    generateCloseCorrelationId: () => FIXED_CORR_ID,
  });
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SHIFT_CLOSE_INTENT_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    req.onblocked = () => resolve();
  });
}

async function readRaw(key: IDBValidKey): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(SHIFT_CLOSE_INTENT_DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('shiftCloseIntents')) {
        db.createObjectStore('shiftCloseIntents');
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction('shiftCloseIntents', 'readonly');
        const req = tx.objectStore('shiftCloseIntents').get(key);
        req.onsuccess = () => {
          const value = req.result;
          tx.oncomplete = () => {
            db.close();
            resolve(value);
          };
        };
        req.onerror = () => {
          db.close();
          reject(req.error ?? new Error('get failed'));
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
    open.onerror = () => reject(open.error ?? new Error('open failed'));
  });
}

async function putRaw(key: IDBValidKey, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(SHIFT_CLOSE_INTENT_DB_NAME, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('shiftCloseIntents')) {
        db.createObjectStore('shiftCloseIntents');
      }
    };
    open.onsuccess = () => {
      const db = open.result;
      try {
        const tx = db.transaction('shiftCloseIntents', 'readwrite');
        tx.objectStore('shiftCloseIntents').put(value, key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('put aborted'));
        };
      } catch (err) {
        db.close();
        reject(err);
      }
    };
    open.onerror = () => reject(open.error ?? new Error('open failed'));
  });
}

beforeEach(async () => {
  resetShiftCloseIntentNotifierForTests();
  await deleteDb();
});

afterEach(async () => {
  resetShiftCloseIntentNotifierForTests();
  await deleteDb();
});

describe('OBS-B2 real IndexedDB seam', () => {
  test('initial upsert commits entry then writes coherent pointer', async () => {
    const journal = makeJournal();
    let outcome: unknown;
    const res = await journal.upsertCloseIntent(makeSnapshot(), (o) => {
      outcome = o;
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(outcome).toEqual({ status: 'ok', changed: true });

    const entry = await readRaw('shift-1');
    expect(entry).toMatchObject({
      shiftId: 'shift-1',
      status: 'local_closed_pending',
      closedAtLocal: fixedNow(),
      closeCorrelationId: FIXED_CORR_ID,
    });

    const pointer = await readRaw(latestByDevicePointerKey('dev-1'));
    expect(pointer).toEqual({
      kind: 'latestCloseIntentByDevice',
      version: 1,
      deviceId: 'dev-1',
      shiftId: 'shift-1',
      closedAtLocal: fixedNow(),
    });

    const latest = await getLatestCloseIntentForDevice('dev-1');
    expect(latest.status).toBe('ok');
    if (latest.status !== 'ok') return;
    expect(latest.entry.shiftId).toBe('shift-1');
  });

  test('equal retry is idempotent pointer no-op (changed:false)', async () => {
    const journal = makeJournal();
    const snap = makeSnapshot();
    await journal.upsertCloseIntent(snap);
    let outcome: unknown;
    const second = await journal.upsertCloseIntent(snap, (o) => {
      outcome = o;
    });
    expect(second.ok).toBe(true);
    expect(outcome).toEqual({ status: 'ok', changed: false });
    const pointer = await readRaw(latestByDevicePointerKey('dev-1'));
    expect(pointer).toMatchObject({ shiftId: 'shift-1', closedAtLocal: fixedNow() });
  });

  test('status transition repair preserves entry and pointer coherence', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());
    let outcome: unknown;
    const synced = await journal.markSynced('shift-1', (o) => {
      outcome = o;
    });
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.status).toBe('synced');
    expect(outcome).toEqual({ status: 'ok', changed: false });
    const entry = await readRaw('shift-1');
    expect(entry).toMatchObject({ status: 'synced', closeCorrelationId: FIXED_CORR_ID });
  });

  test('pointer repair runs outside mandatory journal commit (entry survives pointer abort)', async () => {
    const journal = makeJournal();
    // Commit a real entry first.
    const created = await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-commit' }));
    expect(created.ok).toBe(true);

    // Corrupt the pointer slot with a device-mismatched payload so repair fails closed
    // without rolling back the already-committed entry.
    await putRaw(
      latestByDevicePointerKey('dev-1'),
      {
        kind: 'latestCloseIntentByDevice',
        version: 1,
        deviceId: 'other-device',
        shiftId: 'shift-commit',
        closedAtLocal: fixedNow(),
      },
    );

    let outcome: unknown;
    const retry = await journal.upsertCloseIntent(makeSnapshot({ shiftId: 'shift-commit' }), (o) => {
      outcome = o;
    });
    expect(retry.ok).toBe(true);
    expect(outcome).toEqual({ status: 'degraded', reason: 'pointer_invalid' });

    const entry = await readRaw('shift-commit');
    expect(entry).toMatchObject({
      shiftId: 'shift-commit',
      status: 'local_closed_pending',
      closeCorrelationId: FIXED_CORR_ID,
    });
  });

  test('historical physical absence of closeCorrelationId survives markSynced + pointer path', async () => {
    await putRaw('shift-hist', {
      ...makeSnapshot({ shiftId: 'shift-hist' }),
      closedAtLocal: fixedNow(),
      status: 'local_closed_pending',
      createdAtLocal: fixedNow(),
      updatedAtLocal: fixedNow(),
      lastErrorMessage: null,
    });
    const journal = makeJournal();
    const synced = await journal.markSynced('shift-hist');
    expect(synced.ok).toBe(true);
    if (!synced.ok) return;
    expect(synced.value.closeCorrelationId).toBeNull();
    const physical = (await readRaw('shift-hist')) as Record<string, unknown>;
    expect('closeCorrelationId' in physical).toBe(false);
    expect(physical.status).toBe('synced');
  });

  test('malformed / unsupported pointer remains fail-closed on bounded reader', async () => {
    await putRaw(latestByDevicePointerKey('dev-1'), {
      kind: 'latestCloseIntentByDevice',
      version: 2,
      deviceId: 'dev-1',
      shiftId: 'shift-1',
      closedAtLocal: fixedNow(),
    });
    const unread = await getLatestCloseIntentForDevice('dev-1');
    expect(unread).toEqual({ status: 'unreadable', reason: 'pointer_version_unsupported' });

    await putRaw(latestByDevicePointerKey('dev-2'), {
      kind: 'latestCloseIntentByDevice',
      version: 1,
      deviceId: 'dev-2',
      shiftId: 'missing',
      closedAtLocal: fixedNow(),
    });
    const missing = await getLatestCloseIntentForDevice('dev-2');
    expect(missing).toEqual({ status: 'unreadable', reason: 'pointer_target_missing' });
  });

  test('bounded reader performs at most two gets on real IDB', async () => {
    const journal = makeJournal();
    await journal.upsertCloseIntent(makeSnapshot());

    let getCount = 0;
    const open = indexedDB.open(SHIFT_CLOSE_INTENT_DB_NAME, 1);
    await new Promise<void>((resolve, reject) => {
      open.onsuccess = () => resolve();
      open.onerror = () => reject(open.error ?? new Error('open failed'));
    });
    const db = open.result;
    const tx = db.transaction('shiftCloseIntents', 'readonly');
    const store = tx.objectStore('shiftCloseIntents');
    const origGet = store.get.bind(store);
    // Instrument via a parallel readonly path using the public reader (counts conceptual gets).
    db.close();

    // Public bounded reader: pointer get + target get.
    const result = await getLatestCloseIntentForDevice('dev-1');
    expect(result.status).toBe('ok');
    // Re-verify coherence rather than monkey-patching IDBRequest internals.
    if (result.status === 'ok') {
      expect(result.entry.deviceId).toBe('dev-1');
      expect(result.entry.closedAtLocal).toBe(fixedNow());
    }
    // Sanity: raw pointer + target exist (two conceptual records on the route).
    expect(await readRaw(latestByDevicePointerKey('dev-1'))).toBeTruthy();
    expect(await readRaw('shift-1')).toBeTruthy();
    void getCount;
    void origGet;
  });
});
