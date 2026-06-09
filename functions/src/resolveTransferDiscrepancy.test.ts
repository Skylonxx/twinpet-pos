import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock the Functions/admin surface so importing the resolver has no side effects
// and `performResolveTransferDiscrepancy` is testable with an injected fake db.
vi.mock('./db', () => ({ db: { __unused: true } }));
vi.mock('./deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
  // Real lots are seeded as plain { seconds } objects (not instances), so the
  // resolver's `value instanceof Timestamp` is false and it reads `.seconds`.
  Timestamp: class Timestamp {},
}));

import { performResolveTransferDiscrepancy } from './resolveTransferDiscrepancy';

// ── Minimal transactional fake Admin Firestore (paths + subcollections + queries) ──
type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  let auto = 0;

  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    }
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return 1_700_000_000_000;
    return v;
  };

  const seconds = (v: unknown): number =>
    v && typeof v === 'object' && typeof (v as { seconds?: number }).seconds === 'number'
      ? (v as { seconds: number }).seconds
      : 0;

  const directChildren = (colPath: string) =>
    [...store.entries()]
      .filter(([p]) => p.startsWith(`${colPath}/`) && !p.slice(colPath.length + 1).includes('/'))
      .map(([p, data]) => ({ p, data }));

  function docRef(path: string): any {
    return {
      __doc: true,
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      collection: (name: string) => colRef(`${path}/${name}`),
    };
  }
  function makeQuery(path: string, wheres: Array<{ f: string; v: unknown }>, order: string | null): any {
    return {
      __query: true,
      path,
      wheres,
      order,
      where: (f: string, _op: string, v: unknown) => makeQuery(path, [...wheres, { f, v }], order),
      orderBy: (f: string) => makeQuery(path, wheres, f),
    };
  }
  function colRef(path: string): any {
    return {
      __col: true,
      path,
      doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++auto}`}`),
      where: (f: string, op: string, v: unknown) => makeQuery(path, [{ f, v }], null).where(f, op, v),
      orderBy: (f: string) => makeQuery(path, [], f),
    };
  }

  const snapshotFor = (path: string, wheres: Array<{ f: string; v: unknown }>, order: string | null) => {
    let rows = directChildren(path);
    for (const w of wheres) rows = rows.filter((r) => r.data[w.f] === w.v);
    if (order) rows = [...rows].sort((a, b) => seconds(a.data[order]) - seconds(b.data[order]));
    const docs = rows.map((r) => ({ id: r.p.slice(r.p.lastIndexOf('/') + 1), ref: docRef(r.p), data: () => r.data }));
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (cb: (d: unknown) => void) => docs.forEach(cb) };
  };

  const db = {
    collection: (c: string) => colRef(c),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (x: any) => {
          if (x.__doc) {
            const data = store.get(x.path);
            return { exists: data !== undefined, id: x.id, ref: x, data: () => data };
          }
          if (x.__query) return snapshotFor(x.path, x.wheres, x.order);
          if (x.__col) return snapshotFor(x.path, [], null);
          throw new Error('tx.get: unexpected arg');
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal((existing as Doc)[k], v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
      };
      return fn(tx);
    },
    __store: store,
  };
  return db;
}

const ORIGIN = 'BR-ORIGIN';
const DEST = 'BR-DEST';
const TID = 'TR-7B2-1';
const DID = 'DISC-1';

const origin = { uid: 'u1', token: { role: 'staff', staffId: 's-origin', branchIds: [ORIGIN] } };
const dest = { uid: 'u2', token: { role: 'staff', staffId: 's-dest', branchIds: [DEST] } };
const other = { uid: 'u3', token: { role: 'staff', staffId: 's-other', branchIds: ['BR-OTHER'] } };
const admin = { uid: 'u4', token: { role: 'admin', staffId: 'admin1', branchIds: ['ALL'] } };

/** Seed a completed transfer (10 of PD), dest stock 10, two inherited dest lots, + a reported discrepancy. */
function seedScenario(over: { discLines?: Doc[]; productCost?: number } = {}) {
  const lines = over.discLines ?? [
    { productId: 'PD', productName: 'PD', sku: 'SKU-PD', expectedQty: 10, actualQty: 8, difference: -2 },
  ];
  return makeDb({
    'products/PD': { id: 'PD', name: 'PD', sku: 'SKU-PD', avgCost: 12, cost: over.productCost ?? 0 },
    'products/PD/productStocks/BR-DEST': { branchId: DEST, totalStockBase: 10 },
    'stockLots/L1': { id: 'L1', productId: 'PD', branchId: DEST, costPerUnit: 10, qtyRemaining: 6, isDepleted: false, receivedAt: { seconds: 1 } },
    'stockLots/L2': { id: 'L2', productId: 'PD', branchId: DEST, costPerUnit: 20, qtyRemaining: 4, isDepleted: false, receivedAt: { seconds: 2 } },
    [`inventoryTransfers/${TID}`]: { id: TID, fromBranchId: ORIGIN, toBranchId: DEST, status: 'completed' },
    [`inventoryTransfers/${TID}/transferItems/I1`]: { productId: 'PD', productName: 'PD', sku: 'SKU-PD', transferQty: 10 },
    [`inventoryTransfers/${TID}/transferDiscrepancies/${DID}`]: {
      id: DID, transferId: TID, fromBranchId: ORIGIN, toBranchId: DEST, status: 'reported',
      reason: 'short', lines, reportedByBranchId: DEST, reportedByStaffId: 's-dest',
    },
  });
}

const call = (db: ReturnType<typeof makeDb>, auth: unknown, over: Partial<{ transferId: string; discrepancyId: string }> = {}) =>
  performResolveTransferDiscrepancy(
    db as never,
    { transferId: TID, discrepancyId: DID, adjustDate: '2026-06-09', staffName: 'Resolver', ...over },
    auth as never,
  );

const discDoc = (db: ReturnType<typeof makeDb>) => db.__store.get(`inventoryTransfers/${TID}/transferDiscrepancies/${DID}`)!;
const destStock = (db: ReturnType<typeof makeDb>) => db.__store.get('products/PD/productStocks/BR-DEST')!.totalStockBase;
const adjustments = (db: ReturnType<typeof makeDb>) =>
  [...db.__store.entries()].filter(([p]) => /^inventoryAdjustments\/[^/]+$/.test(p)).map(([, d]) => d);

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
  db = seedScenario();
});

describe('performResolveTransferDiscrepancy — authority (origin-only, server-side)', () => {
  test('unauthenticated is rejected', async () => {
    await expect(call(db, null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('missing ids are invalid-argument', async () => {
    await expect(call(db, origin, { transferId: '' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('DESTINATION branch cannot resolve (permission-denied, nothing mutated)', async () => {
    await expect(call(db, dest)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(discDoc(db).status).toBe('reported');
    expect(adjustments(db)).toHaveLength(0);
    expect(destStock(db)).toBe(10);
  });

  test('an unrelated branch cannot resolve', async () => {
    await expect(call(db, other)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(adjustments(db)).toHaveLength(0);
  });
});

describe('performResolveTransferDiscrepancy — origin resolution (FIFO, atomic)', () => {
  test('ORIGIN resolves a short receipt: dest stock corrected, oldest lot cut, disc resolved', async () => {
    const { adjustmentId } = await call(db, origin);

    // Adjustment created on the DESTINATION branch with origin-gating markers.
    const adj = db.__store.get(`inventoryAdjustments/${adjustmentId}`)!;
    expect(adj.branchId).toBe(DEST);
    expect(adj.refTransferId).toBe(TID);
    expect(adj.refDiscrepancyId).toBe(DID);
    expect(adj.status).toBe('completed');

    // Dest system stock reduced 10 → 8 (actual received).
    expect(destStock(db)).toBe(8);

    // FIFO: oldest dest lot (cost 10) cut by 2 → 4 remaining; newer untouched.
    expect(db.__store.get('stockLots/L1')!.qtyRemaining).toBe(4);
    expect(db.__store.get('stockLots/L2')!.qtyRemaining).toBe(4);

    // Discrepancy resolved with origin audit + adjustment link.
    const d = discDoc(db);
    expect(d.status).toBe('resolved');
    expect(d.resolvedByBranchId).toBe(ORIGIN);
    expect(d.resolutionAdjustmentId).toBe(adjustmentId);

    // An 'adjust' movement was recorded for -2.
    const moves = [...db.__store.entries()].filter(([p]) => p.startsWith('stockMovements/')).map(([, m]) => m);
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe('adjust');
    expect(moves[0].qty).toBe(-2);
  });

  test('an ADMIN (global ALL) may resolve even without explicit origin-branch membership', async () => {
    const { adjustmentId } = await call(db, admin);
    expect(db.__store.get(`inventoryAdjustments/${adjustmentId}`)!.branchId).toBe(DEST);
    expect(discDoc(db).status).toBe('resolved');
    expect(destStock(db)).toBe(8);
  });

  test('an OVER receipt creates a new dest lot at the standard cost and raises stock', async () => {
    db = seedScenario({
      productCost: 15,
      discLines: [{ productId: 'PD', productName: 'PD', sku: 'SKU-PD', expectedQty: 10, actualQty: 12, difference: 2 }],
    });
    const { adjustmentId } = await call(db, origin);
    expect(destStock(db)).toBe(12);
    const newLots = [...db.__store.entries()]
      .filter(([p]) => p.startsWith('stockLots/') && db.__store.get(p)!.receivingId === adjustmentId)
      .map(([, l]) => l);
    expect(newLots).toHaveLength(1);
    expect(newLots[0].qtyRemaining).toBe(2);
    expect(newLots[0].costPerUnit).toBe(15);
  });

  test('resolving twice is rejected (idempotent — no double correction)', async () => {
    await call(db, origin);
    await expect(call(db, origin)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(destStock(db)).toBe(8); // still 8, not 6
  });
});

describe('performResolveTransferDiscrepancy — identity validation (parent transfer = source of truth)', () => {
  const expectRejectNoWrites = async (auth: unknown) => {
    await expect(call(db, auth)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(discDoc(db).status).toBe('reported');
    expect(adjustments(db)).toHaveLength(0);
    expect(destStock(db)).toBe(10);
  };

  test('rejects a tampered toBranchId', async () => {
    discDoc(db).toBranchId = 'BR-EVIL';
    await expectRejectNoWrites(origin);
  });

  test('rejects a tampered fromBranchId', async () => {
    discDoc(db).fromBranchId = 'BR-EVIL';
    await expectRejectNoWrites(origin);
  });

  test('rejects a tampered transferId', async () => {
    discDoc(db).transferId = 'TR-OTHER';
    await expectRejectNoWrites(origin);
  });

  test('rejects a tampered reportedByBranchId', async () => {
    discDoc(db).reportedByBranchId = ORIGIN;
    await expectRejectNoWrites(origin);
  });

  test('rejects a tampered line difference (re-derived from the transfer item)', async () => {
    discDoc(db).lines = [{ productId: 'PD', productName: 'PD', sku: 'SKU-PD', expectedQty: 10, actualQty: 8, difference: 0 }];
    await expectRejectNoWrites(origin);
  });

  test('rejects a forged expectedQty that disagrees with the transfer item', async () => {
    discDoc(db).lines = [{ productId: 'PD', productName: 'PD', sku: 'SKU-PD', expectedQty: 8, actualQty: 8, difference: 0 }];
    await expectRejectNoWrites(origin);
  });

  test('rejects a line referencing a product not in the transfer', async () => {
    discDoc(db).lines = [{ productId: 'GHOST', productName: 'G', sku: 'G', expectedQty: 10, actualQty: 8, difference: -2 }];
    await expectRejectNoWrites(origin);
  });

  test('rejects an already-resolved discrepancy', async () => {
    discDoc(db).status = 'resolved';
    await expect(call(db, origin)).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('rejects a zero-difference (no real discrepancy) without writing stock', async () => {
    db = seedScenario({
      discLines: [{ productId: 'PD', productName: 'PD', sku: 'SKU-PD', expectedQty: 10, actualQty: 10, difference: 0 }],
    });
    await expect(call(db, origin)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(destStock(db)).toBe(10);
    expect(adjustments(db)).toHaveLength(0);
  });
});
