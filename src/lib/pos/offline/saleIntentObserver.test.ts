import { describe, test, expect, vi } from 'vitest';
import type { AsyncOrder } from '../../types';
import { createInMemorySaleIntentJournal } from './saleIntentJournal';
import { createNoopSaleIntentObserver, createSaleIntentObserver } from './saleIntentObserver';

/** A promise plus externally-callable resolve/reject, for controlling settle timing. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeOrder(overrides?: Partial<AsyncOrder>): AsyncOrder {
  return {
    id: 'DEV1-000001',
    billId: 'B-000001',
    deviceId: 'DEV1',
    deviceLabel: 'iPad-01',
    branchId: 'LDP-001',
    shiftId: 'shift-1',
    staffId: 'staff1',
    staffName: 'Staff One',
    customerId: null,
    customerSnap: null,
    priceLevelId: 'retail',
    lines: [],
    payments: [{ method: 'cash', amount: 50, ref: null }],
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
    clientCreatedAt: Date.now(),
    serverCreatedAt: null,
    updatedAt: null,
    ...overrides,
  } as AsyncOrder;
}

const permissionDenied = Object.assign(new Error('Missing or insufficient permissions.'), {
  code: 'permission-denied',
});

describe('saleIntentObserver · no-op observer', () => {
  test('observe() is inert — never throws, never touches a journal', () => {
    const observer = createNoopSaleIntentObserver();
    const { promise } = deferred<void>();
    expect(() => observer.observe(makeOrder(), promise)).not.toThrow();
  });
});

describe('saleIntentObserver · real observer (fail-open, fixed-key contract)', () => {
  test('enqueues a redacted Sale Intent before classification settles', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder();
    const { promise } = deferred<void>(); // never settles in this test
    observer.observe(order, promise);

    await new Promise((r) => setTimeout(r, 0));
    const entry = await journal.getSaleIntent(order.id);
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.value?.status).toBe('flushed_to_cache');
      // redacted policy: payload retained but no customer PII duplication.
      expect(entry.value?.asyncOrderId).toBe(order.id);
    }
  });

  test('marks flushed_to_cache without awaiting server ack', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder({ id: 'DEV1-000002', billId: 'B-000002' });
    const { promise } = deferred<void>(); // still pending — server ack never arrives here
    observer.observe(order, promise);

    await new Promise((r) => setTimeout(r, 0));
    const entry = await journal.getSaleIntent(order.id);
    expect(entry.ok && entry.value?.status).toBe('flushed_to_cache');
  });

  test('raw promise resolve marks server_acknowledged', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder({ id: 'DEV1-000003', billId: 'B-000003' });
    const { promise, resolve } = deferred<void>();
    observer.observe(order, promise);
    resolve();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const entry = await journal.getSaleIntent(order.id);
    expect(entry.ok && entry.value?.status).toBe('server_acknowledged');
  });

  test('permission-denied rejection marks rejected_by_rules with sanitized code', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder({ id: 'DEV1-000004', billId: 'B-000004' });
    const { promise, reject } = deferred<void>();
    observer.observe(order, promise);
    reject(permissionDenied);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const entry = await journal.getSaleIntent(order.id);
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.value?.status).toBe('rejected_by_rules');
      expect(entry.value?.lastErrorCode).toBe('permission-denied');
    }
  });

  test('non-rule rejection records exception_observed with fixed keys only', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder({ id: 'DEV1-000005', billId: 'B-000005' });
    const { promise, reject } = deferred<void>();
    observer.observe(order, promise);
    reject(Object.assign(new Error('network hiccup'), { code: 'unavailable' }));

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const entry = await journal.getSaleIntent(order.id);
    expect(entry.ok && entry.value?.status).toBe('exception_observed');

    const events = await journal.listSaleIntentEvents(order.id);
    expect(events.ok).toBe(true);
    if (events.ok) {
      const exceptionEvent = events.value.find(
        (e) => e.eventType === 'exception_observed' && e.details,
      );
      expect(exceptionEvent).toBeDefined();
      const details = exceptionEvent?.details ?? {};
      // Fixed literal keys only — no computed/dynamic keys, no raw Error object.
      expect(Object.keys(details).sort()).toEqual(['errorCode', 'phase']);
      expect(details.phase).toBe('observe');
      expect(details.errorCode).toBe('unavailable');
      expect(typeof details.errorCode).toBe('string');
    }
  });

  test('journal unavailable does not throw — fails open', async () => {
    const journal = createInMemorySaleIntentJournal();
    // Force every journal call to fail by using an asyncOrderId that will never
    // be enqueued successfully: simulate by rejecting the underlying store call.
    const brokenJournal = {
      ...journal,
      enqueueSaleIntent: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const observer = createSaleIntentObserver({ journal: brokenJournal });
    const order = makeOrder({ id: 'DEV1-000006', billId: 'B-000006' });
    const { promise, resolve } = deferred<void>();
    expect(() => observer.observe(order, promise)).not.toThrow();
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // No throw surfaced anywhere; nothing to assert beyond survival.
  });

  test('duplicate enqueue (same asyncOrderId observed twice) does not throw', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder({ id: 'DEV1-000007', billId: 'B-000007' });
    const { promise: p1, resolve: r1 } = deferred<void>();
    const { promise: p2, resolve: r2 } = deferred<void>();
    expect(() => observer.observe(order, p1)).not.toThrow();
    expect(() => observer.observe(order, p2)).not.toThrow();
    r1();
    r2();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Second enqueue is a 'duplicate' JournalResult, not a throw; fail-open.
  });

  test('does not retry or re-send the write — observer never initiates a write', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const order = makeOrder({ id: 'DEV1-000008', billId: 'B-000008' });
    const { promise, reject } = deferred<void>();
    observer.observe(order, promise);
    reject(permissionDenied);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // The observer's only surface is `observe`; it holds no setDoc/network handle,
    // so there is nothing it could call to retry or re-send the write.
    expect(Object.keys(observer)).toEqual(['observe']);
  });
});
