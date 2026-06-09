import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, type Firestore } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Phase 7B-2 — Origin-Controlled Discrepancy Handling (Firestore rules).
 *
 * Proves at the rules / system boundary that:
 *   • only the DESTINATION branch may REPORT (create, status 'reported') and only
 *     with branch identity matching the parent transfer and no resolution fields;
 *   • ALL client updates to `transferDiscrepancies` are DENIED — resolution is
 *     server/Admin SDK only (Cloud Function `resolveTransferDiscrepancy`); even
 *     the origin branch cannot resolve client-side;
 *   • a destination user cannot forge a resolution-marked inventory adjustment;
 *   • a generic (unmarked) adjustment is unaffected.
 *
 * These tests verify that client-side abuse of the resolution path is denied at
 * the Firestore rules layer, regardless of caller identity or branch.
 */

const ORIGIN = 'BR-ORIGIN';
const DEST = 'BR-DEST';
const OTHER = 'BR-OTHER';
const TRANSFER_ID = 'TR-7B2-0001';
const DISC_ID = 'DISC-7B2-0001';

const staffAt = (branchId: string) => ({
  staffId: `staff-${branchId}`,
  role: 'staff',
  branchIds: [branchId],
  permissions: [],
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet',
    firestore: {
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      host,
      port: Number(port),
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed the parent transfer (rules-bypassed).
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'inventoryTransfers', TRANSFER_ID), {
      id: TRANSFER_ID,
      fromBranchId: ORIGIN,
      toBranchId: DEST,
      status: 'completed',
    });
  });
});

const discRef = (db: Firestore) =>
  doc(db, 'inventoryTransfers', TRANSFER_ID, 'transferDiscrepancies', DISC_ID);

const reportedPayload = (overrides: Record<string, unknown> = {}) => ({
  id: DISC_ID,
  transferId: TRANSFER_ID,
  fromBranchId: ORIGIN,
  toBranchId: DEST,
  status: 'reported',
  reason: 'short',
  lines: [{ productId: 'P', productName: 'P', sku: 'S', expectedQty: 10, actualQty: 8, difference: -2 }],
  reportedByStaffId: 'staff-BR-DEST',
  reportedByStaffName: 'Dest',
  reportedByBranchId: DEST,
  ...overrides,
});

// ── CREATE (destination reports) ─────────────────────────────────────────────
describe('transferDiscrepancies create — destination-only report', () => {
  it('ALLOWS the destination branch to create a valid reported discrepancy', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertSucceeds(setDoc(discRef(db), reportedPayload()));
  });

  it('DENIES the origin branch from reporting', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(ORIGIN)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload()));
  });

  it('DENIES creating in a non-reported state', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload({ status: 'resolved' })));
  });

  it('DENIES a wrong fromBranchId (must match the transfer)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload({ fromBranchId: 'BR-EVIL' })));
  });

  it('DENIES a wrong toBranchId (must match the transfer)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload({ toBranchId: 'BR-EVIL' })));
  });

  it('DENIES a wrong transferId (must match the parent path)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload({ transferId: 'TR-OTHER' })));
  });

  it('DENIES a reportedByBranchId that is not the destination', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload({ reportedByBranchId: ORIGIN })));
  });

  it('DENIES resolution fields on create', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(discRef(db), reportedPayload({ resolutionAdjustmentId: 'ADJ-x' })));
    await assertFails(setDoc(discRef(db), reportedPayload({ resolvedByBranchId: ORIGIN })));
  });
});

// ── UPDATE — resolution is SERVER-ONLY (no client may resolve) ───────────────
describe('transferDiscrepancies update — server-only resolution (all client writes denied)', () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(discRef(ctx.firestore()), reportedPayload({ reportedAt: new Date() }));
    });
  });

  const resolution = {
    status: 'resolved',
    resolvedByStaffId: 'staff-BR-ORIGIN',
    resolvedByStaffName: 'Origin',
    resolvedByBranchId: ORIGIN,
    resolvedAt: new Date(),
    resolutionAdjustmentId: 'ADJ-1',
  };

  it('DENIES the ORIGIN branch from resolving client-side (server-only)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(ORIGIN)).firestore();
    await assertFails(updateDoc(discRef(db), resolution));
  });

  it('DENIES the DESTINATION branch from resolving client-side', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(updateDoc(discRef(db), resolution));
  });

  it('DENIES any client from mutating a reported discrepancy (facts immutable client-side)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(ORIGIN)).firestore();
    await assertFails(updateDoc(discRef(db), { reason: 'tampered' }));
    await assertFails(updateDoc(discRef(db), { reportedByBranchId: 'BR-EVIL' }));
  });

  it('ALLOWS both involved branches to read, DENIES an unrelated branch', async () => {
    await assertSucceeds(getDoc(discRef(testEnv.authenticatedContext('u', staffAt(ORIGIN)).firestore())));
    await assertSucceeds(getDoc(discRef(testEnv.authenticatedContext('u', staffAt(DEST)).firestore())));
    await assertFails(getDoc(discRef(testEnv.authenticatedContext('u', staffAt(OTHER)).firestore())));
  });
});

// ── inventoryAdjustments — resolution-marked adjustments are SERVER-ONLY ──────
describe('inventoryAdjustments — discrepancy-resolution markers are server-only', () => {
  const marked = (branchId: string, over: Record<string, unknown> = {}) => ({
    id: 'ADJ-MARK',
    branchId,
    status: 'completed',
    refTransferId: TRANSFER_ID,
    refDiscrepancyId: DISC_ID,
    ...over,
  });

  it('DENIES the ORIGIN branch from creating a marked adjustment client-side (server-only)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(ORIGIN)).firestore();
    await assertFails(setDoc(doc(db, 'inventoryAdjustments', 'ADJ-MARK'), marked(DEST)));
  });

  it('DENIES the DESTINATION branch from forging a marked (resolution) adjustment', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(setDoc(doc(db, 'inventoryAdjustments', 'ADJ-MARK'), marked(DEST)));
  });

  it('DENIES even a single marker on a client adjustment (either marker ⇒ resolution)', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertFails(
      setDoc(doc(db, 'inventoryAdjustments', 'ADJ-MARK1'), { id: 'ADJ-MARK1', branchId: DEST, status: 'completed', refTransferId: TRANSFER_ID }),
    );
    await assertFails(
      setDoc(doc(db, 'inventoryAdjustments', 'ADJ-MARK2'), { id: 'ADJ-MARK2', branchId: DEST, status: 'completed', refDiscrepancyId: DISC_ID }),
    );
  });

  it('ALLOWS a generic (unmarked) own-branch adjustment — unchanged behaviour', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(DEST)).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'inventoryAdjustments', 'ADJ-GEN'), { id: 'ADJ-GEN', branchId: DEST, status: 'completed' }),
    );
  });

  it('DENIES a generic adjustment on a branch the staff cannot access', async () => {
    const db = testEnv.authenticatedContext('u', staffAt(ORIGIN)).firestore();
    await assertFails(
      setDoc(doc(db, 'inventoryAdjustments', 'ADJ-GEN2'), { id: 'ADJ-GEN2', branchId: DEST, status: 'completed' }),
    );
  });
});
