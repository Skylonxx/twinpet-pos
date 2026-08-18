// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { makeAsyncOrderId } from '../../lib/pos/deviceId';
import { beginOwnedActiveCartGeneration } from '../../lib/pos/offline/trustedOrchestrationOwner';
import { beginTrustedSaleSubmission } from '../../lib/pos/offline/trustedSaleSubmissionOrchestrator';
import { allocateOrderIdentity, submitAsyncOrder } from '../../lib/pos/asyncCheckout';
import { useCheckout } from './useCheckout';
import type { CartLine, CartTotals, PaymentSplit } from '../../lib/pos/types';
import type { Shift, User } from '../../lib/types';

vi.mock('../../lib/pos/offline/trustedOrchestrationOwner', { spy: true });
vi.mock('../../lib/pos/offline/trustedSaleSubmissionOrchestrator', { spy: true });
vi.mock('../../lib/pos/asyncCheckout', { spy: true });
vi.mock('../../lib/firebase', () => ({ isFirebaseConfigured: false }));
vi.mock('../../lib/customers/crmService', () => ({
  applyCrmSaleLocally: (prev: { lifetimeValue: number; points: number }) => prev,
}));
vi.mock('../../lib/customers/devMock', () => ({
  devApplyCreditCharge: vi.fn(),
  devApplyCrmAfterSale: vi.fn(),
}));
vi.mock('../../lib/pos/shiftService', () => ({
  applyShiftPaymentTotals: (shift: Shift) => shift,
  calcShiftPaymentTotals: () => ({ expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0 }),
}));
vi.mock('../../lib/pos/shiftDevMock', () => ({ devIncrementShiftTotals: vi.fn() }));
vi.mock('../../lib/pos/offline/saleIntentJournal', () => ({ createSaleIntentJournal: vi.fn() }));
vi.mock('../../lib/pos/offline/saleIntentObserver', () => ({
  createNoopSaleIntentObserver: () => ({ observe: vi.fn() }),
  createSaleIntentObserver: vi.fn(),
}));

const CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS = 2000;

const user = {
  id: 'U1',
  firstName: 'Test',
  lastName: 'User',
  username: 'test',
  pin: 'x',
  role: 'staff',
  branchIds: ['BR-1'],
  permissions: {
    canVoidOrder: false,
    canEditPrice: false,
    canViewReport: false,
    canManageStock: false,
    canManageStaff: false,
  },
  isActive: true,
  lastLoginAt: null,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
} as unknown as User;

const activeShift = {
  id: 'shift-1',
  branchId: 'BR-1',
  staffId: 'U1',
  staffName: 'Test User',
  status: 'open',
  openedAt: new Date() as unknown,
  closedAt: null,
  startingCash: 0,
  actualCashCount: 0,
  expectedCash: 0,
  expectedQr: 0,
  expectedKbank: 0,
  expectedCard: 0,
  expectedCredit: 0,
  totalBills: 0,
  payInTotal: 0,
  payOutTotal: 0,
  variance: 0,
  note: '',
  cashEntries: [],
} as unknown as Shift;

const cartLines: CartLine[] = [
  {
    lineKey: 'P1::ชิ้น',
    productId: 'P1',
    productName: 'สินค้าทดสอบ',
    category: 'cat',
    sku: 'SKU1',
    barcode: null,
    unit: 'ชิ้น',
    unitFactor: 1,
    unitPrice: 10,
    originalPrice: 10,
    qty: 1,
    discount: { type: 'none', val: 0 },
  },
];

const totals: CartTotals = {
  subtotal: 10,
  billDiscount: 0,
  fee: 0,
  grandTotal: 10,
  itemCount: 1,
  totalQty: 1,
};

const payments: PaymentSplit[] = [{ method: 'cash', amount: 10 }];

const identity = {
  deviceId: 'dev-nv2',
  deviceLabel: 'DEV',
  seq: 42,
  billId: 'R-42',
};

beforeEach(() => {
  vi.mocked(allocateOrderIdentity).mockResolvedValue(identity);
  vi.mocked(submitAsyncOrder).mockReset();
  vi.mocked(submitAsyncOrder).mockReturnValue({
    orderId: 'fabricated-submit-id-must-not-satisfy-nv2',
    billId: identity.billId,
  });
  vi.mocked(beginTrustedSaleSubmission).mockClear();
});

afterEach(() => {
  cleanup();
  vi.mocked(beginOwnedActiveCartGeneration).mockRestore();
  vi.mocked(beginTrustedSaleSubmission).mockRestore();
  vi.useRealTimers();
});

function renderCheckout() {
  return renderHook(() =>
    useCheckout({
      user,
      branchId: 'BR-1',
      activeShift,
      setActiveShift: vi.fn(),
      showToast: vi.fn(),
    }),
  );
}

describe('useCheckout trusted orchestration', () => {
  test('C-2 / NV-4 orchestration is called and a failure does not block submit', async () => {
    vi.mocked(beginTrustedSaleSubmission).mockResolvedValue({
      ok: false,
      reason: 'generation_refused',
    });
    const { result } = renderCheckout();
    let billId = '';
    await act(async () => {
      billId = await result.current.confirmSale(payments, cartLines, totals);
    });
    expect(beginTrustedSaleSubmission).toHaveBeenCalledTimes(1);
    expect(submitAsyncOrder).toHaveBeenCalledTimes(1);
    expect(billId).toBe(identity.billId);
  });

  test('NV-2 asyncOrderId equals the real makeAsyncOrderId derivation from the same identity', async () => {
    vi.mocked(beginTrustedSaleSubmission).mockResolvedValue({
      ok: true,
      generationId: 'GGGGGGGGGGGGGGGGGGGGGGGGGG',
      generationSeq: 1,
      storeEpochId: 'EEEEEEEEEEEEEEEEEEEEEEEEEE',
    });
    const { result } = renderCheckout();
    await act(async () => {
      await result.current.confirmSale(payments, cartLines, totals);
    });
    const expectedId = makeAsyncOrderId(identity.deviceId, identity.seq);
    expect(expectedId).toBe('dev-nv2-42');
    expect(expectedId).not.toBe('fabricated-submit-id-must-not-satisfy-nv2');
    expect(beginTrustedSaleSubmission).toHaveBeenCalledWith({
      branchId: 'BR-1',
      deviceId: identity.deviceId,
      asyncOrderId: expectedId,
      billId: identity.billId,
    });
    const submitted = vi.mocked(submitAsyncOrder).mock.calls[0];
    expect(submitted?.[1]?.identity).toBe(identity);
  });

  test('NV-9 never-settling orchestration still lets checkout submit within 2000ms', async () => {
    vi.mocked(beginTrustedSaleSubmission).mockRestore();
    vi.mocked(beginOwnedActiveCartGeneration).mockReturnValue(new Promise(() => {}));
    vi.useFakeTimers();
    const { result } = renderCheckout();
    const pending = result.current.confirmSale(payments, cartLines, totals);
    let settled: string | 'pending' = 'pending';
    void pending.then((value) => {
      settled = value;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECKOUT_ORCHESTRATION_SETTLE_BOUND_MS - 1);
    });
    expect(settled).toBe('pending');
    expect(submitAsyncOrder).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const billId = await pending;
    expect(billId).toBe(identity.billId);
    expect(submitAsyncOrder).toHaveBeenCalledTimes(1);
    expect(settled).toBe(identity.billId);
  });
});
