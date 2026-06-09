import { describe, test, expect, beforeEach, vi } from 'vitest';
import { confirmBranchTransfer, cancelBranchTransfer } from './transferCrud';
import type { BranchTransferForm } from './transferTypes';

// vi.hoisted runs before the (hoisted) vi.mock factories
const fb = vi.hoisted(() => {
  type Ref = { __ref: true; path: string; id: string };
  type Col = { __col: true; path: string };

  const FIRESTORE = { __firestore: true } as const;
  const store = new Map<string, Record<string, unknown>>();
  let idSeq = 0;
  const genId = () => `auto-${++idSeq}`;
  const idFromPath = (path: string) => path.slice(path.lastIndexOf('/') + 1);

  const makeTs = (ms: number) => ({
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
    toDate: () => new Date(ms),
  });

  const tsToMs = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') {
      const o = v as { toDate?: () => Date; seconds?: number };
      if (typeof o.toDate === 'function') return o.toDate().getTime();
      if (typeof o.seconds === 'number') return o.seconds * 1000;
    }
    return 0;
  };

  const isFirestore = (v: unknown): v is typeof FIRESTORE =>
    !!v && (v as { __firestore?: boolean }).__firestore === true;
  const isCol = (v: unknown): v is Col =>
    !!v && (v as { __col?: boolean }).__col === true;

  function doc(parent: unknown, ...segs: string[]): Ref {
    if (isFirestore(parent)) {
      const path = segs.join('/');
      return { __ref: true, path, id: segs[segs.length - 1]! };
    }
    if (isCol(parent)) {
      const id = segs[0] ?? genId();
      return { __ref: true, path: `${parent.path}/${id}`, id };
    }
    throw new Error('doc(): unexpected parent');
  }

  function collection(parent: unknown, name: string): Col {
    if (isFirestore(parent)) return { __col: true, path: name };
    if ((parent as { __ref?: boolean })?.__ref) {
      return { __col: true, path: `${(parent as Ref).path}/${name}` };
    }
    throw new Error('collection(): unexpected parent');
  }

  const increment = (n: number) => ({ __inc: n });
  const serverTimestamp = () => ({ __serverTs: true });
  const Timestamp = { now: () => makeTs(Date.now()), fromMillis: (ms: number) => makeTs(ms) };

  function resolveValue(v: unknown, existing: unknown): unknown {
    if (v && typeof v === 'object') {
      if ('__inc' in v) return (typeof existing === 'number' ? existing : 0) + (v as { __inc: number }).__inc;
      if ('__serverTs' in v) return makeTs(Date.now());
    }
    return v;
  }

  type Write =
    | { op: 'set'; ref: Ref; data: Record<string, unknown>; merge: boolean }
    | { op: 'update'; ref: Ref; data: Record<string, unknown> };

  async function runTransaction<T>(
    _fs: unknown,
    fn: (tx: {
      get: (ref: Ref) => Promise<{ id: string; exists: () => boolean; data: () => Record<string, unknown> | undefined }>;
      set: (ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) => void;
      update: (ref: Ref, data: Record<string, unknown>) => void;
    }) => Promise<T>,
  ): Promise<T> {
    const writes: Write[] = [];
    const tx = {
      async get(ref: Ref) {
        const data = store.get(ref.path);
        return { id: ref.id, exists: () => data !== undefined, data: () => data };
      },
      set(ref: Ref, data: Record<string, unknown>, opts?: { merge?: boolean }) {
        writes.push({ op: 'set', ref, data, merge: !!opts?.merge });
      },
      update(ref: Ref, data: Record<string, unknown>) {
        writes.push({ op: 'update', ref, data });
      },
    };

    const result = await fn(tx);

    for (const w of writes) {
      const existing = store.get(w.ref.path);
      if (w.op === 'set' && !w.merge) {
        const next: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(w.data)) next[k] = resolveValue(v, undefined);
        store.set(w.ref.path, next);
      } else {
        const base: Record<string, unknown> = existing ? { ...existing } : {};
        for (const [k, v] of Object.entries(w.data)) base[k] = resolveValue(v, existing?.[k]);
        store.set(w.ref.path, base);
      }
    }
    return result;
  }

  const query = (col: Col, ...constraints: unknown[]) => ({ __query: true, path: col.path, constraints });
  const where = (field: string, op: string, value: unknown) => ({ type: 'where', field, op, value });
  const orderBy = (field: string, dir: 'asc' | 'desc' = 'asc') => ({ type: 'orderBy', field, dir });

  async function getDocs(q: { path: string; constraints: unknown[] }) {
    const colPath = q.path;
    let rows = [...store.entries()]
      .filter(([path]) => path.startsWith(`${colPath}/`) && !path.slice(colPath.length + 1).includes('/'))
      .map(([path, data]) => ({ path, data }));

    for (const c of (q.constraints || []) as Array<{ type: string; field: string; op?: string; value?: unknown; dir?: string }>) {
      if (c.type === 'where' && c.op === '==') {
        rows = rows.filter((r) => r.data[c.field] === c.value);
      }
    }
    const ob = ((q.constraints || []) as Array<{ type: string; field: string; dir?: string }>).find((c) => c.type === 'orderBy');
    if (ob) {
      rows.sort((a, b) => {
        const av = tsToMs(a.data[ob.field]);
        const bv = tsToMs(b.data[ob.field]);
        return ob.dir === 'desc' ? bv - av : av - bv;
      });
    }
    return {
      docs: rows.map((r) => ({
        id: idFromPath(r.path),
        ref: { __ref: true, path: r.path, id: idFromPath(r.path) } as Ref,
        exists: () => true,
        data: () => r.data,
      })),
    };
  }

  async function getDoc(ref: Ref) {
    const data = store.get(ref.path);
    return { id: ref.id, exists: () => data !== undefined, data: () => data };
  }

  const reset = () => {
    store.clear();
    idSeq = 0;
  };
  const seed = (path: string, data: Record<string, unknown>) => store.set(path, { ...data });
  const get = (path: string) => store.get(path);
  const docsUnder = (colPath: string) =>
    [...store.entries()]
      .filter(([path]) => path.startsWith(`${colPath}/`) && !path.slice(colPath.length + 1).includes('/'))
      .map(([, data]) => data);
  const lots = () => docsUnder('stockLots');

  return {
    FIRESTORE,
    doc,
    collection,
    increment,
    serverTimestamp,
    Timestamp,
    runTransaction,
    getDocs,
    getDoc,
    query,
    where,
    orderBy,
    makeTs,
    reset,
    seed,
    get,
    docsUnder,
    lots,
  };
});

vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: fb.FIRESTORE,
  collections: {
    branches: 'branches',
    users: 'users',
    products: 'products',
    productStocks: 'productStocks',
    stockLots: 'stockLots',
    stockMovements: 'stockMovements',
    inventoryTransfers: 'inventoryTransfers',
    transferItems: 'transferItems',
  },
}));

vi.mock('firebase/firestore', () => ({
  collection: fb.collection,
  doc: fb.doc,
  increment: fb.increment,
  serverTimestamp: fb.serverTimestamp,
  runTransaction: fb.runTransaction,
  getDocs: fb.getDocs,
  getDoc: fb.getDoc,
  query: fb.query,
  where: fb.where,
  orderBy: fb.orderBy,
  Timestamp: fb.Timestamp,
}));

const BRANCH_SRC = 'branch-src';
const BRANCH_DEST = 'branch-dest';

function seedProduct(id: string, avgCost: number) {
  fb.seed(`products/${id}`, { id, name: id, sku: `SKU-${id}`, avgCost, allowNegativeStock: false });
}

function seedStock(productId: string, branchId: string, totalStockBase: number) {
  fb.seed(`products/${productId}/productStocks/${branchId}`, { branchId, totalStockBase });
}

let lotSeq = 0;
function seedLot(productId: string, branchId: string, qty: number, cost: number, receivedAtMs: number): string {
  const id = `LOT-${++lotSeq}`;
  fb.seed(`stockLots/${id}`, {
    id,
    productId,
    branchId,
    receivingId: 'seed',
    costPerUnit: cost,
    qtyReceived: qty,
    qtyRemaining: qty,
    receivedAt: fb.makeTs(receivedAtMs),
    isDepleted: false,
    isGhost: false,
  });
  return id;
}

/** Read a stored lot's receivedAt back to epoch ms (matches the mock Timestamp shape). */
function receivedMs(lot: { receivedAt?: { toDate?: () => Date; seconds?: number } }): number {
  const v = lot.receivedAt;
  if (v && typeof v.toDate === 'function') return v.toDate().getTime();
  if (v && typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

beforeEach(() => {
  fb.reset();
  lotSeq = 0;
});

describe('Branch Transfer FIFO carry-over (7B-1)', () => {
  test('Transfer fully preserves multiple FIFO lots from source to dest without averaging', async () => {
    seedProduct('P1', 10);
    seedStock('P1', BRANCH_SRC, 20);
    seedStock('P1', BRANCH_DEST, 0);

    // Source has two lots with different costs
    seedLot('P1', BRANCH_SRC, 5, 10, 1000); // older lot, cost 10
    seedLot('P1', BRANCH_SRC, 15, 20, 2000); // newer lot, cost 20

    const form: BranchTransferForm = {
      fromBranchId: BRANCH_SRC,
      toBranchId: BRANCH_DEST,
      transferDate: '2026-06-09',
      note: 'test transfer',
      staffId: 's1',
      staffName: 'Staff',
    };

    // Transfer 10 items. Should take 5 from lot 1 (cost 10) and 5 from lot 2 (cost 20).
    const transferId = await confirmBranchTransfer(form, [
      { productId: 'P1', name: 'P1', sku: 'SKU-P1', sourceStock: 20, transferQty: 10 }
    ]);

    expect(fb.get(`products/P1/productStocks/${BRANCH_SRC}`)?.totalStockBase).toBe(10);
    expect(fb.get(`products/P1/productStocks/${BRANCH_DEST}`)?.totalStockBase).toBe(10);

    const items = fb.docsUnder(`inventoryTransfers/${transferId}/transferItems`) as any[];
    expect(items).toHaveLength(1);

    const sourceLots = items[0].sourceLotDetails;
    expect(sourceLots).toHaveLength(2);
    expect(sourceLots[0].costPerUnit).toBe(10);
    expect(sourceLots[0].qty).toBe(5);
    expect(sourceLots[1].costPerUnit).toBe(20);
    expect(sourceLots[1].qty).toBe(5);

    // Destination should receive exact cuts as separate new lots, NOT averaged
    const allLots = fb.lots() as any[];
    const destLots = allLots.filter(l => l.branchId === BRANCH_DEST);
    expect(destLots).toHaveLength(2);

    // Sort dest lots by receivedAt or cost just for matching
    destLots.sort((a, b) => a.costPerUnit - b.costPerUnit);

    expect(destLots[0].costPerUnit).toBe(10);
    expect(destLots[0].qtyRemaining).toBe(5);
    expect(destLots[0].receivingId).toBe(transferId);

    expect(destLots[1].costPerUnit).toBe(20);
    expect(destLots[1].qtyRemaining).toBe(5);
    expect(destLots[1].receivingId).toBe(transferId);
  });

  test('Cancel transfer restores original cost basis perfectly to source branch', async () => {
    seedProduct('P2', 15);
    seedStock('P2', BRANCH_SRC, 5);
    seedStock('P2', BRANCH_DEST, 0);

    seedLot('P2', BRANCH_SRC, 5, 25, 1000);

    const form: BranchTransferForm = {
      fromBranchId: BRANCH_SRC,
      toBranchId: BRANCH_DEST,
      transferDate: '2026-06-09',
      note: '',
      staffId: 's1',
      staffName: 'Staff',
    };

    const transferId = await confirmBranchTransfer(form, [
      { productId: 'P2', name: 'P2', sku: 'SKU-P2', sourceStock: 5, transferQty: 5 }
    ]);

    // Now dest has the lot at cost 25.
    await cancelBranchTransfer({
      transferId,
      staffId: 's1',
      staffName: 'Staff',
      reason: 'wrong item'
    });

    expect(fb.get(`products/P2/productStocks/${BRANCH_SRC}`)?.totalStockBase).toBe(5);
    expect(fb.get(`products/P2/productStocks/${BRANCH_DEST}`)?.totalStockBase).toBe(0);

    // Dest lot is depleted
    const allLots = fb.lots() as any[];
    const destLots = allLots.filter(l => l.branchId === BRANCH_DEST && l.qtyRemaining > 0);
    expect(destLots).toHaveLength(0); // empty

    // Source lot is recreated perfectly at original cost 25
    const srcLots = allLots.filter(l => l.branchId === BRANCH_SRC && l.qtyRemaining > 0);
    expect(srcLots).toHaveLength(1);
    expect(srcLots[0].costPerUnit).toBe(25);
    expect(srcLots[0].qtyRemaining).toBe(5);
    expect(srcLots[0].receivingId).toBe(transferId); // new lot, sourced back to the transfer!
  });

  test('Destination lots inherit ORIGINAL source receivedAt, not the transfer arrival time', async () => {
    seedProduct('P3', 10);
    seedStock('P3', BRANCH_SRC, 20);
    seedStock('P3', BRANCH_DEST, 0);

    const OLDER = 1000; // original receipt time of the older lot
    const NEWER = 2000; // original receipt time of the newer lot
    seedLot('P3', BRANCH_SRC, 5, 10, OLDER); // older lot, cost A=10
    seedLot('P3', BRANCH_SRC, 15, 20, NEWER); // newer lot, cost B=20

    const before = Date.now();
    const form: BranchTransferForm = {
      fromBranchId: BRANCH_SRC,
      toBranchId: BRANCH_DEST,
      transferDate: '2026-06-09',
      note: 'chronology',
      staffId: 's1',
      staffName: 'Staff',
    };

    // Transfer at a much later moment (Date.now() ≫ OLDER/NEWER).
    const transferId = await confirmBranchTransfer(form, [
      { productId: 'P3', name: 'P3', sku: 'SKU-P3', sourceStock: 20, transferQty: 10 },
    ]);

    const allLots = fb.lots() as any[];
    const destLots = allLots.filter((l) => l.branchId === BRANCH_DEST);
    expect(destLots).toHaveLength(2);
    destLots.sort((a, b) => a.costPerUnit - b.costPerUnit);

    // Exact cost carry-over preserved …
    expect(destLots[0].costPerUnit).toBe(10);
    expect(destLots[0].qtyRemaining).toBe(5);
    expect(destLots[1].costPerUnit).toBe(20);
    expect(destLots[1].qtyRemaining).toBe(5);

    // … AND the original source receipt chronology is inherited.
    expect(receivedMs(destLots[0])).toBe(OLDER);
    expect(receivedMs(destLots[1])).toBe(NEWER);

    // Hard guard: dest FIFO key must NOT be the transfer arrival time.
    expect(receivedMs(destLots[0])).toBeLessThan(before);
    expect(receivedMs(destLots[1])).toBeLessThan(before);

    // The persisted item detail carries the chronology key for cancel restore.
    const items = fb.docsUnder(`inventoryTransfers/${transferId}/transferItems`) as any[];
    const details = items[0].sourceLotDetails as any[];
    expect(details.map((d) => d.receivedAtMs).sort((a, b) => a - b)).toEqual([OLDER, NEWER]);
  });

  test('Destination FIFO depletion consumes the OLDEST original source receipt first', async () => {
    // Source: oldest lot (cost 10 @ t=1000) + newer lot (cost 20 @ t=5000).
    seedProduct('P4', 10);
    seedStock('P4', BRANCH_SRC, 10);
    // A pre-existing dest lot whose receipt time sits BETWEEN the two source
    // lots. If the dest used the transfer arrival time, this lot would be the
    // oldest and get consumed first; with inheritance, the source t=1000 wins.
    seedStock('P4', BRANCH_DEST, 5);
    seedLot('P4', BRANCH_DEST, 5, 99, 3000); // pre-existing dest lot, cost 99

    seedLot('P4', BRANCH_SRC, 5, 10, 1000); // oldest, cost 10
    seedLot('P4', BRANCH_SRC, 5, 20, 5000); // newest, cost 20

    const form: BranchTransferForm = {
      fromBranchId: BRANCH_SRC,
      toBranchId: BRANCH_DEST,
      transferDate: '2026-06-09',
      note: 'fill dest',
      staffId: 's1',
      staffName: 'Staff',
    };
    await confirmBranchTransfer(form, [
      { productId: 'P4', name: 'P4', sku: 'SKU-P4', sourceStock: 10, transferQty: 10 },
    ]);

    // Now deplete the destination by transferring 5 out to a third branch.
    const BRANCH_3 = 'branch-3';
    seedStock('P4', BRANCH_3, 0);
    const outId = await confirmBranchTransfer(
      {
        fromBranchId: BRANCH_DEST,
        toBranchId: BRANCH_3,
        transferDate: '2026-06-09',
        note: 'deplete',
        staffId: 's1',
        staffName: 'Staff',
      },
      [{ productId: 'P4', name: 'P4', sku: 'SKU-P4', sourceStock: 15, transferQty: 5 }],
    );

    // FIFO must consume the inherited oldest (t=1000, cost 10) first — proving
    // the dest ordering respects the original source receipt time, not arrival.
    const outItems = fb.docsUnder(`inventoryTransfers/${outId}/transferItems`) as any[];
    const cuts = outItems[0].sourceLotDetails as any[];
    expect(cuts).toHaveLength(1);
    expect(cuts[0].costPerUnit).toBe(10);
    expect(cuts[0].qty).toBe(5);
    expect(cuts[0].receivedAtMs).toBe(1000);
  });
});
