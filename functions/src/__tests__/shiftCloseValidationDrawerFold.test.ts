import { describe, test, expect } from 'vitest';
import { foldDeviceScopedDrawer, isLedgerSaleDoc, type RawAsyncOrderForFold } from '../shiftCloseValidationDrawerFold';

const DEVICE = 'device-1';
const OTHER_DEVICE = 'device-2';

function sale(overrides: Partial<RawAsyncOrderForFold> & { id: string }): RawAsyncOrderForFold {
  return {
    shiftId: 'shift-1',
    branchId: 'branch-1',
    deviceId: DEVICE,
    status: 'completed',
    voidRequested: false,
    reconcileStatus: 'pending_reconcile',
    changeAmt: 0,
    payments: [],
    ...overrides,
  };
}

describe('isLedgerSaleDoc', () => {
  test('voided excluded', () => {
    expect(isLedgerSaleDoc(sale({ id: 'a', status: 'voided' }))).toBe(false);
  });
  test('voidRequested excluded', () => {
    expect(isLedgerSaleDoc(sale({ id: 'a', voidRequested: true }))).toBe(false);
  });
  test('reconcile exception excluded', () => {
    expect(isLedgerSaleDoc(sale({ id: 'a', reconcileStatus: 'exception' }))).toBe(false);
  });
  test('pending_reconcile included', () => {
    expect(isLedgerSaleDoc(sale({ id: 'a', reconcileStatus: 'pending_reconcile' }))).toBe(true);
  });
});

describe('foldDeviceScopedDrawer — parity with summarizeDrawer semantics', () => {
  test('single cash sale, no change', () => {
    const result = foldDeviceScopedDrawer(
      [sale({ id: 'a', payments: [{ method: 'cash', amount: 100 }], changeAmt: 0 })],
      DEVICE,
    );
    expect(result.foldBlocked).toBe(false);
    expect(result.expectedCashMinor).toBe(10_000);
    expect(result.totalBills).toBe(1);
  });

  test('cash net of change per sale (change > cash clamps to 0)', () => {
    const result = foldDeviceScopedDrawer(
      [sale({ id: 'a', payments: [{ method: 'cash', amount: 100 }], changeAmt: 150 })],
      DEVICE,
    );
    expect(result.expectedCashMinor).toBe(0);
  });

  test('qr/kbank/card/credit sums independently', () => {
    const result = foldDeviceScopedDrawer(
      [
        sale({
          id: 'a',
          payments: [
            { method: 'qr', amount: 10 },
            { method: 'kbank', amount: 20 },
            { method: 'card', amount: 30 },
            { method: 'credit', amount: 40 },
          ],
        }),
      ],
      DEVICE,
    );
    expect(result.expectedQrMinor).toBe(1_000);
    expect(result.expectedKbankMinor).toBe(2_000);
    expect(result.expectedCardMinor).toBe(3_000);
    expect(result.expectedCreditMinor).toBe(4_000);
  });

  test('totalBills == folded sale count', () => {
    const result = foldDeviceScopedDrawer(
      [
        sale({ id: 'a', payments: [{ method: 'cash', amount: 10 }] }),
        sale({ id: 'b', payments: [{ method: 'cash', amount: 20 }] }),
      ],
      DEVICE,
    );
    expect(result.totalBills).toBe(2);
  });

  test('voided/voidRequested/exception excluded from fold and count', () => {
    const result = foldDeviceScopedDrawer(
      [
        sale({ id: 'a', payments: [{ method: 'cash', amount: 10 }] }),
        sale({ id: 'b', status: 'voided', payments: [{ method: 'cash', amount: 999 }] }),
        sale({ id: 'c', voidRequested: true, payments: [{ method: 'cash', amount: 999 }] }),
        sale({ id: 'd', reconcileStatus: 'exception', payments: [{ method: 'cash', amount: 999 }] }),
      ],
      DEVICE,
    );
    expect(result.totalBills).toBe(1);
    expect(result.expectedCashMinor).toBe(1_000);
  });

  test('pending_reconcile is included in the fold', () => {
    const result = foldDeviceScopedDrawer(
      [sale({ id: 'a', reconcileStatus: 'pending_reconcile', payments: [{ method: 'cash', amount: 10 }] })],
      DEVICE,
    );
    expect(result.totalBills).toBe(1);
  });

  test('device-scope membership: only evidence.deviceId docs are folded', () => {
    const result = foldDeviceScopedDrawer(
      [
        sale({ id: 'a', deviceId: DEVICE, payments: [{ method: 'cash', amount: 10 }] }),
        sale({ id: 'b', deviceId: OTHER_DEVICE, payments: [{ method: 'cash', amount: 500 }] }),
      ],
      DEVICE,
    );
    expect(result.totalBills).toBe(1);
    expect(result.expectedCashMinor).toBe(1_000);
  });

  test('cross-device ledger sales are counted, not folded', () => {
    const result = foldDeviceScopedDrawer(
      [
        sale({ id: 'a', deviceId: OTHER_DEVICE, payments: [{ method: 'cash', amount: 500 }] }),
        sale({ id: 'b', deviceId: OTHER_DEVICE, payments: [{ method: 'qr', amount: 500 }] }),
      ],
      DEVICE,
    );
    expect(result.crossDeviceSalesObserved).toEqual({ observed: true, count: 2 });
    expect(result.totalBills).toBe(0);
    expect(result.saleCount).toBe(0);
  });

  test('cross-device voided doc is not counted as an observed sale', () => {
    const result = foldDeviceScopedDrawer([sale({ id: 'a', deviceId: OTHER_DEVICE, status: 'voided' })], DEVICE);
    expect(result.crossDeviceSalesObserved).toEqual({ observed: false, count: 0 });
  });

  test('no cross-device docs -> observed:false, count:0', () => {
    const result = foldDeviceScopedDrawer([sale({ id: 'a', payments: [{ method: 'cash', amount: 10 }] })], DEVICE);
    expect(result.crossDeviceSalesObserved).toEqual({ observed: false, count: 0 });
  });

  describe('malformed tender -> fold-blocked (V6 invalid_payload precursor)', () => {
    test('unknown payment method', () => {
      const result = foldDeviceScopedDrawer([sale({ id: 'a', payments: [{ method: 'bitcoin', amount: 10 }] })], DEVICE);
      expect(result.foldBlocked).toBe(true);
      expect(result.foldBlockReason).toBe('unknown_payment_method');
      expect(result.totalBills).toBeNull();
      expect(result.expectedCashMinor).toBeNull();
    });

    test('non-finite payment amount', () => {
      const result = foldDeviceScopedDrawer([sale({ id: 'a', payments: [{ method: 'cash', amount: NaN }] })], DEVICE);
      expect(result.foldBlocked).toBe(true);
      expect(result.foldBlockReason).toBe('non_finite_amount');
    });

    test('over-precision (>2dp) payment amount', () => {
      const result = foldDeviceScopedDrawer([sale({ id: 'a', payments: [{ method: 'cash', amount: 10.005 }] })], DEVICE);
      expect(result.foldBlocked).toBe(true);
      expect(result.foldBlockReason).toBe('amount_precision');
    });

    test('out-of-envelope (non-positive) payment amount', () => {
      const result = foldDeviceScopedDrawer([sale({ id: 'a', payments: [{ method: 'cash', amount: -5 }] })], DEVICE);
      expect(result.foldBlocked).toBe(true);
      expect(result.foldBlockReason).toBe('non_positive_amount');
    });

    test('malformed changeAmt on an otherwise fold-member doc', () => {
      const result = foldDeviceScopedDrawer(
        [sale({ id: 'a', payments: [{ method: 'cash', amount: 10 }], changeAmt: -1 })],
        DEVICE,
      );
      expect(result.foldBlocked).toBe(true);
      expect(result.foldBlockReason).toBe('malformed_change_amt');
    });

    test('missing/non-array payments', () => {
      const result = foldDeviceScopedDrawer([sale({ id: 'a', payments: undefined })], DEVICE);
      expect(result.foldBlocked).toBe(true);
      expect(result.foldBlockReason).toBe('payments_missing_or_malformed');
    });

    test('malformed tender on an other-device doc does NOT block the fold (corroboration-only)', () => {
      const result = foldDeviceScopedDrawer(
        [
          sale({ id: 'a', payments: [{ method: 'cash', amount: 10 }] }),
          sale({ id: 'b', deviceId: OTHER_DEVICE, payments: [{ method: 'bitcoin', amount: 999 }] }),
        ],
        DEVICE,
      );
      expect(result.foldBlocked).toBe(false);
      expect(result.crossDeviceSalesObserved.count).toBe(1);
    });

    test('deterministic first-blocking-reason regardless of input order (canonical docId ASC scan)', () => {
      const docs = [
        sale({ id: 'z', payments: [{ method: 'bitcoin', amount: 1 }] }),
        sale({ id: 'a', payments: [{ method: 'cash', amount: NaN }] }),
      ];
      const forward = foldDeviceScopedDrawer(docs, DEVICE);
      const reversed = foldDeviceScopedDrawer([...docs].reverse(), DEVICE);
      expect(forward.foldBlockDocId).toBe('a');
      expect(forward.foldBlockReason).toBe('non_finite_amount');
      expect(reversed).toEqual(forward);
    });
  });

  test('empty input -> zero totals, not blocked', () => {
    const result = foldDeviceScopedDrawer([], DEVICE);
    expect(result.foldBlocked).toBe(false);
    expect(result.totalBills).toBe(0);
    expect(result.expectedCashMinor).toBe(0);
    expect(result.crossDeviceSalesObserved).toEqual({ observed: false, count: 0 });
  });
});
