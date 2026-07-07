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
import { formatOfflineReceiptNumber } from './billId';
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

// Partial mock of deviceId.ts: every export stays the REAL implementation
// (wrapped in vi.fn so calls can be counted), keeping this jsdom environment's
// real localStorage-backed behavior (indexedDB is undefined in jsdom, so
// allocateLocalSeq() exercises its own real bounded fail-open to the real
// nextLocalSeq() — this is the "no-IDB environment" case, not a fake).
vi.mock('./deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./deviceId')>();
  return {
    ...actual,
    getDeviceId: vi.fn(actual.getDeviceId),
    getDeviceLabel: vi.fn(actual.getDeviceLabel),
    getReceiptDeviceSegment: vi.fn(actual.getReceiptDeviceSegment),
    nextLocalSeq: vi.fn(actual.nextLocalSeq),
    allocateLocalSeq: vi.fn(actual.allocateLocalSeq),
  };
});

// Imported AFTER the mocks are declared (vi.mock is hoisted, so this is safe).
import {
  allocateOrderIdentity,
  submitAsyncOrder,
  type OrderIdentity,
  type SubmitAsyncOrderInput,
} from './asyncCheckout';
import * as deviceIdModule from './deviceId';

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
  vi.mocked(deviceIdModule.getDeviceId).mockClear();
  vi.mocked(deviceIdModule.getDeviceLabel).mockClear();
  vi.mocked(deviceIdModule.getReceiptDeviceSegment).mockClear();
  vi.mocked(deviceIdModule.nextLocalSeq).mockClear();
  vi.mocked(deviceIdModule.allocateLocalSeq).mockClear();
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

// ─── W-01/3B-3 · injected identity path (Checkout Identity Preallocation) ────
describe('3B-3 · submitAsyncOrder with a pre-allocated identity', () => {
  const identity: OrderIdentity = {
    deviceId: 'DEV1234',
    deviceLabel: 'iPad-01',
    seq: 42,
    billId: 'OFF-260707-IPAD01-000042',
  };

  test('T1 · uses the injected identity verbatim for orderId/billId and the order handed to the observer', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const result = submitAsyncOrder(input, { observer, identity });

    expect(result.orderId).toBe(`${identity.deviceId}-${identity.seq}`);
    expect(result.billId).toBe(identity.billId);

    await flush();
    const entry = await journal.getSaleIntent(result.orderId);
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.value?.billId).toBe(identity.billId);
    }
  });

  test('T2 · performs no second allocation: nextLocalSeq/allocateLocalSeq are not called', () => {
    submitAsyncOrder(input, { identity });
    expect(deviceIdModule.nextLocalSeq).not.toHaveBeenCalled();
    expect(deviceIdModule.allocateLocalSeq).not.toHaveBeenCalled();
  });

  test('T2b · performs no re-composition: getDeviceId/getDeviceLabel/getReceiptDeviceSegment are not called', () => {
    submitAsyncOrder(input, { identity });
    expect(deviceIdModule.getDeviceId).not.toHaveBeenCalled();
    expect(deviceIdModule.getDeviceLabel).not.toHaveBeenCalled();
    expect(deviceIdModule.getReceiptDeviceSegment).not.toHaveBeenCalled();
  });

  test('T3 · legacy no-identity path still allocates exactly once via nextLocalSeq', () => {
    submitAsyncOrder(input);
    expect(deviceIdModule.nextLocalSeq).toHaveBeenCalledTimes(1);
  });

  test('T3b · legacy no-identity path still formats billId with formatOfflineReceiptNumber(getReceiptDeviceSegment(), seq)', () => {
    const result = submitAsyncOrder(input);
    const seq = vi.mocked(deviceIdModule.nextLocalSeq).mock.results[0]?.value as number;
    const expectedBillId = formatOfflineReceiptNumber(deviceIdModule.getReceiptDeviceSegment(), seq);
    expect(result.billId).toBe(expectedBillId);
  });

  test('T4 · submitAsyncOrder remains a non-async, synchronous export (source pin)', async () => {
    const source = (await import('./asyncCheckout.ts?raw')).default;
    expect(source).toContain('export function submitAsyncOrder(');
    expect(source).not.toContain('export async function submitAsyncOrder');
  });
});

describe('3B-3 · allocateOrderIdentity()', () => {
  test('T5 · composition matches the legacy formatter/orderId shape for an equal seq', async () => {
    const identity = await allocateOrderIdentity();
    expect(identity.billId).toBe(
      formatOfflineReceiptNumber(deviceIdModule.getReceiptDeviceSegment(), identity.seq),
    );
    expect(deviceIdModule.makeAsyncOrderId(identity.deviceId, identity.seq)).toBe(
      `${identity.deviceId}-${identity.seq}`,
    );
  });

  test('T6 · resolves via the allocator fail-open in this no-IndexedDB (jsdom) environment', async () => {
    expect(typeof indexedDB).toBe('undefined');
    const identity = await allocateOrderIdentity();
    expect(typeof identity.seq).toBe('number');
    expect(Number.isFinite(identity.seq)).toBe(true);
    expect(identity.billId.length).toBeGreaterThan(0);
  });

  test('T7 · calls allocateLocalSeq exactly once and never nextLocalSeq directly', async () => {
    await allocateOrderIdentity();
    expect(deviceIdModule.allocateLocalSeq).toHaveBeenCalledTimes(1);
  });

  test('T7b · journal correlation with a preallocated identity keys off order.id', async () => {
    const journal = createInMemorySaleIntentJournal();
    const observer = createSaleIntentObserver({ journal });
    const identity = await allocateOrderIdentity();
    const result = submitAsyncOrder(input, { observer, identity });
    await flush();
    const entry = await journal.getSaleIntent(`${identity.deviceId}-${identity.seq}`);
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.value?.status).toBe('rejected_by_rules');
    }
    expect(result.orderId).toBe(`${identity.deviceId}-${identity.seq}`);
  });
});

// ─── T8 · useCheckout source-contract pins (placement: after guard, before submit) ─
describe('3B-3 · useCheckout source contract', () => {
  let hookSource: string;
  beforeEach(async () => {
    hookSource = (await import('../../hooks/pos/useCheckout.ts?raw')).default;
  });

  test('imports allocateOrderIdentity from asyncCheckout', () => {
    expect(hookSource).toContain('allocateOrderIdentity');
    expect(hookSource).toContain("from '../../lib/pos/asyncCheckout'");
  });

  test('awaits allocateOrderIdentity() after the guard clause and before submitAsyncOrder(', () => {
    const guardIdx = hookSource.indexOf('throw new Error(');
    const allocIdx = hookSource.indexOf('await allocateOrderIdentity()');
    const submitIdx = hookSource.indexOf('submitAsyncOrder(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(allocIdx).toBeGreaterThan(guardIdx);
    expect(submitIdx).toBeGreaterThan(allocIdx);
  });

  test('passes identity through the existing deps object', () => {
    expect(hookSource).toContain('{ observer: getSaleIntentObserver(), identity }');
  });

  test('does not add a broad fallback catch around allocateOrderIdentity()', () => {
    expect(hookSource).not.toContain('catch { identity = undefined');
    expect(hookSource).not.toContain('allocateOrderIdentity().catch(');
  });
});
