import { describe, test, expect, vi } from 'vitest';

// Mock ONLY firebase-admin/firestore so `FieldValue` produces inspectable
// sentinels our fake store resolves. `db` is dependency-injected (no './db'
// mock), and we never import reconcileOrder.ts, so no trigger/emulator is needed.
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
    arrayUnion: (...items: unknown[]) => ({ __fv: 'arr', items }),
  },
  Timestamp: { now: () => ({ __fv: 'ts' }), fromMillis: (ms: number) => ({ __ms: ms }) },
}));

import { handleVoidIntent } from './voidIntent';

// ─── Minimal in-memory Firestore fake ────────────────────────────────────────
//
// Faithful to the bits handleVoidIntent uses: nested collection/doc paths,
// transactional get/set/update, merge, auto-ids, FieldValue sentinel resolution,
// and the read-before-write rule (a read after a write THROWS, like real
// Firestore) so the test also guards that invariant.

type Doc = Record<string, unknown>;
type Seed = Record<string, Doc>;

function isSentinel(v: unknown): v is { __fv: string; n?: number; items?: unknown[] } {
  return typeof v === 'object' && v !== null && '__fv' in v;
}

function makeFakeDb(seed: Seed) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  let auto = 0;

  const resolve = (current: unknown, incoming: unknown): unknown => {
    if (isSentinel(incoming)) {
      if (incoming.__fv === 'inc') return ((current as number) ?? 0) + (incoming.n ?? 0);
      if (incoming.__fv === 'ts') return 1_700_000_000_000;
      if (incoming.__fv === 'arr') {
        const arr = Array.isArray(current) ? [...current] : [];
        for (const it of incoming.items ?? []) {
          if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(it))) arr.push(it);
        }
        return arr;
      }
    }
    return incoming;
  };

  const apply = (path: string, data: Doc, merge: boolean) => {
    const existing = merge ? (store.get(path) ?? {}) : {};
    const next: Doc = { ...existing };
    for (const [k, v] of Object.entries(data)) next[k] = resolve(existing[k], v);
    store.set(path, next);
  };

  type Ref = { path: string; id: string; collection: (n: string) => Coll };
  type Coll = { doc: (id?: string) => Ref };
  const docRef = (path: string): Ref => ({
    path,
    id: path.slice(path.lastIndexOf('/') + 1),
    collection: (n: string) => collRef(`${path}/${n}`),
  });
  const collRef = (path: string): Coll => ({
    doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++auto}`}`),
  });

  const db = {
    collection: (n: string) => collRef(n),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      let wrote = false;
      const tx = {
        get: async (ref: Ref) => {
          if (wrote) throw new Error('READ_AFTER_WRITE: all reads must precede writes');
          const data = store.get(ref.path);
          return { exists: data !== undefined, id: ref.id, data: () => data };
        },
        set: (ref: Ref, data: Doc, opts?: { merge?: boolean }) => {
          wrote = true;
          apply(ref.path, data, opts?.merge ?? false);
        },
        update: (ref: Ref, data: Doc) => {
          wrote = true;
          if (!store.has(ref.path)) throw new Error(`NO_DOCUMENT_TO_UPDATE: ${ref.path}`);
          apply(ref.path, data, true);
        },
      };
      await fn(tx);
    },
    __store: store,
  };
  return db;
}

// ─── Soak fixture: POST-SETTLEMENT state of the bill we will void ─────────────
//
// 15 × P @100 = 1500, tendered 1000 cash + 500 credit. FIFO cut Lot A(10@40) +
// Lot B(5@50). Baseline (pre-sale) we must return to: stock 20, lots 10/10,
// outstanding 0, creditUsed 0.

function seedSettledSale(): Seed {
  return {
    'asyncOrders/dev01-1': {
      id: 'dev01-1',
      branchId: 'br1',
      staffId: 'staff1',
      customerId: 'cust1',
      creditAmt: 500,
      total: 1500,
      billId: 'R001',
      reconcileStatus: 'settled',
      status: 'voided', // client already flipped it via requestPendingVoid
      voidRequested: true,
      voidedBy: 'staff1',
      voidReason: 'ลูกค้าเปลี่ยนใจ',
      lines: [
        {
          productId: 'P',
          qtyBase: 15,
          lotRefs: [
            { lotId: 'lotA', qty: 10, cost: 40 },
            { lotId: 'lotB', qty: 5, cost: 50 },
          ],
        },
      ],
    },
    'stockLots/lotA': { qtyRemaining: 0, costPerUnit: 40, isDepleted: true },
    'stockLots/lotB': { qtyRemaining: 5, costPerUnit: 50, isDepleted: false },
    'products/P/productStocks/br1': { branchId: 'br1', totalStockBase: 5 },
    'creditAccounts/cust1': { creditUsed: 500, creditLimit: 5000, creditBalance: 4500 },
    'customers/cust1': { outstandingBalance: 500 },
    'orders/dev01-1': { id: 'dev01-1', status: 'completed', total: 1500 },
  };
}

describe('handleVoidIntent — settled-void soak (Phase 7, automated)', () => {
  test('fully reverses a settled sale back to baseline (zero drift)', async () => {
    const db = makeFakeDb(seedSettledSale());
    const orderRef = db.collection('asyncOrders').doc('dev01-1');

    await handleVoidIntent(db as never, orderRef as never);

    const s = db.__store;
    // Idempotency flag set + async source voided.
    expect(s.get('asyncOrders/dev01-1')!.voidReconciled).toBe(true);
    expect(s.get('asyncOrders/dev01-1')!.status).toBe('voided');
    // FIFO lots restocked to FULL, un-depleted.
    expect(s.get('stockLots/lotA')!.qtyRemaining).toBe(10);
    expect(s.get('stockLots/lotA')!.isDepleted).toBe(false);
    expect(s.get('stockLots/lotB')!.qtyRemaining).toBe(10);
    // Product stock back to baseline 20.
    expect(s.get('products/P/productStocks/br1')!.totalStockBase).toBe(20);
    // Credit + outstanding fully reversed.
    expect(s.get('creditAccounts/cust1')!.creditUsed).toBe(0);
    expect(s.get('creditAccounts/cust1')!.creditBalance).toBe(5000);
    expect(s.get('customers/cust1')!.outstandingBalance).toBe(0);
    // Canonical order voided so HQ reflects it.
    expect(s.get('orders/dev01-1')!.status).toBe('voided');
  });

  test('writes a reversal credit transaction (type payment, −500)', async () => {
    const db = makeFakeDb(seedSettledSale());
    await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);

    const creditTxs = [...db.__store.entries()].filter(([k]) => k.startsWith('creditTransactions/'));
    expect(creditTxs).toHaveLength(1);
    expect(creditTxs[0][1]).toMatchObject({ type: 'payment', amount: -500, refOrderId: 'dev01-1' });
  });

  test('is idempotent — a second delivery does NOT double-restock', async () => {
    const db = makeFakeDb(seedSettledSale());
    const ref = db.collection('asyncOrders').doc('dev01-1');

    await handleVoidIntent(db as never, ref as never); // first
    await handleVoidIntent(db as never, ref as never); // re-delivery

    // Still baseline — NOT 35 / 1000 / negative credit.
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(20);
    expect(db.__store.get('stockLots/lotA')!.qtyRemaining).toBe(10);
    expect(db.__store.get('customers/cust1')!.outstandingBalance).toBe(0);
    // Only ONE reversal credit tx, not two.
    const creditTxs = [...db.__store.keys()].filter((k) => k.startsWith('creditTransactions/'));
    expect(creditTxs).toHaveLength(1);
  });

  test('a still-PENDING void is tombstoned (no reversal side-effects)', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).reconcileStatus = 'pending_reconcile';
    const db = makeFakeDb(seed);

    await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);

    const order = db.__store.get('asyncOrders/dev01-1')!;
    expect(order.status).toBe('voided');
    expect(order.reconcileStatus).toBe('settled'); // tombstoned
    expect(order.voidReconciled).toBeUndefined(); // reversal branch NOT run
    // No stock restored (it was never applied).
    expect(db.__store.get('stockLots/lotA')!.qtyRemaining).toBe(0);
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(5);
  });
});
