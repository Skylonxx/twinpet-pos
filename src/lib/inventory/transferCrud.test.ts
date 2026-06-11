import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  confirmBranchTransfer,
  cancelBranchTransfer,
  reportTransferDiscrepancy,
} from './transferCrud';
import { devConfirmBranchTransfer, devGetAllTransfers } from './transferDevMock';
import type { BranchTransferForm } from './transferTypes';
import {
  assertTransferReversalEvidenceCoversCompletion,
  type TransferReversalEvidence,
  type TransferReversalEvidenceInput,
} from './transferReversalEvidence';

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

  async function setDoc(ref: Ref, data: Record<string, unknown>) {
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) next[k] = resolveValue(v, undefined);
    store.set(ref.path, next);
  }

  async function updateDoc(ref: Ref, data: Record<string, unknown>) {
    const existing = store.get(ref.path);
    const base: Record<string, unknown> = existing ? { ...existing } : {};
    for (const [k, v] of Object.entries(data)) base[k] = resolveValue(v, existing?.[k]);
    store.set(ref.path, base);
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
    setDoc,
    updateDoc,
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
    transferDiscrepancies: 'transferDiscrepancies',
    inventoryAdjustments: 'inventoryAdjustments',
    adjustmentItems: 'adjustmentItems',
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
  setDoc: fb.setDoc,
  updateDoc: fb.updateDoc,
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

describe('Origin-Controlled Discrepancy Handling (7B-2)', () => {
  // Shared scenario: SRC ships 10 of PD (FIFO 6@10 @t1000 + 4@20 @t2000) → DEST.
  async function makeTransfer() {
    seedProduct('PD', 10);
    seedStock('PD', BRANCH_SRC, 20);
    seedStock('PD', BRANCH_DEST, 0);
    seedLot('PD', BRANCH_SRC, 6, 10, 1000); // older
    seedLot('PD', BRANCH_SRC, 14, 20, 2000); // newer
    const form: BranchTransferForm = {
      fromBranchId: BRANCH_SRC,
      toBranchId: BRANCH_DEST,
      transferDate: '2026-06-09',
      note: 'disc base',
      staffId: 's-src',
      staffName: 'Origin Staff',
    };
    const transferId = await confirmBranchTransfer(form, [
      { productId: 'PD', name: 'PD', sku: 'SKU-PD', sourceStock: 20, transferQty: 10 },
    ]);
    return transferId;
  }

  const discrepancies = (transferId: string) =>
    fb.docsUnder(`inventoryTransfers/${transferId}/transferDiscrepancies`) as any[];

  test('Destination can flag/report a discrepancy as metadata WITHOUT mutating stock', async () => {
    const transferId = await makeTransfer();
    const destStockBefore = fb.get(`products/PD/productStocks/${BRANCH_DEST}`)?.totalStockBase;
    const lotsBefore = JSON.stringify(fb.lots());

    const discId = await reportTransferDiscrepancy({
      transferId,
      branchId: BRANCH_DEST, // destination reports
      staffId: 's-dest',
      staffName: 'Dest Staff',
      reason: 'received short by 2',
      lines: [{ productId: 'PD', actualQty: 8 }],
    });

    const recs = discrepancies(transferId);
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe(discId);
    expect(recs[0].status).toBe('reported');
    expect(recs[0].reportedByBranchId).toBe(BRANCH_DEST);
    expect(recs[0].fromBranchId).toBe(BRANCH_SRC);
    expect(recs[0].toBranchId).toBe(BRANCH_DEST);
    expect(recs[0].lines).toHaveLength(1);
    expect(recs[0].lines[0].expectedQty).toBe(10);
    expect(recs[0].lines[0].actualQty).toBe(8);
    expect(recs[0].lines[0].difference).toBe(-2);

    // Metadata-only: NO stock or lot mutation occurred.
    expect(fb.get(`products/PD/productStocks/${BRANCH_DEST}`)?.totalStockBase).toBe(destStockBefore);
    expect(JSON.stringify(fb.lots())).toBe(lotsBefore);
  });

  test('Destination cannot hide a discrepancy: reporting never rewrites received qty or stock', async () => {
    const transferId = await makeTransfer();
    const itemsBefore = fb.docsUnder(`inventoryTransfers/${transferId}/transferItems`) as any[];
    const transferQtyBefore = itemsBefore[0].transferQty;

    await reportTransferDiscrepancy({
      transferId,
      branchId: BRANCH_DEST,
      staffId: 's-dest',
      staffName: 'Dest Staff',
      reason: 'short',
      lines: [{ productId: 'PD', actualQty: 8 }],
    });

    // The shipped (expected) quantity on the transfer item is immutable …
    const itemsAfter = fb.docsUnder(`inventoryTransfers/${transferId}/transferItems`) as any[];
    expect(itemsAfter[0].transferQty).toBe(transferQtyBefore);
    expect(itemsAfter[0].transferQty).toBe(10);
    // … and destination system stock still reflects the full shipped qty until
    // the ORIGIN resolves — the destination cannot absorb the difference itself.
    expect(fb.get(`products/PD/productStocks/${BRANCH_DEST}`)?.totalStockBase).toBe(10);
  });

  test('Origin branch cannot REPORT a discrepancy (only the destination can)', async () => {
    const transferId = await makeTransfer();
    await expect(
      reportTransferDiscrepancy({
        transferId,
        branchId: BRANCH_SRC, // origin trying to report
        staffId: 's-src',
        staffName: 'Origin Staff',
        reason: 'x',
        lines: [{ productId: 'PD', actualQty: 8 }],
      }),
    ).rejects.toThrow(/สาขาปลายทาง/);
    expect(discrepancies(transferId)).toHaveLength(0);
  });

  test('No-discrepancy report: equal quantity records zero difference and mutates no stock', async () => {
    const transferId = await makeTransfer();
    await reportTransferDiscrepancy({
      transferId,
      branchId: BRANCH_DEST,
      staffId: 's-dest',
      staffName: 'Dest Staff',
      reason: 'count confirm',
      lines: [{ productId: 'PD', actualQty: 10 }], // matches expected
    });
    expect(discrepancies(transferId)[0].lines[0].difference).toBe(0);
    // Reporting is metadata-only — it never touches stock or creates an adjustment.
    expect(fb.get(`products/PD/productStocks/${BRANCH_DEST}`)?.totalStockBase).toBe(10);
    expect(fb.docsUnder('inventoryAdjustments')).toHaveLength(0);
  });

  // NOTE: discrepancy RESOLUTION is server-authoritative (Phase 7B-2 blocker-fix).
  // The stock correction, origin-only authority, and identity validation against
  // the parent transfer are covered by the Cloud Function unit tests in
  // functions/src/resolveTransferDiscrepancy.test.ts; the thin client→CF caller by
  // ./resolveTransferDiscrepancy.test.ts; and the Firestore-rules denial of any
  // client-side resolution by rules-tests/transfer-discrepancy-phase7b2.spec.ts.
});

// ─── Phase 7B-H6-E1: transfer creation stamps `updatedAt` ─────────────────────
// Closes the stale-client timestamp gap: a freshly completed transfer must carry an
// `updatedAt` so (a) the H4/H6-C server stale-client guard has an authoritative
// baseline to compare against, and (b) the H6-D2 client capture
// (`observedDocumentUpdatedAt`) is reliably populated for new transfers.
describe('H6-E1: transfer completion stamps updatedAt', () => {
  /** A Firestore Timestamp-compatible value exposes `toDate()` or numeric `seconds`. */
  function isTimestampLike(v: unknown): boolean {
    if (!v || typeof v !== 'object') return false;
    const o = v as { toDate?: unknown; seconds?: unknown };
    return typeof o.toDate === 'function' || typeof o.seconds === 'number';
  }

  test('production confirmBranchTransfer stamps updatedAt alongside (and without disturbing) createdAt', async () => {
    seedProduct('PE', 10);
    seedStock('PE', BRANCH_SRC, 20);
    seedStock('PE', BRANCH_DEST, 0);
    seedLot('PE', BRANCH_SRC, 20, 10, 1000);

    const form: BranchTransferForm = {
      fromBranchId: BRANCH_SRC,
      toBranchId: BRANCH_DEST,
      transferDate: '2026-06-09',
      note: 'ts test',
      staffId: 's1',
      staffName: 'Staff',
    };
    const transferId = await confirmBranchTransfer(form, [
      { productId: 'PE', name: 'PE', sku: 'SKU-PE', sourceStock: 20, transferQty: 5 },
    ]);

    const header = fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown> | undefined;
    expect(header).toBeDefined();
    expect(header!.status).toBe('completed');
    // createdAt behavior remains intact …
    expect(header!.createdAt).toBeDefined();
    expect(isTimestampLike(header!.createdAt)).toBe(true);
    // … and H6-E1 now stamps a timestamp-compatible updatedAt at completion.
    expect(header!.updatedAt).toBeDefined();
    expect(isTimestampLike(header!.updatedAt)).toBe(true);
  });

  test('dev/mock devConfirmBranchTransfer mirrors the production updatedAt shape', () => {
    const form: BranchTransferForm = {
      fromBranchId: 'DEV-A',
      toBranchId: 'DEV-B',
      transferDate: '2026-06-09',
      note: 'dev ts',
      staffId: 's1',
      staffName: 'Staff',
    };
    const id = devConfirmBranchTransfer(form, [
      { productId: '1', name: 'Dev P1', sku: 'SKU001', sourceStock: 98, transferQty: 5 },
    ]);

    const doc = devGetAllTransfers().find((t) => t.id === id);
    expect(doc).toBeDefined();
    expect(doc!.status).toBe('completed');
    expect(doc!.createdAt).toBeDefined(); // createdAt intact
    expect(doc!.updatedAt).toBeDefined(); // H6-E1 updatedAt present
    expect(isTimestampLike(doc!.updatedAt)).toBe(true);
  });
});

// ─── Phase 7B-H6-E2-B: reversalEvidence written at transfer completion ─────────
// Verifies that confirmBranchTransfer and devConfirmBranchTransfer both persist a
// valid TransferReversalEvidence snapshot on the transfer header, atomically with
// the rest of the write. The evidence must: be schema-valid; carry correct branch
// IDs, itemCount, and totalQtyBase; produce no undefined values (Firestore safety);
// and pass the completeness invariant against the input that produced it.
describe('H6-E2-B: write reversalEvidence at transfer completion', () => {
  /** Returns true if no value in the object tree is strictly undefined. */
  function containsNoUndefined(obj: unknown): boolean {
    if (obj === undefined) return false;
    if (obj === null || typeof obj !== 'object') return true;
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (!containsNoUndefined(v)) return false;
    }
    return true;
  }

  const FORM_BASE: BranchTransferForm = {
    fromBranchId: BRANCH_SRC,
    toBranchId: BRANCH_DEST,
    transferDate: '2026-06-11',
    note: 'evidence test',
    staffId: 'staff-ev',
    staffName: 'Evidence Tester',
  };

  test('1. production confirmBranchTransfer writes reversalEvidence to the transfer header', async () => {
    seedProduct('EV1', 10);
    seedStock('EV1', BRANCH_SRC, 20);
    seedStock('EV1', BRANCH_DEST, 0);
    seedLot('EV1', BRANCH_SRC, 20, 10, 1000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV1', name: 'EV1', sku: 'SKU-EV1', sourceStock: 20, transferQty: 7 },
    ]);

    const header = fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown> | undefined;
    expect(header).toBeDefined();
    expect(header!.reversalEvidence).toBeDefined();
  });

  test('2. evidence has correct schema fields (version, source, branches, itemCount, totalQtyBase, effects, createdAt, createdBy)', async () => {
    seedProduct('EV2', 10);
    seedStock('EV2', BRANCH_SRC, 30);
    seedStock('EV2', BRANCH_DEST, 0);
    seedLot('EV2', BRANCH_SRC, 30, 10, 1000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV2', name: 'EV2', sku: 'SKU-EV2', sourceStock: 30, transferQty: 9 },
    ]);

    const ev = (fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown>)
      .reversalEvidence as TransferReversalEvidence;

    expect(ev.version).toBe(1);
    expect(ev.source).toBe('transfer_completion');
    expect(ev.fromBranchId).toBe(BRANCH_SRC);
    expect(ev.toBranchId).toBe(BRANCH_DEST);
    expect(ev.itemCount).toBe(1);
    expect(ev.totalQtyBase).toBe(9);
    expect(Array.isArray(ev.effects)).toBe(true);
    expect(ev.effects.length).toBe(2); // one dest_gain + one source_loss
    expect(typeof ev.createdAt).toBe('string');
    expect(ev.createdBy).toBe('staff-ev');
  });

  test('3. evidence effects carry correct branch IDs and directions', async () => {
    seedProduct('EV3', 10);
    seedStock('EV3', BRANCH_SRC, 25);
    seedStock('EV3', BRANCH_DEST, 0);
    seedLot('EV3', BRANCH_SRC, 25, 10, 1000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV3', name: 'EV3', sku: 'SKU-EV3', sourceStock: 25, transferQty: 6 },
    ]);

    const ev = (fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown>)
      .reversalEvidence as TransferReversalEvidence;

    const destGain = ev.effects.find((e) => e.direction === 'dest_gain');
    const sourceLoss = ev.effects.find((e) => e.direction === 'source_loss');

    expect(destGain).toBeDefined();
    expect(sourceLoss).toBeDefined();
    expect(destGain!.branchId).toBe(BRANCH_DEST);
    expect(sourceLoss!.branchId).toBe(BRANCH_SRC);
    expect(destGain!.qtyBase).toBe(6);
    expect(sourceLoss!.qtyBase).toBe(6);
    expect(destGain!.productId).toBe('EV3');
    expect(sourceLoss!.productId).toBe('EV3');
  });

  test('4. evidence passes assertTransferReversalEvidenceCoversCompletion', async () => {
    seedProduct('EV4', 10);
    seedStock('EV4', BRANCH_SRC, 20);
    seedStock('EV4', BRANCH_DEST, 0);
    seedLot('EV4', BRANCH_SRC, 20, 10, 1000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV4', name: 'EV4', sku: 'SKU-EV4', sourceStock: 20, transferQty: 4 },
    ]);

    const ev = (fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown>)
      .reversalEvidence as TransferReversalEvidence;

    // Reconstruct a compatible input from the persisted evidence to re-run the invariant.
    const assertInput: TransferReversalEvidenceInput = {
      fromBranchId: ev.fromBranchId,
      toBranchId: ev.toBranchId,
      items: [{ productId: 'EV4', transferQty: 4 }],
      createdAt: ev.createdAt,
      createdBy: ev.createdBy,
    };
    expect(() => assertTransferReversalEvidenceCoversCompletion(assertInput, ev)).not.toThrow();
  });

  test('5. evidence contains no undefined values (Firestore serialization safety)', async () => {
    seedProduct('EV5', 10);
    seedStock('EV5', BRANCH_SRC, 20);
    seedStock('EV5', BRANCH_DEST, 0);
    seedLot('EV5', BRANCH_SRC, 20, 10, 1000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV5', name: 'EV5', sku: 'SKU-EV5', sourceStock: 20, transferQty: 3 },
    ]);

    const ev = (fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown>)
      .reversalEvidence as TransferReversalEvidence;

    expect(containsNoUndefined(ev)).toBe(true);
  });

  test('6. multi-item transfer produces itemCount and totalQtyBase covering all lines', async () => {
    seedProduct('EV6A', 10);
    seedProduct('EV6B', 10);
    seedStock('EV6A', BRANCH_SRC, 20);
    seedStock('EV6B', BRANCH_SRC, 20);
    seedStock('EV6A', BRANCH_DEST, 0);
    seedStock('EV6B', BRANCH_DEST, 0);
    seedLot('EV6A', BRANCH_SRC, 20, 10, 1000);
    seedLot('EV6B', BRANCH_SRC, 20, 10, 2000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV6A', name: 'EV6A', sku: 'SKU-EV6A', sourceStock: 20, transferQty: 5 },
      { productId: 'EV6B', name: 'EV6B', sku: 'SKU-EV6B', sourceStock: 20, transferQty: 8 },
    ]);

    const ev = (fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown>)
      .reversalEvidence as TransferReversalEvidence;

    expect(ev.itemCount).toBe(2);
    expect(ev.totalQtyBase).toBe(13); // 5 + 8
    expect(ev.effects.length).toBe(4); // 2 products × 2 directions
  });

  test('7. dev mock devConfirmBranchTransfer writes equivalent reversalEvidence', () => {
    const id = devConfirmBranchTransfer(
      { fromBranchId: 'DEV-SRC', toBranchId: 'DEV-DST', transferDate: '2026-06-11',
        note: 'dev ev', staffId: 'dev-staff', staffName: 'Dev Staff' },
      [{ productId: '1', name: 'Dev P1', sku: 'SKU001', sourceStock: 98, transferQty: 10 }],
    );

    const transfer = devGetAllTransfers().find((t) => t.id === id)!;
    const ev = transfer.reversalEvidence!;

    expect(ev).toBeDefined();
    expect(ev.version).toBe(1);
    expect(ev.source).toBe('transfer_completion');
    expect(ev.fromBranchId).toBe('DEV-SRC');
    expect(ev.toBranchId).toBe('DEV-DST');
    expect(ev.itemCount).toBe(1);
    expect(ev.totalQtyBase).toBe(10);
    expect(ev.effects.length).toBe(2);
    expect(typeof ev.createdAt).toBe('string');
    expect(ev.createdBy).toBe('dev-staff');
    expect(containsNoUndefined(ev)).toBe(true);
  });

  test('8. existing createdAt and updatedAt behaviour is not disturbed by evidence write', async () => {
    seedProduct('EV8', 10);
    seedStock('EV8', BRANCH_SRC, 20);
    seedStock('EV8', BRANCH_DEST, 0);
    seedLot('EV8', BRANCH_SRC, 20, 10, 1000);

    const transferId = await confirmBranchTransfer(FORM_BASE, [
      { productId: 'EV8', name: 'EV8', sku: 'SKU-EV8', sourceStock: 20, transferQty: 2 },
    ]);

    const header = fb.get(`inventoryTransfers/${transferId}`) as Record<string, unknown>;
    // H6-E1 timestamps remain present and well-formed.
    expect(header.createdAt).toBeDefined();
    expect(header.updatedAt).toBeDefined();
    expect(header.status).toBe('completed');
    // Evidence is additional — createdAt in evidence is a string, not a timestamp.
    const ev = header.reversalEvidence as TransferReversalEvidence;
    expect(typeof ev.createdAt).toBe('string');
  });
});
