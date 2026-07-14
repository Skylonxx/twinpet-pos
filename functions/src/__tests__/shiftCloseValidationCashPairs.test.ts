import { describe, test, expect } from 'vitest';
import { classifyCashPairEntry, classifyCashPairs, type CashPairAuditSide, type CashPairEntrySide } from '../shiftCloseValidationCashPairs';

describe('classifyCashPairEntry', () => {
  test('same id, same type/amount -> paired_equal', () => {
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_in', amount: 100 };
    expect(classifyCashPairEntry(entrySide, auditSide)).toEqual({ id: '1', class: 'paired_equal' });
  });

  test('same id, different amount -> paired_value_mismatch with mismatchFields [amount]', () => {
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_in', amount: 150 };
    expect(classifyCashPairEntry(entrySide, auditSide)).toEqual({
      id: '1',
      class: 'paired_value_mismatch',
      mismatchFields: ['amount'],
    });
  });

  test('same id, different type -> paired_value_mismatch with mismatchFields [type]', () => {
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_out', amount: 100 };
    expect(classifyCashPairEntry(entrySide, auditSide)).toEqual({
      id: '1',
      class: 'paired_value_mismatch',
      mismatchFields: ['type'],
    });
  });

  test('both type and amount differ -> mismatchFields [type, amount] in canonical order', () => {
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_out', amount: 999 };
    expect(classifyCashPairEntry(entrySide, auditSide)).toEqual({
      id: '1',
      class: 'paired_value_mismatch',
      mismatchFields: ['type', 'amount'],
    });
  });

  test('malformed audit-side amount -> paired_value_mismatch [amount]', () => {
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_in', amount: 'not-a-number' };
    expect(classifyCashPairEntry(entrySide, auditSide)).toEqual({
      id: '1',
      class: 'paired_value_mismatch',
      mismatchFields: ['amount'],
    });
  });

  test('missing cashTransactions counterpart -> missing_cashTransaction', () => {
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    expect(classifyCashPairEntry(entrySide, undefined)).toEqual({ id: '1', class: 'missing_cashTransaction' });
  });

  test('extra cashTransactions doc with no snapshot counterpart -> missing_cashEntry', () => {
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_in', amount: 100 };
    expect(classifyCashPairEntry(undefined, auditSide)).toEqual({ id: '1', class: 'missing_cashEntry' });
  });

  test('annotation-only rewrite (note/staffId/staffName/at) does not affect classification — accepted residual', () => {
    // classifyCashPairEntry only ever compares type+amount; annotation fields
    // are not part of either side's input, so a rewrite of them is structurally
    // invisible here — this test documents that as the accepted residual.
    const entrySide: CashPairEntrySide = { id: '1', type: 'pay_in', amount: 100 };
    const auditSide: CashPairAuditSide = { id: '1', type: 'pay_in', amount: 100 };
    expect(classifyCashPairEntry(entrySide, auditSide).class).toBe('paired_equal');
  });
});

describe('classifyCashPairs — full array', () => {
  test('produces a deterministic id-ordered array', () => {
    const entries: CashPairEntrySide[] = [
      { id: 'z', type: 'pay_in', amount: 1 },
      { id: 'a', type: 'pay_in', amount: 1 },
      { id: 'm', type: 'pay_in', amount: 1 },
    ];
    const audits: CashPairAuditSide[] = [
      { id: 'z', type: 'pay_in', amount: 1 },
      { id: 'a', type: 'pay_in', amount: 1 },
      { id: 'm', type: 'pay_in', amount: 1 },
    ];
    const result = classifyCashPairs(entries, audits);
    expect(result.map((r) => r.id)).toEqual(['a', 'm', 'z']);
  });

  test('mixes paired, missing_cashTransaction, and missing_cashEntry, still ordered by id', () => {
    const entries: CashPairEntrySide[] = [{ id: 'b', type: 'pay_in', amount: 10 }];
    const audits: CashPairAuditSide[] = [{ id: 'a', type: 'pay_in', amount: 10 }];
    const result = classifyCashPairs(entries, audits);
    expect(result).toEqual([
      { id: 'a', class: 'missing_cashEntry' },
      { id: 'b', class: 'missing_cashTransaction' },
    ]);
  });
});
