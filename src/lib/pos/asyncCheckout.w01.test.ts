// @vitest-environment jsdom
//
// W-01 evidence (client side): submitAsyncOrder behavior when the Firestore
// `asyncOrders` write is rejected by rules (permission-denied).
//
// BEFORE-state (no observer injected — the default/fallback path, unchanged):
//   1. submitAsyncOrder still returns a cashier-visible orderId + billId even though
//      the setDoc promise rejects (fire-and-forget; success returns before settle).
//   2. The rejection is swallowed and only logged via console.warn — no throw to caller.
//
// AFTER-state (Packet 2 observer wired via injected deps):
//   3. The observer receives the RAW setDoc promise (captured before any `.catch`) and
//      classifies a permission-denied rejection as `rejected_by_rules` in the journal —
//      the rejection is no longer silently lost when an observer is present.
//   4. When an observer is present, the fallback console.warn is skipped entirely (the
//      observer owns classification instead of a duplicate/competing log path).
//
// The forbidden anti-pattern remains:
//     const p = setDoc(...).catch(console.warn); observer.observe(p)  // ← swallows the reject
// Source-level assertions below pin that the raw promise is captured in a variable
// BEFORE the observer/fallback branch, so the anti-pattern cannot silently regress.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInMemorySaleIntentJournal } from './offline/saleIntentJournal';
import { createSaleIntentObserver } from './offline/saleIntentObserver';
import type { CartLine, CartTotals, PaymentSplit } from './types';

// Force the Firebase branch of submitAsyncOrder (`if (isFirebaseConfigured && db)`)
// without touching production source. Both this test and asyncCheckout.ts resolve
// `../firebase` to the same module, so this mock applies to the code under test.
vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
}));

// Reject the write like a Firestore rules denial. `vi.hoisted` makes the mock fn
// available to the (hoisted) vi.mock factory. Only `doc` (avoid real Firestore
// validation on the fake db) and `setDoc` (the rejection) are overridden; every other
// export stays real so transitive imports are unaffected.
const { setDocMock } = vi.hoisted(() => {
  const permissionDenied = Object.assign(new Error('Missing or insufficient permissions.'), {
    code: 'permission-denied',
  });
  return { setDocMock: vi.fn(() => Promise.reject(permissionDenied)) };
});

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: vi.fn(() => ({}) as never),
    setDoc: setDocMock,
  };
});

// Imported AFTER the mocks are declared (vi.mock is hoisted, so this is safe).
import { submitAsyncOrder, type SubmitAsyncOrderInput } from './asyncCheckout';

const line = {
  lineKey: 'lk1',
  productId: 'p1',
  productName: 'สินค้าทดสอบ',
  category: 'cat',
  sku: 'SKU-1',
  barcode: null,
  unit: 'ชิ้น',
  unitFactor: 1,
  unitPrice: 50,
  originalPrice: 50,
  qty: 1,
  discount: { type: 'none', val: 0 },
} as unknown as CartLine;

const totals: CartTotals = {
  subtotal: 50,
  billDiscount: 0,
  fee: 0,
  grandTotal: 50,
  itemCount: 1,
  totalQty: 1,
};

const payments: PaymentSplit[] = [{ method: 'cash', amount: 50 }];

const input: SubmitAsyncOrderInput = {
  branchId: 'LDP-001',
  staffId: 'staff2',
  staffName: 'Staff Two',
  shiftId: 'shift-1',
  lines: [line],
  totals,
  billDiscount: 0,
  fee: 0,
  payments,
  customerId: null,
  customerName: null,
};

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setDocMock.mockClear();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/** Drain microtasks + one macrotask so the fire-and-forget `.catch` has run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('W-01 · submitAsyncOrder BEFORE-state (setDoc rejected by rules)', () => {
  test('returns a cashier-visible orderId + billId despite the setDoc rejection', () => {
    const result = submitAsyncOrder(input);
    expect(typeof result.orderId).toBe('string');
    expect(result.orderId.length).toBeGreaterThan(0);
    expect(typeof result.billId).toBe('string');
    expect(result.billId.length).toBeGreaterThan(0);
    // The write was attempted against asyncOrders (fire-and-forget).
    expect(setDocMock).toHaveBeenCalledTimes(1);
  });

  test('does NOT throw to the caller — the rejection is swallowed', () => {
    expect(() => submitAsyncOrder(input)).not.toThrow();
  });

  test('logs the rejection via console.warn (log-only, no durable evidence)', async () => {
    submitAsyncOrder(input);
    await flush();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The existing (misleading) message treats every rejection as transient.
    const [msg] = warnSpy.mock.calls[0] as unknown[];
    expect(String(msg)).toContain('[asyncCheckout]');
    expect(String(msg)).toContain('queued, will retry');
  });

  test('the returned success is unaffected by the (later) terminal rejection', async () => {
    const result = submitAsyncOrder(input);
    await flush(); // rejection has now been observed + swallowed
    expect(result.orderId.length).toBeGreaterThan(0);
    expect(result.billId.length).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('W-01 · submitAsyncOrder AFTER-state (observer injected)', () => {
  test('permission-denied rejection is observed as rejected_by_rules (no longer silently lost)', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const result = submitAsyncOrder(input, { observer });
    await flush();
    await flush();

    const entry = await journal.getSaleIntent(result.orderId);
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.value?.status).toBe('rejected_by_rules');
      expect(entry.value?.lastErrorCode).toBe('permission-denied');
    }
  });

  test('return shape/timing is unchanged with an observer injected', () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const result = submitAsyncOrder(input, { observer });
    expect(typeof result.orderId).toBe('string');
    expect(result.orderId.length).toBeGreaterThan(0);
    expect(typeof result.billId).toBe('string');
    expect(result.billId.length).toBeGreaterThan(0);
  });

  test('does NOT throw to the caller when an observer is injected', () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    expect(() => submitAsyncOrder(input, { observer })).not.toThrow();
  });

  test('fallback console.warn is skipped when an observer is present (observer owns classification)', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    submitAsyncOrder(input, { observer });
    await flush();
    await flush();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── Source-level contract (raw-promise interception + anti-pattern pin) ─────
describe('W-01 · asyncCheckout source contract', () => {
  let source: string;
  beforeEach(async () => {
    source = (await import('./asyncCheckout.ts?raw')).default;
  });

  test('captures the RAW setDoc promise in a variable before any .catch/observer branch', () => {
    expect(source).toContain('const writePromise = setDoc(');
    // The forbidden anti-pattern: `.catch` chained directly onto setDoc's result,
    // which would resolve a permission-denied rejection before the observer sees it.
    expect(source).not.toContain('order).catch(');
    expect(source).not.toContain('setDoc(doc(db, \'asyncOrders\', order.id), order).catch(');
  });

  test('passes the raw writePromise (not a pre-caught derivative) to the observer', () => {
    expect(source).toContain('deps.observer.observe(order, writePromise)');
    expect(source).not.toContain('observer.observe(order, writePromise.catch(');
    expect(source).not.toContain('observer.observe(order, writePromise.then(');
  });

  test('fallback console.warn only runs on the no-observer branch', () => {
    expect(source).toContain('void writePromise.catch(');
    expect(source).toContain('console.warn');
  });

  test('asyncCheckout.ts does not import the Sale Intent Journal directly (observer is injected)', () => {
    for (const token of ['createSaleIntentJournal', 'enqueueSaleIntent', "from './offline/saleIntentJournal'"]) {
      expect(source).not.toContain(token);
    }
  });
});
