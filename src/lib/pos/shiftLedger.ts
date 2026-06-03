import { roundMoney } from '../money';
import type { Shift, ShiftCashEntry } from '../types';
import type { LocalSale } from './localLedger';

/**
 * Drawer single-writer (Standalone POS — Local-First).
 *
 * The terminal is the SOLE authority for its own shift/drawer totals. Instead of
 * each sale incrementing `shifts.expected*` (and the server reconciler doing the
 * same — the old double-writer), the terminal derives those totals by folding the
 * local ledger ({@link selectLocalLedger}) for the active shift. Pure, no I/O.
 *
 * Mirrors `calcShiftPaymentTotals` in shiftService.ts, but folds over the durable
 * ledger of sales rather than a single in-flight payment split — so it is correct
 * after refresh, offline, and replay, with no running counter to drift.
 *
 * Out of scope here (intentionally): `startingCash`, `payInTotal`, `payOutTotal`.
 * Those are cash-drawer events, not sales, and remain on the stored shift doc;
 * {@link deriveShiftDrawer} layers these sale-derived totals on top of them.
 */

/** Sale-derived drawer totals — the `expected*` fields the terminal now owns. */
export type DrawerTenderTotals = Pick<
  Shift,
  'expectedCash' | 'expectedQr' | 'expectedKbank' | 'expectedCard' | 'expectedCredit' | 'totalBills'
>;

/**
 * Fold a ledger (already filtered to ledger-visible sales, ideally for ONE shift)
 * into per-tender expected totals. Cash is net of change given — change always
 * comes out of the cash drawer — computed per sale to mirror the legacy math.
 */
export function summarizeDrawer(sales: readonly LocalSale[]): DrawerTenderTotals {
  let netCash = 0;
  let qr = 0;
  let kbank = 0;
  let card = 0;
  let credit = 0;

  for (const sale of sales) {
    let cashIn = 0;
    for (const p of sale.payments) {
      switch (p.method) {
        case 'cash':
          cashIn += p.amount;
          break;
        case 'qr':
          qr += p.amount;
          break;
        case 'kbank':
          kbank += p.amount;
          break;
        case 'card':
          card += p.amount;
          break;
        case 'credit':
          credit += p.amount;
          break;
      }
    }
    // Change is returned from the cash tendered on that same sale.
    netCash += Math.max(0, cashIn - sale.changeAmt);
  }

  return {
    expectedCash: roundMoney(netCash),
    expectedQr: roundMoney(qr),
    expectedKbank: roundMoney(kbank),
    expectedCard: roundMoney(card),
    expectedCredit: roundMoney(credit),
    totalBills: sales.length,
  };
}

/** Local cash-movement totals — derived from the shift's embedded `cashEntries[]`. */
export type CashMovementTotals = Pick<Shift, 'payInTotal' | 'payOutTotal'>;

/**
 * Fold the shift's embedded cash entries into pay-in / pay-out totals. These are
 * queueable, offline-safe appends ({@link ShiftCashEntry}), so the drawer's
 * pay-in/out component is recomputed from durable local data — never a
 * server-incremented counter that drifts or is lost on an offline reload.
 */
export function foldCashEntries(entries: readonly ShiftCashEntry[]): CashMovementTotals {
  let payIn = 0;
  let payOut = 0;
  for (const e of entries) {
    if (e.type === 'pay_in') payIn += e.amount;
    else if (e.type === 'pay_out') payOut += e.amount;
  }
  return { payInTotal: roundMoney(payIn), payOutTotal: roundMoney(payOut) };
}

/**
 * Return a copy of the stored shift with BOTH halves of the drawer derived from
 * local data: sale-derived `expected*` from the ledger fold, and `payInTotal` /
 * `payOutTotal` from the embedded `cashEntries[]`. Together these complete the
 * single-writer drawer formula
 *   startingCash + Σ(ledger cash) + Σ(pay_in) − Σ(pay_out)
 * via the existing `calcShiftDrawerExpected`. The stored server-incremented
 * `expected*` / `payInTotal` / `payOutTotal` counters are intentionally ignored.
 */
export function deriveShiftDrawer(shift: Shift, sales: readonly LocalSale[]): Shift {
  return {
    ...shift,
    ...summarizeDrawer(sales),
    ...foldCashEntries(shift.cashEntries ?? []),
  };
}
