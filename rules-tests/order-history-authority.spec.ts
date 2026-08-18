import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc, getDoc, Timestamp } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const BRANCH = 'LDP-001';
const OTHER = 'BKK-002';

const staff = (over: Record<string, unknown> = {}) => ({
  staffId: 'staff1',
  role: 'staff',
  branchIds: [BRANCH],
  permissions: ['pos_sale', 'pos_void'],
  ...over,
});

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet-r76',
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
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'orders', 'o1'), { branchId: BRANCH, total: 100, status: 'completed' });
    await setDoc(doc(db, 'asyncOrders', 'a1'), {
      branchId: BRANCH,
      staffId: 'staff1',
      total: 50,
      reconcileStatus: 'pending_reconcile',
      serverCreatedAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'asyncOrders', 'aFaultRev'), {
      branchId: BRANCH,
      staffId: 'staff1',
      total: 50,
      reconcileStatus: 'pending_reconcile',
      serverCreatedAt: Timestamp.now(),
      voidRevisionFault: 'revision_malformed',
      voidRevisionFaultAt: Timestamp.now(),
    });
    await setDoc(doc(db, 'asyncOrders', 'aFault'), {
      branchId: BRANCH,
      staffId: 'staff1',
      total: 50,
      reconcileStatus: 'pending_reconcile',
      serverCreatedAt: Timestamp.now(),
      voidAnomaly: 'missing_canonical',
      voidAnomalyAt: Timestamp.now(),
    });
  });
});

describe('K order history authority rules', () => {
  it('K01 client canonical orders create is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'orders', 'new'), { branchId: BRANCH, staffId: 'staff1', total: 50 }));
  });

  it('K02 client historyRev update injection is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'orders', 'o1'), { historyRev: 1 }));
  });

  it('K03 client canonical total update is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'orders', 'o1'), { total: 99 }));
  });

  it('K04 client orderItems create/update/delete DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orders', 'o1', 'orderItems', 'i1'), { qty: 1 });
    });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'orders', 'o1', 'orderItems', 'i2'), { qty: 1 }));
    await assertFails(updateDoc(doc(db, 'orders', 'o1', 'orderItems', 'i1'), { qty: 2 }));
    const { deleteDoc } = await import('firebase/firestore');
    await assertFails(deleteDoc(doc(db, 'orders', 'o1', 'orderItems', 'i1')));
  });

  it('K05 client payments create/update DENIED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'payments', 'p1'), { orderId: 'o1', amount: 1, branchId: BRANCH });
    });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(setDoc(doc(db, 'payments', 'p2'), { orderId: 'o1', amount: 1, branchId: BRANCH }));
    await assertFails(updateDoc(doc(db, 'payments', 'p1'), { amount: 2 }));
  });

  it('K06 admin delete of canonical order, orderItems, and payments is ALLOWED', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'orders', 'o1', 'orderItems', 'i1'), { qty: 1 });
      await setDoc(doc(db, 'payments', 'p1'), { orderId: 'o1', amount: 1, branchId: BRANCH });
    });
    const db = testEnv.authenticatedContext('admin1', staff({ role: 'admin', branchIds: ['ALL'] })).firestore();
    const { deleteDoc } = await import('firebase/firestore');
    await assertSucceeds(deleteDoc(doc(db, 'orders', 'o1', 'orderItems', 'i1')));
    await assertSucceeds(deleteDoc(doc(db, 'payments', 'p1')));
    await assertSucceeds(deleteDoc(doc(db, 'orders', 'o1')));
  });

  it('K07 staff may read own-branch branches and settings; cross-branch settings denied', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'branches', BRANCH), { name: 'LDP' });
      await setDoc(doc(db, 'settings', BRANCH), { companyName: 'TwinPet' });
      await setDoc(doc(db, 'settings', OTHER), { companyName: 'Other' });
    });
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(getDoc(doc(db, 'branches', BRANCH)));
    await assertSucceeds(getDoc(doc(db, 'settings', BRANCH)));
    await assertFails(getDoc(doc(db, 'settings', OTHER)));
  });

  it('K09 client create with voidAnomaly present is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'bad'), {
        branchId: BRANCH,
        staffId: 'staff1',
        total: 1,
        voidAnomaly: 'missing_canonical',
      }),
    );
  });

  it('K10 client create with voidAnomalyAt present is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'bad2'), {
        branchId: BRANCH,
        staffId: 'staff1',
        total: 1,
        voidAnomalyAt: new Date(),
      }),
    );
  });

  it('K11 client update ADDING an anomaly marker is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { voidAnomaly: 'x' }));
  });

  it('K12 client update MUTATING an existing anomaly marker is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const existing = await assertSucceeds(getDoc(doc(db, 'asyncOrders', 'aFault')));
    expect(existing.exists()).toBe(true);
    expect(existing.data()?.voidAnomaly).toBe('missing_canonical');
    expect(existing.data()?.voidAnomalyAt).toBeTruthy();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'aFault'), { voidAnomaly: 'canonical_ineligible' }));
  });

  it('K13 client update CLEARING a server anomaly marker is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const existing = await assertSucceeds(getDoc(doc(db, 'asyncOrders', 'aFault')));
    expect(existing.exists()).toBe(true);
    expect(existing.data()?.voidAnomaly).toBe('missing_canonical');
    expect(existing.data()?.voidAnomalyAt).toBeTruthy();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'aFault'), { voidAnomaly: null }));
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'aFault'), { voidAnomalyAt: null }));
  });

  it('client cannot seed reconcileStatus settled', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'settled'), {
        branchId: BRANCH,
        staffId: 'staff1',
        total: 1,
        reconcileStatus: 'settled',
      }),
    );
  });

  it('pending_reconcile create without reserved fields is ALLOWED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'asyncOrders', 'ok'), { branchId: BRANCH, staffId: 'staff1', total: 1 }),
    );
  });

  it('K14 seven-key void intent update is ALLOWED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'asyncOrders', 'a1'), {
        voidRequested: true,
        status: 'voided',
        voidReason: 'x',
        voidedBy: 'staff1',
        deviceId: 'dev',
      }),
    );
  });

  it('K15 create with voidRevisionFault is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'vf'), {
        branchId: BRANCH,
        staffId: 'staff1',
        total: 1,
        voidRevisionFault: 'revision_malformed',
      }),
    );
  });

  it('K16 create with voidRevisionFaultAt is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'vfa'), {
        branchId: BRANCH,
        staffId: 'staff1',
        total: 1,
        voidRevisionFaultAt: new Date(),
      }),
    );
  });

  it('K17 client cannot add/mutate/clear revision-fault fields', async () => {
    const db = testEnv.authenticatedContext('staff1', staff()).firestore();
    const arms: Array<{ id: string; patch: Record<string, unknown> }> = [
      { id: 'a1', patch: { voidRevisionFault: 'revision_malformed' } },
      { id: 'a1', patch: { voidRevisionFaultAt: new Date() } },
      { id: 'aFaultRev', patch: { voidRevisionFault: 'revision_overflow' } },
      { id: 'aFaultRev', patch: { voidRevisionFaultAt: new Date() } },
      { id: 'aFaultRev', patch: { voidRevisionFault: null } },
      { id: 'aFaultRev', patch: { voidRevisionFaultAt: null } },
    ];
    for (const arm of arms) {
      await assertFails(updateDoc(doc(db, 'asyncOrders', arm.id), arm.patch));
    }
  });

  it('K18 branch-scoped asyncOrders read is DENIED without hasBranchAccess', async () => {
    const db = testEnv.authenticatedContext('staff2', staff({ branchIds: [OTHER] })).firestore();
    await assertFails(getDoc(doc(db, 'asyncOrders', 'a1')));
  });
});
