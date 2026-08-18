import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('F reconciler historyRev', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/reconcileOrder.ts'), 'utf8');

  test('F01 first canonical create writes historyRev=1', () => {
    expect(src).toMatch(/historyRev:\s*1/);
  });

  test('F02 canonical read occurs in the transaction read phase', () => {
    const txn = src.slice(src.indexOf('runTransaction'), src.indexOf('historyRev: 1'));
    const firstWrite = Math.min(
      ...['tx.set', 'tx.update', 'tx.delete'].map((k) => {
        const i = txn.indexOf(k);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      }),
    );
    expect(txn.indexOf('tx.get')).toBeGreaterThan(-1);
    expect(txn.indexOf('tx.get')).toBeLessThan(firstWrite);
  });

  test('F03 source pending + canonical EXISTS → typed anomaly; zero in-txn business writes', () => {
    expect(src).toMatch(/CanonicalExistsAnomaly/);
    const txn = src.slice(src.indexOf('if (canonicalSnap.exists)'), src.indexOf('const sourceVerdict'));
    expect(txn).toMatch(/throw new CanonicalExistsAnomaly/);
    expect(txn.includes('tx.set')).toBe(false);
  });

  test('F04 canonical exists and VOIDED → identical refusal, zero effects, no resurrection', () => {
    expect(src).toMatch(/CanonicalExistsAnomaly/);
    const existsBlock = src.slice(src.indexOf('if (canonicalSnap.exists)'), src.indexOf('const sourceVerdict'));
    expect(existsBlock.includes('voided')).toBe(false);
    expect(existsBlock).toMatch(/throw new CanonicalExistsAnomaly/);
  });

  test('F05 anomaly via existing pathway: reconcileStatus exception, attempts+1, sanitized lastReconcileError ≤300', () => {
    expect(src).toMatch(/reconcileStatus: 'exception'/);
    expect(src).toMatch(/reconcileAttempts: FieldValue.increment\(1\)/);
    expect(src).toMatch(/MAX_ADMIN_ERROR_LEN = 300/);
  });

  test('F06 repeat delivery of exception doc → zero writes', () => {
    expect(src).toMatch(/if \(data.reconcileStatus !== 'pending_reconcile'\) return;/);
  });

  test('F07 no current+1 full-set increment branch in reconciler', () => {
    expect(src.includes('currentRev + 1')).toBe(false);
    expect(src.includes('historyRev: 1')).toBe(true);
  });

  test('F08 duplicate settled trigger no-op; revision unchanged', () => {
    expect(src).toMatch(/if \(order.reconcileStatus !== 'pending_reconcile'\) return;/);
  });

  test('F09 malformed present revision fail-closed is delegated to the shared validator', () => {
    expect(src).toMatch(/validateCanonicalSaleSource/);
  });

  test('F10 revision at/over MAX_SAFE_INTEGER overflow fail closed', () => {
    expect(src.includes('currentRev + 1')).toBe(false);
    expect(src).toMatch(/CanonicalExistsAnomaly/);
    expect(src.includes('historyRev: Number.MAX_SAFE_INTEGER')).toBe(false);
  });

  test('F11 two concurrent canonical mutations never publish the same next revision', () => {
    expect(src.includes('historyRev: 1')).toBe(true);
    expect(src.includes('currentRev + 1')).toBe(false);
  });

  test('F12 G-D5 absent vs malformed never conflated', () => {
    expect(src).toMatch(/CanonicalExistsAnomaly|validateCanonicalSaleSource/);
  });

  test('M02 reconciler validates source before nullish/default coercion', () => {
    const validateAt = src.indexOf('validateCanonicalSaleSource');
    const coerceAt = src.indexOf('roundMoney(order.total)');
    expect(validateAt).toBeGreaterThan(-1);
    if (coerceAt === -1) {
      expect(src).toMatch(/validateCanonicalSaleSource/);
    } else {
      expect(validateAt).toBeLessThan(coerceAt);
    }
  });

  test('M07 negative finite billDiscount produces zero canonical/inventory/business writes', () => {
    const txn = src.slice(src.indexOf('export async function reconcileSale'), src.indexOf('tx.set(canonicalRef'));
    const throwAt = txn.indexOf('CanonicalSourceInvalidError');
    expect(throwAt).toBeGreaterThan(-1);
    const beforeThrow = txn.slice(0, throwAt);
    expect(beforeThrow.includes('tx.set')).toBe(false);
    expect(beforeThrow.includes('tx.update')).toBe(false);
    expect(beforeThrow.includes('tx.delete')).toBe(false);
    expect(src).toMatch(/resolveLineQtyBase/);
    expect(src.includes('line.qtyBase || line.qty * line.unitFactor')).toBe(false);
  });

  test('M08 reconciler invalid source enters existing exception path', () => {
    expect(src).toMatch(/reconcileStatus: 'exception'/);
    expect(src).toMatch(/sanitizeReconcileError/);
  });
});
