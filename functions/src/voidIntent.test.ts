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
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
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
      return await fn(tx);
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

describe('handleVoidIntent — R7-6 historyRev / V9', () => {
  test('F13 canonical header read in READ phase; void mutation writes current+1 atomically', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = 1;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome.kind).toBe('VOID_APPLIED');
    expect(db.__store.get('orders/dev01-1')!.historyRev).toBe(2);
    expect(db.__store.get('orders/dev01-1')!.status).toBe('voided');
  });

  test('F14 missing canonical → one source marker; zero business/canonical writes', async () => {
    const seed = seedSettledSale();
    delete seed['orders/dev01-1'];
    const db = makeFakeDb(seed);
    const before = new Map(db.__store);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'VOID_ANOMALY_COMMITTED', anomaly: 'missing_canonical' });
    expect(db.__store.get('asyncOrders/dev01-1')!.voidAnomaly).toBe('missing_canonical');
    expect(db.__store.get('asyncOrders/dev01-1')!.voidReconciled).toBeUndefined();
    expect(db.__store.get('stockLots/lotA')!.qtyRemaining).toBe(before.get('stockLots/lotA')!.qtyRemaining);
    expect([...db.__store.keys()].some((k) => k.startsWith('orders/'))).toBe(false);
  });

  test('F16 repeat delivery with marker present → zero writes', async () => {
    const seed = seedSettledSale();
    delete seed['orders/dev01-1'];
    (seed['asyncOrders/dev01-1'] as Doc).voidAnomaly = 'missing_canonical';
    (seed['asyncOrders/dev01-1'] as Doc).voidAnomalyAt = 111;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'terminal_marker_present' });
    expect(db.__store.get('asyncOrders/dev01-1')!.voidAnomalyAt).toBe(111);
  });

  test('F17 voidReconciled true performs no second increment', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidReconciled = true;
    (seed['orders/dev01-1'] as Doc).historyRev = 4;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'already_reconciled' });
    expect(db.__store.get('orders/dev01-1')!.historyRev).toBe(4);
  });

  test('F18 malformed canonical revision fail closed; void not applied', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = 1.5;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome.kind).toBe('VOID_REVISION_FAULT_COMMITTED');
    expect(db.__store.get('orders/dev01-1')!.status).toBe('completed');
  });

  test('F22 value-blind voidAnomaly presence is terminal', async () => {
    for (const value of ['missing_canonical', 'canonical_ineligible', '', 'x', 0, null, {}, [], true]) {
      const seed = seedSettledSale();
      (seed['asyncOrders/dev01-1'] as Doc).voidAnomaly = value as never;
      const db = makeFakeDb(seed);
      const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
      expect(outcome.kind).toBe('NOOP');
      expect(db.__store.get('orders/dev01-1')!.status).toBe('completed');
    }
  });

  test('F23 voidAnomalyAt present without voidAnomaly is terminal', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidAnomalyAt = 1;
    const db = makeFakeDb(seed);
    expect((await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never)).kind).toBe('NOOP');
  });

  test('F24 canonical already voided → one asyncOrders marker; voidReconciled not set', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).status = 'voided';
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'VOID_ANOMALY_COMMITTED', anomaly: 'canonical_ineligible' });
    expect(db.__store.get('asyncOrders/dev01-1')!.voidReconciled).toBeUndefined();
    expect(db.__store.get('stockLots/lotA')!.qtyRemaining).toBe(0);
  });

  test('F25 unexpected canonical status refuses identically', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).status = 12;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome.kind).toBe('VOID_ANOMALY_COMMITTED');
  });

  test('F26 completed/pending_payment proceed', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).status = 'pending_payment';
    (seed['orders/dev01-1'] as Doc).historyRev = 1;
    const db = makeFakeDb(seed);
    expect((await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never)).kind).toBe('VOID_APPLIED');
  });

  test('F27 repeat ineligible-marked source is zero writes', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidAnomaly = 'canonical_ineligible';
    (seed['asyncOrders/dev01-1'] as Doc).voidAnomalyAt = 9;
    const db = makeFakeDb(seed);
    expect((await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never)).kind).toBe('NOOP');
    expect(db.__store.get('asyncOrders/dev01-1')!.voidAnomalyAt).toBe(9);
  });

  test('F28 malformed present historyRev writes revision_malformed only', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = '3';
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'VOID_REVISION_FAULT_COMMITTED', fault: 'revision_malformed', branchId: 'br1' });
    expect(db.__store.get('asyncOrders/dev01-1')!.voidRevisionFault).toBe('revision_malformed');
    expect(db.__store.get('asyncOrders/dev01-1')!.voidReconciled).toBeUndefined();
    expect(db.__store.get('asyncOrders/dev01-1')!.reconcileStatus).toBe('settled');
    expect(db.__store.get('orders/dev01-1')!.status).toBe('completed');
  });

  test('F29 overflow writes revision_overflow', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = Number.MAX_SAFE_INTEGER;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toMatchObject({ kind: 'VOID_REVISION_FAULT_COMMITTED', fault: 'revision_overflow', branchId: 'br1' });
  });

  test('F30 repeat fault-marked source is zero writes and byte-unchanged timestamp', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidRevisionFault = 'revision_malformed';
    (seed['asyncOrders/dev01-1'] as Doc).voidRevisionFaultAt = 42;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'terminal_marker_present' });
    expect(db.__store.get('asyncOrders/dev01-1')!.voidRevisionFaultAt).toBe(42);
  });

  test('F31 value-blind V9 fields only', async () => {
    for (const field of ['voidRevisionFault', 'voidRevisionFaultAt'] as const) {
      for (const value of ['', 'x', 0, null, {}, [], true]) {
        const seed = seedSettledSale();
        (seed['asyncOrders/dev01-1'] as Doc)[field] = value as never;
        const db = makeFakeDb(seed);
        expect((await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never)).kind).toBe('NOOP');
      }
    }
  });

  test('F32 valid historyRev mints current+1', async () => {
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = 3;
    const db = makeFakeDb(seed);
    await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(db.__store.get('orders/dev01-1')!.historyRev).toBe(4);
  });

  test('F33 absent historyRev is not routed to V9', async () => {
    const seed = seedSettledSale();
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome.kind).toBe('VOID_APPLIED');
    expect(db.__store.get('asyncOrders/dev01-1')!.voidRevisionFault).toBeUndefined();
    expect(db.__store.get('orders/dev01-1')!.historyRev).toBe(1);
  });

  test('F35 transaction callback retry performs no log side effect', async () => {
    let inCallback = false;
    let callbackLogs = 0;
    let postCommitLogs = 0;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (!String(args[0]).includes('void_revision_fault_terminal')) return;
      if (inCallback) callbackLogs += 1;
      else postCommitLogs += 1;
    });
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = 'bad';
    const db = makeFakeDb(seed);
    const orig = db.runTransaction;
    db.runTransaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot: Seed = {};
      for (const [path, data] of db.__store.entries()) snapshot[path] = { ...data };
      const isolated = makeFakeDb(snapshot);
      inCallback = true;
      await isolated.runTransaction(fn);
      inCallback = false;
      expect(db.__store.get('asyncOrders/dev01-1')!.voidRevisionFault).toBeUndefined();

      inCallback = true;
      const committed = await orig(fn);
      inCallback = false;
      return committed;
    };
    await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(callbackLogs).toBe(0);
    expect(postCommitLogs).toBe(1);
    expect(db.__store.get('asyncOrders/dev01-1')!.voidRevisionFault).toBe('revision_malformed');
    errorSpy.mockRestore();
  });

  test('F36 post-commit log uses outcome.branchId', async () => {
    const seenBranches: string[] = [];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seed = seedSettledSale();
    (seed['orders/dev01-1'] as Doc).historyRev = 1.2;
    (seed['asyncOrders/dev01-1'] as Doc).branchId = 'br-attempt';
    const db = makeFakeDb(seed);
    const orig = db.runTransaction;
    const wrapAttempt = async (
      runner: typeof orig,
      fn: (tx: unknown) => Promise<unknown>,
    ) => {
      return runner(async (innerTx) => {
        const tx = innerTx as {
          get: (ref: { path: string }) => Promise<{ data: () => Doc | undefined }>;
          set: (...args: never[]) => void;
          update: (...args: never[]) => void;
        };
        return fn({
          get: async (ref: { path: string }) => {
            const snap = await tx.get(ref);
            if (ref.path === 'asyncOrders/dev01-1') {
              const branchId = snap.data()?.branchId;
              if (typeof branchId === 'string') seenBranches.push(branchId);
            }
            return snap;
          },
          set: tx.set.bind(tx),
          update: tx.update.bind(tx),
        });
      });
    };
    db.runTransaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot: Seed = {};
      for (const [path, data] of db.__store.entries()) snapshot[path] = { ...data };
      const isolated = makeFakeDb(snapshot);
      await wrapAttempt(isolated.runTransaction, fn);
      db.__store.get('asyncOrders/dev01-1')!.branchId = 'br-committed';
      return wrapAttempt(orig, fn);
    };
    await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(new Set(seenBranches).size).toBeGreaterThan(1);
    expect(seenBranches).toContain('br-attempt');
    expect(seenBranches).toContain('br-committed');
    const terminalLogs = errorSpy.mock.calls.filter((c) => String(c[0]).includes('void_revision_fault_terminal'));
    expect(terminalLogs).toHaveLength(1);
    expect(terminalLogs[0]?.[1]).toEqual({
      orderId: 'dev01-1',
      branchId: 'br-committed',
      fault: 'revision_malformed',
    });
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged.includes('br-attempt')).toBe(false);
    expect(logged.includes('br1')).toBe(false);
    errorSpy.mockRestore();
  });

  test('F37 duplicate delivery NOOP emits no marker-commit log', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidRevisionFault = 'revision_malformed';
    (seed['asyncOrders/dev01-1'] as Doc).voidRevisionFaultAt = 1;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'terminal_marker_present' });
    expect(errorSpy.mock.calls.some((c) => String(c[0]).includes('void_revision_fault_terminal'))).toBe(false);
    errorSpy.mockRestore();
  });
});

describe('handleVoidIntent — privileged execution correlation', () => {
  const EXEC_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const EXEC_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  test('absence of options does not stamp privilegedVoidExecutionId', async () => {
    const db = makeFakeDb(seedSettledSale());
    await handleVoidIntent(db as never, db.collection('asyncOrders').doc('dev01-1') as never);
    expect(db.__store.get('asyncOrders/dev01-1')!.privilegedVoidExecutionId).toBeUndefined();
    expect(db.__store.get('asyncOrders/dev01-1')!.voidReconciled).toBe(true);
  });

  test('VOID_APPLIED writes correlation in the same canonical effect', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).status = 'completed';
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(
      db as never,
      db.collection('asyncOrders').doc('dev01-1') as never,
      { privilegedVoidExecutionId: EXEC_A },
    );
    expect(outcome.kind).toBe('VOID_APPLIED');
    expect(db.__store.get('asyncOrders/dev01-1')).toMatchObject({
      status: 'voided',
      voidReconciled: true,
      privilegedVoidExecutionId: EXEC_A,
    });
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(20);
  });

  test('VOID_TOMBSTONED writes correlation without FIFO reversal', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).status = 'completed';
    (seed['asyncOrders/dev01-1'] as Doc).reconcileStatus = 'pending_reconcile';
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(
      db as never,
      db.collection('asyncOrders').doc('dev01-1') as never,
      { privilegedVoidExecutionId: EXEC_A },
    );
    expect(outcome.kind).toBe('VOID_TOMBSTONED');
    expect(db.__store.get('asyncOrders/dev01-1')).toMatchObject({
      status: 'voided',
      reconcileStatus: 'settled',
      privilegedVoidExecutionId: EXEC_A,
    });
    expect(db.__store.get('asyncOrders/dev01-1')!.voidReconciled).toBeUndefined();
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(5);
  });

  test('matching correlation on already-voided target is NOOP and does not restock again', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).status = 'completed';
    const db = makeFakeDb(seed);
    const ref = db.collection('asyncOrders').doc('dev01-1');
    await handleVoidIntent(db as never, ref as never, { privilegedVoidExecutionId: EXEC_A });
    const second = await handleVoidIntent(db as never, ref as never, { privilegedVoidExecutionId: EXEC_A });
    expect(second).toEqual({ kind: 'NOOP', reason: 'already_reconciled' });
    expect(db.__store.get('asyncOrders/dev01-1')!.privilegedVoidExecutionId).toBe(EXEC_A);
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(20);
    expect([...db.__store.keys()].filter((k) => k.startsWith('creditTransactions/'))).toHaveLength(1);
  });

  test('different correlation on already-voided target is not overwritten and does not re-enter reversal', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidReconciled = true;
    (seed['asyncOrders/dev01-1'] as Doc).privilegedVoidExecutionId = EXEC_B;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(
      db as never,
      db.collection('asyncOrders').doc('dev01-1') as never,
      { privilegedVoidExecutionId: EXEC_A },
    );
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'already_reconciled' });
    expect(db.__store.get('asyncOrders/dev01-1')!.privilegedVoidExecutionId).toBe(EXEC_B);
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(5);
  });

  test('missing correlation on already-voided target is not stamped by a later privileged caller', async () => {
    const seed = seedSettledSale();
    (seed['asyncOrders/dev01-1'] as Doc).voidReconciled = true;
    const db = makeFakeDb(seed);
    const outcome = await handleVoidIntent(
      db as never,
      db.collection('asyncOrders').doc('dev01-1') as never,
      { privilegedVoidExecutionId: EXEC_A },
    );
    expect(outcome).toEqual({ kind: 'NOOP', reason: 'already_reconciled' });
    expect(db.__store.get('asyncOrders/dev01-1')!.privilegedVoidExecutionId).toBeUndefined();
    expect(db.__store.get('products/P/productStocks/br1')!.totalStockBase).toBe(5);
  });
});
