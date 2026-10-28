// @vitest-environment jsdom
// Packet 023 parity remediation (Codex REQUEST_CHANGES_MASTER_PLAN_PARITY_BLOCKER):
// after shift A is closed OFFLINE by the server-authoritative close (deferred —
// no client W3, so A's cached and server doc stay `open`), the SAME device,
// still offline, must be able to open a DIFFERENT shift B and work in it
// (restart in between included), while A stays a pending local close that only
// its owner's session can get confirmed by the server.
//
// Over: the REAL IndexedDB close + open journals (`fake-indexeddb`; "restart" =
// new journal instances over the same databases), the REAL `openShift` /
// `getActiveShift` / `readActiveShiftForBoot` / `recordCashTransaction`, a
// multi-document Firestore fake that separates this device's CACHE (incl. its
// queued writes) from the SERVER, and a FAITHFUL `closeShiftAuthoritative`
// decided by the production core (functions/src/closeShiftAuthoritativeCore.ts).
// The POS screen / checkout acceptance is POSPage.deferredCloseContinuity.test.tsx.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import type { LocalSale } from './localLedger';
import { deriveShiftDrawer } from './shiftLedger';
import { SHIFT_CLOSE_INTENT_DB_NAME, createShiftCloseIntentJournal, type ShiftCloseIntentJournal } from './offline/shiftCloseIntentStore';
import { createShiftOpenIntentJournal } from './offline/shiftOpenIntentStore';
import {
  runShiftCloseReconciliationSweep,
  shiftCloseConfirmationDocFromData,
  type ReconcileShiftCloseIntentDeps,
} from './offline/shiftCloseReconciler';
import {
  buildAuthorityRecord,
  canonicalResponseFromDurable,
  decideClosedShiftReplay,
  deriveCloseRequestDigest,
  foldShiftCashEntriesStrict,
  parseOpenShiftIdentity,
  planAuthoritativeClose,
  validateCloseShiftRequest,
  verifyRefundAudit,
} from '../../../functions/src/closeShiftAuthoritativeCore';

vi.mock('../firebase', () => ({
  isFirebaseConfigured: true,
  db: {} as unknown,
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

type Doc = Record<string, unknown>;
const fs = vi.hoisted(() => ({
  online: false,
  /** This device's local cache, INCLUDING its own queued (unflushed) writes. */
  cache: new Map<string, Record<string, unknown>>(),
  /** What the server holds. */
  server: new Map<string, Record<string, unknown>>(),
  /** Writes queued while offline, flushed (in order) by `flush()`. */
  queue: [] as Array<{ id: string; apply: (d: Record<string, unknown> | undefined) => Record<string, unknown> }>,
  writes: [] as Array<{ op: 'setDoc' | 'updateDoc'; collection: string; id: string }>,
  autoId: 0,
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  type Ref = { collection: string; id: string };
  type Q = { constraints: Array<{ field?: string; value?: unknown; limit?: number }> };
  const matches = (q: Q, d: Record<string, unknown>) =>
    q.constraints.every((c) => c.field === undefined || d[c.field] === c.value);
  const snapOf = (source: Map<string, Record<string, unknown>>, q: Q, fromCache: boolean) => {
    const lim = q.constraints.find((c) => c.limit !== undefined)?.limit ?? Infinity;
    const docs = [...source.entries()]
      .filter(([, d]) => matches(q, d))
      .slice(0, lim)
      .map(([id, d]) => ({ id, data: () => ({ ...d }) }));
    return { empty: docs.length === 0, docs, metadata: { fromCache } };
  };
  const write = (ref: Ref, op: 'setDoc' | 'updateDoc', apply: (d: Record<string, unknown> | undefined) => Record<string, unknown>) => {
    fs.writes.push({ op, collection: ref.collection, id: ref.id });
    if (ref.collection !== 'shifts') return Promise.resolve();
    fs.cache.set(ref.id, apply(fs.cache.get(ref.id)));
    if (fs.online) {
      fs.server.set(ref.id, apply(fs.server.get(ref.id)));
      return Promise.resolve();
    }
    fs.queue.push({ id: ref.id, apply });
    return new Promise<void>(() => undefined); // never acknowledged while offline
  };
  const resolveFields = (payload: Record<string, unknown>, base: Record<string, unknown> | undefined) => {
    const out: Record<string, unknown> = { ...(base ?? {}) };
    for (const [k, v] of Object.entries(payload)) {
      const union = (v as { __arrayUnion?: unknown[] } | null)?.__arrayUnion;
      out[k] = union ? [...((out[k] as unknown[]) ?? []), ...union] : v;
    }
    return out;
  };
  return {
    ...actual,
    collection: vi.fn((_db: unknown, name: string) => ({ collection: name })),
    doc: vi.fn((a: unknown, b?: string, id?: string) =>
      b === undefined
        ? { collection: (a as { collection: string }).collection, id: `auto-${(fs.autoId += 1)}` }
        : { collection: b, id: id! },
    ),
    query: vi.fn((_c: unknown, ...constraints: unknown[]) => ({ constraints })),
    where: vi.fn((field: string, _op: string, value: unknown) => ({ field, value })),
    limit: vi.fn((n: number) => ({ limit: n })),
    arrayUnion: vi.fn((...items: unknown[]) => ({ __arrayUnion: items })),
    increment: vi.fn((n: number) => n),
    serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
    getDocs: vi.fn(async (q: Q) => (fs.online ? snapOf(fs.server, q, false) : snapOf(fs.cache, q, true))),
    getDocsFromCache: vi.fn(async (q: Q) => snapOf(fs.cache, q, true)),
    getDocFromCache: vi.fn(async (ref: Ref) => {
      const d = fs.cache.get(ref.id);
      return { exists: () => d !== undefined, data: () => (d ? { ...d } : undefined) };
    }),
    getDocFromServer: vi.fn(async (ref: Ref) => {
      if (!fs.online) throw Object.assign(new Error('offline'), { code: 'unavailable' });
      const d = fs.server.get(ref.id);
      return { exists: () => d !== undefined, data: () => (d ? { ...d } : undefined) };
    }),
    setDoc: vi.fn((ref: Ref, payload: Record<string, unknown>) => write(ref, 'setDoc', () => resolveFields(payload, undefined))),
    updateDoc: vi.fn((ref: Ref, payload: Record<string, unknown>) => write(ref, 'updateDoc', (d) => resolveFields(payload, d))),
    runTransaction: vi.fn(async () => {
      throw new Error('no client transaction expected in this suite');
    }),
  };
});

vi.mock('./deviceId', async (importOriginal) => ({ ...(await importOriginal<typeof import('./deviceId')>()), getDeviceId: vi.fn(() => 'DEV1') }));

import { SERVER_AUTHORITATIVE_CLOSE_ENABLED, buildReviewedDrawerWitness } from './shiftCloseAuthoritativeClient';
import {
  ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE,
  ActiveShiftUnavailableError,
  closeShift,
  getActiveShift,
  openShift,
  readActiveShiftForBoot,
  recordCashTransaction,
  type CloseShiftDeps,
} from './shiftService';

const UUIDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
const CLOSED_AT_MS = Date.parse('2026-10-27T22:00:00Z');
const BRANCH = 'LDP-001';
const X = 'staff-x';
const Y = 'staff-y';

function flush() {
  fs.online = true;
  for (const w of fs.queue.splice(0)) fs.server.set(w.id, w.apply(fs.server.get(w.id)));
}

function sale(id: string, shiftId: string, cash: number, staffId = X): LocalSale {
  return {
    id, billId: `R-${id}`, deviceId: 'DEV1', shiftId, staffId, staffName: staffId, customerId: null, status: 'completed',
    reconcileStatus: 'settled', total: cash, paidAmt: cash, changeAmt: 0, creditAmt: 0, payments: [{ method: 'cash', amount: cash }],
    pendingSync: true, clientCreatedAt: 1, occurredAt: 1, sortSeq: 1,
  } as unknown as LocalSale;
}

function shiftDoc(id: string, staffId: string, over: Doc = {}): Doc {
  return {
    id, branchId: BRANCH, staffId, staffName: staffId, status: 'open', openedAt: { toMillis: () => 1 }, closedAt: null,
    startingCash: 500, actualCashCount: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
    totalBills: 0, payInTotal: 0, payOutTotal: 0, variance: 0, note: '', cashEntries: [], ...over,
  };
}

function asShift(d: Doc): Shift {
  return { ...(d as unknown as Shift) };
}

/** Faithful callable for ANY shift on the fake server; the caller is the device's current session. */
function createServer() {
  const records = new Map<string, Doc>();
  const calls: Array<{ request: Doc; caller: string | null }> = [];
  const session = { staffId: X as string | null };
  async function callable(request: Record<string, unknown>): Promise<unknown> {
    const raw = JSON.parse(JSON.stringify(request)) as Doc;
    calls.push({ request: raw, caller: session.staffId });
    if (session.staffId === null) return { ok: false, code: 'unauthenticated' };
    const v = validateCloseShiftRequest(raw);
    if (!v.ok) return v;
    const req = v.value;
    const digest = deriveCloseRequestDigest(req);
    const shiftData = fs.server.get(req.shiftId);
    if (!shiftData) return { ok: false, code: 'shift_not_found' };
    if (shiftData.staffId !== session.staffId) return { ok: false, code: 'not_shift_owner' };
    const record = records.get(req.shiftId) ?? null;
    if (shiftData.status === 'closed') return decideClosedShiftReplay({ shiftData, record, request: req, requestDigest: digest });
    const identity = parseOpenShiftIdentity(req.shiftId, shiftData);
    if (!identity.ok) return identity;
    const cash = foldShiftCashEntriesStrict(shiftData.cashEntries, 'cashEntries' in shiftData);
    if (!cash.ok) return cash;
    const audit = verifyRefundAudit({ shift: identity.value, refunds: [], returns: [], serverRefundEntries: cash.value.serverRefundEntries });
    if (!audit.ok) return audit;
    const plan = planAuthoritativeClose({ shift: identity.value, request: req, cash: cash.value });
    if (!plan.ok) return plan;
    const closedAt = { toMillis: () => CLOSED_AT_MS, toDate: () => new Date(CLOSED_AT_MS) };
    const next = { ...shiftData, ...plan.value.w3Fields, closedAt };
    fs.server.set(req.shiftId, next);
    const rec = {
      ...buildAuthorityRecord({ request: req, requestDigest: digest, plan: plan.value, cash: cash.value, audit: audit.value, callerStaffId: session.staffId, nowMillis: CLOSED_AT_MS }),
      closedAt,
    };
    records.set(req.shiftId, rec);
    return canonicalResponseFromDurable({ shiftData: next, record: rec, idempotentReplay: false });
  }
  return { callable, calls, records, session };
}

function closeJournal(): ShiftCloseIntentJournal {
  const ids = [...UUIDS];
  return createShiftCloseIntentJournal({ generateCloseCorrelationId: () => ids.shift() ?? null });
}

/** Close `shiftId` OFFLINE through the gate-ON server-authoritative close (deferred). */
async function closeOfflineDeferred(journal: ShiftCloseIntentJournal, shiftId: string, staffId: string, sales: LocalSale[], count: number) {
  const shown = deriveShiftDrawer(asShift(fs.cache.get(shiftId)!), sales);
  const deps = {
    journal,
    isOnline: () => false,
    serverCashPending: { has: () => false, clear: vi.fn() },
    authoritativeCloseGate: true,
    authoritativeClose: { sales, reviewedDrawer: buildReviewedDrawerWitness(shown, 'unavailable') },
  } as unknown as CloseShiftDeps;
  void staffId;
  return closeShift(shown, count, '', deps);
}

async function openB(staffId: string, journals: { open?: ReturnType<typeof createShiftOpenIntentJournal>; close: ShiftCloseIntentJournal }) {
  return openShift(BRANCH, staffId, staffId, 300, {
    journal: journals.open ?? createShiftOpenIntentJournal(),
    closeJournal: journals.close,
    readConfirmation: async () => ({ ok: false }),
  });
}

function sweepDeps(server: ReturnType<typeof createServer>, journal: ShiftCloseIntentJournal): ReconcileShiftCloseIntentDeps {
  return {
    journal,
    deviceId: 'DEV1',
    readConfirmation: async (id) => {
      const d = fs.server.get(id);
      return d ? { ok: true, doc: shiftCloseConfirmationDocFromData({ ...d }) } : { ok: true, doc: { exists: false } };
    },
    normalizeSyncState: async (id) => {
      const d = fs.server.get(id)!;
      if (d.syncState === 'synced') return 'already_synced';
      fs.server.set(id, { ...d, syncState: 'synced' });
      return 'written';
    },
    authoritativeCallable: server.callable,
    deferredReplay: {
      readServerShift: async (id) => {
        if (!fs.online) return { ok: false };
        const d = fs.server.get(id);
        return d ? { ok: true, exists: true, data: { ...d } } : { ok: true, exists: false };
      },
      waitForQueuedWrites: async () => fs.online && fs.queue.length === 0,
      sessionStaffId: async () => server.session.staffId,
    },
  };
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

const SALES_A = [sale('a1', 'A', 400), sale('a2', 'A', 600)];

/** Shift A of cashier X, synced earlier (server + cache), now closed OFFLINE (deferred) for 1500 (= 500 + 1000). */
async function worldWithDeferredA(journal = closeJournal()) {
  const a = shiftDoc('A', X);
  fs.server.set('A', a);
  fs.cache.set('A', { ...a });
  fs.online = false;
  const local = await closeOfflineDeferred(journal, 'A', X, SALES_A, 1500);
  expect(local.authoritativeDeferred).toBe(true);
  return journal;
}

beforeEach(async () => {
  for (const name of [SHIFT_CLOSE_INTENT_DB_NAME, 'twinpet-shift-open-intents', 'twinpet_shift_open_intents']) await deleteDb(name);
  // the open-intent DB name is module-private: wipe every database fake-indexeddb knows
  const dbs = (await indexedDB.databases?.()) ?? [];
  for (const d of dbs) if (d.name) await deleteDb(d.name);
  fs.online = false;
  fs.cache.clear();
  fs.server.clear();
  fs.queue.length = 0;
  fs.writes.length = 0;
  fs.autoId = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('023-P1/P2 offline continuity: A closed offline (pending) → B opens and works, same device, still offline', () => {
  test('[RED at the pre-remediation 023 source] same cashier, restart between A and B: boot finds no open shift to restore (A is never restored), B opens with a NEW id', async () => {
    await worldWithDeferredA();
    // restart: fresh journals over the same IndexedDB
    const close = createShiftCloseIntentJournal();
    const listed = await close.listCloseIntents();
    expect(listed.ok && listed.value.map((e) => [e.shiftId, e.status])).toEqual([['A', 'local_closed_pending']]);
    // boot read (offline, cache still says A is `open`): A is excluded, not restored, not "unverifiable"
    const boot = await readActiveShiftForBoot(BRANCH, X, new Set(['A']));
    expect(boot).toEqual({ status: 'absent', provenance: 'local_close_record' });
    const b = await openB(X, { close });
    expect(b.id).not.toBe('A');
    expect(b).toMatchObject({ status: 'open', staffId: X, branchId: BRANCH, startingCash: 300, openedOffline: true, syncState: 'pending' });
    // B's W0 is queued on B's own doc; nothing was ever written to A
    expect(fs.writes.filter((w) => w.collection === 'shifts').map((w) => w.id)).toEqual([b.id]);
    expect(fs.cache.get('A')?.status).toBe('open');
    expect((await close.getCloseIntent('A')).ok).toBe(true);
  });

  test('[RED at the pre-remediation 023 source] different cashier without restart (X closed A; Y signed in, network then lost): Y opens B — A is not an obstacle and stays pending', async () => {
    const close = await worldWithDeferredA();
    const b = await openB(Y, { close });
    expect(b).toMatchObject({ staffId: Y, status: 'open' });
    expect(b.id).not.toBe('A');
    expect((await close.getCloseIntent('A')).ok && (await close.getCloseIntent('A'))).toMatchObject({ value: { status: 'local_closed_pending' } });
  });

  test('[RED at the pre-remediation 023 source] A itself was opened OFFLINE (pending open intent): after its deferred close it is never resumed or restored — B gets a new id', async () => {
    const open = createShiftOpenIntentJournal();
    const close = closeJournal();
    const a = await openB(X, { open, close }); // A opened offline (W0 queued, intent pending)
    expect((await open.findPendingOpenForStaff(BRANCH, X, 'DEV1'))).toMatchObject({ ok: true, value: { shiftId: a.id } });
    await closeOfflineDeferred(close, a.id, X, [sale('a1', a.id, 100)], 400);
    // boot: the pending open of A is not offered for restore any more
    const restartedOpen = createShiftOpenIntentJournal();
    expect(await restartedOpen.findPendingOpenForStaff(BRANCH, X, 'DEV1', new Set([a.id]))).toEqual({ ok: true, value: undefined });
    const b = await openB(X, { open: restartedOpen, close: createShiftCloseIntentJournal() });
    expect(b.id).not.toBe(a.id);
  });

  test('B operates in its own shift: cash movements go to B\'s doc, getActiveShift resolves B (never A), A\'s recorded close is unchanged', async () => {
    const close = await worldWithDeferredA();
    const before = (await close.getCloseIntent('A'));
    const b = await openB(X, { close });
    expect((await getActiveShift(BRANCH, X, { closeJournal: close }))?.id).toBe(b.id);
    recordCashTransaction({ shiftId: b.id, branchId: BRANCH, staffId: X, staffName: X, type: 'pay_in', amount: 50, note: 'เงินทอน' });
    expect(fs.writes.filter((w) => w.collection === 'shifts' && w.id === 'A')).toEqual([]);
    expect((fs.cache.get(b.id)?.cashEntries as ShiftCashEntry[]).map((e) => e.amount)).toEqual([50]);
    expect(await close.getCloseIntent('A')).toEqual(before);
  });

  test('with only A in the cache, getActiveShift returns no shift (a refund / credit payment is never attached to locally-closed A)', async () => {
    const close = await worldWithDeferredA();
    expect(await getActiveShift(BRANCH, X, { closeJournal: close })).toBeNull();
  });

  test('DEC-08 unchanged: a cache that returns NOTHING is still unverifiable (no absence is invented without a local close record)', async () => {
    fs.online = false;
    expect(await readActiveShiftForBoot(BRANCH, Y, new Set(['A']))).toEqual({ status: 'unverifiable', reason: 'cache_empty' });
    expect(await readActiveShiftForBoot(BRANCH, Y)).toEqual({ status: 'unverifiable', reason: 'cache_empty' });
  });

  test('a cached open shift that is NOT locally closed is still restored (found), even when A is excluded', async () => {
    await worldWithDeferredA();
    fs.cache.set('B0', shiftDoc('B0', X));
    const boot = await readActiveShiftForBoot(BRANCH, X, new Set(['A']));
    expect(boot).toMatchObject({ status: 'found', provenance: 'cache', shift: { id: 'B0' } });
  });
});

/** `journal` whose list read fails — `{ok:false}` or a thrown read — like a locked / corrupt IndexedDB. */
function unreadable(journal: ShiftCloseIntentJournal, how: 'not_ok' | 'throws'): ShiftCloseIntentJournal {
  return {
    ...journal,
    listCloseIntents: vi.fn(async () => {
      if (how === 'throws') throw new Error('IndexedDB read failed');
      return { ok: false as const, code: 'tx_failed' as const, message: 'IndexedDB read failed' };
    }),
  };
}

const GATE_ON = { authoritativeCloseGate: true } as const;

describe('023 fail-closed (Codex re-review): gate ON, an unreadable close journal never resolves a shift', () => {
  test.each(['not_ok', 'throws'] as const)(
    '[RED at the pre-remediation 023 source] A closed locally, B open, journal read %s: getActiveShift refuses (ActiveShiftUnavailableError) — never A, never B, never null',
    async (how) => {
      const close = await worldWithDeferredA();
      const b = await openB(X, { close });
      // the cache lists A FIRST (still `open`, no client W3), then B
      expect([...fs.cache.keys()]).toEqual(['A', b.id]);
      const failing = unreadable(close, how);
      const got = getActiveShift(BRANCH, X, { closeJournal: failing, ...GATE_ON });
      await expect(got).rejects.toBeInstanceOf(ActiveShiftUnavailableError);
      await expect(got).rejects.toThrow(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE);
      expect(failing.listCloseIntents).toHaveBeenCalledTimes(1);
      // nothing was written anywhere, A's local close is intact
      expect(fs.writes.filter((w) => w.id === 'A')).toEqual([]);
      expect(await close.getCloseIntent('A')).toMatchObject({ ok: true, value: { status: 'local_closed_pending' } });
    },
  );

  test.each(['not_ok', 'throws'] as const)(
    '[RED at the pre-remediation 023 source] A (closed locally) is the ONLY open shift in the cache, journal read %s: still refuses — no A fallback',
    async (how) => {
      const close = await worldWithDeferredA();
      expect([...fs.cache.keys()]).toEqual(['A']);
      await expect(getActiveShift(BRANCH, X, { closeJournal: unreadable(close, how), ...GATE_ON })).rejects.toBeInstanceOf(
        ActiveShiftUnavailableError,
      );
    },
  );

  test('positive control: the readable journal (A closed locally, B open) resolves B; with A alone it resolves no shift', async () => {
    const close = await worldWithDeferredA();
    expect(await getActiveShift(BRANCH, X, { closeJournal: close, ...GATE_ON })).toBeNull();
    const b = await openB(X, { close });
    expect((await getActiveShift(BRANCH, X, { closeJournal: close, ...GATE_ON }))?.id).toBe(b.id);
  });

  test('a transient read failure leaves nothing behind: the next read (restart = new journal over the same IndexedDB) resolves B', async () => {
    const close = await worldWithDeferredA();
    const b = await openB(X, { close });
    await expect(getActiveShift(BRANCH, X, { closeJournal: unreadable(close, 'throws'), ...GATE_ON })).rejects.toBeInstanceOf(
      ActiveShiftUnavailableError,
    );
    expect((await getActiveShift(BRANCH, X, { closeJournal: createShiftCloseIntentJournal(), ...GATE_ON }))?.id).toBe(b.id);
  });

  test('positive control: a READABLE EMPTY journal keeps the legacy semantics — legacy query (limit 1), first open shift; none open ⇒ null', async () => {
    const { limit } = await import('firebase/firestore');
    vi.mocked(limit).mockClear();
    expect(await getActiveShift(BRANCH, X, { closeJournal: closeJournal(), ...GATE_ON })).toBeNull();
    fs.cache.set('L', shiftDoc('L', X));
    expect(await getActiveShift(BRANCH, X, { closeJournal: closeJournal(), ...GATE_ON })).toMatchObject({ id: 'L' });
    expect(vi.mocked(limit).mock.calls.map(([n]) => n)).toEqual([1, 1]);
  });

  test.each(['not_ok', 'throws'] as const)(
    'gate OFF (the shipped default) unchanged: journal read %s ⇒ the legacy read (limit 1, first open shift), as at c8f18f8',
    async (how) => {
      expect(SERVER_AUTHORITATIVE_CLOSE_ENABLED).toBe(false);
      const { limit } = await import('firebase/firestore');
      vi.mocked(limit).mockClear();
      fs.cache.set('L', shiftDoc('L', X));
      expect(await getActiveShift(BRANCH, X, { closeJournal: unreadable(closeJournal(), how) })).toMatchObject({ id: 'L' });
      expect(await getActiveShift(BRANCH, Y, { closeJournal: unreadable(closeJournal(), how) })).toBeNull();
      expect(vi.mocked(limit).mock.calls.map(([n]) => n)).toEqual([1, 1]);
    },
  );
});

describe('023-P3/P4 reconciliation of A after B exists (owner-only D7, A\'s own data)', () => {
  test('owner X absent (Y signed in): A is never sent under Y — awaiting the owner; B keeps working', async () => {
    const close = await worldWithDeferredA();
    const b = await openB(Y, { close });
    flush(); // reconnect: B's W0 reaches the server
    const server = createServer();
    server.session.staffId = Y;
    const results = await runShiftCloseReconciliationSweep(sweepDeps(server, close));
    expect(results.find((r) => r.shiftId === 'A')).toMatchObject({ deferred: 'awaiting_owner_session' });
    expect(server.calls).toEqual([]);
    expect(fs.server.get('A')?.status).toBe('open');
    expect(fs.server.get(b.id)).toMatchObject({ status: 'open', staffId: Y });
    expect(results.normalization.attention).toContainEqual({ shiftId: 'A', branchId: BRANCH, condition: 'deferred_close_awaiting_owner' });
  });

  test('owner X returns later: A is replayed with A\'s own request / UUID / drawer and confirmed; B (same cashier, open, with its own pay-in) is untouched', async () => {
    const close = await worldWithDeferredA();
    const entryA = (await close.getCloseIntent('A'));
    const b = await openB(X, { close });
    recordCashTransaction({ shiftId: b.id, branchId: BRANCH, staffId: X, staffName: X, type: 'pay_in', amount: 50, note: 'เงินทอน' });
    flush();
    const server = createServer();
    const results = await runShiftCloseReconciliationSweep(sweepDeps(server, close));
    expect(results.find((r) => r.shiftId === 'A')).toMatchObject({ outcome: 'confirmed', deferred: 'confirmed' });
    expect(server.calls.map((c) => [c.request.shiftId, c.request.closeCorrelationId, c.request.actualCashCount, c.caller])).toEqual([
      ['A', entryA.ok && entryA.value?.closeCorrelationId, 1500, X],
    ]);
    expect(fs.server.get('A')).toMatchObject({ status: 'closed', payInTotal: 0, variance: 0, syncState: 'synced' });
    expect(fs.server.get(b.id)).toMatchObject({ status: 'open', cashEntries: [expect.objectContaining({ amount: 50 })] });
    expect(server.records.has(b.id)).toBe(false);
    // a second sweep: nothing more for A (synced), and B is never closed by the sweep
    await runShiftCloseReconciliationSweep(sweepDeps(server, close));
    expect(server.calls).toHaveLength(1);
    expect(fs.server.get(b.id)?.status).toBe('open');
  });

  test('lost response then replay: same UUID, ONE authority record for A, B unaffected', async () => {
    const close = await worldWithDeferredA();
    const b = await openB(X, { close });
    flush();
    const server = createServer();
    const real = server.callable;
    let first = true;
    const lossy = async (r: Record<string, unknown>) => {
      const out = await real(r);
      if (first) {
        first = false;
        throw Object.assign(new Error('deadline'), { code: 'functions/deadline-exceeded' });
      }
      return out;
    };
    const deps = { ...sweepDeps(server, close), authoritativeCallable: lossy };
    expect((await runShiftCloseReconciliationSweep(deps)).find((r) => r.shiftId === 'A')?.deferred).toBe('unreachable');
    expect((await runShiftCloseReconciliationSweep(deps)).find((r) => r.shiftId === 'A')?.deferred).toBe('confirmed');
    expect(new Set(server.calls.map((c) => c.request.closeCorrelationId)).size).toBe(1);
    expect(server.records.size).toBe(1);
    expect(fs.server.get(b.id)?.status).toBe('open');
  });
});

describe('023-P5 A rejected: durable attention, no Z, B and its data persist', () => {
  test('A\'s server drawer changed (a pay-out elsewhere) → A rejected (attention every sweep), nothing sent; B still opens / is found; B is not rolled back', async () => {
    const close = await worldWithDeferredA();
    const b = await openB(X, { close });
    flush();
    fs.server.set('A', { ...fs.server.get('A')!, cashEntries: [{ id: 'po_1', type: 'pay_out', amount: 20, note: 'x', staffId: X, staffName: X, at: 2 }] });
    const server = createServer();
    const results = await runShiftCloseReconciliationSweep(sweepDeps(server, close));
    expect(results.find((r) => r.shiftId === 'A')).toMatchObject({ deferred: 'rejected', deferredReason: 'drawer_changed' });
    expect(server.calls).toEqual([]);
    expect((await close.getCloseIntent('A'))).toMatchObject({ ok: true, value: { status: 'rejected_manual_attention' } });
    const again = await runShiftCloseReconciliationSweep(sweepDeps(server, close));
    expect(again.normalization.attention).toContainEqual({ shiftId: 'A', branchId: BRANCH, condition: 'deferred_close_rejected' });
    expect(again.normalization.status).toBe('unresolved');
    expect(server.calls).toEqual([]); // no retry / spin of a rejected close
    // B remains this cashier's working shift (online boot read: A is still open on the server but locally closed)
    expect(await readActiveShiftForBoot(BRANCH, X, new Set(['A']))).toMatchObject({ status: 'found', shift: { id: b.id } });
    expect(fs.server.get(b.id)?.status).toBe('open');
    // and a later shift can still be opened after B (A's rejection blocks only A)
    expect((await openB(Y, { close })).id).not.toBe(b.id);
  });
});

describe('023-P8 legacy guards unchanged', () => {
  test('a LEGACY pending close whose cached shift still reads open still refuses a new open (PK-1 guard unchanged)', async () => {
    const close = closeJournal();
    fs.cache.set('L', shiftDoc('L', X));
    const r = await close.upsertCloseIntent({
      shiftId: 'L', branchId: BRANCH, staffId: X, staffName: X, startingCash: 500, expectedCash: 0, expectedQr: 0, expectedKbank: 0,
      expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 0, actualCashCount: 500, variance: 0, note: '', deviceId: 'DEV1',
    });
    expect(r.ok).toBe(true);
    await expect(openB(X, { close })).rejects.toThrow('มีกะที่ปิดค้างอยู่ในเครื่องนี้และยังยืนยันสถานะไม่ได้');
  });

  test('a LEGACY rejected close still blocks a new open (PK-1 guard unchanged)', async () => {
    const close = closeJournal();
    fs.cache.set('L', shiftDoc('L', X, { status: 'closed' }));
    await close.upsertCloseIntent({
      shiftId: 'L', branchId: BRANCH, staffId: X, staffName: X, startingCash: 500, expectedCash: 0, expectedQr: 0, expectedKbank: 0,
      expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 0, actualCashCount: 500, variance: 0, note: '', deviceId: 'DEV1',
    });
    await close.markRejectedManualAttention('L', 'denied');
    await expect(openB(X, { close })).rejects.toThrow('การปิดกะก่อนหน้านี้ต้องตรวจสอบ');
  });

  test('without any deferred record the boot read and getActiveShift issue the legacy query (limit 1) and return the first open shift', async () => {
    const { limit } = await import('firebase/firestore');
    vi.mocked(limit).mockClear();
    fs.cache.set('L', shiftDoc('L', X));
    expect(await readActiveShiftForBoot(BRANCH, X)).toMatchObject({ status: 'found', shift: { id: 'L' } });
    expect(await getActiveShift(BRANCH, X, { closeJournal: closeJournal() })).toMatchObject({ id: 'L' });
    expect(vi.mocked(limit).mock.calls.every(([n]) => n === 1)).toBe(true);
  });
});
