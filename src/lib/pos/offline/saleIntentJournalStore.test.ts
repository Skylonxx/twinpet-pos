// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AsyncOrder } from '../../types';
import {
  createInMemorySaleIntentJournal,
  createSaleIntentJournal,
} from './saleIntentJournal';
import {
  createInMemorySaleIntentJournalStore,
  type SaleIntentJournalStore,
} from './saleIntentJournalStore';
import { DEFAULT_PRUNE_MAX_ENTRIES } from './saleIntentJournalTypes';

const fixedNow = () => new Date('2026-07-01T12:00:00.000Z');

function makeAsyncOrder(id = 'dev-1-99'): AsyncOrder {
  return {
    id,
    billId: 'B-0099',
    deviceId: 'dev-1',
    branchId: 'branch-1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    staffName: 'Tester',
    customerId: null,
    customerSnap: null,
    priceLevelId: 'retail',
    lines: [],
    payments: [],
    subtotal: 50,
    discountAmt: 0,
    billDiscount: 0,
    fee: 0,
    vatRate: 0,
    vatAmt: 0,
    total: 50,
    paidAmt: 50,
    changeAmt: 0,
    creditAmt: 0,
    status: 'completed',
    reconcileStatus: 'pending_reconcile',
    reconciledAt: null,
    note: '',
    printCount: 0,
    clientCreatedAt: Date.parse('2026-07-01T11:00:00.000Z'),
    serverCreatedAt: null,
    updatedAt: null,
  };
}

function makeJournal() {
  return createInMemorySaleIntentJournal({ now: fixedNow });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('enqueue and read', () => {
  test('enqueue happy path', async () => {
    const journal = makeJournal();
    const order = makeAsyncOrder();
    const enq = await journal.enqueueSaleIntent({ order });
    expect(enq.ok).toBe(true);
    if (!enq.ok) return;
    expect(enq.value.asyncOrderId).toBe(order.id);
    expect(enq.value.localQueueId).toBe(order.id);
    expect(enq.value.idempotencyKey).toBe(order.id);

    const got = await journal.getSaleIntent(order.id);
    expect(got.ok && got.value?.status).toBe('queued');
  });

  test('duplicate id returns duplicate error', async () => {
    const journal = makeJournal();
    const order = makeAsyncOrder();
    await journal.enqueueSaleIntent({ order });
    const dup = await journal.enqueueSaleIntent({ order });
    expect(dup.ok).toBe(false);
    if (dup.ok) return;
    expect(dup.code).toBe('duplicate');
  });

  test('list by status filters and sorts', async () => {
    const journal = makeJournal();
    await journal.enqueueSaleIntent({ order: makeAsyncOrder('a-1') });
    await journal.enqueueSaleIntent({ order: makeAsyncOrder('a-2') });
    await journal.markFlushedToCache('a-1');
    const queued = await journal.listSaleIntentsByStatus(['queued']);
    expect(queued.ok && queued.value?.map((e) => e.asyncOrderId)).toEqual(['a-2']);
  });
});

describe('transitions and events', () => {
  test('transition end-to-end with event append', async () => {
    const journal = makeJournal();
    const order = makeAsyncOrder('t-1');
    await journal.enqueueSaleIntent({ order });
    const moved = await journal.markFlushedToCache('t-1');
    expect(moved.ok && moved.value?.status).toBe('flushed_to_cache');

    const events = await journal.listSaleIntentEvents('t-1');
    expect(events.ok && events.value?.length).toBe(2);
    expect(events.ok && events.value?.[1].eventType).toBe('flushed_to_cache');
  });

  test('illegal transition is non-throwing', async () => {
    const journal = makeJournal();
    await journal.enqueueSaleIntent({ order: makeAsyncOrder('bad-1') });
    const eventsBefore = await journal.listSaleIntentEvents('bad-1');
    const res = await journal.transitionStatus('bad-1', 'settled_observed');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('illegal_transition');
    const eventsAfter = await journal.listSaleIntentEvents('bad-1');
    expect(eventsAfter.ok && eventsAfter.value?.length).toBe(eventsBefore.ok ? eventsBefore.value?.length : 0);
    const entry = await journal.getSaleIntent('bad-1');
    expect(entry.ok && entry.value?.status).toBe('queued');
  });

  test('recordSaleIntentEvent sanitizes caller details before persistence', async () => {
    const journal = makeJournal();
    await journal.enqueueSaleIntent({ order: makeAsyncOrder('ev-sanitize') });
    const err = new Error('boom\nat foo');
    err.stack = 'stack must not persist';
    const rec = await journal.recordSaleIntentEvent('ev-sanitize', 'pruned_notice', {
      msg: 'line1\nline2',
      err,
      nested: { customerSnap: { name: 'secret' } },
      count: 2,
      ok: true,
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.value.details).toEqual({
      msg: 'line1 line2',
      err: 'boom at foo',
      nested: '[non-primitive]',
      count: 2,
      ok: true,
    });
    const persisted = await journal.listSaleIntentEvents('ev-sanitize');
    const custom = persisted.ok ? persisted.value?.find((e) => e.eventType === 'pruned_notice') : undefined;
    expect(custom?.details).toEqual(rec.value.details);
  });

  test('recordSaleIntentEvent appends custom event', async () => {
    const journal = makeJournal();
    await journal.enqueueSaleIntent({ order: makeAsyncOrder('ev-1') });
    const rec = await journal.recordSaleIntentEvent('ev-1', 'pruned_notice', { note: 'test' });
    expect(rec.ok && rec.value?.eventType).toBe('pruned_notice');
  });

  test('markRejectedByRules sanitizes error', async () => {
    const journal = makeJournal();
    await journal.enqueueSaleIntent({ order: makeAsyncOrder('rej-1') });
    const res = await journal.markRejectedByRules('rej-1', new Error('rules\nfail'));
    expect(res.ok && res.value?.lastErrorMessage).toBe('rules fail');
  });
});

describe('transaction rollback on error', () => {
  test('in-memory store rolls back put on throw', async () => {
    const store = createInMemorySaleIntentJournalStore();
    await expect(
      store.transact(['saleIntents'], 'readwrite', async (txn) => {
        await txn.put('saleIntents', 'x', { asyncOrderId: 'x' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const read = await store.transact(['saleIntents'], 'readonly', async (txn) =>
      txn.get('saleIntents', 'x'),
    );
    expect(read).toBeUndefined();
  });
});

describe('pruneSaleIntents', () => {
  test('phase A strips payload on legacy settled entry that still retains payload', async () => {
    const backing = createInMemorySaleIntentJournalStore();
    const journal = createInMemorySaleIntentJournal({ store: backing, now: fixedNow });
    const id = 'prune-a';
    const order = makeAsyncOrder(id);
    await backing.transact(['saleIntents'], 'readwrite', async (txn) => {
      await txn.put('saleIntents', id, {
        asyncOrderId: id,
        localQueueId: id,
        idempotencyKey: id,
        billId: order.billId,
        branchId: order.branchId,
        deviceId: order.deviceId,
        shiftId: order.shiftId,
        staffId: order.staffId,
        createdAtLocal: order.clientCreatedAt,
        createdAtIso: fixedNow().toISOString(),
        status: 'settled_observed',
        payloadVersion: 1,
        salePayload: order,
        payloadStrippedAt: null,
        totalAmount: order.total,
        retryCount: 0,
        lastAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        rejectedAt: null,
        serverAcknowledgedAt: null,
        settledObservedAt: fixedNow().toISOString(),
        manualReviewReason: null,
        conflictState: null,
        supersededBy: null,
        nextEventSeq: 1,
        updatedAtLocal: fixedNow().toISOString(),
      });
    });

    const pruned = await journal.pruneSaleIntents();
    expect(pruned.ok && pruned.value?.strippedPayloads).toBe(1);
    const after = await journal.getSaleIntent(id);
    expect(after.ok && after.value?.salePayload).toBeNull();
  });

  test('phase B deletes resolved entries older than 14 days', async () => {
    const backing = createInMemorySaleIntentJournalStore();
    const oldNow = () => new Date('2026-06-01T00:00:00.000Z');
    const j1 = createInMemorySaleIntentJournal({ store: backing, now: oldNow });
    const id = 'prune-b';
    const oldOrder = {
      ...makeAsyncOrder(id),
      clientCreatedAt: Date.parse('2026-05-01T00:00:00.000Z'),
    };
    await j1.enqueueSaleIntent({ order: oldOrder });
    await j1.transitionStatus(id, 'flushed_to_cache');
    await j1.transitionStatus(id, 'settled_observed');

    const j2 = createInMemorySaleIntentJournal({ store: backing, now: fixedNow });
    const pruned = await j2.pruneSaleIntents({ maxAgeDays: 14 });
    expect(pruned.ok && pruned.value?.deletedEntries).toBe(1);
    const gone = await j2.getSaleIntent(id);
    expect(gone.ok && gone.value).toBeUndefined();
    const events = await j2.listSaleIntentEvents(id);
    expect(events.ok && events.value?.length).toBe(0);
  });

  test('500-entry cap only prunes resolved terminal overflow', async () => {
    const backing = createInMemorySaleIntentJournalStore();
    const journal = createInMemorySaleIntentJournal({ store: backing, now: fixedNow });
    const oldTs = Date.parse('2026-05-01T00:00:00.000Z');

    for (let i = 0; i < DEFAULT_PRUNE_MAX_ENTRIES; i++) {
      await journal.enqueueSaleIntent({
        order: makeAsyncOrder(`risk-${i}`),
      });
    }
    for (let i = 0; i < 20; i++) {
      const id = `resolved-${i}`;
      await journal.enqueueSaleIntent({
        order: { ...makeAsyncOrder(id), clientCreatedAt: oldTs - i },
      });
      await journal.transitionStatus(id, 'flushed_to_cache');
      await journal.transitionStatus(id, 'settled_observed');
    }

    const pruned = await journal.pruneSaleIntents({ maxEntries: DEFAULT_PRUNE_MAX_ENTRIES });
    expect(pruned.ok).toBe(true);
    const queued = await journal.listSaleIntentsByStatus(['queued']);
    expect(queued.ok && queued.value?.length).toBe(DEFAULT_PRUNE_MAX_ENTRIES);
  });
});

describe('journal meta', () => {
  test('get/set meta', async () => {
    const journal = makeJournal();
    const set = await journal.setJournalMeta({ deviceId: 'dev-1' });
    expect(set.ok && set.value?.deviceId).toBe('dev-1');
    const got = await journal.getJournalMeta();
    expect(got.ok && got.value?.deviceId).toBe('dev-1');
  });
});

describe('open / unavailable', () => {
  test('indexedDB unavailable returns unavailable result', async () => {
    const original = globalThis.indexedDB;
    // @ts-expect-error test override
    delete globalThis.indexedDB;
    const journal = createSaleIntentJournal();
    const res = await journal.enqueueSaleIntent({ order: makeAsyncOrder('u-1') });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('unavailable');
    globalThis.indexedDB = original;
  });

  test('QuotaExceededError maps to quota result without throw', async () => {
    const quotaStore: SaleIntentJournalStore = {
      transact: async () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      },
    };
    const journal = createInMemorySaleIntentJournal({ store: quotaStore, now: fixedNow });
    const res = await journal.enqueueSaleIntent({ order: makeAsyncOrder('quota-1') });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('quota');
  });
});

describe('static source guards (journal + store)', () => {
  let journalSource = '';
  let storeSource = '';

  beforeAll(async () => {
    journalSource = (await import('./saleIntentJournal.ts?raw')).default;
    storeSource = (await import('./saleIntentJournalStore.ts?raw')).default;
  });

  test('loads raw sources', () => {
    expect(journalSource.length).toBeGreaterThan(0);
    expect(storeSource.length).toBeGreaterThan(0);
  });

  test('no forbidden runtime imports', () => {
    for (const src of [journalSource, storeSource]) {
      expect(src).not.toMatch(/from ['"]firebase/);
      expect(src).not.toMatch(/from ['"]react/);
      expect(src).not.toMatch(/asyncCheckout|POSPage|PaymentModal|useCheckout/);
      expect(src).not.toMatch(/localStorage|sessionStorage/);
      expect(src).not.toMatch(/\bfetch\s*\(/);
    }
  });

  test('no production importer outside offline journal package', async () => {
    const files = [
      journalSource,
      storeSource,
      (await import('./saleIntentJournalLogic.ts?raw')).default,
      (await import('./saleIntentJournalTypes.ts?raw')).default,
    ];
    for (const src of files) {
      expect(src).not.toMatch(/from ['"]\.\.\/\.\.\/pages\//);
    }
  });
});
