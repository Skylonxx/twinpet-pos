// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import type { SaleIntentEntry } from './saleIntentJournalTypes';
import {
  OLD_PENDING_AGE_MS,
  readDeviceSaleIntentEntries,
  selectDeviceAttentionRows,
  selectDevicePendingSummary,
} from './saleIntentUiSelectors';

const NOW_MS = new Date('2026-07-08T12:00:00.000Z').getTime();

function makeEntry(overrides: Partial<SaleIntentEntry> = {}): SaleIntentEntry {
  return {
    asyncOrderId: 'dev-1-1',
    localQueueId: 'dev-1-1',
    idempotencyKey: 'dev-1-1',
    billId: 'B-0001',
    branchId: 'branch-1',
    deviceId: 'dev-1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    createdAtLocal: NOW_MS,
    createdAtIso: new Date(NOW_MS).toISOString(),
    status: 'queued',
    payloadVersion: 1,
    salePayload: null,
    payloadStrippedAt: null,
    totalAmount: 100,
    retryCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    rejectedAt: null,
    serverAcknowledgedAt: null,
    settledObservedAt: null,
    manualReviewReason: null,
    conflictState: null,
    supersededBy: null,
    nextEventSeq: 1,
    updatedAtLocal: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

describe('selectDevicePendingSummary', () => {
  test('no entries for this device -> zero count, not stale', () => {
    const summary = selectDevicePendingSummary([], 'dev-1', NOW_MS);
    expect(summary).toEqual({ count: 0, oldestAgeMs: null, isStale: false });
  });

  test('counts only queued/flushed_to_cache/server_acknowledged for THIS device', () => {
    const entries = [
      makeEntry({ asyncOrderId: 'a', status: 'queued' }),
      makeEntry({ asyncOrderId: 'b', status: 'flushed_to_cache' }),
      makeEntry({ asyncOrderId: 'c', status: 'server_acknowledged' }),
      makeEntry({ asyncOrderId: 'd', status: 'settled_observed' }), // resolved — excluded
      makeEntry({ asyncOrderId: 'e', status: 'rejected_by_rules' }), // attention — excluded
      makeEntry({ asyncOrderId: 'f', status: 'queued', deviceId: 'dev-2' }), // other device — excluded
    ];
    const summary = selectDevicePendingSummary(entries, 'dev-1', NOW_MS);
    expect(summary.count).toBe(3);
  });

  test('flags stale once the oldest pending entry crosses the age threshold', () => {
    const fresh = makeEntry({ asyncOrderId: 'a', createdAtLocal: NOW_MS - 60_000 });
    const old = makeEntry({ asyncOrderId: 'b', createdAtLocal: NOW_MS - OLD_PENDING_AGE_MS - 1 });

    expect(selectDevicePendingSummary([fresh], 'dev-1', NOW_MS).isStale).toBe(false);
    const staleSummary = selectDevicePendingSummary([fresh, old], 'dev-1', NOW_MS);
    expect(staleSummary.isStale).toBe(true);
    expect(staleSummary.oldestAgeMs).toBeGreaterThanOrEqual(OLD_PENDING_AGE_MS);
  });
});

describe('selectDeviceAttentionRows', () => {
  test('surfaces rejected/orphaned/manual_review only, for this device, oldest first', () => {
    const entries = [
      makeEntry({ asyncOrderId: 'later', status: 'manual_review', createdAtLocal: NOW_MS - 1_000, manualReviewReason: 'ตรวจสอบยอดเงิน' }),
      makeEntry({ asyncOrderId: 'earlier', status: 'rejected_by_rules', createdAtLocal: NOW_MS - 5_000 }),
      makeEntry({ asyncOrderId: 'orphan', status: 'orphaned', createdAtLocal: NOW_MS - 3_000 }),
      makeEntry({ asyncOrderId: 'ok', status: 'settled_observed' }),
      makeEntry({ asyncOrderId: 'pending', status: 'queued' }),
      makeEntry({ asyncOrderId: 'other-device', status: 'manual_review', deviceId: 'dev-9' }),
    ];

    const rows = selectDeviceAttentionRows(entries, 'dev-1');
    expect(rows.map((r) => r.asyncOrderId)).toEqual(['earlier', 'orphan', 'later']);
  });

  test('rows include billId, time, amount, and a human reason', () => {
    const entry = makeEntry({
      asyncOrderId: 'x',
      status: 'rejected_by_rules',
      billId: 'B-9999',
      totalAmount: 250,
      lastErrorMessage: 'permission-denied',
    });
    const [row] = selectDeviceAttentionRows([entry], 'dev-1');
    expect(row).toMatchObject({
      asyncOrderId: 'x',
      billId: 'B-9999',
      totalAmount: 250,
      status: 'rejected_by_rules',
      reason: 'permission-denied',
    });
    expect(row.createdAtIso).toBe(entry.createdAtIso);
  });

  test('manual_review without a lastErrorMessage falls back to the manual review reason', () => {
    const entry = makeEntry({
      asyncOrderId: 'y',
      status: 'manual_review',
      manualReviewReason: 'ยอดไม่ตรงกับใบเสร็จ',
    });
    const [row] = selectDeviceAttentionRows([entry], 'dev-1');
    expect(row.reason).toBe('ยอดไม่ตรงกับใบเสร็จ');
  });

  test('falls back to a generic Thai reason when nothing else is available', () => {
    const entry = makeEntry({ asyncOrderId: 'z', status: 'orphaned' });
    const [row] = selectDeviceAttentionRows([entry], 'dev-1');
    expect(row.reason.length).toBeGreaterThan(0);
  });

  test('billId falls back to asyncOrderId when missing', () => {
    const entry = makeEntry({ asyncOrderId: 'no-bill', status: 'orphaned', billId: '' });
    const [row] = selectDeviceAttentionRows([entry], 'dev-1');
    expect(row.billId).toBe('no-bill');
  });
});

describe('readDeviceSaleIntentEntries', () => {
  test('fails open to an empty array when the journal read errors', async () => {
    const brokenJournal = {
      listSaleIntentsByStatus: async () => {
        throw new Error('IndexedDB unavailable');
      },
    };
    const entries = await readDeviceSaleIntentEntries(brokenJournal);
    expect(entries).toEqual([]);
  });

  test('fails open to an empty array when the journal returns a non-ok result', async () => {
    const journal = {
      listSaleIntentsByStatus: async () => ({ ok: false as const, code: 'unavailable' as const }),
    };
    const entries = await readDeviceSaleIntentEntries(journal);
    expect(entries).toEqual([]);
  });

  test('returns entries as-is when the journal read succeeds', async () => {
    const entry = makeEntry();
    const journal = {
      listSaleIntentsByStatus: async () => ({ ok: true as const, value: [entry] }),
    };
    const entries = await readDeviceSaleIntentEntries(journal);
    expect(entries).toEqual([entry]);
  });
});
