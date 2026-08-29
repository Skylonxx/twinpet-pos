import { describe, expect, test } from 'vitest';
import { encodeDurableKey, sortEncodedKeys } from '../platform/durableStore/kvKeyCodec';
import { sha256HexOfRows } from '../platform/durableStore/canonicalDigest';
import {
  P13MigrationError,
  discoverLegacySuspendedBillBranches,
  migrateLegacySuspendedBills,
  validateMigrationCartLine,
  validateMigrationSuspendedBill,
  type SuspendedBill,
} from './suspendedBills';
import type { CartLine } from './types';

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

function validLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    lineKey: 'P1::ชิ้น',
    productId: 'P1',
    productName: 'อาหาร',
    category: 'food',
    sku: 'SKU1',
    unit: 'ชิ้น',
    unitFactor: 1,
    unitPrice: 10,
    qty: 1,
    discount: { type: 'none', val: 0 },
    ...overrides,
  };
}

function validBill(overrides: Partial<SuspendedBill> = {}): SuspendedBill {
  return {
    id: 'b1',
    note: '',
    cartItems: [validLine()],
    customerId: null,
    discount: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    customer: null,
    discountPercent: false,
    feeRate: 0,
    totalAmount: 10,
    itemCount: 1,
    ...overrides,
  };
}

describe('P-13 sqlite migration', () => {
  test('discovers prefix keys and empty suffix aborts', () => {
    const storage = memoryStorage({
      'twinpet-suspended-bills:b': '[]',
      'twinpet-suspended-bills:a': '[]',
      'twinpet_branch_id': 'session-only',
    });
    expect(discoverLegacySuspendedBillBranches(storage)).toEqual(['session-only', 'a', 'b']);
    const empty = memoryStorage({ 'twinpet-suspended-bills:': '[]' });
    expect(() => discoverLegacySuspendedBillBranches(empty)).toThrow(P13MigrationError);
  });

  test('malformed branch JSON and non-array abort', () => {
    expect(() =>
      migrateLegacySuspendedBills(memoryStorage({ 'twinpet-suspended-bills:b1': '{not json' })),
    ).toThrow(/malformed/);
    expect(() =>
      migrateLegacySuspendedBills(memoryStorage({ 'twinpet-suspended-bills:b1': '{}' })),
    ).toThrow(/not an array/);
  });

  test('invalid outer bill and empty id abort', () => {
    expect(() => validateMigrationSuspendedBill({ note: '', cartItems: [], createdAt: 'x' })).toThrow(
      /id/,
    );
    expect(() =>
      validateMigrationSuspendedBill({ id: 'b1', note: '', cartItems: 'nope', createdAt: 'x' }),
    ).toThrow(/cartItems/);
    expect(() =>
      validateMigrationSuspendedBill({ id: 'b1', note: '', cartItems: [], createdAt: 1 }),
    ).toThrow(/createdAt/);
  });

  test('cartItems [{}] aborts and empty cartItems pass', () => {
    expect(() => validateMigrationSuspendedBill(validBill({ cartItems: [{} as never] }))).toThrow(
      P13MigrationError,
    );
    expect(validateMigrationSuspendedBill(validBill({ cartItems: [], itemCount: 0 })).cartItems).toEqual([]);
  });

  test.each(['lineKey', 'productId', 'productName', 'category', 'sku', 'unit', 'unitFactor', 'unitPrice', 'qty', 'discount'] as const)(
    'missing required CartLine field %s aborts',
    (field) => {
      const line = { ...validLine() } as Record<string, unknown>;
      delete line[field];
      expect(() => validateMigrationCartLine(line)).toThrow(P13MigrationError);
    },
  );

  test('non-finite numerics, string numbers, and unknown fields abort', () => {
    expect(() => validateMigrationCartLine(validLine({ qty: Number.NaN }))).toThrow(P13MigrationError);
    expect(() => validateMigrationCartLine({ ...validLine(), qty: '1' as never })).toThrow(P13MigrationError);
    expect(() => validateMigrationCartLine({ ...validLine(), extra: 1 } as never)).toThrow(/unknown cart line field/);
    expect(() =>
      validateMigrationCartLine({ ...validLine(), discount: { type: 'none', val: 0, extra: 1 } as never }),
    ).toThrow(/unknown discount field/);
  });

  test('discount closed set and optionals', () => {
    expect(() => validateMigrationCartLine(validLine({ discount: { type: 'foo' as never, val: 0 } }))).toThrow(
      P13MigrationError,
    );
    expect(validateMigrationCartLine(validLine({ barcode: null })).barcode).toBeNull();
    expect(validateMigrationCartLine(validLine({ barcode: 'x' })).barcode).toBe('x');
    expect(() => validateMigrationCartLine({ ...validLine(), barcode: 1 as never })).toThrow(P13MigrationError);
    expect(validateMigrationCartLine(validLine()).originalPrice).toBeUndefined();
  });

  test('lineKey empty or duplicate aborts; mismatch with productId/unit still passes', () => {
    expect(() => validateMigrationCartLine(validLine({ lineKey: '' }))).toThrow(P13MigrationError);
    expect(() =>
      validateMigrationSuspendedBill(
        validBill({
          cartItems: [validLine({ lineKey: 'k', qty: 1 }), validLine({ lineKey: 'k', qty: 2, productName: 'other' })],
        }),
      ),
    ).toThrow(/duplicate lineKey/);
    expect(validateMigrationCartLine(validLine({ lineKey: 'custom' })).lineKey).toBe('custom');
  });

  test('exact canonical duplicates coalesce and divergent duplicates abort', () => {
    const bill = validBill();
    const same = memoryStorage({
      'twinpet-suspended-bills:br': JSON.stringify([bill, { ...bill, discountPercent: false }]),
    });
    const migrated = migrateLegacySuspendedBills(same);
    expect(migrated.rows).toHaveLength(1);
    expect(migrated.identicalDuplicateCount).toBe(1);
    const divergent = memoryStorage({
      'twinpet-suspended-bills:br': JSON.stringify([bill, { ...bill, note: 'other' }]),
    });
    expect(() => migrateLegacySuspendedBills(divergent)).toThrow(/divergent/);
  });

  test('digest is deterministic for the same valid source', async () => {
    const storage = memoryStorage({
      'twinpet-suspended-bills:br': JSON.stringify([validBill()]),
    });
    const a = migrateLegacySuspendedBills(storage);
    const b = migrateLegacySuspendedBills(storage);
    const digestA = await sha256HexOfRows(
      sortEncodedKeys(a.rows.map((r) => r.encodedKey)).map((encodedKey) => ({
        encodedKey,
        value: a.rows.find((r) => r.encodedKey === encodedKey)!.bill,
      })),
    );
    const digestB = await sha256HexOfRows(
      sortEncodedKeys(b.rows.map((r) => r.encodedKey)).map((encodedKey) => ({
        encodedKey,
        value: b.rows.find((r) => r.encodedKey === encodedKey)!.bill,
      })),
    );
    expect(digestA).toBe(digestB);
    expect(a.rows[0]!.encodedKey).toBe(encodeDurableKey(['br', 'b1']));
    expect(a.allCartLinesSchemaValid).toBe(true);
  });

  test('valid empty branch remains in discovered inventory with zero bill rows', async () => {
    const storage = memoryStorage({
      'twinpet-suspended-bills:empty-branch': '[]',
      'twinpet-suspended-bills:สาขา-01': JSON.stringify([validBill({ id: 'b1' })]),
    });
    const migrated = migrateLegacySuspendedBills(storage);
    expect(migrated.branchIds).toEqual(['empty-branch', 'สาขา-01']);
    expect(migrated.rows).toHaveLength(1);
    expect(migrated.rows[0]!.branchId).toBe('สาขา-01');
    const { buildP13ManifestEvidence } = await import('../platform/durableStore/epochSelector');
    const withEmpty = await buildP13ManifestEvidence({
      branchIds: migrated.branchIds,
      rows: migrated.rows.map((row) => ({ store: 'bills', key: [row.branchId, row.billId], value: row.bill })),
      identicalDuplicateCount: migrated.identicalDuplicateCount,
    });
    const billsOnly = await buildP13ManifestEvidence({
      branchIds: migrated.rows.map((row) => row.branchId),
      rows: migrated.rows.map((row) => ({ store: 'bills', key: [row.branchId, row.billId], value: row.bill })),
      identicalDuplicateCount: migrated.identicalDuplicateCount,
    });
    expect(withEmpty.branchIds).toContain('empty-branch');
    expect(withEmpty.rowCount).toBe(1);
    expect(withEmpty.digestSha256).not.toBe(billsOnly.digestSha256);
  });
});
