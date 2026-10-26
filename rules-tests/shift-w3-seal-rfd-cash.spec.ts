/**
 * Return/Refund V1 packet 017 — Firestore Rules SOURCE seal (NOT deployed):
 *
 *   W3 seal   no client SDK write may move `shifts/{shiftId}` to the terminal
 *             `closed` state — not by update, set/merge, overwrite, batch,
 *             transaction or create — whatever the Auth role (cashier, manager,
 *             admin) or branch. The server-authoritative close
 *             (`closeShiftAuthoritative`, Admin SDK) is meant to be the only
 *             close writer after a coordinated cutover.
 *   rfd_ ids  `cashTransactions/rfd_*` is the Admin-SDK refund ledger namespace
 *             (`submitSaleReturn` `tx.create`s `cashTransactions/rfd_<returnId>`).
 *             No client may create, overwrite, update or delete a doc there.
 *
 * Every client write below is a REAL client SDK write against the emulator's
 * named database `pos-db` (project `demo-twinpet`) with a `mockUserToken`, so
 * the Rules from firebase.json are evaluated. Seeding and the server-side
 * evidence use the production Admin SDK handle (`functions/src/db`), which
 * BYPASSES Rules — an Admin write succeeding is evidence of the bypass, never
 * of a Rules permission.
 *
 * Labels:
 *   [SEAL]       expected to FAIL against the parent Rules (43a651a), which still
 *                accept the write — the RED set of this packet.
 *   [KEEP]       expected to pass on BOTH sides: a legitimate flow that must stay
 *                accepted, or a write the parent already denied.
 *   [ADMIN-SDK]  Admin SDK (Rules bypassed) evidence, both sides.
 *   [STATIC]     a source-text check of firestore.rules match overlap.
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts rules-tests/shift-w3-seal-rfd-cash.spec.ts"
 * Skips unless FIRESTORE_EMULATOR_HOST and GCLOUD_PROJECT=demo-twinpet are set.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import * as fs from 'firebase/firestore';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const RUN = Boolean(EMULATOR) && process.env.GCLOUD_PROJECT === 'demo-twinpet';
const describeEmu = RUN ? describe : describe.skip;

const BRANCH = 'B-W3S';
const OTHER_BRANCH = 'B-W3S-OTHER';
const RETURN_ID = 'f'.repeat(40);
const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

type Persona = { staffId: string; role: 'staff' | 'manager' | 'admin'; branchIds: string[] };

const CASHIER: Persona = { staffId: 'w3s-cashier', role: 'staff', branchIds: [BRANCH] };
const HOSTILE: Persona = { staffId: 'w3s-hostile', role: 'staff', branchIds: [OTHER_BRANCH] };
const MANAGER: Persona = { staffId: 'w3s-manager', role: 'manager', branchIds: [BRANCH] };
const ADMIN: Persona = { staffId: 'w3s-admin', role: 'admin', branchIds: ['ALL'] };
const STALE: Persona = { staffId: 'w3s-stale', role: 'staff', branchIds: [BRANCH] };

type AdminRef = {
  set: (d: Record<string, unknown>) => Promise<unknown>;
  create: (d: Record<string, unknown>) => Promise<unknown>;
  update: (d: Record<string, unknown>) => Promise<unknown>;
  delete: () => Promise<unknown>;
  get: () => Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
};
type AdminDb = { doc: (p: string) => AdminRef };

let adminDb: AdminDb;
const apps: FirebaseApp[] = [];
const dbs: fs.Firestore[] = [];
const clients = new Map<string, fs.Firestore>();
let seq = 0;

function client(persona: Persona | null): fs.Firestore {
  const key = persona?.staffId ?? 'unauthenticated';
  const existing = clients.get(key);
  if (existing) return existing;
  const app = initializeApp({ projectId: 'demo-twinpet', apiKey: 'demo-key' }, `seal-017-${key}`);
  const db = fs.getFirestore(app, 'pos-db');
  const [host, port] = EMULATOR!.split(':');
  if (persona) {
    const uid = `u-${persona.staffId}`;
    fs.connectFirestoreEmulator(db, host!, Number(port), {
      mockUserToken: { sub: uid, user_id: uid, staffId: persona.staffId, role: persona.role, branchIds: persona.branchIds, authVersion: 0, permissions: [] },
    });
  } else {
    fs.connectFirestoreEmulator(db, host!, Number(port));
  }
  apps.push(app);
  dbs.push(db);
  clients.set(key, db);
  return db;
}

const nextId = (prefix: string) => `${prefix}_${++seq}_${Date.now().toString(36)}`;

function openShiftDoc(shiftId: string): Record<string, unknown> {
  return {
    id: shiftId,
    branchId: BRANCH,
    staffId: CASHIER.staffId,
    staffName: 'Cashier W3S',
    status: 'open',
    openedAt: new Date(),
    closedAt: null,
    startingCash: 500,
    actualCashCount: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 0,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries: [],
  };
}

/** Admin SDK seed (Rules bypassed) of an open shift owned by CASHIER on BRANCH. */
async function seedOpenShift(): Promise<string> {
  const shiftId = nextId('SH017');
  await adminDb.doc(`shifts/${shiftId}`).set(openShiftDoc(shiftId));
  return shiftId;
}

/** Admin SDK seed of a shift as the server-authoritative close leaves it (syncState pending). */
async function seedClosedShift(syncState: 'pending' | 'synced' = 'pending'): Promise<string> {
  const shiftId = nextId('SH017C');
  await adminDb.doc(`shifts/${shiftId}`).set({
    ...openShiftDoc(shiftId),
    status: 'closed',
    closedAt: new Date(),
    actualCashCount: 900,
    expectedCash: 400,
    totalBills: 2,
    closedOffline: true,
    syncState,
    deviceId: 'DEV-SERVER',
    closeCorrelationId: CORRELATION_ID,
  });
  return shiftId;
}

async function adminRead(path: string): Promise<Record<string, unknown> | undefined> {
  const snap = await adminDb.doc(path).get();
  return snap.exists ? snap.data() : undefined;
}

/**
 * The exact production W3 field set (`closeWritePayload`, shiftService.ts) —
 * what the installed 0.1.12 fleet and the gate-OFF current client send, by
 * `updateDoc` (offline queue) or inside `runTransaction` (online close).
 */
function w3Payload(withCorrelation = true): Record<string, unknown> {
  return {
    status: 'closed',
    closedAt: fs.serverTimestamp(),
    actualCashCount: 900,
    variance: 0,
    note: '',
    expectedCash: 400,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 2,
    payInTotal: 0,
    payOutTotal: 0,
    closedOffline: true,
    syncState: 'pending',
    deviceId: 'DEV1',
    ...(withCorrelation ? { closeCorrelationId: CORRELATION_ID } : {}),
  };
}

async function expectDenied(write: Promise<unknown>): Promise<void> {
  await expect(write).rejects.toMatchObject({ code: 'permission-denied' });
}

async function expectStillOpen(shiftId: string): Promise<void> {
  expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'open', closedAt: null });
}

/** What `submitSaleReturn` (Admin SDK) creates for a cash refund. */
function serverRefundCashTx(id: string): Record<string, unknown> {
  return {
    id,
    shiftId: 'SH-ANY',
    branchId: BRANCH,
    staffId: CASHIER.staffId,
    staffName: 'Cashier W3S',
    type: 'pay_out',
    amount: 81,
    note: 'คืนเงินสด RT-1 (บิล B1)',
    createdAt: new Date(),
    source: 'sale_refund',
    refundId: RETURN_ID,
    returnId: RETURN_ID,
  };
}

/** What `recordCashTransaction` (client) writes to the audit collection. */
function clientCashTx(id: string, branchId = BRANCH, staff: Persona = CASHIER): Record<string, unknown> {
  return {
    id,
    shiftId: 'SH-ANY',
    branchId,
    staffId: staff.staffId,
    staffName: 'Cashier W3S',
    type: 'pay_in',
    amount: 50,
    note: 'n',
    createdAt: fs.serverTimestamp(),
  };
}

describeEmu('017 W3 client seal + cashTransactions rfd_ reservation (demo-twinpet / pos-db, real client SDK)', () => {
  beforeAll(async () => {
    adminDb = ((await import('../functions/src/db')) as unknown as { db: AdminDb }).db;
    for (const p of [CASHIER, HOSTILE, MANAGER, ADMIN]) {
      await adminDb.doc(`users/${p.staffId}`).set({ isActive: true, deletedAt: null, authVersion: 0, role: p.role, branchIds: p.branchIds });
    }
    // Token authVersion 0 vs live users doc 1 → hasFreshAuthority() is false.
    await adminDb.doc(`users/${STALE.staffId}`).set({ isActive: true, deletedAt: null, authVersion: 1, role: 'staff', branchIds: [BRANCH] });
  });

  afterAll(async () => {
    for (const db of dbs) await fs.terminate(db);
    for (const app of apps) await deleteApp(app);
  });

  it('[KEEP] sentinel: Rules are enforced on pos-db for this client SDK (unauthenticated read denied, branch read allowed)', async () => {
    const shiftId = await seedOpenShift();
    await expectDenied(fs.getDoc(fs.doc(client(null), 'shifts', shiftId)));
    await expectDenied(fs.getDoc(fs.doc(client(HOSTILE), 'shifts', shiftId)));
    const snap = await fs.getDoc(fs.doc(client(CASHIER), 'shifts', shiftId));
    expect(snap.data()).toMatchObject({ status: 'open' });
  });

  describe('[SEAL] no client may perform the W3 open → closed transition', () => {
    for (const [label, persona] of [
      ['cashier (shift owner)', CASHIER],
      ['branch manager', MANAGER],
      ['global admin (ALL)', ADMIN],
    ] as const) {
      it(`[SEAL] DENIED: ${label} — exact production W3 updateDoc (installed 0.1.12 / gate-OFF offline-queue shape)`, async () => {
        const shiftId = await seedOpenShift();
        await expectDenied(fs.updateDoc(fs.doc(client(persona), 'shifts', shiftId), w3Payload()));
        await expectStillOpen(shiftId);
      });
    }

    it('[SEAL] DENIED: historical W3 without closeCorrelationId (pre-OBS-B1B client shape)', async () => {
      const shiftId = await seedOpenShift();
      await expectDenied(fs.updateDoc(fs.doc(client(CASHIER), 'shifts', shiftId), w3Payload(false)));
      await expectStillOpen(shiftId);
    });

    it('[SEAL] DENIED: W3 inside runTransaction (the online closeShiftOnline shape: read, then tx.update)', async () => {
      const shiftId = await seedOpenShift();
      const db = client(CASHIER);
      const ref = fs.doc(db, 'shifts', shiftId);
      await expectDenied(
        fs.runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          expect(snap.data()).toMatchObject({ status: 'open' });
          tx.update(ref, w3Payload());
        }),
      );
      await expectStillOpen(shiftId);
    });

    it('[SEAL] DENIED: W3 in a writeBatch, and the batch is atomic (a valid W1 append in the same batch is not applied)', async () => {
      const shiftA = await seedOpenShift();
      const shiftB = await seedOpenShift();
      const db = client(CASHIER);
      const batch = fs.writeBatch(db);
      batch.update(fs.doc(db, 'shifts', shiftA), {
        cashEntries: fs.arrayUnion({ id: 'Zk3sQe9wLm2PqRtUvXy1', type: 'pay_in', amount: 20, note: 'n', staffId: CASHIER.staffId, staffName: 'Cashier W3S', at: Date.now() }),
        updatedAt: fs.serverTimestamp(),
      });
      batch.update(fs.doc(db, 'shifts', shiftB), w3Payload());
      await expectDenied(batch.commit());
      await expectStillOpen(shiftB);
      expect(await adminRead(`shifts/${shiftA}`)).toMatchObject({ status: 'open', cashEntries: [] });
    });

    it('[SEAL] DENIED: W3 via setDoc { merge: true } (manager)', async () => {
      const shiftId = await seedOpenShift();
      await expectDenied(fs.setDoc(fs.doc(client(MANAGER), 'shifts', shiftId), w3Payload(), { merge: true }));
      await expectStillOpen(shiftId);
    });

    it('[SEAL] DENIED: W3 via full-document setDoc overwrite of an existing open shift (admin)', async () => {
      const shiftId = await seedOpenShift();
      const current = (await adminRead(`shifts/${shiftId}`))!;
      const openedAt = current.openedAt as { seconds: number; nanoseconds: number };
      const overwrite = { ...current, openedAt: new fs.Timestamp(openedAt.seconds, openedAt.nanoseconds), ...w3Payload() };
      await expectDenied(fs.setDoc(fs.doc(client(ADMIN), 'shifts', shiftId), overwrite));
      await expectStillOpen(shiftId);
    });

    it('[SEAL] DENIED: W3 on an open shift that already holds a server rfd_ payout (the refund-then-close race the seal exists for)', async () => {
      const shiftId = await seedOpenShift();
      await adminDb.doc(`shifts/${shiftId}`).update({
        cashEntries: [{ id: `rfd_${RETURN_ID}`, type: 'pay_out', amount: 81, note: 'คืนเงินสด', staffId: CASHIER.staffId, staffName: 'Cashier W3S', at: Date.now() }],
      });
      await expectDenied(fs.updateDoc(fs.doc(client(CASHIER), 'shifts', shiftId), { ...w3Payload(), payOutTotal: 0 }));
      await expectStillOpen(shiftId);
    });
  });

  describe('[KEEP] every alternative client path to a closed shift stays denied', () => {
    it('[KEEP] DENIED: creating a shift directly in the closed state (cashier, manager, admin)', async () => {
      for (const persona of [CASHIER, MANAGER, ADMIN]) {
        const shiftId = nextId('SH017N');
        const closedDoc = { ...openShiftDoc(shiftId), ...w3Payload(), openedAt: fs.serverTimestamp() };
        delete (closedDoc as Record<string, unknown>).cashEntries;
        await expectDenied(fs.setDoc(fs.doc(client(persona), 'shifts', shiftId), closedDoc));
        expect(await adminRead(`shifts/${shiftId}`)).toBeUndefined();
      }
    });

    it('[KEEP] DENIED: a W0-shaped create that only flips status to closed', async () => {
      const shiftId = nextId('SH017N');
      const w0 = { ...openShiftDoc(shiftId), openedAt: fs.serverTimestamp(), status: 'closed' };
      delete (w0 as Record<string, unknown>).cashEntries;
      await expectDenied(fs.setDoc(fs.doc(client(CASHIER), 'shifts', shiftId), w0));
      expect(await adminRead(`shifts/${shiftId}`)).toBeUndefined();
    });

    it('[KEEP] DENIED: reopening a closed shift (closed → open), admin and manager', async () => {
      const shiftId = await seedClosedShift('synced');
      for (const persona of [MANAGER, ADMIN]) {
        await expectDenied(fs.updateDoc(fs.doc(client(persona), 'shifts', shiftId), { status: 'open', closedAt: null }));
      }
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'closed', syncState: 'synced' });
    });

    it('[KEEP] DENIED: rewriting the totals / drawer count of a historical closed shift (closed → closed)', async () => {
      const shiftId = await seedClosedShift('pending');
      for (const persona of [CASHIER, MANAGER, ADMIN]) {
        await expectDenied(fs.updateDoc(fs.doc(client(persona), 'shifts', shiftId), { actualCashCount: 1, variance: -899 }));
        await expectDenied(fs.updateDoc(fs.doc(client(persona), 'shifts', shiftId), { ...w3Payload(), actualCashCount: 1 }));
      }
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'closed', actualCashCount: 900, syncState: 'pending' });
    });

    it('[KEEP] DENIED: a W3 that lands directly on syncState synced', async () => {
      const shiftId = await seedOpenShift();
      await expectDenied(fs.updateDoc(fs.doc(client(CASHIER), 'shifts', shiftId), { ...w3Payload(), syncState: 'synced' }));
      await expectStillOpen(shiftId);
    });

    it('[KEEP] DENIED: a cross-branch staff member and an unauthenticated client attempting W3', async () => {
      const shiftId = await seedOpenShift();
      await expectDenied(fs.updateDoc(fs.doc(client(HOSTILE), 'shifts', shiftId), w3Payload()));
      await expectDenied(fs.updateDoc(fs.doc(client(null), 'shifts', shiftId), w3Payload()));
      await expectStillOpen(shiftId);
    });

    it('[KEEP] DENIED: status closed smuggled into a W1 cash append or a W2 credit-debt receipt', async () => {
      const shiftId = await seedOpenShift();
      const ref = fs.doc(client(CASHIER), 'shifts', shiftId);
      await expectDenied(
        fs.updateDoc(ref, {
          cashEntries: fs.arrayUnion({ id: 'Ab3sQe9wLm2PqRtUvXy2', type: 'pay_in', amount: 5, note: 'n', staffId: CASHIER.staffId, staffName: 'Cashier W3S', at: Date.now() }),
          updatedAt: fs.serverTimestamp(),
          status: 'closed',
        }),
      );
      await expectDenied(fs.updateDoc(ref, { expectedCash: 10, status: 'closed' }));
      await expectStillOpen(shiftId);
    });

    it('[KEEP] DENIED: an admin batch that deletes a closed shift and re-creates it as closed', async () => {
      const shiftId = await seedClosedShift('synced');
      const db = client(ADMIN);
      const ref = fs.doc(db, 'shifts', shiftId);
      const batch = fs.writeBatch(db);
      batch.delete(ref);
      batch.set(ref, { ...openShiftDoc(shiftId), ...w3Payload(), openedAt: fs.serverTimestamp(), actualCashCount: 1 });
      await expectDenied(batch.commit());
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'closed', actualCashCount: 900 });
    });
  });

  describe('[KEEP] legitimate W0 / W1 / W2 / W4 shift writes are unchanged', () => {
    it('[KEEP] ALLOWED: W0 open (exact openShift create)', async () => {
      const shiftId = nextId('SH017O');
      const w0 = { ...openShiftDoc(shiftId), openedAt: fs.serverTimestamp() };
      delete (w0 as Record<string, unknown>).cashEntries;
      await fs.setDoc(fs.doc(client(CASHIER), 'shifts', shiftId), w0);
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'open', staffId: CASHIER.staffId });
    });

    it('[KEEP] ALLOWED: W1 cash append (arrayUnion, recordCashTransaction shape) + its ordinary cashTransactions audit doc', async () => {
      const shiftId = await seedOpenShift();
      const db = client(CASHIER);
      const txRef = fs.doc(fs.collection(db, 'cashTransactions'));
      const entry = { id: txRef.id, type: 'pay_in', amount: 20, note: 'n', staffId: CASHIER.staffId, staffName: 'Cashier W3S', at: Date.now() };
      await fs.updateDoc(fs.doc(db, 'shifts', shiftId), { cashEntries: fs.arrayUnion(entry), updatedAt: fs.serverTimestamp() });
      await fs.setDoc(txRef, { ...clientCashTx(txRef.id), shiftId });
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'open', cashEntries: [entry] });
      expect(await adminRead(`cashTransactions/${txRef.id}`)).toMatchObject({ id: txRef.id, shiftId, amount: 50 });
    });

    it('[KEEP] ALLOWED: W2 credit-debt receipt increments; a decrement stays denied', async () => {
      const shiftId = await seedOpenShift();
      const ref = fs.doc(client(CASHIER), 'shifts', shiftId);
      await fs.updateDoc(ref, { expectedCash: 120 });
      await fs.updateDoc(ref, { expectedKbank: 30 });
      await expectDenied(fs.updateDoc(ref, { expectedCash: 100 }));
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'open', expectedCash: 120, expectedKbank: 30 });
    });

    it('[KEEP] ALLOWED: W4 pending → synced on a server-closed shift (plain update); a second W4 is denied', async () => {
      const shiftId = await seedClosedShift('pending');
      const ref = fs.doc(client(CASHIER), 'shifts', shiftId);
      await fs.updateDoc(ref, { syncState: 'synced' });
      await expectDenied(fs.updateDoc(ref, { syncState: 'synced' }));
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'closed', syncState: 'synced', actualCashCount: 900 });
    });

    it('[KEEP] ALLOWED: W4 as the conditional runTransaction CAS (008 normalization shape) on a server-closed shift', async () => {
      const shiftId = await seedClosedShift('pending');
      const db = client(CASHIER);
      const ref = fs.doc(db, 'shifts', shiftId);
      const outcome = await fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (snap.data()?.status !== 'closed' || snap.data()?.syncState !== 'pending') return 'skipped';
        tx.update(ref, { syncState: 'synced' });
        return 'normalized';
      });
      expect(outcome).toBe('normalized');
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ syncState: 'synced' });
    });

    it('[KEEP] DENIED: W4 from another branch, and W4 bundled with any other field', async () => {
      const shiftId = await seedClosedShift('pending');
      await expectDenied(fs.updateDoc(fs.doc(client(HOSTILE), 'shifts', shiftId), { syncState: 'synced' }));
      await expectDenied(fs.updateDoc(fs.doc(client(CASHIER), 'shifts', shiftId), { syncState: 'synced', note: 'x' }));
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ syncState: 'pending' });
    });

    it('[KEEP] READ: a historical closed shift stays readable by its branch (cashier, manager, admin), not cross-branch', async () => {
      const shiftId = await seedClosedShift('synced');
      for (const persona of [CASHIER, MANAGER, ADMIN]) {
        expect((await fs.getDoc(fs.doc(client(persona), 'shifts', shiftId))).data()).toMatchObject({ status: 'closed' });
      }
      await expectDenied(fs.getDoc(fs.doc(client(HOSTILE), 'shifts', shiftId)));
    });

    it('[KEEP] ALLOWED (pre-existing, unchanged): admin delete of a shift (Danger Zone reset); manager delete denied', async () => {
      const a = await seedClosedShift('synced');
      await expectDenied(fs.deleteDoc(fs.doc(client(MANAGER), 'shifts', a)));
      await fs.deleteDoc(fs.doc(client(ADMIN), 'shifts', a));
      expect(await adminRead(`shifts/${a}`)).toBeUndefined();
    });
  });

  describe('[ADMIN-SDK] server writes bypass Rules (evidence of the bypass, NOT a Rules permission)', () => {
    it('[ADMIN-SDK] the Admin SDK can still write the W3 close fields; the client W4 then normalizes it', async () => {
      const shiftId = await seedOpenShift();
      // The Admin SDK cannot take a client serverTimestamp() sentinel: closedAt is a server Date here.
      await adminDb.doc(`shifts/${shiftId}`).update({ ...w3Payload(), closedAt: new Date() });
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'closed', syncState: 'pending' });
      await fs.updateDoc(fs.doc(client(CASHIER), 'shifts', shiftId), { syncState: 'synced' });
      expect(await adminRead(`shifts/${shiftId}`)).toMatchObject({ status: 'closed', syncState: 'synced' });
    });

    it('[ADMIN-SDK] the Admin SDK can create cashTransactions/rfd_<returnId> exactly as submitSaleReturn does', async () => {
      const id = `rfd_${nextId('adm')}`;
      await adminDb.doc(`cashTransactions/${id}`).create(serverRefundCashTx(id));
      expect(await adminRead(`cashTransactions/${id}`)).toMatchObject({ id, source: 'sale_refund' });
    });
  });

  describe('[SEAL] cashTransactions/rfd_* is server-only for every client role', () => {
    for (const [label, persona] of [
      ['cashier', CASHIER],
      ['branch manager', MANAGER],
      ['global admin (ALL)', ADMIN],
    ] as const) {
      it(`[SEAL] DENIED: ${label} creating cashTransactions/rfd_<id> (setDoc on a new id)`, async () => {
        const id = `rfd_${nextId(persona.role)}`;
        await expectDenied(fs.setDoc(fs.doc(client(persona), 'cashTransactions', id), clientCashTx(id, BRANCH, persona)));
        expect(await adminRead(`cashTransactions/${id}`)).toBeUndefined();
      });
    }

    it('[SEAL] DENIED: squatting the exact rfd_<returnId> id before the server; the server create then still succeeds', async () => {
      const id = `rfd_${nextId('squat')}`;
      await expectDenied(fs.setDoc(fs.doc(client(CASHIER), 'cashTransactions', id), { ...serverRefundCashTx(id), createdAt: fs.serverTimestamp() }));
      await adminDb.doc(`cashTransactions/${id}`).create(serverRefundCashTx(id));
      expect(await adminRead(`cashTransactions/${id}`)).toMatchObject({ amount: 81, source: 'sale_refund' });
    });

    it('[SEAL] DENIED: the bare prefix id rfd_ and a payload whose body id differs', async () => {
      await expectDenied(fs.setDoc(fs.doc(client(CASHIER), 'cashTransactions', 'rfd_'), clientCashTx('rfd_')));
      const id = `rfd_${nextId('body')}`;
      await expectDenied(fs.setDoc(fs.doc(client(CASHIER), 'cashTransactions', id), clientCashTx('Zz3sQe9wLm2PqRtUvXy9')));
      expect(await adminRead('cashTransactions/rfd_')).toBeUndefined();
    });

    it('[SEAL] DENIED: rfd_ create inside a writeBatch (with an otherwise valid ordinary create) and inside a transaction', async () => {
      const db = client(MANAGER);
      const ordinary = fs.doc(fs.collection(db, 'cashTransactions'));
      const id = `rfd_${nextId('batch')}`;
      const batch = fs.writeBatch(db);
      batch.set(ordinary, clientCashTx(ordinary.id, BRANCH, MANAGER));
      batch.set(fs.doc(db, 'cashTransactions', id), clientCashTx(id, BRANCH, MANAGER));
      await expectDenied(batch.commit());
      expect(await adminRead(`cashTransactions/${ordinary.id}`)).toBeUndefined();
      expect(await adminRead(`cashTransactions/${id}`)).toBeUndefined();

      const txId = `rfd_${nextId('tx')}`;
      await expectDenied(
        fs.runTransaction(db, async (tx) => {
          const ref = fs.doc(db, 'cashTransactions', txId);
          expect((await tx.get(ref)).exists()).toBe(false);
          tx.set(ref, clientCashTx(txId, BRANCH, MANAGER));
        }),
      );
      expect(await adminRead(`cashTransactions/${txId}`)).toBeUndefined();
    });

    it('[SEAL] DENIED: admin client delete of a server rfd_ ledger record (deleteDoc and in a batch)', async () => {
      const id = `rfd_${nextId('del')}`;
      await adminDb.doc(`cashTransactions/${id}`).create(serverRefundCashTx(id));
      const db = client(ADMIN);
      await expectDenied(fs.deleteDoc(fs.doc(db, 'cashTransactions', id)));
      const batch = fs.writeBatch(db);
      batch.delete(fs.doc(db, 'cashTransactions', id));
      await expectDenied(batch.commit());
      expect(await adminRead(`cashTransactions/${id}`)).toMatchObject({ source: 'sale_refund', amount: 81 });
    });

    it('[KEEP] DENIED: overwrite / merge / update / manager delete of an existing server rfd_ record (no client update lane)', async () => {
      const id = `rfd_${nextId('ovr')}`;
      await adminDb.doc(`cashTransactions/${id}`).create(serverRefundCashTx(id));
      for (const persona of [CASHIER, MANAGER, ADMIN]) {
        const ref = fs.doc(client(persona), 'cashTransactions', id);
        await expectDenied(fs.setDoc(ref, { ...clientCashTx(id, BRANCH, persona), amount: 1 }));
        await expectDenied(fs.setDoc(ref, { amount: 1 }, { merge: true }));
        await expectDenied(fs.updateDoc(ref, { amount: 1 }));
      }
      await expectDenied(fs.deleteDoc(fs.doc(client(MANAGER), 'cashTransactions', id)));
      expect(await adminRead(`cashTransactions/${id}`)).toMatchObject({ amount: 81, source: 'sale_refund' });
    });

    it('[KEEP] READ: a server rfd_ record keeps the existing branch-scoped read (branch staff yes, cross-branch / unauthenticated no)', async () => {
      const id = `rfd_${nextId('read')}`;
      await adminDb.doc(`cashTransactions/${id}`).create(serverRefundCashTx(id));
      expect((await fs.getDoc(fs.doc(client(CASHIER), 'cashTransactions', id))).data()).toMatchObject({ source: 'sale_refund' });
      await expectDenied(fs.getDoc(fs.doc(client(HOSTILE), 'cashTransactions', id)));
      await expectDenied(fs.getDoc(fs.doc(client(null), 'cashTransactions', id)));
    });
  });

  describe('[KEEP] ordinary (non-rfd_) cashTransactions keep their prior role constraints', () => {
    it('[KEEP] ALLOWED: auto-id create by cashier and manager; ids that merely contain or case-differ from the prefix', async () => {
      for (const persona of [CASHIER, MANAGER]) {
        const ref = fs.doc(fs.collection(client(persona), 'cashTransactions'));
        await fs.setDoc(ref, clientCashTx(ref.id, BRANCH, persona));
        expect(await adminRead(`cashTransactions/${ref.id}`)).toMatchObject({ id: ref.id });
      }
      for (const id of [`xrfd_${seq}`, `RFD_${seq}`, `rfd${seq}`, `Rfd_${seq}`]) {
        await fs.setDoc(fs.doc(client(CASHIER), 'cashTransactions', id), clientCashTx(id));
        expect(await adminRead(`cashTransactions/${id}`)).toMatchObject({ id });
      }
    });

    it('[KEEP] DENIED: cross-branch, unauthenticated and stale-authority creates', async () => {
      const db = client(HOSTILE);
      const ref = fs.doc(fs.collection(db, 'cashTransactions'));
      await expectDenied(fs.setDoc(ref, clientCashTx(ref.id, BRANCH, HOSTILE)));
      const ref2 = fs.doc(fs.collection(client(null), 'cashTransactions'));
      await expectDenied(fs.setDoc(ref2, clientCashTx(ref2.id)));
      const ref3 = fs.doc(fs.collection(client(STALE), 'cashTransactions'));
      await expectDenied(fs.setDoc(ref3, clientCashTx(ref3.id, BRANCH, STALE)));
    });

    it('[KEEP] DENIED: any update of an ordinary record (tamper after create)', async () => {
      const db = client(CASHIER);
      const ref = fs.doc(fs.collection(db, 'cashTransactions'));
      await fs.setDoc(ref, clientCashTx(ref.id));
      await expectDenied(fs.updateDoc(ref, { amount: 5000 }));
      await expectDenied(fs.setDoc(ref, { ...clientCashTx(ref.id), amount: 5000 }));
      expect(await adminRead(`cashTransactions/${ref.id}`)).toMatchObject({ amount: 50 });
    });

    it('[KEEP] delete: admin may still delete an ORDINARY record (Danger Zone reset); manager and cashier may not', async () => {
      const ref = fs.doc(fs.collection(client(CASHIER), 'cashTransactions'));
      await fs.setDoc(ref, clientCashTx(ref.id));
      await expectDenied(fs.deleteDoc(fs.doc(client(CASHIER), 'cashTransactions', ref.id)));
      await expectDenied(fs.deleteDoc(fs.doc(client(MANAGER), 'cashTransactions', ref.id)));
      await fs.deleteDoc(fs.doc(client(ADMIN), 'cashTransactions', ref.id));
      expect(await adminRead(`cashTransactions/${ref.id}`)).toBeUndefined();
    });
  });
});

describe('[STATIC] firestore.rules match overlap for shifts and cashTransactions', () => {
  it('[STATIC] only the dedicated matches (plus the deny-all catch-all) can match shifts/{id} and cashTransactions/{id}', () => {
    const rules = readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8');
    const matches = [...rules.matchAll(/^\s*match\s+(\S+)\s*\{/gm)].map((m) => m[1]!);
    // A match whose FIRST segment is a wildcard could also cover a top-level
    // shifts / cashTransactions document and OR in another allow.
    const wildcardTop = matches.filter((p) => p !== '/databases/{database}/documents' && /^\/\{/.test(p));
    expect(wildcardTop).toEqual(['/{path=**}/productStocks/{stockDocId}', '/{document=**}']);
    expect(rules).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;\s*\}/);
    expect(matches.filter((p) => p.startsWith('/shifts'))).toEqual(['/shifts/{shiftId}']);
    expect(matches.filter((p) => p.startsWith('/cashTransactions'))).toEqual(['/cashTransactions/{txId}']);
  });
});
