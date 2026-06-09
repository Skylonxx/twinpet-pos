import { describe, test, expect, vi } from 'vitest';

// Mock Admin Timestamp so the `value instanceof Timestamp` branch is exercised
// without the real firebase-admin runtime.
vi.mock('firebase-admin/firestore', () => ({
  Timestamp: class Timestamp {
    ms: number;
    constructor(ms = 0) {
      this.ms = ms;
    }
    toMillis() {
      return this.ms;
    }
  },
}));

import { Timestamp } from 'firebase-admin/firestore';
import {
  roundMoney,
  parseReceivedAtMs,
  planFifoCutFromState,
  mergeLotCuts,
  type MutableLot,
} from './fifo';

const lot = (id: string, qty: number, cost: number, receivedAtMs: number): MutableLot => ({
  ref: { path: `stockLots/${id}` } as MutableLot['ref'],
  id,
  qtyRemaining: qty,
  costPerUnit: cost,
  receivedAtMs,
});

describe('shared server FIFO — roundMoney', () => {
  test('rounds to 2dp', () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(roundMoney(3.333333)).toBe(3.33);
  });
});

describe('shared server FIFO — parseReceivedAtMs', () => {
  test('reads an Admin Timestamp via toMillis()', () => {
    expect(parseReceivedAtMs(new (Timestamp as unknown as { new (n: number): unknown })(7000))).toBe(7000);
  });
  test('reads a { seconds } shape', () => {
    expect(parseReceivedAtMs({ seconds: 3 })).toBe(3000);
  });
  test('falls back to 0 for unknown values', () => {
    expect(parseReceivedAtMs(undefined)).toBe(0);
    expect(parseReceivedAtMs('nope')).toBe(0);
  });
});

describe('shared server FIFO — planFifoCutFromState', () => {
  test('cuts oldest-first across lots and mutates qtyRemaining in place', () => {
    const lots = [lot('L1', 6, 10, 1000), lot('L2', 14, 20, 2000)];
    const { cuts, lotRefs, remaining } = planFifoCutFromState(lots, 10);
    expect(remaining).toBe(0);
    expect(cuts).toEqual([
      { ref: { path: 'stockLots/L1' }, cutQty: 6 },
      { ref: { path: 'stockLots/L2' }, cutQty: 4 },
    ]);
    expect(lotRefs).toEqual([
      { lotId: 'L1', qty: 6, cost: 10 },
      { lotId: 'L2', qty: 4, cost: 20 },
    ]);
    expect(lots[0].qtyRemaining).toBe(0);
    expect(lots[1].qtyRemaining).toBe(10);
  });

  test('reports unmet demand via remaining (oversell tolerance)', () => {
    const lots = [lot('L1', 3, 10, 1000)];
    const { cuts, remaining } = planFifoCutFromState(lots, 5);
    expect(cuts).toEqual([{ ref: { path: 'stockLots/L1' }, cutQty: 3 }]);
    expect(remaining).toBe(2);
  });

  test('skips already-empty lots', () => {
    const lots = [lot('L1', 0, 10, 1000), lot('L2', 5, 20, 2000)];
    const { lotRefs } = planFifoCutFromState(lots, 2);
    expect(lotRefs).toEqual([{ lotId: 'L2', qty: 2, cost: 20 }]);
  });
});

describe('shared server FIFO — mergeLotCuts', () => {
  test('collapses cuts against the same lot ref', () => {
    const ref = { path: 'stockLots/L1' } as MutableLot['ref'];
    const merged = mergeLotCuts([
      { ref, cutQty: 2 },
      { ref, cutQty: 3 },
    ]);
    expect(merged).toEqual([{ ref, cutQty: 5 }]);
  });
  test('drops zero/empty cuts', () => {
    expect(mergeLotCuts([{ ref: { path: 'x' } as MutableLot['ref'], cutQty: 0 }])).toEqual([]);
  });
});
