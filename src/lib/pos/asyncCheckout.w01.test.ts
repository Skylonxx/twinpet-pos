// @vitest-environment jsdom
//
// W-01 evidence (client side) — the CURRENT "before" behavior of submitAsyncOrder
// when the Firestore `asyncOrders` write is rejected by rules (permission-denied).
//
// This is BEFORE-STATE evidence only. It changes NO production code and wires NO
// observer. It proves the W-01 risk exactly:
//   1. submitAsyncOrder still returns a cashier-visible orderId + billId even though
//      the setDoc promise rejects (fire-and-forget; success returns before settle).
//   2. The rejection is swallowed and only logged via console.warn — no throw to caller.
//   3. The current catch does NOT inspect err.code — a terminal `permission-denied`
//      is misclassified identically to a transient offline-pending "queued, will retry".
//   4. The current execution path writes NO durable Sale Intent Journal evidence
//      (Packet 1 journal is not imported/wired by asyncCheckout).
//
// Packet 2 (future) MUST capture the RAW setDoc promise before any `.catch`, so its
// observer can classify permission-denied. The forbidden future shape is:
//     const p = setDoc(...).catch(console.warn); observer.observe(p)  // ← swallows the reject
// A source assertion below pins that the current code chains `.catch` directly, so the
// wiring packet has to change this exact line rather than layer on top of it.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
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

// ─── Source-level "before" contract (durable-evidence gap + anti-pattern pin) ─────
describe('W-01 · asyncCheckout current source contract', () => {
  let source: string;
  beforeEach(async () => {
    source = (await import('./asyncCheckout.ts?raw')).default;
  });

  test('writes NO durable Sale Intent Journal evidence (journal not imported/wired)', () => {
    // Packet 1's journal is not referenced by the checkout write path today.
    for (const token of [
      'saleIntentJournal',
      'createSaleIntentJournal',
      'enqueueSaleIntent',
      'markRejectedByRules',
      'SaleIntentJournal',
    ]) {
      expect(source).not.toContain(token);
    }
  });

  test('the catch is a direct-chained log that does NOT classify permission-denied', () => {
    // Direct `.catch(...)` chained onto the setDoc(...) call (the swallow), console.warn inside.
    expect(source).toContain('void setDoc(');
    expect(source).toContain('order).catch('); // `.catch` chained directly onto setDoc's result
    expect(source).toContain('console.warn');
    // The current catch never inspects err.code / permission-denied → offline vs terminal
    // rejection are conflated. (Packet 2 must add this classification on the RAW promise.)
    expect(source).not.toContain('permission-denied');
    expect(source).not.toContain('err.code');
  });

  test('FUTURE GUARD (documented): the observer must not receive an already-caught promise', () => {
    // The current code chains `.catch(console.warn)` directly, so today there is NO
    // `observer.observe(...)` and NO pre-caught promise handed anywhere. Packet 2 must
    // capture `const writePromise = setDoc(...)` (raw) BEFORE any `.catch`.
    expect(source).not.toContain('observer.observe');
    expect(source).not.toContain('.catch(console.warn));');
  });
});
