import { describe, test, expect, vi } from 'vitest';

vi.mock('./db', () => ({ db: { __unused: true } }));
vi.mock('./deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class HttpsError extends Error {},
}));
// Server-side PIN verification (bcrypt) — mock compares plaintext for tests.
vi.mock('bcryptjs', () => ({ default: { compare: async (pin: string, hash: string) => pin === hash } }));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (n: number) => ({ __fv: 'inc', n }), serverTimestamp: () => ({ __fv: 'ts' }) },
  Timestamp: class Timestamp {
    static fromMillis(ms: number) {
      return { seconds: Math.floor(ms / 1000), nanoseconds: 0, toMillis: () => ms };
    }
  },
}));

import { performResolveReversal, type ResolveReversalRequest } from './resolveReversal';

// ── Fake Admin Firestore (paths + subcollections + where/orderBy queries) ──
type Doc = Record<string, unknown>;
function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  let auto = 0;
  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return 1_700_000_000_000;
    return v;
  };
  const seconds = (v: unknown): number =>
    v && typeof v === 'object' && typeof (v as { seconds?: number }).seconds === 'number' ? (v as { seconds: number }).seconds : 0;
  const directChildren = (colPath: string) =>
    [...store.entries()].filter(([p]) => p.startsWith(`${colPath}/`) && !p.slice(colPath.length + 1).includes('/'));
  function docRef(path: string): any {
    return { __doc: true, path, id: path.slice(path.lastIndexOf('/') + 1), collection: (n: string) => colRef(`${path}/${n}`) };
  }
  function makeQuery(path: string, wheres: Array<{ f: string; v: unknown }>, order: string | null): any {
    return { __query: true, path, wheres, order, where: (f: string, _o: string, v: unknown) => makeQuery(path, [...wheres, { f, v }], order), orderBy: (f: string) => makeQuery(path, wheres, f) };
  }
  function colRef(path: string): any {
    return { __col: true, path, doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++auto}`}`), where: (f: string, o: string, v: unknown) => makeQuery(path, [{ f, v }], null).where(f, o, v), orderBy: (f: string) => makeQuery(path, [], f) };
  }
  const snapshotFor = (path: string, wheres: Array<{ f: string; v: unknown }>, order: string | null) => {
    let rows = directChildren(path);
    for (const w of wheres) rows = rows.filter(([, data]) => data[w.f] === w.v);
    if (order) rows = [...rows].sort((a, b) => seconds(a[1][order]) - seconds(b[1][order]));
    const docs = rows.map(([p, data]) => ({ id: p.slice(p.lastIndexOf('/') + 1), ref: docRef(p), data: () => data }));
    return { empty: docs.length === 0, size: docs.length, docs, forEach: (cb: (d: unknown) => void) => docs.forEach(cb) };
  };
  const db = {
    collection: (c: string) => colRef(c),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (x: any) => {
          if (x.__doc) { const data = store.get(x.path); return { exists: data !== undefined, id: x.id, ref: x, data: () => data }; }
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

const mgrB1 = { uid: 'u1', token: { role: 'manager', staffId: 'm1', branchIds: ['B1'] } };
const adminAll = { uid: 'u2', token: { role: 'admin', staffId: 'a1', branchIds: ['ALL'] } };
const staffB1 = { uid: 'u3', token: { role: 'staff', staffId: 's-staff', branchIds: ['B1'] } };
const otherBranch = { uid: 'u4', token: { role: 'staff', staffId: 's-x', branchIds: ['BX'] } };

const USER_SEED = { 'users/s-staff': { pin: '1234', role: 'staff' } };

function seedReceiving(over: { stock?: number; lotRemaining?: number; status?: string; updatedAt?: unknown } = {}) {
  return makeDb({
    ...USER_SEED,
    'receivings/R1': { id: 'R1', branchId: 'B1', status: over.status ?? 'completed', total: 100, updatedAt: over.updatedAt },
    'receivings/R1/receivingItems/I1': { productId: 'P1', qtyBase: 10, lotId: 'L1', costBase: 5 },
    'products/P1/productStocks/B1': { branchId: 'B1', totalStockBase: over.stock ?? 10 },
    'stockLots/L1': { id: 'L1', productId: 'P1', branchId: 'B1', qtyRemaining: over.lotRemaining ?? 10, qtyReceived: 10, isDepleted: false, receivedAt: { seconds: 1 }, costPerUnit: 5 },
  });
}

function seedTransfer(over: { status?: string; destStock?: number; destLotRemaining?: number; updatedAt?: unknown } = {}) {
  return makeDb({
    ...USER_SEED,
    'inventoryTransfers/T1': { id: 'T1', fromBranchId: 'B1', toBranchId: 'B2', status: over.status ?? 'completed', updatedAt: over.updatedAt },
    'inventoryTransfers/T1/transferItems/I1': { productId: 'P1', productName: 'P1', sku: 'P1', transferQty: 5, unitCost: 10, sourceLotDetails: [{ lotId: 'L1', costPerUnit: 10, qty: 5, receivedAtMs: 1000 }] },
    'products/P1/productStocks/B2': { branchId: 'B2', totalStockBase: over.destStock ?? 5 },
    'stockLots/D1': { id: 'D1', productId: 'P1', branchId: 'B2', qtyRemaining: over.destLotRemaining ?? 5, qtyReceived: 5, isDepleted: false, receivedAt: { seconds: 1 }, costPerUnit: 10 },
  });
}

const recReq = (over: Partial<ResolveReversalRequest> = {}): ResolveReversalRequest => ({
  idempotencyKey: 'reversal:B1:receiving:R1:receiving_reversal:LI1', actionType: 'receiving_reversal',
  sourceDocumentId: 'R1', sourceDocumentType: 'receiving', branchId: 'B1', reasonCode: 'wrong_entry', localIntentId: 'LI1', ...over,
});
const trReq = (over: Partial<ResolveReversalRequest> = {}): ResolveReversalRequest => ({
  idempotencyKey: 'reversal:B1:transfer:T1:transfer_reversal:LI1', actionType: 'transfer_reversal',
  sourceDocumentId: 'T1', sourceDocumentType: 'transfer', branchId: 'B1', reasonCode: 'wrong_entry', localIntentId: 'LI1', ...over,
});
const auditDocs = (db: ReturnType<typeof makeDb>) => [...db.__store.entries()].filter(([p]) => /^reversalDocuments\/[^/]+$/.test(p)).map(([, d]) => d);
const recStock = (db: ReturnType<typeof makeDb>, b = 'B1') => db.__store.get(`products/P1/productStocks/${b}`)!.totalStockBase;

// ── Idempotency + audit collision (Blocker 6) ──
describe('resolveReversal — idempotency & audit', () => {
  test('first valid receiving reversal → confirmed; deterministic audit id', async () => {
    const db = seedReceiving();
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(res).toMatchObject({ ok: true, status: 'confirmed' });
    expect(res.serverReversalId).toMatch(/^REV-/);
    expect(db.__store.get(`reversalDocuments/${res.serverReversalId}`)).toBeTruthy();
    expect(recStock(db)).toBe(0);
  });

  test('duplicate same key + payload → duplicate_confirmed, no second mutation/audit', async () => {
    const db = seedReceiving();
    const r1 = await performResolveReversal(db as never, recReq(), mgrB1);
    const r2 = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(r2.status).toBe('duplicate_confirmed');
    expect(r2.serverReversalId).toBe(r1.serverReversalId);
    expect(recStock(db)).toBe(0); // not deducted twice
    expect(auditDocs(db)).toHaveLength(1); // collision-safe: no second audit
  });

  test('same key + DIFFERENT payload → conflict, no mutation, no audit overwrite', async () => {
    const db = seedReceiving();
    const r1 = await performResolveReversal(db as never, recReq(), mgrB1);
    const auditBefore = JSON.stringify(db.__store.get(`reversalDocuments/${r1.serverReversalId}`));
    const res = await performResolveReversal(db as never, recReq({ reasonCode: 'different' }), mgrB1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('conflict_requires_manual_review');
    expect(res.rejectCode).toBe('invalid_payload');
    expect(recStock(db)).toBe(0); // unchanged
    expect(JSON.stringify(db.__store.get(`reversalDocuments/${r1.serverReversalId}`))).toBe(auditBefore); // not overwritten
    expect(auditDocs(db)).toHaveLength(1);
  });

  test('already reversed by DIFFERENT idempotency → already_reversed', async () => {
    const db = seedReceiving();
    await performResolveReversal(db as never, recReq(), mgrB1);
    const res = await performResolveReversal(db as never, recReq({ idempotencyKey: 'other-key', localIntentId: 'LI2' }), mgrB1);
    expect(res.rejectCode).toBe('already_reversed');
  });
});

// ── Server PIN / authority (Blocker 2) ──
describe('resolveReversal — server PIN authority', () => {
  test('Manager bypasses PIN → confirmed', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq(), mgrB1);
    expect(res.status).toBe('confirmed');
  });
  test('Admin (ALL) bypasses PIN → confirmed', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq(), adminAll);
    expect(res.status).toBe('confirmed');
  });
  test('Staff with VALID server-verified PIN → confirmed', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq({ pin: '1234' }), staffB1);
    expect(res.status).toBe('confirmed');
  });
  test('Staff with WRONG PIN → invalid_pin (no mutation)', async () => {
    const db = seedReceiving();
    const res = await performResolveReversal(db as never, recReq({ pin: '9999' }), staffB1);
    expect(res.rejectCode).toBe('invalid_pin');
    expect(recStock(db)).toBe(10);
  });
  test('Staff with MISSING PIN → invalid_pin (client evidence is never trusted)', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq({ pinVerificationId: 'opaque', pinVerifiedAt: 'x' }), staffB1);
    expect(res.rejectCode).toBe('invalid_pin');
  });
  test('missing auth → unauthorized', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq(), null);
    expect(res.rejectCode).toBe('unauthorized');
  });
  test('actor without branch access → unauthorized (no mutation)', async () => {
    const db = seedReceiving();
    const res = await performResolveReversal(db as never, recReq({ pin: '1234' }), otherBranch);
    expect(res.rejectCode).toBe('unauthorized');
    expect(recStock(db)).toBe(10);
  });
});

// ── Receiving reversal (Blockers 3, 4) ──
describe('resolveReversal — receiving', () => {
  test('missing receiving doc → source_document_not_found', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq({ sourceDocumentId: 'NOPE', idempotencyKey: 'k1' }), mgrB1);
    expect(res.rejectCode).toBe('source_document_not_found');
  });
  test('action/document-type mismatch → invalid_payload', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq({ sourceDocumentType: 'transfer' }), mgrB1);
    expect(res.rejectCode).toBe('invalid_payload');
  });
  test('partial-sold (current_stock < received) → stock_conflict (untouched)', async () => {
    const db = seedReceiving({ stock: 8 });
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(res.rejectCode).toBe('stock_conflict');
    expect(recStock(db)).toBe(8);
  });
  test('never produces negative stock; lot depleted', async () => {
    const db = seedReceiving({ stock: 10 });
    await performResolveReversal(db as never, recReq(), mgrB1);
    expect(recStock(db)).toBe(0);
    expect(db.__store.get('stockLots/L1')!.qtyRemaining).toBe(0);
    expect(db.__store.get('stockLots/L1')!.isDepleted).toBe(true);
  });
  test('Blocker 3: item missing lotId → invalid_payload (no mutation)', async () => {
    const db = makeDb({
      ...USER_SEED,
      'receivings/R1': { id: 'R1', branchId: 'B1', status: 'completed' },
      'receivings/R1/receivingItems/I1': { productId: 'P1', qtyBase: 10 }, // no lotId
      'products/P1/productStocks/B1': { branchId: 'B1', totalStockBase: 10 },
    });
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(res.rejectCode).toBe('invalid_payload');
    expect(recStock(db)).toBe(10);
  });
  test('Blocker 3: referenced lot missing → lot_conflict (no mutation)', async () => {
    const db = makeDb({
      ...USER_SEED,
      'receivings/R1': { id: 'R1', branchId: 'B1', status: 'completed' },
      'receivings/R1/receivingItems/I1': { productId: 'P1', qtyBase: 10, lotId: 'GONE' },
      'products/P1/productStocks/B1': { branchId: 'B1', totalStockBase: 10 },
    });
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(res.rejectCode).toBe('lot_conflict');
    expect(recStock(db)).toBe(10);
  });
  test('Blocker 4: two items sharing a lot overdraw aggregate → lot_conflict (no mutation)', async () => {
    const db = makeDb({
      ...USER_SEED,
      'receivings/R1': { id: 'R1', branchId: 'B1', status: 'completed' },
      'receivings/R1/receivingItems/I1': { productId: 'P1', qtyBase: 6, lotId: 'L1' },
      'receivings/R1/receivingItems/I2': { productId: 'P1', qtyBase: 6, lotId: 'L1' }, // aggregate 12 > lot 10
      'products/P1/productStocks/B1': { branchId: 'B1', totalStockBase: 12 },
      'stockLots/L1': { id: 'L1', productId: 'P1', branchId: 'B1', qtyRemaining: 10, qtyReceived: 12, isDepleted: false, receivedAt: { seconds: 1 }, costPerUnit: 5 },
    });
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(res.rejectCode).toBe('lot_conflict');
    expect(recStock(db)).toBe(12); // product stock untouched
    expect(db.__store.get('stockLots/L1')!.qtyRemaining).toBe(10); // lot untouched
  });
  test('valid receiving reversal creates audit + marks source reversed', async () => {
    const db = seedReceiving();
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    const audit = db.__store.get(`reversalDocuments/${res.serverReversalId}`)!;
    expect(audit.actionType).toBe('receiving_reversal');
    expect((audit.affectedItems as unknown[]).length).toBeGreaterThan(0);
    expect(db.__store.get('receivings/R1')!.status).toBe('cancelled');
    expect(db.__store.get('receivings/R1')!.reversedBy).toBe(res.serverReversalId);
  });
});

// ── Transfer reversal (Blockers 1, 5) ──
describe('resolveReversal — transfer state gate & lot coverage', () => {
  // ── H6-B (CEO Option A): `completed` is the live reversible state ──
  test("H6-C: 'completed' is the live reversible state → confirmed", async () => {
    const res = await performResolveReversal(seedTransfer({ status: 'completed' }) as never, trReq(), mgrB1);
    expect(res.status).toBe('confirmed');
  });
  test("H6-C: speculative 'sent'/'received' are NOT live-eligible → source_document_not_reversible", async () => {
    const sent = await performResolveReversal(seedTransfer({ status: 'sent' }) as never, trReq(), mgrB1);
    expect(sent.rejectCode).toBe('source_document_not_reversible');
    const received = await performResolveReversal(seedTransfer({ status: 'received' }) as never, trReq(), mgrB1);
    expect(received.rejectCode).toBe('source_document_not_reversible');
  });
  test('other state rejected; cancelled → already_reversed (before eligibility gate), zero mutation', async () => {
    const draft = await performResolveReversal(seedTransfer({ status: 'draft' }) as never, trReq(), mgrB1);
    expect(draft.rejectCode).toBe('source_document_not_reversible');
    const db = seedTransfer({ status: 'cancelled' });
    const cancelled = await performResolveReversal(db as never, trReq(), mgrB1);
    expect(cancelled.rejectCode).toBe('already_reversed');
    expect(db.__store.get('products/P1/productStocks/B2')!.totalStockBase).toBe(5); // dest untouched
    expect(db.__store.get('products/P1/productStocks/B1')).toBeUndefined(); // source not created
    expect(auditDocs(db)).toHaveLength(0); // no misleading audit
  });
  test('missing transfer doc → source_document_not_found', async () => {
    const res = await performResolveReversal(seedTransfer() as never, trReq({ sourceDocumentId: 'NOPE', idempotencyKey: 'kx' }), mgrB1);
    expect(res.rejectCode).toBe('source_document_not_found');
  });
  // ── `completed` is eligible but NOT unconditionally reversible ──
  test('H6-C: completed + dest stock counter insufficient → stock_conflict (zero mutation)', async () => {
    const db = seedTransfer({ status: 'completed', destStock: 3, destLotRemaining: 5 }); // counter 3 < transferQty 5
    const res = await performResolveReversal(db as never, trReq(), mgrB1);
    expect(res.rejectCode).toBe('stock_conflict');
    expect(db.__store.get('products/P1/productStocks/B2')!.totalStockBase).toBe(3); // dest untouched
    expect(db.__store.get('products/P1/productStocks/B1')).toBeUndefined(); // source not created
    expect(db.__store.get('stockLots/D1')!.qtyRemaining).toBe(5); // dest lot untouched
    expect(auditDocs(db)).toHaveLength(0);
  });
  test('H6-C: completed + dest counter ok but active lots insufficient → lot_conflict (zero mutation)', async () => {
    const db = seedTransfer({ status: 'completed', destStock: 5, destLotRemaining: 3 }); // counter 5 ok, lots only 3
    const res = await performResolveReversal(db as never, trReq(), mgrB1);
    expect(res.rejectCode).toBe('lot_conflict');
    expect(db.__store.get('products/P1/productStocks/B2')!.totalStockBase).toBe(5); // dest untouched
    expect(db.__store.get('products/P1/productStocks/B1')).toBeUndefined(); // source not created
    expect(auditDocs(db)).toHaveLength(0);
  });
  test('valid completed transfer reversal: dest removed, source restored, FIFO cost + receivedAt preserved, audit created', async () => {
    const db = seedTransfer({ status: 'completed' });
    const res = await performResolveReversal(db as never, trReq(), mgrB1);
    expect(res.status).toBe('confirmed');
    expect(db.__store.get('products/P1/productStocks/B2')!.totalStockBase).toBe(0);
    expect(db.__store.get('products/P1/productStocks/B1')!.totalStockBase).toBe(5);
    expect(db.__store.get('stockLots/D1')!.qtyRemaining).toBe(0);
    const restored = [...db.__store.entries()].filter(([p]) => p.startsWith('stockLots/') && db.__store.get(p)!.receivingId === res.serverReversalId).map(([, l]) => l);
    expect(restored).toHaveLength(1);
    expect(restored[0].costPerUnit).toBe(10); // original source costPerUnit preserved
    expect((restored[0].receivedAt as { seconds: number }).seconds).toBe(1); // original receivedAtMs 1000 preserved
    expect(db.__store.get(`reversalDocuments/${res.serverReversalId}`)!.actionType).toBe('transfer_reversal');
    // Source document marked cancelled/reversed only after the successful mutation.
    expect(db.__store.get('inventoryTransfers/T1')!.status).toBe('cancelled');
    expect(db.__store.get('inventoryTransfers/T1')!.reversedBy).toBe(res.serverReversalId);
    // Dual stock movements recorded (transfer_in at source, transfer_out at dest).
    const moves = [...db.__store.entries()].filter(([p]) => p.startsWith('stockMovements/')).map(([, m]) => m);
    expect(moves.some((m) => m.type === 'transfer_in' && m.branchId === 'B1')).toBe(true);
    expect(moves.some((m) => m.type === 'transfer_out' && m.branchId === 'B2')).toBe(true);
  });
  test('H6-C: oversell-remainder source lot detail is restored as a real source lot', async () => {
    const db = makeDb({
      ...USER_SEED,
      'inventoryTransfers/T1': { id: 'T1', fromBranchId: 'B1', toBranchId: 'B2', status: 'completed' },
      'inventoryTransfers/T1/transferItems/I1': { productId: 'P1', productName: 'P1', sku: 'P1', transferQty: 5, unitCost: 10, sourceLotDetails: [{ lotId: 'oversell', costPerUnit: 10, qty: 5, receivedAtMs: 1000 }] },
      'products/P1/productStocks/B2': { branchId: 'B2', totalStockBase: 5 },
      'stockLots/D1': { id: 'D1', productId: 'P1', branchId: 'B2', qtyRemaining: 5, qtyReceived: 5, isDepleted: false, receivedAt: { seconds: 1 }, costPerUnit: 10 },
    });
    const res = await performResolveReversal(db as never, trReq(), mgrB1);
    expect(res.status).toBe('confirmed');
    expect(db.__store.get('products/P1/productStocks/B1')!.totalStockBase).toBe(5);
    const restored = [...db.__store.entries()].filter(([p]) => p.startsWith('stockLots/') && db.__store.get(p)!.receivingId === res.serverReversalId).map(([, l]) => l);
    expect(restored).toHaveLength(1);
    expect(restored[0].qtyRemaining).toBe(5);
    expect(restored[0].costPerUnit).toBe(10);
  });
  // ── Idempotency / authority parity for the transfer path ──
  test('H6-C: duplicate same key + payload → duplicate_confirmed, no second mutation/audit', async () => {
    const db = seedTransfer({ status: 'completed' });
    const r1 = await performResolveReversal(db as never, trReq(), mgrB1);
    const r2 = await performResolveReversal(db as never, trReq(), mgrB1);
    expect(r2.status).toBe('duplicate_confirmed');
    expect(r2.serverReversalId).toBe(r1.serverReversalId);
    expect(db.__store.get('products/P1/productStocks/B1')!.totalStockBase).toBe(5); // not restored twice
    expect(auditDocs(db)).toHaveLength(1);
  });
  test('H6-C: already reversed by DIFFERENT key → already_reversed (status now cancelled)', async () => {
    const db = seedTransfer({ status: 'completed' });
    await performResolveReversal(db as never, trReq(), mgrB1);
    const res = await performResolveReversal(db as never, trReq({ idempotencyKey: 'other-key', localIntentId: 'LI9' }), mgrB1);
    expect(res.rejectCode).toBe('already_reversed');
  });
  test('H6-C: Staff WRONG pin on completed transfer → invalid_pin (zero mutation)', async () => {
    const db = seedTransfer({ status: 'completed' });
    const res = await performResolveReversal(db as never, trReq({ pin: '9999' }), staffB1);
    expect(res.rejectCode).toBe('invalid_pin');
    expect(db.__store.get('products/P1/productStocks/B2')!.totalStockBase).toBe(5);
    expect(db.__store.get('products/P1/productStocks/B1')).toBeUndefined();
  });
});

// ── H4: stale-client guard (server-authoritative staleness rejection) ──
describe('resolveReversal — H4 stale client guard', () => {
  // Server doc's updatedAt = 2,000,000 ms; observations bracket it.
  const SERVER_UPDATED = { seconds: 2000 };
  const STALE_OBS = new Date(1_000_000).toISOString(); // older than server → stale
  const FRESH_OBS = new Date(2_000_000).toISOString(); // equal instant → fresh (strict >)
  const NEWER_OBS = new Date(3_000_000).toISOString(); // newer than server → fresh
  const intentDocs = (db: ReturnType<typeof makeDb>) =>
    [...db.__store.entries()].filter(([p]) => /^reversalIntents\/[^/]+$/.test(p));
  const lot = (db: ReturnType<typeof makeDb>) => db.__store.get('stockLots/L1')!;

  test('absent observation → guard skipped, fresh reversal still confirms (no regression)', async () => {
    const db = seedReceiving({ updatedAt: SERVER_UPDATED });
    const res = await performResolveReversal(db as never, recReq(), mgrB1);
    expect(res.status).toBe('confirmed');
    expect(recStock(db)).toBe(0);
  });

  test('observation at/after server updatedAt → fresh → confirmed', async () => {
    const equal = seedReceiving({ updatedAt: SERVER_UPDATED });
    const r1 = await performResolveReversal(equal as never, recReq({ clientObservedDocumentUpdatedAt: FRESH_OBS }), mgrB1);
    expect(r1.status).toBe('confirmed');

    const newer = seedReceiving({ updatedAt: SERVER_UPDATED });
    const r2 = await performResolveReversal(newer as never, recReq({ clientObservedDocumentUpdatedAt: NEWER_OBS }), mgrB1);
    expect(r2.status).toBe('confirmed');
  });

  test('stale observation → rejected with structured stale_client_observation', async () => {
    const db = seedReceiving({ updatedAt: SERVER_UPDATED });
    const res = await performResolveReversal(db as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('rejected');
    expect(res.rejectCode).toBe('stale_client_observation');
    expect(typeof res.message).toBe('string');
    expect(res.serverReversalId).toBeUndefined();
  });

  test('stale rejection is deterministic (same inputs → identical result)', async () => {
    const a = await performResolveReversal(seedReceiving({ updatedAt: SERVER_UPDATED }) as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    const b = await performResolveReversal(seedReceiving({ updatedAt: SERVER_UPDATED }) as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    expect(a).toEqual(b);
  });

  test('stale rejection mutates ZERO stock and ZERO lots', async () => {
    const db = seedReceiving({ updatedAt: SERVER_UPDATED });
    await performResolveReversal(db as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    expect(recStock(db)).toBe(10); // stock untouched
    expect(lot(db).qtyRemaining).toBe(10); // lot untouched
    expect(lot(db).isDepleted).toBe(false);
  });

  test('stale rejection does NOT advance reversal/manual-review state', async () => {
    const db = seedReceiving({ updatedAt: SERVER_UPDATED });
    await performResolveReversal(db as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    const rec = db.__store.get('receivings/R1')!;
    expect(rec.status).toBe('completed'); // not cancelled
    expect(rec.reversedBy).toBeUndefined(); // not resolved
  });

  test('stale rejection writes NO audit doc and NO intent ledger entry', async () => {
    const db = seedReceiving({ updatedAt: SERVER_UPDATED });
    await performResolveReversal(db as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    expect(auditDocs(db)).toHaveLength(0);
    expect(intentDocs(db)).toHaveLength(0);
  });

  test('repeated stale attempts remain idempotent and safe (no cumulative effect)', async () => {
    const db = seedReceiving({ updatedAt: SERVER_UPDATED });
    for (let i = 0; i < 3; i++) {
      const res = await performResolveReversal(db as never, recReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
      expect(res.rejectCode).toBe('stale_client_observation');
    }
    expect(recStock(db)).toBe(10);
    expect(lot(db).qtyRemaining).toBe(10);
    expect(db.__store.get('receivings/R1')!.status).toBe('completed');
    expect(auditDocs(db)).toHaveLength(0);
    expect(intentDocs(db)).toHaveLength(0);
  });

  test('transfer reversal: stale observation → rejected, dest stock untouched', async () => {
    const db = seedTransfer({ status: 'completed', updatedAt: SERVER_UPDATED });
    const res = await performResolveReversal(db as never, trReq({ clientObservedDocumentUpdatedAt: STALE_OBS }), mgrB1);
    expect(res.rejectCode).toBe('stale_client_observation');
    expect(res.status).toBe('rejected');
    expect(db.__store.get('products/P1/productStocks/B2')!.totalStockBase).toBe(5); // dest untouched
    expect(db.__store.get('products/P1/productStocks/B1')).toBeUndefined(); // source not created
    expect(db.__store.get('inventoryTransfers/T1')!.status).toBe('completed'); // state not advanced
  });

  test('transfer reversal: fresh observation → confirmed', async () => {
    const db = seedTransfer({ status: 'completed', updatedAt: SERVER_UPDATED });
    const res = await performResolveReversal(db as never, trReq({ clientObservedDocumentUpdatedAt: FRESH_OBS }), mgrB1);
    expect(res.status).toBe('confirmed');
  });
});

// ── Unsupported scope ──
describe('resolveReversal — unsupported scope', () => {
  test('inventory adjustment reversal → unsupported_action_type', async () => {
    const res = await performResolveReversal(seedReceiving() as never, { ...recReq(), actionType: 'adjustment_reversal' } as ResolveReversalRequest, mgrB1);
    expect(res.rejectCode).toBe('unsupported_action_type');
  });
  test('returns/RTV → unsupported_action_type', async () => {
    const res = await performResolveReversal(seedReceiving() as never, { ...recReq(), actionType: 'return_reversal' } as ResolveReversalRequest, mgrB1);
    expect(res.rejectCode).toBe('unsupported_action_type');
  });
  test('missing reasonCode → invalid_payload', async () => {
    const res = await performResolveReversal(seedReceiving() as never, recReq({ reasonCode: '' }), mgrB1);
    expect(res.rejectCode).toBe('invalid_payload');
  });
});
