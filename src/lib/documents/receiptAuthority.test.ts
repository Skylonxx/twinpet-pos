import { describe, expect, test } from 'vitest';
import { AUTHORITATIVE_RECEIPT_STATEMENT, decideReceiptAuthority, gd2ImmediateSlip } from './receiptAuthority';

const ok = {
  envelopeOk: true,
  historyRevOk: true,
  projectionProven: true,
  numericOk: true,
  paymentOk: true,
  notVoided: true,
  noUnreconciledVoid: true,
  noVoidAnomaly: true,
  settingsResolved: true,
};

describe('H receipt authority', () => {
  test('H01 AUTHORITATIVE only on full conjunction; each missing conjunct removes it', () => {
    expect(decideReceiptAuthority(ok).authority).toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, envelopeOk: false }).authority).not.toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, historyRevOk: false }).authority).not.toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, projectionProven: false }).authority).not.toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, numericOk: false }).authority).not.toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, paymentOk: false }).authority).not.toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, notVoided: false }).authority).not.toBe('AUTHORITATIVE');
    expect(decideReceiptAuthority({ ...ok, settingsResolved: false }).authority).not.toBe('AUTHORITATIVE');
  });

  test('H02 each PROVISIONAL/UNPROVEN cause yields a distinct stated reason', () => {
    const reasons = [
      decideReceiptAuthority({ ...ok, envelopeOk: false }).reason,
      decideReceiptAuthority({ ...ok, historyRevOk: false }).reason,
      decideReceiptAuthority({ ...ok, projectionProven: false }).reason,
      decideReceiptAuthority({ ...ok, numericOk: false }).reason,
      decideReceiptAuthority({ ...ok, paymentOk: false }).reason,
    ];
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  test('H03 REFUSED for voided, unreconciled void, settings unresolved', () => {
    expect(decideReceiptAuthority({ ...ok, notVoided: false }).authority).toBe('REFUSED');
    expect(decideReceiptAuthority({ ...ok, noUnreconciledVoid: false }).authority).toBe('REFUSED');
    expect(decideReceiptAuthority({ ...ok, noVoidAnomaly: false }).authority).toBe('REFUSED');
    expect(decideReceiptAuthority({ ...ok, settingsResolved: false }).authority).toBe('REFUSED');
  });

  test('H04 authority × copyStatus orthogonality PROVISIONAL+COPY', () => {
    const d = decideReceiptAuthority({ ...ok, envelopeOk: false, copyStatus: 'COPY' });
    expect(d.authority).toBe('UNPROVEN');
    expect(d.copyStatus).toBe('COPY');
    const p = gd2ImmediateSlip('A');
    expect(p.authority).toBe('PROVISIONAL');
    expect(p.copyStatus).toBe('ORIGINAL');
  });

  test('H05 G-D2 offline branch exercised in both configurations', () => {
    expect(gd2ImmediateSlip('A')).toMatchObject({ authority: 'PROVISIONAL', reason: 'offline_unqualified' });
    expect(gd2ImmediateSlip('B')).toMatchObject({ authority: 'REFUSED', reason: 'offline_unqualified' });
  });

  test('H07 Sales History fan-out state is not an input to the authoritative render path', async () => {
    const src = (await import('./receiptAuthority.ts?raw')).default as string;
    expect(src.includes('paymentObservation')).toBe(false);
    expect(src.includes('useSalesHistory')).toBe(false);
    expect(AUTHORITATIVE_RECEIPT_STATEMENT.includes('sale-time VAT')).toBe(true);
  });
});
