// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import {
  createInMemoryShiftCloseIntentJournal,
  createShiftCloseIntentJournal,
  isStaleClosePending,
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
