import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import * as clientReturn from '../../../src/lib/saleReturn/saleReturnTypes';
import {
  allocateProportional,
  buildReturnContextView,
  cumulativeRefundMinor,
  deriveReturnApprovalCommandId,
  deriveReturnContentDigest,
  deriveReturnId,
  decideInPlaceLotRestore,
  emptyLedger,
  exactBaseMilli,
  lineRefundForReturnMinor,
  maxSupportedReturnQtyMilli,
  parseReturnLedger,
  parseReturnLedgerForSale,
  parseSaleEvidence,
  planCustomerSpendAdjustment,
  planLotRestoration,
  planSaleReturn,
  saleReturnLedgerBlocksVoid,
  serializeReturnLedger,
  toMilliExact,
  toMinorExact,
  validateSubmitSaleReturnRequest,
  type ReturnLedger,
  type SaleEvidence,
} from '../saleReturnCore';

type Doc = Record<string, unknown>;

function asyncSale(over: Doc = {}): Doc {
  return {
    id: 'O1',
    billId: 'R-0001',
    branchId: 'B1',
    shiftId: 'SH0',
    staffId: 's0',
    customerId: null,
    customerSnap: null,
    reconcileStatus: 'settled',
    status: 'completed',
    clientCreatedAt: 1_700_000_000_000,
    lines: [
      {
        productId: 'P1',
        productSnap: { name: 'อาหารแมว', sku: 'CF' },
        unit: 'ถุง',
        unitFactor: 1,
        qty: 5,
        qtyBase: 5,
        unitPrice: 100,
        discountAmt: 50,
        lineTotal: 450,
        lotRefs: [
          { lotId: 'L1', qty: 3, cost: 40 },
          { lotId: 'L2', qty: 2, cost: 55 },
        ],
      },
      {
        productId: 'P2',
        productSnap: { name: 'ทราย', sku: 'SD' },
        unit: 'ลัง',
        unitFactor: 12,
        qty: 2,
        qtyBase: 24,
        unitPrice: 300,
        discountAmt: 0,
        lineTotal: 600,
        lotRefs: [{ lotId: 'L3', qty: 24, cost: 20 }],
      },
    ],
    subtotal: 1050,
    discountAmt: 50,
    billDiscount: 105,
    fee: 0,
    total: 945,
    payments: [{ method: 'cash', amount: 1000 }],
    paidAmt: 1000,
    changeAmt: 55,
    creditAmt: 0,
    vatRate: 0,
    vatAmt: 0,
    ...over,
  };
}

function canonical(over: Doc = {}): Doc {
  return { id: 'O1', branchId: 'B1', status: 'completed', total: 945, ...over };
}

function evidence(a: Doc = asyncSale(), c: Doc | null = canonical()): SaleEvidence {
  const r = parseSaleEvidence('O1', a, c, 'B1');
  if (!r.ok) throw new Error(`unexpected ${r.classification}:${r.reason}`);
  return r.sale;
}

const RID = 'r'.repeat(40);

function req(lines: { lineIndex: number; productId: string; qtyMilli: number }[], expectedRefundMinor: number, refundMethod: 'cash' | 'qr' | 'kbank' | 'card' | 'none' = 'cash', refundReference = '') {
  return { lines, expectedRefundMinor, refundMethod, refundReference };
}

describe('allocateProportional (order-level discount / fee)', () => {
  test('exact proportional split sums to the amount', () => {
    expect(allocateProportional(10500, [45000, 60000])).toEqual([4500, 6000]);
  });
  test('largest remainder, ties to the lower index, never drifts', () => {
    const out = allocateProportional(100, [1, 1, 1]);
    expect(out).toEqual([34, 33, 33]);
    expect(out.reduce((s, v) => s + v, 0)).toBe(100);
  });
  test('zero weights / zero amount allocate nothing', () => {
    expect(allocateProportional(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportional(10, [0, 0])).toEqual([0, 0]);
  });
});

describe('parseSaleEvidence — historical classification (D-RET-13)', () => {
  test('settled sale with full FIFO evidence is eligible; shares = lineTotal − bill-discount share + fee share', () => {
    const sale = evidence();
    expect(sale.lines.map((l) => l.refundableShareMinor)).toEqual([40500, 54000]);
    expect(sale.lines.map((l) => l.billDiscountAllocMinor)).toEqual([4500, 6000]);
    expect(sale.lines[0]!.lineDiscountMinor).toBe(5000);
    expect(sale.netPaidByMethodMinor).toEqual({ cash: 94500, qr: 0, kbank: 0, card: 0 });
    expect(sale.lines[1]!.soldQtyBaseMilli).toBe(24000);
  });

  test.each([
    ['voided', { status: 'voided' }, 'voided'],
    ['void reconciled', { voidReconciled: true }, 'voided'],
    ['privileged void correlation', { privilegedVoidExecutionId: 'x' }, 'voided'],
    ['void requested', { voidRequested: true }, 'void_in_progress'],
    ['void anomaly marker', { voidAnomaly: 'missing_canonical' }, 'void_terminal_marker'],
    ['pending reconcile', { reconcileStatus: 'pending_reconcile' }, 'not_settled'],
    ['reconcile exception', { reconcileStatus: 'exception' }, 'reconcile_exception'],
  ])('%s → RETURN_NOT_ELIGIBLE', (_label, over, reason) => {
    const r = parseSaleEvidence('O1', asyncSale(over), canonical(), 'B1');
    expect(r).toEqual({ ok: false, classification: 'RETURN_NOT_ELIGIBLE', reason });
  });

  test('canonical voided → not eligible; missing canonical → unsupported', () => {
    expect(parseSaleEvidence('O1', asyncSale(), canonical({ status: 'voided' }), 'B1')).toMatchObject({
      classification: 'RETURN_NOT_ELIGIBLE',
      reason: 'voided',
    });
    expect(parseSaleEvidence('O1', asyncSale(), null, 'B1')).toMatchObject({
      classification: 'RETURN_UNSUPPORTED_EVIDENCE',
      reason: 'canonical_missing',
    });
  });

  test.each([
    ['missing lotRefs (historical)', (a: Doc) => { (a.lines as Doc[])[0]!.lotRefs = undefined; }, 'line_evidence_missing'],
    ['empty lotRefs', (a: Doc) => { (a.lines as Doc[])[0]!.lotRefs = []; }, 'line_evidence_missing'],
    ['lot qty ≠ sold base', (a: Doc) => { (a.lines as Doc[])[0]!.lotRefs = [{ lotId: 'L1', qty: 4, cost: 40 }]; }, 'lot_qty_mismatch'],
    ['lot cost missing', (a: Doc) => { (a.lines as Doc[])[0]!.lotRefs = [{ lotId: 'L1', qty: 5 }]; }, 'lot_evidence_malformed'],
    ['VAT present', (a: Doc) => { a.vatAmt = 5; }, 'vat_unsupported'],
    ['credit sale', (a: Doc) => { a.creditAmt = 100; }, 'credit_sale_unsupported'],
    ['subtotal ≠ Σ lineTotal', (a: Doc) => { a.subtotal = 1000; a.total = 895; }, 'money_inconsistent'],
    ['total ≠ subtotal − discount + fee', (a: Doc) => { a.total = 900; }, 'money_inconsistent'],
    ['tender ≠ total', (a: Doc) => { a.changeAmt = 10; }, 'paid_value_mismatch'],
    ['sub-satang money', (a: Doc) => { a.billDiscount = 105.005; }, 'money_malformed'],
  ])('%s → RETURN_UNSUPPORTED_EVIDENCE (fail closed, no guessing)', (_label, mutate, reason) => {
    const a = structuredClone(asyncSale());
    mutate(a);
    const r = parseSaleEvidence('O1', a, canonical(), 'B1');
    expect(r).toEqual({ ok: false, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason });
  });

  test('branch mismatch and absent order', () => {
    expect(parseSaleEvidence('O1', asyncSale(), canonical(), 'B2')).toMatchObject({ reason: 'branch_mismatch' });
    expect(parseSaleEvidence('O1', null, null, 'B1')).toMatchObject({ reason: 'order_not_found' });
  });
});

describe('cumulative refund math (D-RET-5 / D-RET-6 rounding)', () => {
  test('partial returns of a 3-unit line sum exactly to the line share', () => {
    const share = 10000;
    const r1 = lineRefundForReturnMinor(share, 3000, 0, 1000);
    const r2 = lineRefundForReturnMinor(share, 3000, 1000, 1000);
    const r3 = lineRefundForReturnMinor(share, 3000, 2000, 1000);
    expect([r1, r2, r3]).toEqual([3333, 3334, 3333]);
    expect(r1 + r2 + r3).toBe(share);
  });
  test('cumulative refund never exceeds the share even if asked beyond sold qty', () => {
    expect(cumulativeRefundMinor(40500, 5000, 9000)).toBe(40500);
    expect(cumulativeRefundMinor(40500, 5000, 0)).toBe(0);
  });
});

describe('planLotRestoration — original FIFO cost basis (D-RET-3)', () => {
  const lots = [
    { lotId: 'L1', qtyBaseMilli: 3000, cost: 40 },
    { lotId: 'L2', qtyBaseMilli: 2000, cost: 55 },
  ];
  test('first return takes the FIFO prefix at the original lot cost', () => {
    expect(planLotRestoration(lots, 0, 2000)).toEqual([
      { portionIndex: 0, originalLotId: 'L1', qtyBaseMilli: 2000, costPerUnit: 40 },
    ]);
  });
  test('second return spans two cost layers without collapsing them', () => {
    expect(planLotRestoration(lots, 2000, 3000)).toEqual([
      { portionIndex: 0, originalLotId: 'L1', qtyBaseMilli: 1000, costPerUnit: 40 },
      { portionIndex: 1, originalLotId: 'L2', qtyBaseMilli: 2000, costPerUnit: 55 },
    ]);
  });
  test('cumulative restoration can never exceed the original allocation', () => {
    expect(planLotRestoration(lots, 4000, 2000)).toBeNull();
  });
});

describe('planSaleReturn', () => {
  test('partial line return: qty, refund, cost and ledger successor', () => {
    const r = planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200), RID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.refundMinor).toBe(16200);
    expect(r.plan.costMinor).toBe(8000);
    expect(r.plan.lines[0]!.returnQtyBaseMilli).toBe(2000);
    expect(r.plan.nextLedger.lines.get(0)).toEqual({ returnedQtyMilli: 2000, returnedQtyBaseMilli: 2000, refundedMinor: 16200 });
    expect(r.plan.nextLedger.refundedByMethodMinor.cash).toBe(16200);
    expect(r.plan.sequence).toBe(1);
  });

  test('multi-line return with a multi-unit (unitFactor 12) line', () => {
    const r = planSaleReturn(
      evidence(),
      emptyLedger(),
      req(
        [
          { lineIndex: 0, productId: 'P1', qtyMilli: 1000 },
          { lineIndex: 1, productId: 'P2', qtyMilli: 1000 },
        ],
        8100 + 27000,
      ),
      RID,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.lines[1]!.returnQtyBaseMilli).toBe(12000);
    expect(r.plan.lines[1]!.portions).toEqual([{ portionIndex: 0, originalLotId: 'L3', qtyBaseMilli: 12000, costPerUnit: 20 }]);
  });

  test('second return of the remaining qty, then over-return is rejected', () => {
    const first = planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200), RID);
    if (!first.ok) throw new Error('first');
    const second = planSaleReturn(evidence(), first.plan.nextLedger, req([{ lineIndex: 0, productId: 'P1', qtyMilli: 3000 }], 24300), RID);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.plan.nextLedger.lines.get(0)!.refundedMinor).toBe(40500);
    const third = planSaleReturn(evidence(), second.plan.nextLedger, req([{ lineIndex: 0, productId: 'P1', qtyMilli: 1000 }], 0, 'none'), RID);
    expect(third).toEqual({ ok: false, code: 'over_return' });
    expect(planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 6000 }], 0), RID)).toEqual({
      ok: false,
      code: 'over_return',
    });
  });

  test('fully returned sale blocks any further return', () => {
    let ledger: ReturnLedger = emptyLedger();
    const all = planSaleReturn(
      evidence(),
      ledger,
      req(
        [
          { lineIndex: 0, productId: 'P1', qtyMilli: 5000 },
          { lineIndex: 1, productId: 'P2', qtyMilli: 2000 },
        ],
        94500,
      ),
      RID,
    );
    if (!all.ok) throw new Error('all');
    ledger = all.plan.nextLedger;
    expect(ledger.refundedTotalMinor).toBe(94500);
    expect(planSaleReturn(evidence(), ledger, req([{ lineIndex: 0, productId: 'P1', qtyMilli: 1000 }], 0, 'none'), RID)).toEqual({
      ok: false,
      code: 'return_not_eligible',
    });
    expect(buildReturnContextView(evidence(), ledger).fullyReturned).toBe(true);
  });

  test('refund amount must equal the server computation (no client-chosen amount)', () => {
    expect(planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 20000), RID)).toEqual({
      ok: false,
      code: 'refund_mismatch',
    });
  });

  test('refund tender must be one the customer paid with, within its net amount', () => {
    expect(
      planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200, 'qr', 'ref'), RID),
    ).toEqual({ ok: false, code: 'refund_method_not_allowed' });
    const mixed = evidence(
      asyncSale({ payments: [{ method: 'cash', amount: 100 }, { method: 'qr', amount: 845 }], paidAmt: 945, changeAmt: 0 }),
    );
    expect(planSaleReturn(mixed, emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200, 'cash'), RID)).toEqual({
      ok: false,
      code: 'refund_cap_exceeded',
    });
    const viaQr = planSaleReturn(mixed, emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200, 'qr', 'QR-REF-1'), RID);
    expect(viaQr.ok).toBe(true);
  });

  test('non-cash refund requires a reference; zero-value return requires method none', () => {
    const qrSale = evidence(asyncSale({ payments: [{ method: 'qr', amount: 945 }], paidAmt: 945, changeAmt: 0 }));
    expect(planSaleReturn(qrSale, emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200, 'qr', ''), RID)).toEqual({
      ok: false,
      code: 'reference_required',
    });
    const freeLine = structuredClone(asyncSale());
    (freeLine.lines as Doc[])[0]!.lineTotal = 0;
    (freeLine.lines as Doc[])[0]!.discountAmt = 500;
    freeLine.subtotal = 600;
    freeLine.billDiscount = 0;
    freeLine.total = 600;
    freeLine.payments = [{ method: 'cash', amount: 600 }];
    freeLine.paidAmt = 600;
    freeLine.changeAmt = 0;
    const sale = evidence(freeLine, canonical({ total: 600 }));
    expect(planSaleReturn(sale, emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 1000 }], 0, 'cash'), RID)).toEqual({
      ok: false,
      code: 'refund_method_not_allowed',
    });
    expect(planSaleReturn(sale, emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 1000 }], 0, 'none'), RID).ok).toBe(true);
  });

  test('fee (surcharge) is allocated pro-rata and fully refunded only when everything is returned', () => {
    const feeSale = asyncSale({ billDiscount: 0, fee: 21, total: 1071, payments: [{ method: 'card', amount: 1071 }], paidAmt: 1071, changeAmt: 0 });
    const sale = evidence(feeSale, canonical({ total: 1071 }));
    expect(sale.lines.map((l) => l.feeAllocMinor)).toEqual([900, 1200]);
    expect(sale.lines.map((l) => l.refundableShareMinor)).toEqual([45900, 61200]);
  });

  test('line identity must match (lineIndex + productId)', () => {
    expect(planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P2', qtyMilli: 1000 }], 0), RID)).toEqual({
      ok: false,
      code: 'invalid_request',
    });
  });
});

describe('ledger + identity', () => {
  test('ledger round-trips; malformed ledger fails closed; void guard reads it', () => {
    const r = planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200), RID);
    if (!r.ok) throw new Error('plan');
    const ser = serializeReturnLedger(r.plan.nextLedger, 'O1', 'B1');
    const back = parseReturnLedger(ser);
    expect(back?.returnCount).toBe(1);
    expect(back?.lines.get(0)?.returnedQtyMilli).toBe(2000);
    expect(parseReturnLedger({ ...ser, returnCount: 2 })).toBeNull();
    expect(parseReturnLedger({ schemaVersion: 9 })).toBeNull();
    // D-RET-FIX-2: ANY existing ledger document blocks Void — content never trusted.
    expect(saleReturnLedgerBlocksVoid(true)).toBe(true);
    expect(saleReturnLedgerBlocksVoid(false)).toBe(false);
  });

  test('returnId depends only on branch/order/attempt; content digest binds the content', () => {
    const base = validateSubmitSaleReturnRequest({
      attemptId: 'attempt-0001',
      orderId: 'O1',
      branchId: 'B1',
      lines: [{ lineIndex: 0, productId: 'P1', qty: 2 }],
      refundMethod: 'cash',
      reason: 'ชำรุด',
      expectedRefundAmount: 162,
      shiftId: 'SH1',
      approverStaffId: 'm1',
      pin: '1234',
    });
    if (!base.ok) throw new Error('validate');
    const other = { ...base.value, lines: [{ lineIndex: 0, productId: 'P1', qtyMilli: 3000 }] };
    expect(deriveReturnId('B1', 'O1', 'attempt-0001')).toBe(deriveReturnId('B1', 'O1', 'attempt-0001'));
    expect(deriveReturnId('B1', 'O1', 'attempt-0001')).not.toBe(deriveReturnId('B1', 'O1', 'attempt-0002'));
    expect(deriveReturnContentDigest(base.value)).not.toBe(deriveReturnContentDigest(other));
    expect(deriveReturnApprovalCommandId(RID, deriveReturnContentDigest(base.value))).toMatch(/^saleReturn:v1:r{40}:[0-9a-f]{32}$/);
    expect(base.value.expectedRefundMinor).toBe(16200);
    expect(base.value.lines[0]!.qtyMilli).toBe(2000);
  });

  test('request validation rejects zero/negative qty, duplicate lines, missing reason', () => {
    const ok = {
      attemptId: 'attempt-0001',
      orderId: 'O1',
      branchId: 'B1',
      lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
      refundMethod: 'cash',
      reason: 'x',
      expectedRefundAmount: 1,
      approverStaffId: 'm1',
      pin: '1234',
    };
    expect(validateSubmitSaleReturnRequest(ok).ok).toBe(true);
    expect(validateSubmitSaleReturnRequest({ ...ok, lines: [{ lineIndex: 0, productId: 'P1', qty: 0 }] }).ok).toBe(false);
    expect(validateSubmitSaleReturnRequest({ ...ok, lines: [{ lineIndex: 0, productId: 'P1', qty: -1 }] }).ok).toBe(false);
    expect(
      validateSubmitSaleReturnRequest({
        ...ok,
        lines: [
          { lineIndex: 0, productId: 'P1', qty: 1 },
          { lineIndex: 0, productId: 'P1', qty: 1 },
        ],
      }).ok,
    ).toBe(false);
    expect(validateSubmitSaleReturnRequest({ ...ok, reason: '  ' }).ok).toBe(false);
    expect(validateSubmitSaleReturnRequest({ ...ok, branchId: 'ALL' }).ok).toBe(false);
    expect(validateSubmitSaleReturnRequest({ ...ok, refundMethod: 'credit' }).ok).toBe(false);
  });
});

describe('context view (UI sold / returned / returnable)', () => {
  test('shows sold, already returned and returnable per line plus remaining tender', () => {
    const r = planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200), RID);
    if (!r.ok) throw new Error('plan');
    const view = buildReturnContextView(evidence(), r.plan.nextLedger);
    expect(view.lines[0]).toMatchObject({ soldQty: 5, returnedQty: 2, returnableQty: 3, refundedAmount: 162 });
    expect(view.lines[1]).toMatchObject({ soldQty: 2, returnedQty: 0, returnableQty: 2 });
    expect(view.refundMethods).toEqual([{ method: 'cash', remaining: 783 }]);
    expect(view.fullyReturned).toBe(false);
  });
});

describe('server ↔ client parity and source defaults', () => {
  test('client refund preview formula is identical to the server computation', () => {
    for (const share of [0, 1, 999, 10000, 40500, 1234567]) {
      for (const sold of [1, 1000, 3000, 5000, 7500]) {
        for (let cum = 0; cum <= sold; cum += Math.max(1, Math.floor(sold / 7))) {
          expect(clientReturn.cumulativeRefundMinor(share, sold, cum)).toBe(cumulativeRefundMinor(share, sold, cum));
        }
      }
    }
  });

  test('server fallback + seed role defaults: Admin/Manager have pos_return, Staff does not', () => {
    const root = resolve(__dirname, '..');
    for (const file of ['index.ts', 'scripts/seed-admin.ts']) {
      const src = readFileSync(resolve(root, file), 'utf8');
      const row = (role: string) => {
        const m = new RegExp(`\\b${role}: \\[([^\\]]*)\\]`).exec(src);
        if (!m) throw new Error(`${file}: ${role} row not found`);
        return m[1]!;
      };
      expect(row('admin'), file).toContain("'pos_return'");
      expect(row('manager'), file).toContain("'pos_return'");
      expect(row('staff'), file).not.toContain('pos_return');
    }
  });
});
// ─── TPOS-USABLE-POS-RETURN-REFUND-V1-BLOCKER-FIX-CLAUDE-001 ─────────────────

describe('D-RET-FIX-1 exact number parsing (fixed absolute tolerance)', () => {
  test('money: half-satang is rejected at small AND large magnitudes; ordinary 2dp passes', () => {
    expect(toMinorExact(10000.005)).toBeNull();
    expect(toMinorExact(0.005)).toBeNull();
    expect(toMinorExact(0.015)).toBeNull();
    expect(toMinorExact(999999999.995)).toBeNull();
    expect(toMinorExact(123456789.125)).toBeNull();
    expect(toMinorExact(123456789.12)).toBe(12345678912);
    expect(toMinorExact(945)).toBe(94500);
    expect(toMinorExact(0.1 + 0.2)).toBe(30); // binary noise only
    expect(toMinorExact(19.99 * 3)).toBe(5997);
    expect(toMinorExact(-12.34)).toBe(-1234);
  });

  test('money: out of the exact supported range, non-finite or non-number fails closed', () => {
    expect(toMinorExact(1e9 + 1)).toBeNull();
    expect(toMinorExact(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(toMinorExact(Number.NaN)).toBeNull();
    expect(toMinorExact(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toMinorExact('945')).toBeNull();
  });

  test('quantity: > 0.001 precision rejected at small and large magnitudes; 3dp passes', () => {
    expect(toMilliExact(1.0005)).toBeNull();
    expect(toMilliExact(12345678.0005)).toBeNull();
    expect(toMilliExact(99999999.0004)).toBeNull();
    expect(toMilliExact(12345.678)).toBe(12345678);
    expect(toMilliExact(0.1 * 3)).toBe(300);
    expect(toMilliExact(1e8 + 1)).toBeNull();
  });

  test('base derivation uses the same absolute tolerance', () => {
    expect(exactBaseMilli(1000, 12)).toBe(12000);
    expect(exactBaseMilli(1500, 0.5)).toBe(750);
    expect(exactBaseMilli(1, 0.3333)).toBeNull();
    expect(exactBaseMilli(-1, 1)).toBeNull();
  });

  test('historical evidence with a half-satang total or sub-milli quantity is unsupported', () => {
    const halfSatang = parseSaleEvidence('O1', asyncSale({ total: 945.005 }), canonical(), 'B1');
    expect(halfSatang).toMatchObject({ ok: false, classification: 'RETURN_UNSUPPORTED_EVIDENCE', reason: 'money_malformed' });
    const lines = asyncSale().lines as Doc[];
    const subMilli = parseSaleEvidence(
      'O1',
      asyncSale({ lines: [{ ...lines[0]!, qty: 5.0005, qtyBase: 5.0005 }, lines[1]] }),
      canonical(),
      'B1',
    );
    expect(subMilli).toMatchObject({ ok: false, reason: 'precision_unsupported' });
    const big = parseSaleEvidence(
      'O1',
      asyncSale({ lines: [{ ...lines[0]!, qty: 12345678.0005, qtyBase: 12345678.0005 }, lines[1]] }),
      canonical(),
      'B1',
    );
    expect(big).toMatchObject({ ok: false, reason: 'precision_unsupported' });
  });
});

describe('D-RET-FIX-2 ledger invariants against the original sale', () => {
  function validLedgerDoc(): Doc {
    const r = planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200), RID);
    if (!r.ok) throw new Error('plan');
    return serializeReturnLedger(r.plan.nextLedger, 'O1', 'B1');
  }
  const linesOf = (d: Doc) => d.lines as Doc[];

  test('a consistent ledger parses; an absent ledger is empty', () => {
    expect(parseReturnLedgerForSale(validLedgerDoc(), evidence())?.returnCount).toBe(1);
    expect(parseReturnLedgerForSale(undefined, evidence())?.returnCount).toBe(0);
  });

  test('identity: a ledger for another order/branch fails closed', () => {
    expect(parseReturnLedgerForSale({ ...validLedgerDoc(), orderId: 'O2' }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...validLedgerDoc(), branchId: 'B2' }, evidence())).toBeNull();
  });

  test('count / accepted ids: zero-count present ledger, duplicates, length mismatch, empty ids', () => {
    const d = validLedgerDoc();
    expect(parseReturnLedgerForSale({ ...d, returnCount: 0, acceptedReturnIds: [] }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, returnCount: 2, acceptedReturnIds: [RID, RID] }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, returnCount: 2 }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, acceptedReturnIds: [''] }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, returnCount: -1 }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, returnCount: 1.5 }, evidence())).toBeNull();
  });

  test('lines: unknown/duplicate index, over-sold qty, base inconsistent with unitFactor, negative', () => {
    const d = validLedgerDoc();
    const l0 = linesOf(d)[0]!;
    const withLines = (lines: Doc[]) => parseReturnLedgerForSale({ ...d, lines }, evidence());
    expect(withLines([{ ...l0, lineIndex: 7 }])).toBeNull();
    expect(withLines([l0, l0])).toBeNull();
    expect(withLines([{ ...l0, returnedQtyMilli: 6000, returnedQtyBaseMilli: 6000 }])).toBeNull();
    expect(withLines([{ ...l0, returnedQtyBaseMilli: 2001 }])).toBeNull();
    expect(withLines([{ ...l0, returnedQtyMilli: -1 }])).toBeNull();
    // Line 1 has unitFactor 12: 1 ลัง must be 12 base units.
    expect(
      withLines([l0, { lineIndex: 1, returnedQtyMilli: 1000, returnedQtyBaseMilli: 11000, refundedMinor: 27000 }]),
    ).toBeNull();
  });

  test('money: line refund, Σ lines, Σ tenders, tender cap and sale cap must all reconcile', () => {
    const d = validLedgerDoc();
    const l0 = linesOf(d)[0]!;
    expect(parseReturnLedgerForSale({ ...d, lines: [{ ...l0, refundedMinor: 16201 }], refundedTotalMinor: 16201, refundedByMethodMinor: { cash: 16201 } }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, refundedTotalMinor: 16000 }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, refundedByMethodMinor: { cash: 16000 } }, evidence())).toBeNull();
    // The sale was paid in cash only: a QR refund total is impossible.
    expect(parseReturnLedgerForSale({ ...d, refundedByMethodMinor: { cash: 0, qr: 16200 } }, evidence())).toBeNull();
    expect(parseReturnLedgerForSale({ ...d, refundedByMethodMinor: { cash: -1 } }, evidence())).toBeNull();
  });
});

describe('D-RET-FIX-4 oversell allocation fails closed in V1', () => {
  function oversellSale(): SaleEvidence {
    const lines = asyncSale().lines as Doc[];
    return evidence(
      asyncSale({
        lines: [
          { ...lines[0]!, lotRefs: [{ lotId: 'L1', qty: 3, cost: 40 }, { lotId: 'oversell', qty: 2, cost: 40 }] },
          lines[1],
        ],
      }),
    );
  }

  test('a return wholly within the real-lot portion is allowed even when the line was later oversold', () => {
    const r = planSaleReturn(oversellSale(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 3000 }], 24300), RID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.lines[0]!.portions).toEqual([expect.objectContaining({ originalLotId: 'L1', qtyBaseMilli: 3000 })]);
  });

  test('a quantity that crosses into the oversell allocation is rejected', () => {
    expect(planSaleReturn(oversellSale(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 4000 }], 32400), RID)).toEqual({
      ok: false,
      code: 'oversell_return_unsupported',
    });
    const first = planSaleReturn(oversellSale(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 3000 }], 24300), RID);
    if (!first.ok) throw new Error('plan');
    expect(planSaleReturn(oversellSale(), first.plan.nextLedger, req([{ lineIndex: 0, productId: 'P1', qtyMilli: 1000 }], 8100), 'x'.repeat(40))).toEqual({
      ok: false,
      code: 'oversell_return_unsupported',
    });
  });

  test('context exposes the supported (oversell-free) returnable quantity', () => {
    const sale = oversellSale();
    expect(maxSupportedReturnQtyMilli(sale.lines[0]!, undefined)).toBe(3000);
    const view = buildReturnContextView(sale, emptyLedger());
    expect(view.lines[0]).toMatchObject({ returnableQty: 5, supportedReturnableQty: 3, oversellLimited: true });
    expect(view.lines[1]).toMatchObject({ returnableQty: 2, supportedReturnableQty: 2, oversellLimited: false });
    const first = planSaleReturn(sale, emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 3000 }], 24300), RID);
    if (!first.ok) throw new Error('plan');
    expect(maxSupportedReturnQtyMilli(sale.lines[0]!, first.plan.nextLedger.lines.get(0))).toBe(0);
  });
});

describe('D-RET-FIX-3 in-place original-lot restore decision', () => {
  const lot = (over: Doc = {}): Doc => ({ productId: 'P1', branchId: 'B1', qtyReceived: 3, qtyRemaining: 0, costPerUnit: 40, ...over });
  const expectP = (restoreBaseMilli = 2000, portionCosts = [40]) => ({ productId: 'P1', branchId: 'B1', portionCosts, restoreBaseMilli });

  test('intact lot with room and the same cost restores in place to an exact value', () => {
    expect(decideInPlaceLotRestore(lot(), expectP())).toEqual({ ok: true, currentRemainingMilli: 0, nextRemainingMilli: 2000 });
    expect(decideInPlaceLotRestore(lot({ qtyRemaining: 1 }), expectP())).toEqual({ ok: true, currentRemainingMilli: 1000, nextRemainingMilli: 3000 });
  });

  test('near-full / already-full / over-full lots never exceed qtyReceived', () => {
    expect(decideInPlaceLotRestore(lot({ qtyRemaining: 2 }), expectP())).toEqual({ ok: false, reason: 'capacity_exceeded' });
    expect(decideInPlaceLotRestore(lot({ qtyRemaining: 3 }), expectP())).toEqual({ ok: false, reason: 'capacity_exceeded' });
    expect(decideInPlaceLotRestore(lot({ qtyRemaining: 4 }), expectP())).toEqual({ ok: false, reason: 'remaining_exceeds_received' });
  });

  test('a lot whose current cost differs from the sale-time cost is never merged into', () => {
    expect(decideInPlaceLotRestore(lot({ costPerUnit: 45 }), expectP())).toEqual({ ok: false, reason: 'cost_mismatch' });
    expect(decideInPlaceLotRestore(lot(), expectP(2000, [40, 41]))).toEqual({ ok: false, reason: 'cost_mismatch' });
    expect(decideInPlaceLotRestore(lot({ costPerUnit: '40' }), expectP())).toEqual({ ok: false, reason: 'cost_mismatch' });
  });

  test('missing / ghost / mismatched / malformed lots', () => {
    expect(decideInPlaceLotRestore(null, expectP())).toEqual({ ok: false, reason: 'lot_missing' });
    expect(decideInPlaceLotRestore(lot({ isGhost: true }), expectP())).toEqual({ ok: false, reason: 'ghost_lot' });
    expect(decideInPlaceLotRestore(lot({ productId: 'P9' }), expectP())).toEqual({ ok: false, reason: 'product_mismatch' });
    expect(decideInPlaceLotRestore(lot({ branchId: 'B2' }), expectP())).toEqual({ ok: false, reason: 'branch_mismatch' });
    expect(decideInPlaceLotRestore(lot({ qtyRemaining: '0' }), expectP())).toEqual({ ok: false, reason: 'qty_malformed' });
    expect(decideInPlaceLotRestore(lot({ qtyReceived: 3.0005 }), expectP())).toEqual({ ok: false, reason: 'qty_malformed' });
    expect(decideInPlaceLotRestore(lot({ qtyRemaining: -1 }), expectP())).toEqual({ ok: false, reason: 'qty_malformed' });
  });
});

describe('D-RET-FIX-9 customer spend adjustment', () => {
  test('decrements both spend aggregates by the refund, exactly', () => {
    expect(planCustomerSpendAdjustment('C1', { lifetimeValue: 1000, totalSpent: 1000 }, 16200)).toEqual({
      apply: true,
      decrementMinor: 16200,
      fields: {
        lifetimeValue: { before: 1000, after: 838, clamped: false },
        totalSpent: { before: 1000, after: 838, clamped: false },
      },
    });
  });

  test('never below the 0 floor; absent fields untouched; malformed / missing never written', () => {
    expect(planCustomerSpendAdjustment('C1', { totalSpent: 100 }, 16200)).toEqual({
      apply: true,
      decrementMinor: 16200,
      fields: { totalSpent: { before: 100, after: 0, clamped: true } },
    });
    expect(planCustomerSpendAdjustment('C1', { totalSpent: 'x' }, 100)).toEqual({ apply: false, reason: 'aggregate_malformed' });
    expect(planCustomerSpendAdjustment('C1', {}, 100)).toEqual({ apply: false, reason: 'no_aggregate' });
    expect(planCustomerSpendAdjustment('C1', null, 100)).toEqual({ apply: false, reason: 'customer_missing' });
    expect(planCustomerSpendAdjustment(null, { totalSpent: 100 }, 100)).toEqual({ apply: false, reason: 'no_customer' });
    expect(planCustomerSpendAdjustment('C1', { totalSpent: 100 }, 0)).toEqual({ apply: false, reason: 'zero_refund' });
  });
});

describe('planSaleReturn line revenue reversal (reporting basis)', () => {
  test('line revenue reversed is the cumulative-exact share of lineTotal (before bill discount)', () => {
    const r = planSaleReturn(evidence(), emptyLedger(), req([{ lineIndex: 0, productId: 'P1', qtyMilli: 2000 }], 16200), RID);
    if (!r.ok) throw new Error('plan');
    // lineTotal 450 × 2/5 = 180; refund (after 10% bill discount) = 162.
    expect(r.plan.lines[0]!.lineRevenueMinor).toBe(18000);
    expect(r.plan.lineRevenueMinor).toBe(18000);
    expect(r.plan.refundMinor).toBe(16200);
  });
});

describe('client exact-quantity parity (D-RET-FIX-1)', () => {
  test('client qtyToMilli accepts/rejects exactly like the server', () => {
    for (const v of [0, 1, 2.5, 0.001, 0.1 * 3, 12345.678, 1.0005, 12345678.0005, 99999999.0004, 1e8, 1e8 + 1, -1, Number.NaN]) {
      expect(clientReturn.qtyToMilli(v), String(v)).toBe(toMilliExact(v));
    }
  });
});
