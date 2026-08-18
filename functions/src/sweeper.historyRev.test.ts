import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
    arrayUnion: (...items: unknown[]) => ({ __fv: 'arr', items }),
  },
  Timestamp: { now: () => ({ __fv: 'ts' }), fromMillis: (ms: number) => ({ __ms: ms }) },
}));

import { CanonicalSourceInvalidError } from './canonicalSaleSource';
import { repairSettledOrder, sweepStuckOrders } from './sweeper';

type Doc = Record<string, unknown>;
type Seed = Record<string, Doc>;
type Ref = {
  path: string;
  id: string;
  collection: (n: string) => Coll;
  get: () => Promise<{ exists: boolean; data: () => Doc | undefined }>;
};
type Coll = { doc: (id?: string) => Ref; where: (field: string, op: string, value: unknown) => { get: () => Promise<{ size: number; docs: unknown[] }> } };

function makeSnap(id: string, data: Doc) {
  return { id, data: () => data };
}

function makeFakeDb(seed: Seed, opts: { existOnlyInsideTx?: string[] } = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const writes: string[] = [];
  let auto = 0;

  const docRef = (path: string): Ref => ({
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    collection: (n: string) => collRef(`${path}/${n}`),
    get: async () => {
      const data = store.get(path);
      const hideOnFastPath = opts.existOnlyInsideTx?.includes(path) === true;
      return { exists: data !== undefined && !hideOnFastPath, data: () => data };
    },
  });
  const collRef = (path: string): Coll => ({
    doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++auto}`}`),
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => {
        const docs = [...store.entries()]
          .filter(([p, d]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1 && d[field] === value)
          .map(([p, d]) => ({
            id: p.slice(path.length + 1),
            data: () => d,
          }));
        return { size: docs.length, docs };
      },
    }),
  });

  const db = {
    collection: (n: string) => collRef(n),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (ref: Ref) => {
          const data = store.get(ref.path);
          return { exists: data !== undefined, id: ref.id, data: () => data };
        },
        set: (ref: Ref, data: Doc) => {
          writes.push(`set:${ref.path}`);
          store.set(ref.path, { ...data });
        },
      };
      return await fn(tx);
    },
    __store: store,
    __writes: writes,
  };
  return db;
}

function malformedLegacySource(over: Doc = {}): Doc {
  return {
    id: 'ord1',
    reconcileStatus: 'settled',
    status: 'completed',
    total: 'legacy-bad',
    lines: 'not-an-array',
    ...over,
  };
}

function validSettledSource(over: Doc = {}): Doc {
  return {
    id: 'ord1',
    reconcileStatus: 'settled',
    billId: 'B1',
    branchId: 'br1',
    staffId: 's1',
    staffName: 'Staff',
    shiftId: 'sh1',
    priceLevelId: 'retail',
    status: 'completed',
    total: 100,
    subtotal: 100,
    paidAmt: 100,
    discountAmt: 0,
    billDiscount: 0,
    fee: 0,
    changeAmt: 0,
    creditAmt: 0,
    cogs: 0,
    profit: 0,
    clientCreatedAt: 1_700_000_000_000,
    lines: [{
      productId: 'p1',
      productSnap: { name: 'A', sku: 'A', category: 'c' },
      unit: 'pcs',
      unitFactor: 1,
      qty: 1,
      qtyBase: 1,
      unitPrice: 100,
      discountAmt: 0,
      lineTotal: 100,
    }],
    payments: [{ method: 'cash', amount: 100, ref: null }],
    ...over,
  };
}

describe('F19-F20 sweeper historyRev', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/sweeper.ts'), 'utf8');
  const repairFn = src.slice(
    src.indexOf('export async function repairSettledOrder'),
    src.indexOf('export async function sweepStuckOrders'),
  );

  test('F19 missing canonical repair create writes historyRev=1', () => {
    expect(src).toMatch(/historyRev:\s*1/);
  });

  test('F20 existing canonical already_present does not reset revision', async () => {
    expect(src).toMatch(/already_present|exists/);
    expect(src.includes('historyRev: 0')).toBe(false);

    const existsPrecheck = repairFn.indexOf("if ((await canonicalRef.get()).exists) return 'already_present'");
    const validateAt = repairFn.indexOf('validateCanonicalSaleSource');
    const txGet = repairFn.indexOf('tx.get(canonicalRef)');
    const txSet = repairFn.indexOf('tx.set(canonicalRef');
    expect(existsPrecheck).toBeGreaterThan(-1);
    expect(validateAt).toBeGreaterThan(existsPrecheck);
    expect(txGet).toBeGreaterThan(-1);
    expect(txSet).toBeGreaterThan(txGet);

    const db = makeFakeDb({
      'orders/ord1': { id: 'ord1', historyRev: 4, status: 'completed', total: 100 },
      'asyncOrders/ord1': malformedLegacySource(),
    });
    const before = JSON.stringify([...db.__store.entries()]);

    const outcome = await repairSettledOrder(
      db as never,
      makeSnap('ord1', malformedLegacySource()) as never,
      true,
    );
    expect(outcome).toBe('already_present');
    expect(outcome).not.toBe('unrepairable');
    expect(db.__writes).toEqual([]);
    expect(db.__store.get('orders/ord1')!.historyRev).toBe(4);
    expect(JSON.stringify([...db.__store.entries()])).toBe(before);

    const report = await sweepStuckOrders(db as never, { apply: true, log: () => undefined });
    expect(report.alreadyPresent).toBe(1);
    expect(report.unrepairable).toEqual([]);
    expect(report.repaired).toEqual([]);
    expect(db.__writes).toEqual([]);
    expect(db.__store.get('orders/ord1')!.historyRev).toBe(4);
    expect(JSON.stringify([...db.__store.entries()])).toBe(before);

    const raceDb = makeFakeDb(
      {
        'orders/ord1': { id: 'ord1', historyRev: 4, status: 'completed', total: 100 },
        'asyncOrders/ord1': validSettledSource(),
      },
      { existOnlyInsideTx: ['orders/ord1'] },
    );
    const raceOutcome = await repairSettledOrder(
      raceDb as never,
      makeSnap('ord1', validSettledSource()) as never,
      true,
    );
    expect(raceOutcome).toBe('already_present');
    expect(raceDb.__writes).toEqual([]);
    expect(raceDb.__store.get('orders/ord1')!.historyRev).toBe(4);
  });

  test('M03 sweeper validates source before nullish/default coercion', async () => {
    const validateAt = src.indexOf('validateCanonicalSaleSource');
    const coerceAt = src.indexOf('roundMoney(order.total)');
    expect(validateAt).toBeGreaterThan(-1);
    expect(coerceAt).toBeGreaterThan(validateAt);
    expect(repairFn.indexOf('validateCanonicalSaleSource')).toBeGreaterThan(
      repairFn.indexOf("if ((await canonicalRef.get()).exists) return 'already_present'"),
    );
    expect(repairFn.indexOf('roundMoney(order.total)')).toBeGreaterThan(
      repairFn.indexOf('validateCanonicalSaleSource'),
    );

    const db = makeFakeDb({
      'asyncOrders/ord1': malformedLegacySource(),
    });
    const before = JSON.stringify([...db.__store.entries()]);
    await expect(
      repairSettledOrder(db as never, makeSnap('ord1', malformedLegacySource()) as never, true),
    ).rejects.toBeInstanceOf(CanonicalSourceInvalidError);
    expect(db.__writes).toEqual([]);
    expect(db.__store.has('orders/ord1')).toBe(false);
    expect(JSON.stringify([...db.__store.entries()])).toBe(before);
  });

  test('M09 sweeper invalid source returns unrepairable with source_invalid field reason', async () => {
    expect(src).toMatch(/unrepairable/);
    expect(src).toMatch(/CanonicalSourceInvalidError/);

    const db = makeFakeDb({
      'asyncOrders/ord1': malformedLegacySource(),
    });
    await expect(
      repairSettledOrder(db as never, makeSnap('ord1', malformedLegacySource()) as never, true),
    ).rejects.toMatchObject({
      name: 'CanonicalSourceInvalidError',
      message: expect.stringMatching(/^source_invalid:/),
    });

    const report = await sweepStuckOrders(db as never, { apply: true, log: () => undefined });
    expect(report.unrepairable).toHaveLength(1);
    expect(report.unrepairable[0]).toMatchObject({
      id: 'ord1',
      reason: expect.stringMatching(/^source_invalid:/),
    });
    expect(report.repaired).toEqual([]);
    expect(report.alreadyPresent).toBe(0);
    expect(db.__writes).toEqual([]);
    expect(db.__store.has('orders/ord1')).toBe(false);
  });
});
