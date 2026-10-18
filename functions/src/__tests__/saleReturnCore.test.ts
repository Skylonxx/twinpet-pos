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
  emptyLedger,
  ledgerHasAcceptedReturns,
  lineRefundForReturnMinor,
  parseReturnLedger,
  parseSaleEvidence,
  planLotRestoration,
  planSaleReturn,
  serializeReturnLedger,
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
    expect(ledgerHasAcceptedReturns(ser)).toBe(true);
    expect(ledgerHasAcceptedReturns({ returnCount: 0 })).toBe(false);
    expect(ledgerHasAcceptedReturns({ returnCount: 'x' })).toBe(true);
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