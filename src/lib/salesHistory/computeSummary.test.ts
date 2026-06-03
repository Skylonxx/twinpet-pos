import { describe, test, expect } from 'vitest';
import type { Order } from '../types';
import { computeSummary, type SaleRecord } from './types';

function record(
  o: { status?: Order['status']; total?: number; creditAmt?: number },
  extra: Partial<SaleRecord> = {},
): SaleRecord {
  return {
    order: {
      status: o.status ?? 'completed',
      total: o.total ?? 100,
      creditAmt: o.creditAmt ?? 0,
    } as Order,
    payments: [],
    items: [],
    ...extra,
  };
}

describe('computeSummary — voidPendingSync (Phase 7b)', () => {
  test('a settled void still syncing is treated as void, not revenue', () => {
    const summary = computeSummary([
      record({ total: 200 }), // normal paid
      record({ total: 300 }, { voidPendingSync: true }), // in-flight settled void
    ]);
    expect(summary.totalAmt).toBe(200);
    expect(summary.billCount).toBe(1);
    expect(summary.paidCount).toBe(1);
    expect(summary.voidCount).toBe(1);
  });

  test('an already-voided canonical row is excluded too (unchanged behavior)', () => {
    const summary = computeSummary([
      record({ total: 200 }),
      record({ status: 'voided', total: 300 }),
    ]);
    expect(summary.totalAmt).toBe(200);
    expect(summary.voidCount).toBe(1);
  });

  test('without the flag, revenue is counted normally', () => {
    const summary = computeSummary([record({ total: 200 }), record({ total: 300 })]);
    expect(summary.totalAmt).toBe(500);
    expect(summary.billCount).toBe(2);
    expect(summary.voidCount).toBe(0);
  });
});
