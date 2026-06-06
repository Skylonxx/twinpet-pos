import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the Functions runtime + admin bits so importing retryReconcile.ts has no
// side effects and `performReconcileRetry` is testable with an injected fake db.
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
}));

import { performReconcileRetry, RECONCILE_RETRY_CAP } from './retryReconcile';

// ── Minimal transactional fake Firestore (asyncOrders only) ──────────────────
type Doc = Record<string, unknown>;
function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const resolve = (cur: unknown, inc: unknown): unknown => {
    if (inc && typeof inc === 'object' && (inc as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((inc as { n: number }).n ?? 0);
    }
    if (inc && typeof inc === 'object' && (inc as { __fv?: string }).__fv === 'ts') return 1_700_000_000_000;
    return inc;
  };
  const ref = (path: string) => ({ path, id: path.slice(path.lastIndexOf('/') + 1) });
  // Serialize transactions so overlapping calls behave like Firestore's
  // serializable transactions (a conflicting tx effectively runs after the
  // other commits) — lets us model an Admin double-click on Retry.
  let txLock: Promise<unknown> = Promise.resolve();
  const db = {
    collection: (c: string) => ({ doc: (id: string) => ref(`${c}/${id}`) }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (r: { path: string }) => {
          const d = store.get(r.path);
          return { exists: d !== undefined, data: () => d };
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolve(existing[k], v);
          store.set(r.path, next);
        },
      };
      const run = txLock.then(() => fn(tx));
      txLock = run.catch(() => undefined);
      return run;
    },
    __store: store,
  };
  return db;
}

const admin = { uid: 'u-admin', token: { role: 'admin', staffId: 'admin1' } };
const staff = { uid: 'u-staff', token: { role: 'staff', staffId: 's1', permissions: ['pos_sale'] } };
const manager = { uid: 'u-mgr', token: { role: 'manager', staffId: 'm1' } };

const exceptionOrder = (over: Doc = {}): Doc => ({
  id: 'o1',
  branchId: 'LDP-001',
  reconcileStatus: 'exception',
  reconcileAttempts: 1,
  reconcileError: 'first boom',
  ...over,
});

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
  db = makeDb({ 'asyncOrders/o1': exceptionOrder() });
});

describe('performReconcileRetry — admin-only', () => {
  test('unauthenticated is rejected', async () => {
    await expect(performReconcileRetry(db as never, 'o1', null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  test('non-admin staff is rejected (cannot retry)', async () => {
    await expect(performReconcileRetry(db as never, 'o1', staff)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(db.__store.get('asyncOrders/o1')!.reconcileStatus).toBe('exception'); // unchanged
  });
  test('non-admin manager is rejected', async () => {
    await expect(performReconcileRetry(db as never, 'o1', manager)).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('missing orderId is invalid-argument', async () => {
    await expect(performReconcileRetry(db as never, '', admin)).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  test('unknown order is not-found', async () => {
    await expect(performReconcileRetry(db as never, 'nope', admin)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('performReconcileRetry — re-arm + idempotency', () => {
  test('an exception order is re-armed to pending_reconcile (audit recorded)', async () => {
    const res = await performReconcileRetry(db as never, 'o1', admin);
    expect(res).toEqual({ status: 're-armed', attempts: 1 });
    const o = db.__store.get('asyncOrders/o1')!;
    expect(o.reconcileStatus).toBe('pending_reconcile');
    expect(o.adminRetryCount).toBe(1);
    expect(o.lastRetryBy).toBe('admin1');
    // Re-arm does NOT touch stock/lots and does NOT reset the attempt counter.
    expect(o.reconcileAttempts).toBe(1);
    expect([...db.__store.keys()]).toEqual(['asyncOrders/o1']); // only the async order changed
  });

  test('already-settled order is a safe no-op (never re-settled)', async () => {
    db = makeDb({ 'asyncOrders/o1': { id: 'o1', branchId: 'LDP-001', reconcileStatus: 'settled' } });
    const res = await performReconcileRetry(db as never, 'o1', admin);
    expect(res).toEqual({ status: 'noop_already_settled' });
    expect(db.__store.get('asyncOrders/o1')!.reconcileStatus).toBe('settled');
  });

  test('a non-exception (pending) order cannot be retried', async () => {
    db = makeDb({ 'asyncOrders/o1': { id: 'o1', branchId: 'LDP-001', reconcileStatus: 'pending_reconcile' } });
    await expect(performReconcileRetry(db as never, 'o1', admin)).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('performReconcileRetry — concurrent retry (Admin double-click)', () => {
  test('two concurrent admin retries re-arm exactly ONCE (idempotent, no double-deduct)', async () => {
    const [a, b] = await Promise.allSettled([
      performReconcileRetry(db as never, 'o1', admin),
      performReconcileRetry(db as never, 'o1', admin),
    ]);

    const statuses = [a, b].map((r) => r.status);
    // Exactly one fulfilled (re-armed); the other safely rejected (no longer 'exception').
    expect(statuses.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'rejected')).toHaveLength(1);
    const rejected = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'failed-precondition' });

    const o = db.__store.get('asyncOrders/o1')!;
    expect(o.reconcileStatus).toBe('pending_reconcile'); // single re-arm
    expect(o.adminRetryCount).toBe(1); // NOT 2 — second click did not double-apply
    expect(o.reconcileAttempts).toBe(1); // counter untouched by re-arm (no double-deduct)
    expect([...db.__store.keys()]).toEqual(['asyncOrders/o1']); // no stock/lot writes
  });
});

describe('performReconcileRetry — retry CAP', () => {
  test(`refuses re-arm once attempts reach the cap (${RECONCILE_RETRY_CAP})`, async () => {
    db = makeDb({ 'asyncOrders/o1': exceptionOrder({ reconcileAttempts: RECONCILE_RETRY_CAP }) });
    await expect(performReconcileRetry(db as never, 'o1', admin)).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(db.__store.get('asyncOrders/o1')!.reconcileStatus).toBe('exception'); // not re-armed
  });
  test('allows re-arm just below the cap', async () => {
    db = makeDb({ 'asyncOrders/o1': exceptionOrder({ reconcileAttempts: RECONCILE_RETRY_CAP - 1 }) });
    const res = await performReconcileRetry(db as never, 'o1', admin);
    expect(res.status).toBe('re-armed');
  });
});

describe('performReconcileRetry — voidRequested + exception conflict', () => {
  test('a voidRequested exception is safely rejected: NOT re-armed, no stock mutation', async () => {
    db = makeDb({ 'asyncOrders/o1': exceptionOrder({ voidRequested: true }) });
    await expect(performReconcileRetry(db as never, 'o1', admin)).rejects.toMatchObject({ code: 'failed-precondition' });
    const o = db.__store.get('asyncOrders/o1')!;
    expect(o.reconcileStatus).toBe('exception'); // NOT blindly re-armed to pending_reconcile
    expect(o.adminRetryCount).toBeUndefined(); // no write occurred
    expect([...db.__store.keys()]).toEqual(['asyncOrders/o1']); // no stock/lot mutation
  });
});
