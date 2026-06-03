import { describe, test, expect } from 'vitest';
import type { AsyncPayment, Shift, ShiftCashEntry } from '../types';
import type { LocalSale } from './localLedger';
import { deriveShiftDrawer, foldCashEntries, summarizeDrawer } from './shiftLedger';

// ─── Fixtures ────────────────────────────────────────────────────────────────
//
// summarizeDrawer reads only `payments` and `changeAmt` off each LocalSale, so we
// build a minimal sale and cast.

function sale(payments: AsyncPayment[], changeAmt = 0): LocalSale {
  return { payments, changeAmt } as unknown as LocalSale;
}

const cash = (amount: number): AsyncPayment => ({ method: 'cash', amount, ref: null });
const qr = (amount: number): AsyncPayment => ({ method: 'qr', amount, ref: null });
const kbank = (amount: number): AsyncPayment => ({ method: 'kbank', amount, ref: null });
const card = (amount: number): AsyncPayment => ({ method: 'card', amount, ref: null });
const credit = (amount: number): AsyncPayment => ({ method: 'credit', amount, ref: null });

// ─── summarizeDrawer ─────────────────────────────────────────────────────────

describe('summarizeDrawer', () => {
  test('empty ledger → all-zero totals', () => {
    expect(summarizeDrawer([])).toEqual({
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      totalBills: 0,
    });
  });

  test('sums each tender method independently across sales', () => {
    const sales = [
      sale([cash(100)]),
      sale([qr(50)]),
      sale([kbank(30)]),
      sale([card(20)]),
      sale([credit(40)]),
    ];
    expect(summarizeDrawer(sales)).toEqual({
      expectedCash: 100,
      expectedQr: 50,
      expectedKbank: 30,
      expectedCard: 20,
      expectedCredit: 40,
      totalBills: 5,
    });
  });

  test('cash is net of change given on that sale', () => {
    // Tendered 500 cash on a 420 sale → 80 change → 420 hits the drawer.
    const totals = summarizeDrawer([sale([cash(500)], 80)]);
    expect(totals.expectedCash).toBe(420);
  });

  test('change only reduces cash, never the cashless tenders', () => {
    // Split-tender 200 cash + 300 qr on a 480 sale, 20 change from the cash.
    const totals = summarizeDrawer([sale([cash(200), qr(300)], 20)]);
    expect(totals.expectedCash).toBe(180);
    expect(totals.expectedQr).toBe(300);
  });

  test('net cash floors at zero per sale (never negative)', () => {
    // Degenerate: change recorded larger than cash tendered must not go negative.
    const totals = summarizeDrawer([sale([cash(50)], 80)]);
    expect(totals.expectedCash).toBe(0);
  });

  test('floors per sale — a refunded-change bill does not subtract from another', () => {
    // Sale A: cash 50, change 80 → floors to 0 (not -30).
    // Sale B: cash 200, no change → 200. Total must be 200, not 170.
    const totals = summarizeDrawer([sale([cash(50)], 80), sale([cash(200)])]);
    expect(totals.expectedCash).toBe(200);
  });

  test('counts one bill per sale', () => {
    expect(summarizeDrawer([sale([cash(10)]), sale([qr(10)]), sale([card(10)])]).totalBills).toBe(
      3,
    );
  });

  test('rounds money to avoid float drift', () => {
    const totals = summarizeDrawer([sale([cash(10.1)]), sale([cash(20.2)])]);
    expect(totals.expectedCash).toBe(30.3);
  });
});

// ─── foldCashEntries ─────────────────────────────────────────────────────────

const entry = (type: ShiftCashEntry['type'], amount: number): ShiftCashEntry =>
  ({ type, amount }) as ShiftCashEntry;

describe('foldCashEntries', () => {
  test('empty → zero pay-in/out', () => {
    expect(foldCashEntries([])).toEqual({ payInTotal: 0, payOutTotal: 0 });
  });

  test('sums pay-in and pay-out independently', () => {
    const totals = foldCashEntries([
      entry('pay_in', 500),
      entry('pay_out', 120),
      entry('pay_in', 300),
    ]);
    expect(totals).toEqual({ payInTotal: 800, payOutTotal: 120 });
  });

  test('rounds money to avoid float drift', () => {
    expect(foldCashEntries([entry('pay_in', 10.1), entry('pay_in', 20.2)]).payInTotal).toBe(30.3);
  });
});

// ─── deriveShiftDrawer ───────────────────────────────────────────────────────

describe('deriveShiftDrawer', () => {
  // Stored counters are stale on purpose — the derive must IGNORE them and
  // recompute from the ledger (expected*) and cashEntries (pay-in/out).
  function baseShift(cashEntries: ShiftCashEntry[] = []): Shift {
    return {
      startingCash: 1000,
      payInTotal: 99999,
      payOutTotal: 99999,
      variance: 0,
      expectedCash: 99999,
      expectedQr: 99999,
      expectedKbank: 99999,
      expectedCard: 99999,
      expectedCredit: 99999,
      totalBills: 99999,
      cashEntries,
    } as unknown as Shift;
  }

  test('replaces stored expected* totals with the ledger fold', () => {
    const sales = [sale([cash(300)]), sale([qr(150)])];
    const derived = deriveShiftDrawer(baseShift(), sales);

    expect(derived.expectedCash).toBe(300);
    expect(derived.expectedQr).toBe(150);
    expect(derived.expectedKbank).toBe(0);
    expect(derived.totalBills).toBe(2);
  });

  test('derives pay-in/out from cashEntries, ignoring stale stored counters', () => {
    const derived = deriveShiftDrawer(
      baseShift([entry('pay_in', 200), entry('pay_out', 50)]),
      [sale([cash(300)])],
    );
    expect(derived.payInTotal).toBe(200);
    expect(derived.payOutTotal).toBe(50);
  });

  test('no cashEntries → pay-in/out fold to zero (not the stale counter)', () => {
    const derived = deriveShiftDrawer(baseShift(), [sale([cash(300)])]);
    expect(derived.payInTotal).toBe(0);
    expect(derived.payOutTotal).toBe(0);
  });

  test('preserves non-sale fields (startingCash)', () => {
    expect(deriveShiftDrawer(baseShift(), [sale([cash(300)])]).startingCash).toBe(1000);
  });

  test('does not mutate the input shift', () => {
    const shift = baseShift([entry('pay_in', 200)]);
    deriveShiftDrawer(shift, [sale([cash(300)])]);
    expect(shift.expectedCash).toBe(99999);
    expect(shift.payInTotal).toBe(99999);
  });
});
