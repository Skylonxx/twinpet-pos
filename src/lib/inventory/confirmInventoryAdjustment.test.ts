import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { ConfirmInventoryAdjustmentInput } from './types';

// ─────────────────────────────────────────────────────────────────────────────
//  Automated tester for the Manual Stock Adjustment financial / inventory logic.
//
//  confirmInventoryAdjustment() is hard-wired to Firestore (runTransaction, doc,
//  collection, increment, serverTimestamp) and only exercises FIFO lot logic on
//  the *real* (non-dev) path. To test that path without a live Firestore, we
//  stand up a tiny in-memory Firestore fake and inject it via vi.mock() for both
//  the `../firebase` singletons and the `firebase/firestore` SDK primitives.
//
//  The fake is intentionally minimal — it implements exactly the surface the
//  adjustment + FIFO code touches: doc()/collection() ref building, a buffered
//  runTransaction (writes commit only on success, so a thrown line leaves the
//  store untouched — matching Firestore atomicity), field-value increment(),
//  serverTimestamp(), and a getDocs() that resolves the active-lots query.
// ─────────────────────────────────────────────────────────────────────────────

// vi.hoisted runs before the (hoisted) vi.mock factories, so the store and fake
// SDK functions exist when the mocks are wired up AND remain reachable from the
// test body for seeding / assertions.
const fb = vi.hoisted(() => {
  type Ref = { __ref: true; path: string; id: string };
  type Col = { __col: true; path: string };

  const FIRESTORE = { __firestore: true } as const;
  const store = new Map<string, Record<string, unknown>>();
  let idSeq = 0;
  const genId = () => `auto-${++idSeq}`;
  const idFromPath = (path: string) => path.slice(path.lastIndexOf('/') + 1);

  // Timestamp-like value compatible with fifo.ts#parseReceivedAtMs (reads .toDate
  // first, then .seconds). Carrying both keeps FIFO ordering deterministic.
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
  const Timestamp = { now: () => makeTs(Date.now()) };

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

    // If fn throws, we never reach the commit loop → store stays untouched.
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

  // Query primitives — only the active-lots query shape is exercised.
  const query = (col: Col, ...constraints: unknown[]) => ({ __query: true, path: col.path, constraints });
  const where = (field: string, op: string, value: unknown) => ({ type: 'where', field, op, value });
  const orderBy = (field: string, dir: 'asc' | 'desc' = 'asc') => ({ type: 'orderBy', field, dir });

  async function getDocs(q: { path: string; constraints: unknown[] }) {
    const colPath = q.path;
    let rows = [...store.entries()]
      .filter(([path]) => path.startsWith(`${colPath}/`) && !path.slice(colPath.length + 1).includes('/'))
      .map(([path, data]) => ({ path, data }));

    for (const c of q.constraints as Array<{ type: string; field: string; op?: string; value?: unknown; dir?: string }>) {
      if (c.type === 'where' && c.op === '==') {
        rows = rows.filter((r) => r.data[c.field] === c.value);
      }
    }
    const ob = (q.constraints as Array<{ type: string; field: string; dir?: string }>).find((c) => c.type === 'orderBy');
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

  // ── Test-only helpers (not part of the Firestore surface) ──
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

// Replace the firebase singletons so the SUT takes the real (Firestore) path and
// talks to our in-memory store instead of a live project.
vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: fb.FIRESTORE,
  collections: {
    branches: 'branches',
    users: 'users',
    products: 'products',
    categories: 'categories',
    productStocks: 'productStocks',
    stockLots: 'stockLots',
    stockMovements: 'stockMovements',
    customers: 'customers',
    orders: 'orders',
    orderItems: 'orderItems',
    payments: 'payments',
    receivings: 'receivings',
    receivingItems: 'receivingItems',
    inventoryAdjustments: 'inventoryAdjustments',
    adjustmentItems: 'adjustmentItems',
    creditAccounts: 'creditAccounts',
    creditTransactions: 'creditTransactions',
    shifts: 'shifts',
    settings: 'settings',
  },
}));

// Replace the Firestore SDK primitives with the in-memory fake.
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
  // Harmless stubs for names imported transitively (never called on this path).
  writeBatch: () => ({ set() {}, update() {}, delete() {}, commit: async () => {} }),
  setDoc: async () => {},
  updateDoc: async () => {},
  deleteDoc: async () => {},
  addDoc: async () => ({}),
  onSnapshot: () => () => {},
  limit: () => ({}),
  startAfter: () => ({}),
  getCountFromServer: async () => ({ data: () => ({ count: 0 }) }),
  arrayUnion: (...a: unknown[]) => ({ __arrayUnion: a }),
  arrayRemove: (...a: unknown[]) => ({ __arrayRemove: a }),
  deleteField: () => ({ __deleteField: true }),
}));

// Imported AFTER the mocks are declared (vi.mock is hoisted above imports anyway).
const { confirmInventoryAdjustment } = await import('./confirmInventoryAdjustment');

// ─── Fixtures ──────────────────────────────────────────────────────────────
const BRANCH = 'branch-1';

function seedProduct(
  id: string,
  fields: { cost?: number; avgCost?: number; allowNegativeStock?: boolean },
) {
  fb.seed(`products/${id}`, {
    id,
    name: id,
    sku: `SKU-${id}`,
    cost: fields.cost ?? 0,
    avgCost: fields.avgCost ?? 0,
    allowNegativeStock: fields.allowNegativeStock ?? false,
  });
}

function seedStock(productId: string, totalStockBase: number) {
  fb.seed(`products/${productId}/productStocks/${BRANCH}`, { branchId: BRANCH, totalStockBase });
}

let lotSeq = 0;
function seedLot(
  productId: string,
  fields: { qtyRemaining: number; costPerUnit: number; receivedAtMs: number },
): string {
  const id = `LOT-${++lotSeq}`;
  fb.seed(`stockLots/${id}`, {
    id,
    productId,
    branchId: BRANCH,
    receivingId: 'seed',
    costPerUnit: fields.costPerUnit,
    qtyReceived: fields.qtyRemaining,
    qtyRemaining: fields.qtyRemaining,
    receivedAt: fb.makeTs(fields.receivedAtMs),
    expiryDate: null,
    isDepleted: false,
    isGhost: false,
  });
  return id;
}

function makeInput(
  lines: ConfirmInventoryAdjustmentInput['lines'],
  reason: ConfirmInventoryAdjustmentInput['reason'] = 'ตรวจนับสต็อก',
): ConfirmInventoryAdjustmentInput {
  return {
    branchId: BRANCH,
    staffId: 'staff-1',
    staffName: 'Tester',
    adjustDate: '2026-05-31',
    reason,
    note: '  note  ',
    lines,
  };
}

const lotsFor = (productId: string) => fb.lots().filter((l) => l.productId === productId);
const adjItems = (adjId: string) => fb.docsUnder(`inventoryAdjustments/${adjId}/adjustmentItems`);

beforeEach(() => {
  fb.reset();
  lotSeq = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('confirmInventoryAdjustment — FIFO lot + financial logic', () => {
  // ── Case 1: Adjust UP (surplus) ────────────────────────────────────────────
  describe('Case 1 — Adjust UP (surplus) creates a new lot at product.cost', () => {
    test('new lot uses product.cost (NOT avgCost) and stock increments', async () => {
      seedProduct('P1', { cost: 25, avgCost: 10 });
      seedStock('P1', 5);

      const adjId = await confirmInventoryAdjustment(
        makeInput(
          [{ productId: 'P1', name: 'Premium Food', sku: 'SKU-P1', currentStock: 5, adjustQty: 10 }],
          'รับเข้าเพิ่มเติม',
        ),
      );

      const newLots = lotsFor('P1');
      expect(newLots).toHaveLength(1);
      const lot = newLots[0]!;
      expect(lot.costPerUnit).toBe(25); // product.cost wins over avgCost(10)
      expect(lot.qtyReceived).toBe(10);
      expect(lot.qtyRemaining).toBe(10);
      expect(lot.isDepleted).toBe(false);
      expect(lot.receivingId).toBe(adjId); // lot is sourced to this adjustment

      // Stock advanced by the full +10.
      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(15);

      // Ledger line valued at the inbound cost.
      const items = adjItems(adjId);
      expect(items).toHaveLength(1);
      expect(items[0]!.unitCost).toBe(25);
      expect(items[0]!.valueImpact).toBe(250); // +10 * 25
    });

    test('falls back to avgCost when product.cost is 0', async () => {
      seedProduct('P2', { cost: 0, avgCost: 12 });
      seedStock('P2', 0);

      const adjId = await confirmInventoryAdjustment(
        makeInput([{ productId: 'P2', name: 'X', sku: 'SKU-P2', currentStock: 0, adjustQty: 4 }]),
      );

      expect(lotsFor('P2')[0]!.costPerUnit).toBe(12);
      expect(adjItems(adjId)[0]!.unitCost).toBe(12);
    });
  });

  // ── Case 2: Adjust DOWN (shrinkage) drains oldest lot ───────────────────────
  describe('Case 2 — Adjust DOWN (shrinkage) drains the oldest lot via FIFO', () => {
    test('single lot: qtyRemaining reduced, valued at avgCost', async () => {
      seedProduct('P1', { cost: 25, avgCost: 10 });
      seedStock('P1', 8);
      const lotId = seedLot('P1', { qtyRemaining: 8, costPerUnit: 10, receivedAtMs: 1_000 });

      const adjId = await confirmInventoryAdjustment(
        makeInput(
          [{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 8, adjustQty: -3 }],
          'สินค้าชำรุด',
        ),
      );

      const lot = fb.get(`stockLots/${lotId}`)!;
      expect(lot.qtyRemaining).toBe(5);
      expect(lot.isDepleted).toBe(false);

      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(5);

      // ADJUST_OUT is valued at the moving-average cost, not product.cost.
      const item = adjItems(adjId)[0]!;
      expect(item.unitCost).toBe(10);
      expect(item.valueImpact).toBe(-30); // -3 * 10
      expect(item.newStock).toBe(5);
    });

    test('exact full drain marks the lot depleted', async () => {
      seedProduct('P1', { avgCost: 10 });
      seedStock('P1', 4);
      const lotId = seedLot('P1', { qtyRemaining: 4, costPerUnit: 10, receivedAtMs: 1_000 });

      await confirmInventoryAdjustment(
        makeInput([{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 4, adjustQty: -4 }]),
      );

      const lot = fb.get(`stockLots/${lotId}`)!;
      expect(lot.qtyRemaining).toBe(0);
      expect(lot.isDepleted).toBe(true);
    });
  });

  // ── Case 3: Adjust DOWN across multiple lots ────────────────────────────────
  describe('Case 3 — Adjust DOWN splits across lots oldest-first (FIFO)', () => {
    test('drains Lot A fully then takes the remainder from Lot B', async () => {
      seedProduct('P1', { avgCost: 11 });
      seedStock('P1', 14);
      const lotA = seedLot('P1', { qtyRemaining: 4, costPerUnit: 10, receivedAtMs: 1_000 }); // older
      const lotB = seedLot('P1', { qtyRemaining: 10, costPerUnit: 12, receivedAtMs: 2_000 }); // newer

      await confirmInventoryAdjustment(
        makeInput([{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 14, adjustQty: -7 }]),
      );

      const a = fb.get(`stockLots/${lotA}`)!;
      const b = fb.get(`stockLots/${lotB}`)!;
      expect(a.qtyRemaining).toBe(0); // 4 fully consumed
      expect(a.isDepleted).toBe(true);
      expect(b.qtyRemaining).toBe(7); // 10 - 3
      expect(b.isDepleted).toBe(false);

      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(7);
    });

    test('FIFO follows receivedAt, not seed order', async () => {
      seedProduct('P1', { avgCost: 10 });
      seedStock('P1', 10);
      // Seed the NEWER lot first to prove ordering is by receivedAt.
      const newer = seedLot('P1', { qtyRemaining: 5, costPerUnit: 12, receivedAtMs: 5_000 });
      const older = seedLot('P1', { qtyRemaining: 5, costPerUnit: 10, receivedAtMs: 1_000 });

      await confirmInventoryAdjustment(
        makeInput([{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 10, adjustQty: -3 }]),
      );

      expect(fb.get(`stockLots/${older}`)!.qtyRemaining).toBe(2); // older drained first
      expect(fb.get(`stockLots/${newer}`)!.qtyRemaining).toBe(5); // untouched
    });
  });

  // ── Case 4: Adjust DOWN exceeding total available stock ─────────────────────
  describe('Case 4 — Adjust DOWN beyond available stock', () => {
    test('THROWS and writes nothing when negative stock is disallowed', async () => {
      seedProduct('P1', { avgCost: 10, allowNegativeStock: false });
      seedStock('P1', 5);
      const lotId = seedLot('P1', { qtyRemaining: 5, costPerUnit: 10, receivedAtMs: 1_000 });

      await expect(
        confirmInventoryAdjustment(
          makeInput([{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 5, adjustQty: -10 }]),
        ),
      ).rejects.toThrow('ยอดคงเหลือใหม่ติดลบ');

      // Atomicity: nothing committed — lot + stock unchanged, no adjustment doc.
      expect(fb.get(`stockLots/${lotId}`)!.qtyRemaining).toBe(5);
      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(5);
      expect(fb.docsUnder('inventoryAdjustments').length).toBe(0);
    });

    test('when negative stock IS allowed: drains lots, goes negative, warns on shortfall', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      seedProduct('P1', { avgCost: 10, allowNegativeStock: true });
      seedStock('P1', 5);
      const lotId = seedLot('P1', { qtyRemaining: 5, costPerUnit: 10, receivedAtMs: 1_000 });

      await confirmInventoryAdjustment(
        makeInput([{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 5, adjustQty: -8 }]),
      );

      // Lot drained to empty; the 3-unit shortfall is counter-only (tolerated).
      expect(fb.get(`stockLots/${lotId}`)!.qtyRemaining).toBe(0);
      expect(fb.get(`stockLots/${lotId}`)!.isDepleted).toBe(true);
      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(-3);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('lot shortfall'));
      warn.mockRestore();
    });
  });

  // ── Case 5: Adjusting with 0 quantity ───────────────────────────────────────
  describe('Case 5 — Zero-quantity handling', () => {
    test('all-zero lines THROW "no items" and write nothing', async () => {
      seedProduct('P1', { avgCost: 10 });
      seedStock('P1', 5);

      await expect(
        confirmInventoryAdjustment(
          makeInput([{ productId: 'P1', name: 'Food', sku: 'SKU-P1', currentStock: 5, adjustQty: 0 }]),
        ),
      ).rejects.toThrow('ไม่มีรายการที่ปรับปรุง');

      expect(fb.docsUnder('inventoryAdjustments').length).toBe(0);
      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(5);
    });

    test('a 0-qty line mixed with a real line is silently dropped', async () => {
      seedProduct('P1', { cost: 20, avgCost: 10 });
      seedProduct('P2', { cost: 30, avgCost: 15 });
      seedStock('P1', 5);
      seedStock('P2', 5);

      const adjId = await confirmInventoryAdjustment(
        makeInput([
          { productId: 'P1', name: 'Zero', sku: 'SKU-P1', currentStock: 5, adjustQty: 0 },
          { productId: 'P2', name: 'Real', sku: 'SKU-P2', currentStock: 5, adjustQty: 2 },
        ]),
      );

      const items = adjItems(adjId);
      expect(items).toHaveLength(1); // only the +2 line survived
      expect(items[0]!.productId).toBe('P2');
      expect(lotsFor('P1')).toHaveLength(0); // zero line created no lot
      expect(fb.get(`products/P1/productStocks/${BRANCH}`)?.totalStockBase).toBe(5); // untouched
    });
  });
});
