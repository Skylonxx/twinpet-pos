import { describe, expect, test } from 'vitest';
import {
  CanonicalSourceInvalidError,
  VALIDATED_FIELDS,
  requireEffectiveQtyBases,
  resolveLineQtyBase,
  validateCanonicalSaleSource,
} from './canonicalSaleSource';

function valid(over: Record<string, unknown> = {}) {
  return {
    total: 100,
    subtotal: 100,
    paidAmt: 100,
    discountAmt: 0,
    billDiscount: 0,
    fee: 0,
    changeAmt: 0,
    creditAmt: 0,
    status: 'completed',
    clientCreatedAt: 1_700_000_000_000,
    lines: [{ qty: 1, unitFactor: 1, unitPrice: 100, discountAmt: 0, lineTotal: 100 }],
    payments: [{ method: 'cash', amount: 100, ref: null }],
    ...over,
  };
}

describe('M canonical sale source validator', () => {
  test('M01 validated field set is accepted when well-formed; exact VALIDATED_FIELDS membership', () => {
    expect(validateCanonicalSaleSource(valid()).ok).toBe(true);
    expect([...VALIDATED_FIELDS]).toEqual([
      'total',
      'subtotal',
      'paidAmt',
      'discountAmt',
      'billDiscount',
      'fee',
      'changeAmt',
      'creditAmt',
      'cogs',
      'profit',
      'status',
      'clientCreatedAt',
      'lines',
      'payments',
    ]);
  });

  test('M04 null authority-relevant numeric cannot become canonical zero', () => {
    const r = validateCanonicalSaleSource(valid({ total: null }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('total');
  });

  test('M05 absent required numeric cannot become canonical zero', () => {
    const rest = { ...valid() };
    delete rest.total;
    const r = validateCanonicalSaleSource(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe('total');
      expect(r.reason).toBe('missing');
    }
  });

  test('M06 NaN/nonfinite source cannot become a canonical row', () => {
    expect(validateCanonicalSaleSource(valid({ paidAmt: Number.NaN })).ok).toBe(false);
    expect(validateCanonicalSaleSource(valid({ payments: [{ method: 'cash', amount: Infinity }] })).ok).toBe(false);
  });

  test('M07 negative finite billDiscount is a distinct invalid class', () => {
    const r = validateCanonicalSaleSource(valid({ billDiscount: -1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe('billDiscount');
      expect(r.reason).toBe('negative_bill_discount');
    }
    expect(() => requireEffectiveQtyBases(valid({ billDiscount: -1 }))).toThrow(CanonicalSourceInvalidError);
    try {
      requireEffectiveQtyBases(valid({ billDiscount: -1 }));
      throw new Error('expected CanonicalSourceInvalidError');
    } catch (err) {
      expect(err).toBeInstanceOf(CanonicalSourceInvalidError);
      expect((err as CanonicalSourceInvalidError).reason).toBe('negative_bill_discount');
    }
  });

  test('qtyBase explicit 0 plus malformed qty does not fall through to multiplication', () => {
    const source = valid({
      lines: [{ qtyBase: 0, qty: Number.NaN, unitFactor: 12, unitPrice: 100, discountAmt: 0, lineTotal: 100 }],
    });
    const r = validateCanonicalSaleSource(source);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('lines[0].qtyBase');
    expect(() => requireEffectiveQtyBases(source)).toThrow(CanonicalSourceInvalidError);
    const resolved = resolveLineQtyBase({ qtyBase: 0, qty: Number.NaN, unitFactor: 12 }, 'lines[0]');
    expect(resolved.ok).toBe(false);
  });

  test('qtyBase explicit 0 plus nonpositive unitFactor does not fall through', () => {
    const source = valid({
      lines: [{ qtyBase: 0, qty: 1, unitFactor: 0, unitPrice: 100, discountAmt: 0, lineTotal: 100 }],
    });
    expect(validateCanonicalSaleSource(source).ok).toBe(false);
    expect(() => requireEffectiveQtyBases(source)).toThrow(CanonicalSourceInvalidError);
  });

  test('absent qtyBase with invalid multiplicand is rejected before inventory', () => {
    const source = valid({
      lines: [{ qty: 1, unitFactor: Number.NaN, unitPrice: 100, discountAmt: 0, lineTotal: 100 }],
    });
    expect(validateCanonicalSaleSource(source).ok).toBe(false);
    expect(() => requireEffectiveQtyBases(source)).toThrow(CanonicalSourceInvalidError);
  });

  test('valid explicit qtyBase and valid derived qtyBase produce positive finite bases', () => {
    expect(requireEffectiveQtyBases(valid({
      lines: [{ qtyBase: 2, qty: 99, unitFactor: 99, unitPrice: 100, discountAmt: 0, lineTotal: 100 }],
    }))).toEqual([2]);
    expect(requireEffectiveQtyBases(valid({
      lines: [{ qty: 3, unitFactor: 4, unitPrice: 100, discountAmt: 0, lineTotal: 100 }],
    }))).toEqual([12]);
  });
});
