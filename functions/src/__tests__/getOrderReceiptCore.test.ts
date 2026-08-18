import { describe, expect, test } from 'vitest';
import {
  AUTHORITY_NON_NUMERIC_PAYMENT_FIELDS,
  AUTHORITY_NUMERIC_FIELDS,
  encodeReceiptTuple,
  evaluateReceiptCore,
  roundMoney,
  sumSatang,
  toSatangOrUnproven,
  type ReceiptSnapshots,
} from '../getOrderReceiptCore';

const snapItem = (over: Record<string, unknown> = {}) => ({
  productSnap: { name: 'Food', sku: 'SKU1', category: 'cat' },
  unit: 'ea',
  unitFactor: 1,
  qty: 1,
  qtyBase: 1,
  unitPrice: 100,
  originalPrice: 100,
  discountAmt: 0,
  lineTotal: 100,
  ...over,
});

const snapPay = (over: Record<string, unknown> = {}) => ({
  method: 'cash',
  amount: 100,
  ref: null,
  ...over,
});

function snaps(over: Partial<ReceiptSnapshots> = {}): ReceiptSnapshots {
  const item = snapItem();
  const pay = snapPay();
  return {
    orderExists: true,
    asyncExists: true,
    order: {
      status: 'completed',
      branchId: 'br1',
      historyRev: 1,
      subtotal: 100,
      discountAmt: 0,
      billDiscount: 0,
      surcharge: 0,
      total: 100,
      paidAmt: 100,
      changeAmt: 0,
      creditAmt: 0,
    },
    items: [item],
    payments: [pay],
    asyncOrder: { lines: [item], payments: [pay] },
    ...over,
  };
}

describe('G receipt core', () => {
  test('G02 well-formed projection is AUTHORITATIVE with matching counts', () => {
    const r = evaluateReceiptCore(snaps());
    expect(r.authority).toBe('AUTHORITATIVE');
    expect(r.items).toHaveLength(1);
    expect(r.payments).toHaveLength(1);
  });

  test('G03 short and extra child sets are INCOMPLETE; equal-count field mutation is not asserted here', () => {
    const short = evaluateReceiptCore(snaps({ items: [] }));
    const extra = evaluateReceiptCore(snaps({ items: [snapItem(), snapItem({ qty: 2, qtyBase: 2 })] }));
    expect(short.authority).toBe('UNPROVEN');
    expect(extra.authority).toBe('UNPROVEN');
    const mutatedName = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'X', sku: 'SKU1', category: 'cat' } })] }),
    );
    expect(mutatedName.reason).not.toBe('projection_cardinality');
  });

  test('G04 equal-count productSnap.name mutation is INCOMPLETE', () => {
    const r = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'Other', sku: 'SKU1', category: 'cat' } })] }),
    );
    expect(r.authority).toBe('UNPROVEN');
    expect(r.reason).toBe('projection_item_mismatch');
  });

  test('G05 equal-count productSnap.sku mutation is INCOMPLETE', () => {
    const r = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'Food', sku: 'OTHER', category: 'cat' } })] }),
    );
    expect(r.authority).toBe('UNPROVEN');
    expect(r.reason).toBe('projection_item_mismatch');
  });

  test('G06 category/barcode mutation; absent vs null barcode normalize identically', () => {
    const cat = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'other' } })] }),
    );
    expect(cat.authority).toBe('UNPROVEN');
    expect(cat.reason).toBe('projection_item_mismatch');

    const barcodeMutated = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: 'OTHER' } })] }),
    );
    expect(barcodeMutated.authority).toBe('UNPROVEN');
    expect(barcodeMutated.reason).toBe('projection_item_mismatch');

    const absentKey = encodeReceiptTuple(['Food', 'SKU1', 'cat', undefined]);
    const nullKey = encodeReceiptTuple(['Food', 'SKU1', 'cat', null]);
    expect(absentKey).toBe(nullKey);

    const absent = evaluateReceiptCore(snaps());
    const nulled = evaluateReceiptCore(
      snaps({
        items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: null } })],
        asyncOrder: {
          lines: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: null } })],
          payments: [snapPay()],
        },
      }),
    );
    const mixed = evaluateReceiptCore(
      snaps({
        items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat' } })],
        asyncOrder: {
          lines: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: null } })],
          payments: [snapPay()],
        },
      }),
    );
    expect(absent.authority).toBe('AUTHORITATIVE');
    expect(nulled.authority).toBe(absent.authority);
    expect(nulled.reason).toBe(absent.reason);
    expect(mixed.authority).toBe(absent.authority);
    expect(mixed.reason).toBe(absent.reason);
  });

  test('G07 equal-count remaining protected item fields', () => {
    const remainder: Array<Record<string, unknown>> = [
      { unit: 'box' },
      { unitFactor: 2 },
      { qty: 2 },
      { qtyBase: 2 },
      { unitPrice: 200 },
      { originalPrice: 200 },
      { discountAmt: 10 },
      { lineTotal: 90 },
    ];
    expect(remainder).toHaveLength(8);
    for (const over of remainder) {
      const r = evaluateReceiptCore(snaps({ items: [snapItem(over)] }));
      expect(r.authority, `field ${Object.keys(over)[0]}`).toBe('UNPROVEN');
      expect(r.reason, `field ${Object.keys(over)[0]}`).toBe('projection_item_mismatch');
    }
  });

  test('G08 equal-count payment method/amount/ref mutation', () => {
    const r = evaluateReceiptCore(snaps({ payments: [snapPay({ method: 'qr' })] }));
    expect(r.authority).toBe('UNPROVEN');
  });

  test('G09 asyncOrders absent is UNPROVEN forever', () => {
    const r = evaluateReceiptCore(snaps({ asyncExists: false, asyncOrder: null }));
    expect(r.authority).toBe('UNPROVEN');
    expect(r.reason).toBe('async_absent_unproven_forever');
  });

  test('G10 revision curation valid/absent/malformed', () => {
    expect(evaluateReceiptCore(snaps()).authority).toBe('AUTHORITATIVE');
    const absent = snaps();
    delete (absent.order as { historyRev?: number }).historyRev;
    expect(evaluateReceiptCore(absent).authority).toBe('AUTHORITATIVE');
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), historyRev: 1.5 } as never })).authority).toBe('UNPROVEN');
  });

  test('G11 voided order and unreconciled void intent are REFUSED', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), status: 'voided' } as never })).authority).toBe('REFUSED');
    const intent = snaps();
    (intent.asyncOrder as Record<string, unknown>).voidRequested = true;
    expect(evaluateReceiptCore(intent).authority).toBe('REFUSED');
  });

  test('G14 productSnap null is UNPROVEN', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ productSnap: null })] })).reason).toBe('productsnap_null');
  });

  test('G15 productSnap non-object is UNPROVEN', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ productSnap: 'x' })] })).reason).toBe('productsnap_non_object');
  });

  test('G16 missing name/sku/category is UNPROVEN and does not stringify undefined', () => {
    const r = evaluateReceiptCore(snaps({ items: [snapItem({ productSnap: { sku: 'S', category: 'c' } })] }));
    expect(r.authority).toBe('UNPROVEN');
    expect(JSON.stringify(r).includes('"undefined"')).toBe(false);
  });

  test('G17 wrong-typed name/sku/category is UNPROVEN', () => {
    const r = evaluateReceiptCore(snaps({ items: [snapItem({ productSnap: { name: 1, sku: 'S', category: 'c' } })] }));
    expect(r.authority).toBe('UNPROVEN');
  });

  test('G18 barcode numeric/object is UNPROVEN; undefined vs null normalize identically', () => {
    const num = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: 1 } })] }),
    );
    expect(num.authority).toBe('UNPROVEN');
    expect(num.reason).toBe('productsnap_invalid');

    const obj = evaluateReceiptCore(
      snaps({ items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: { x: 1 } } })] }),
    );
    expect(obj.authority).toBe('UNPROVEN');
    expect(obj.reason).toBe('productsnap_invalid');

    const undefinedBarcode = evaluateReceiptCore(
      snaps({
        items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat' } })],
        asyncOrder: {
          lines: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat' } })],
          payments: [snapPay()],
        },
      }),
    );
    const nullBarcode = evaluateReceiptCore(
      snaps({
        items: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: null } })],
        asyncOrder: {
          lines: [snapItem({ productSnap: { name: 'Food', sku: 'SKU1', category: 'cat', barcode: null } })],
          payments: [snapPay()],
        },
      }),
    );
    expect(encodeReceiptTuple(['Food', 'SKU1', 'cat', undefined])).toBe(
      encodeReceiptTuple(['Food', 'SKU1', 'cat', null]),
    );
    expect(undefinedBarcode.authority).toBe(nullBarcode.authority);
    expect(undefinedBarcode.reason).toBe(nullBarcode.reason);
    expect(undefinedBarcode.authority).toBe('AUTHORITATIVE');
  });

  test('G19 two malformed shapes never compare equal', () => {
    const a = evaluateReceiptCore(snaps({ items: [snapItem({ productSnap: null })] }));
    const b = evaluateReceiptCore(snaps({ items: [snapItem({ productSnap: 1 })] }));
    expect(a.reason).not.toBe(b.reason);
  });

  test('G20 non-finite payment.amount is UNPROVEN', () => {
    for (const amount of [NaN, Infinity, -Infinity, '3']) {
      expect(evaluateReceiptCore(snaps({ payments: [snapPay({ amount })] })).authority).toBe('UNPROVEN');
    }
  });

  test('G21 non-finite item numerics excluding unitFactor', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ qty: NaN })] })).authority).toBe('UNPROVEN');
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ lineTotal: Infinity })] })).authority).toBe('UNPROVEN');
  });

  test('G22 residual unitPrice<0 and originalPrice<0 are UNPROVEN', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ unitPrice: -1 })] })).authority).toBe('UNPROVEN');
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ originalPrice: -1 })] })).authority).toBe('UNPROVEN');
  });

  test('G23 residual zeros and fractional qty ACCEPT', () => {
    const r = evaluateReceiptCore(
      snaps({
        order: { ...(snaps().order as object), total: 0, paidAmt: 0, changeAmt: 0 } as never,
        items: [snapItem({ discountAmt: 0, lineTotal: 0, qty: 0.5, qtyBase: 0.5, unitPrice: 0, originalPrice: 0 })],
        payments: [],
        asyncOrder: {
          lines: [snapItem({ discountAmt: 0, lineTotal: 0, qty: 0.5, qtyBase: 0.5, unitPrice: 0, originalPrice: 0 })],
          payments: [],
        },
      }),
    );
    expect(r.authority).toBe('AUTHORITATIVE');
  });

  test('G24 header writer-rounded money; total=100.005 UNPROVEN; 2dp ACCEPT', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), total: 100.005 } as never })).authority).toBe('UNPROVEN');
    expect(evaluateReceiptCore(snaps()).authority).toBe('AUTHORITATIVE');
  });

  test('G25 numeric set is exactly 16 fields by size AND membership', () => {
    expect([...AUTHORITY_NUMERIC_FIELDS]).toEqual([
      'unitFactor',
      'qty',
      'qtyBase',
      'unitPrice',
      'originalPrice',
      'item.discountAmt',
      'lineTotal',
      'payment.amount',
      'subtotal',
      'order.discountAmt',
      'billDiscount',
      'surcharge',
      'total',
      'paidAmt',
      'changeAmt',
      'creditAmt',
    ]);
    expect(AUTHORITY_NUMERIC_FIELDS).toHaveLength(16);
    expect(new Set(AUTHORITY_NUMERIC_FIELDS).size).toBe(16);
  });

  test('receipt item tuple encoding is injective across NUL delimiter collisions', () => {
    const a = encodeReceiptTuple(['a\u0000b', 'c', 'd', null]);
    const b = encodeReceiptTuple(['a', 'b\u0000c', 'd', null]);
    expect(a).not.toBe(b);
    expect(`${'a\u0000b'}\0${'c'}`).toBe(`${'a'}\0${'b\u0000c'}`);
  });

  test('G26 payment.method and payment.ref are the disjoint non-numeric pair', () => {
    expect(AUTHORITY_NON_NUMERIC_PAYMENT_FIELDS).toEqual(['payment.method', 'payment.ref']);
  });

  test('G27 lineTotal negative is UNPROVEN', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ lineTotal: -1 })] })).authority).toBe('UNPROVEN');
  });

  test('G28 item.discountAmt negative finite remains structurally valid at domain gate', () => {
    const r = evaluateReceiptCore(snaps({ items: [snapItem({ discountAmt: -1, lineTotal: 100 })] }));
    expect(r.reason !== 'item_discount_negative').toBe(true);
  });

  test('G29 negative billDiscount UNPROVEN billdiscount_negative_invariant', () => {
    const r = evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), billDiscount: -1 } as never }));
    expect(r.reason).toBe('billdiscount_negative_invariant');
  });

  test('G30 non-finite billDiscount UNPROVEN billdiscount_nonfinite', () => {
    const r = evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), billDiscount: NaN } as never }));
    expect(r.reason).toBe('billdiscount_nonfinite');
  });

  test('G32 legacy unitFactor<=0 UNPROVEN unitfactor_nonpositive_invariant', () => {
    const r = evaluateReceiptCore(snaps({ items: [snapItem({ unitFactor: 0 })] }));
    expect(r.reason).toBe('unitfactor_nonpositive_invariant');
  });

  test('G33 positive unitFactor accepted', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ unitFactor: 12 })], asyncOrder: { lines: [snapItem({ unitFactor: 12 })], payments: [snapPay()] } })).authority).toBe('AUTHORITATIVE');
  });

  test('G34 nonfinite unitFactor UNPROVEN unitfactor_nonfinite', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ unitFactor: NaN })] })).reason).toBe('unitfactor_nonfinite');
  });

  test('G35 payment.amount<=0 rejected from canonical payment set', () => {
    expect(evaluateReceiptCore(snaps({ payments: [snapPay({ amount: 0 })] })).authority).toBe('UNPROVEN');
  });

  test('G36 unitPrice zero allowed', () => {
    const item = snapItem({ unitPrice: 0, originalPrice: 0, lineTotal: 0 });
    expect(evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), total: 0, paidAmt: 0, subtotal: 0 } as never,
      items: [item],
      payments: [],
      asyncOrder: { lines: [item], payments: [] },
    })).authority).toBe('AUTHORITATIVE');
  });

  test('G37 qty<=0 rejected', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ qty: 0 })] })).authority).toBe('UNPROVEN');
  });

  test('G38 qtyBase<=0 rejected', () => {
    expect(evaluateReceiptCore(snaps({ items: [snapItem({ qtyBase: 0 })] })).authority).toBe('UNPROVEN');
  });

  test('G39 order.subtotal negative rejected', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), subtotal: -1 } as never })).authority).toBe('UNPROVEN');
  });

  test('G40 order.discountAmt signed finite allowed', () => {
    const r = evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), discountAmt: -1 } as never }));
    expect(r.reason !== 'order_discount_negative').toBe(true);
  });

  test('G41 order.billDiscount authority invariant nonnegative', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), billDiscount: 0 } as never })).authority).toBe('AUTHORITATIVE');
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), billDiscount: -0.01 } as never })).authority).toBe('UNPROVEN');
  });

  test('G42 order.surcharge negative rejected', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), surcharge: -1 } as never })).authority).toBe('UNPROVEN');
  });

  test('G43 order.total negative rejected', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), total: -1 } as never })).authority).toBe('UNPROVEN');
  });

  test('G44 paidAmt / changeAmt / creditAmt negative rejected', () => {
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), paidAmt: -1 } as never })).authority).toBe('UNPROVEN');
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), changeAmt: -1 } as never })).authority).toBe('UNPROVEN');
    expect(evaluateReceiptCore(snaps({ order: { ...(snaps().order as object), creditAmt: -1 } as never })).authority).toBe('UNPROVEN');
  });

  test('J39 non-positive source payment contributes to paidAmt but is not persisted → P2 UNPROVEN', () => {
    const r = evaluateReceiptCore(snaps({
      payments: [snapPay({ amount: 100 })],
      asyncOrder: { lines: [snapItem()], payments: [snapPay({ amount: 100 }), { method: 'cash', amount: 0, ref: null }] },
      order: { ...(snaps().order as object), paidAmt: 100 } as never,
    }));
    expect(r.authority).toBe('UNPROVEN');
  });

  test('J40 cent-normalized payment row converts to safe integer satang', () => {
    const s = toSatangOrUnproven(100.00);
    expect(s.ok).toBe(true);
    if (s.ok) {
      expect(s.k).toBe(10000);
      expect(Number.isSafeInteger(s.k)).toBe(true);
    }
  });

  test('J41 generic non-cent payment.amount is UNPROVEN without using the 10.005 fixture', () => {
    const r = evaluateReceiptCore(snaps({ payments: [snapPay({ amount: 1.234 })] }));
    expect(r.authority).toBe('UNPROVEN');
    expect(r.reason).toBe('payment_amount_not_cent_normalized');
  });

  test('J42 unsafe integer satang conversion is UNPROVEN satang_overflow', () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const r = toSatangOrUnproven(huge);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('satang_overflow');
  });

  test('J43 BigInt aggregation over {100.00,50.25,25.75} is permutation-invariant at 17600n', () => {
    const amounts = [100.00, 50.25, 25.75];
    const perms = [
      amounts,
      [100.00, 25.75, 50.25],
      [50.25, 100.00, 25.75],
      [50.25, 25.75, 100.00],
      [25.75, 100.00, 50.25],
      [25.75, 50.25, 100.00],
    ];
    for (const p of perms) {
      expect(sumSatang(p)).toBe(17600n);
    }
  });

  test('J44 duplicate payment amounts are preserved in the multiset fold', () => {
    expect(sumSatang([10.00, 10.00, 20.00])).toBe(4000n);
  });

  test('J45 P2 matching cent-normalized fixture ACCEPT', () => {
    expect(evaluateReceiptCore(snaps()).authority).toBe('AUTHORITATIVE');
  });

  test('J46 P2 mismatch rejected', () => {
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), paidAmt: 90 } as never,
    }));
    expect(r.reason).toBe('p2_mismatch');
  });

  test('J47 P3 credit-only BigInt satang sum matches creditAmt', () => {
    const credit = snapPay({ method: 'credit', amount: 100 });
    const r = evaluateReceiptCore(snaps({
      payments: [credit],
      asyncOrder: { lines: [snapItem()], payments: [credit] },
      order: { ...(snaps().order as object), paidAmt: 100, creditAmt: 100, changeAmt: 0 } as never,
    }));
    expect(r.authority).toBe('AUTHORITATIVE');
  });

  test('J48 P3 mismatch rejected', () => {
    const credit = snapPay({ method: 'credit', amount: 100 });
    const r = evaluateReceiptCore(snaps({
      payments: [credit],
      asyncOrder: { lines: [snapItem()], payments: [credit] },
      order: { ...(snaps().order as object), paidAmt: 100, creditAmt: 50, changeAmt: 0 } as never,
    }));
    expect(r.reason).toBe('p3_mismatch');
  });

  test('J49 query/document ID order cannot influence P2/P3 verdict', () => {
    const a = snapPay({ amount: 40, method: 'cash' });
    const b = snapPay({ amount: 60, method: 'qr' });
    const order = { ...(snaps().order as object), paidAmt: 100, creditAmt: 0 } as never;
    const fwd = evaluateReceiptCore(snaps({
      payments: [a, b],
      asyncOrder: { lines: [snapItem()], payments: [a, b] },
      order,
    }));
    const rev = evaluateReceiptCore(snaps({
      payments: [b, a],
      asyncOrder: { lines: [snapItem()], payments: [b, a] },
      order,
    }));
    expect(fwd.authority).toBe(rev.authority);
  });

  test('J50 sub-satang 10.005 is displayable; AUTHORITATIVE withheld', () => {
    const r = evaluateReceiptCore(snaps({ payments: [snapPay({ amount: 10.005 })] }));
    expect(r.displayAmount).toBe(10.005);
    expect(r.authority).not.toBe('AUTHORITATIVE');
  });

  test('J51 stored 10.005 byte is preserved; no silent rounder of the stored amount', () => {
    const r = evaluateReceiptCore(snaps({ payments: [snapPay({ amount: 10.005 })] }));
    expect(r.displayAmount).toBe(10.005);
    expect(r.displayAmount).not.toBe(10.00);
    expect(r.displayAmount).not.toBe(10.01);
  });

  test('J52 P4 exact change relation accepted', () => {
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), paidAmt: 150, total: 100, changeAmt: 50 } as never,
      payments: [snapPay({ amount: 150 })],
      asyncOrder: { lines: [snapItem()], payments: [snapPay({ amount: 150 })] },
    }));
    expect(r.authority).toBe('AUTHORITATIVE');
  });

  test('J53 P4 mismatch rejected', () => {
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), paidAmt: 150, total: 100, changeAmt: 10 } as never,
      payments: [snapPay({ amount: 150 })],
      asyncOrder: { lines: [snapItem()], payments: [snapPay({ amount: 150 })] },
    }));
    expect(r.reason).toBe('p4_mismatch');
  });

  test('J54 P5 pending_payment iff creditAmt>0 && paidAmt<total', () => {
    const cash = snapPay({ amount: 40 });
    const credit = snapPay({ method: 'credit', amount: 60 });
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), status: 'pending_payment', paidAmt: 100, total: 150, creditAmt: 60, changeAmt: 0, subtotal: 150 } as never,
      payments: [cash, credit],
      asyncOrder: { lines: [snapItem()], payments: [cash, credit] },
    }));
    expect(r.authority).toBe('AUTHORITATIVE');
  });

  test('J55 P5 mismatch A: completed while creditAmt>0 && paidAmt<total', () => {
    const cash = snapPay({ amount: 40 });
    const credit = snapPay({ method: 'credit', amount: 60 });
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), status: 'completed', paidAmt: 100, total: 150, creditAmt: 60, changeAmt: 0, subtotal: 150 } as never,
      payments: [cash, credit],
      asyncOrder: { lines: [snapItem()], payments: [cash, credit] },
    }));
    expect(r.reason).toBe('p5_mismatch');
  });

  test('J56 P5 mismatch B: pending_payment while predicate false', () => {
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), status: 'pending_payment', paidAmt: 100, total: 100, creditAmt: 0, changeAmt: 0 } as never,
    }));
    expect(r.reason).toBe('p5_mismatch');
  });

  test('J57 sweeper-copied contradictory source status rejected by P5 with and without repairedBySweeper', () => {
    const cash = snapPay({ amount: 40 });
    const credit = snapPay({ method: 'credit', amount: 60 });
    const base = {
      order: { ...(snaps().order as object), status: 'completed', paidAmt: 100, total: 150, creditAmt: 60, changeAmt: 0, subtotal: 150 } as never,
      payments: [cash, credit],
      asyncOrder: { lines: [snapItem()], payments: [cash, credit] },
    };
    expect(evaluateReceiptCore(snaps(base)).reason).toBe('p5_mismatch');
    expect(evaluateReceiptCore(snaps({ ...base, order: { ...(base.order as object), repairedBySweeper: true } as never })).reason).toBe('p5_mismatch');
  });

  test('J58 mutually consistent malicious/legacy row is not claimed as provenance-proven', () => {
    const r = evaluateReceiptCore(snaps());
    expect(r.authority).toBe('AUTHORITATIVE');
    expect(JSON.stringify(r)).not.toMatch(/business-input proven|provenance-proven/);
  });

  test('J59 P6-A changeAmt>0 implies paidAmt>total', () => {
    const r = evaluateReceiptCore(snaps({
      order: { ...(snaps().order as object), total: 100, paidAmt: 150, changeAmt: 50 } as never,
      payments: [snapPay({ amount: 150 })],
      asyncOrder: { lines: [snapItem()], payments: [snapPay({ amount: 150 })] },
    }));
    expect(r.authority).toBe('AUTHORITATIVE');
  });

  test('J60 P6-B zero-change boundary paidAmt==total changeAmt==0', () => {
    const r = evaluateReceiptCore(snaps());
    expect(r.authority).toBe('AUTHORITATIVE');
    expect((snaps().order as { changeAmt: number }).changeAmt > 0).toBe(false);
  });

  test('J62 roundMoney(0.005)===0.01', () => {
    expect(roundMoney(0.005)).toBe(0.01);
  });

  test('J63 roundMoney(1.005)===1.00', () => {
    expect(roundMoney(1.005)).toBe(1.00);
  });
});
