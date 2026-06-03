import { describe, test, expect } from 'vitest';
import {
  OVERSELL_LOT_ID,
  planCreditReversal,
  planLotRestocks,
  planStockRestores,
  type ReversalLine,
} from './voidReversal';

const line = (
  productId: string,
  qtyBase: number,
  lotRefs?: ReversalLine['lotRefs'],
): ReversalLine => ({ productId, qtyBase, lotRefs });

// ─── planLotRestocks ─────────────────────────────────────────────────────────

describe('planLotRestocks', () => {
  test('restocks each consumed lot by its cut qty', () => {
    const lines = [line('p1', 5, [{ lotId: 'lotA', qty: 5, cost: 10 }])];
    expect(planLotRestocks(lines)).toEqual([{ lotId: 'lotA', qty: 5 }]);
  });

  test('merges the same lot consumed across multiple lines into one restock', () => {
    const lines = [
      line('p1', 3, [{ lotId: 'lotA', qty: 3, cost: 10 }]),
      line('p1', 2, [{ lotId: 'lotA', qty: 2, cost: 10 }]),
    ];
    expect(planLotRestocks(lines)).toEqual([{ lotId: 'lotA', qty: 5 }]);
  });

  test('handles a line split across multiple lots', () => {
    const lines = [
      line('p1', 8, [
        { lotId: 'lotA', qty: 5, cost: 10 },
        { lotId: 'lotB', qty: 3, cost: 12 },
      ]),
    ];
    expect(planLotRestocks(lines)).toEqual([
      { lotId: 'lotA', qty: 5 },
      { lotId: 'lotB', qty: 3 },
    ]);
  });

  test('skips the virtual oversell lot (no doc to credit)', () => {
    const lines = [
      line('p1', 7, [
        { lotId: 'lotA', qty: 4, cost: 10 },
        { lotId: OVERSELL_LOT_ID, qty: 3, cost: 0 },
      ]),
    ];
    expect(planLotRestocks(lines)).toEqual([{ lotId: 'lotA', qty: 4 }]);
  });

  test('ignores missing/empty lotRefs and non-positive qty', () => {
    const lines = [
      line('p1', 5),
      line('p2', 2, []),
      line('p3', 1, [{ lotId: 'lotZ', qty: 0, cost: 5 }]),
    ];
    expect(planLotRestocks(lines)).toEqual([]);
  });
});

// ─── planStockRestores ───────────────────────────────────────────────────────

describe('planStockRestores', () => {
  test('restores qtyBase per product', () => {
    expect(planStockRestores([line('p1', 5), line('p2', 3)])).toEqual([
      { productId: 'p1', qtyBase: 5 },
      { productId: 'p2', qtyBase: 3 },
    ]);
  });

  test('merges the same product across lines', () => {
    expect(planStockRestores([line('p1', 5), line('p1', 2)])).toEqual([
      { productId: 'p1', qtyBase: 7 },
    ]);
  });

  test('skips non-positive qtyBase', () => {
    expect(planStockRestores([line('p1', 0), line('p2', 4)])).toEqual([
      { productId: 'p2', qtyBase: 4 },
    ]);
  });
});

// ─── planCreditReversal ──────────────────────────────────────────────────────

describe('planCreditReversal', () => {
  test('null when the sale had no credit component', () => {
    expect(planCreditReversal(0, { creditUsed: 100, creditLimit: 500 })).toBeNull();
  });

  test('null when there is no credit account to reverse', () => {
    expect(planCreditReversal(40, null)).toBeNull();
  });

  test('reverses creditUsed and recomputes balance = limit − used', () => {
    expect(planCreditReversal(40, { creditUsed: 100, creditLimit: 500 })).toEqual({
      newCreditUsed: 60,
      newCreditBalance: 440,
      outstandingDecrement: 40,
    });
  });

  test('clamps creditUsed at zero against inconsistent data', () => {
    const result = planCreditReversal(150, { creditUsed: 100, creditLimit: 500 });
    expect(result).toEqual({
      newCreditUsed: 0,
      newCreditBalance: 500,
      outstandingDecrement: 150,
    });
  });
});
