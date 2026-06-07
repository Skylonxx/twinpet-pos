/**
 * PHASE 2 Track B Step 1 — asyncOrders reconcile-control immutability (rules).
 *
 * The reconcile state machine is SERVER-OWNED. A non-admin client (the offline
 * void-intent merge) may update void fields, but must NOT flip `reconcileStatus`
 * or the retry counter `reconcileAttempts` — those move only via the Admin-SDK
 * reconciler / retryReconcile callable (which bypass rules).
 *
 * Run (from repo root):
 *   firebase emulators:exec --only firestore --project demo-twinpet \
 *     "npx vitest run --config vitest.rules.config.ts"
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const voidStaff = { staffId: 'staff1', role: 'staff', branchIds: [BRANCH], permissions: ['pos_void'] };
const saleStaff = { staffId: 'staff2', role: 'staff', branchIds: [BRANCH], permissions: ['pos_sale'] };
const saleOnly = saleStaff;

// A normal POS checkout intent (matches asyncCheckout.ts): safe baseline only.
const posCreate = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  branchId: BRANCH,
  staffId: 'staff2', // == token.staffId for stampedOwnStaffId
  total: 50,
  status: 'completed',
  reconcileStatus: 'pending_reconcile',
  reconciledAt: null,
  ...over,
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
  // A settled async order with representative SALE PAYLOAD + server-owned reconcile
  // state, to attempt illegitimate client mutations against.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'asyncOrders', 'a1'), {
      id: 'a1',
      branchId: BRANCH,
      staffId: 'staff1',
      total: 100,
      creditAmt: 0,
      lines: [{ productId: 'p1', qtyBase: 1, lineTotal: 100 }],
      payments: [{ method: 'cash', amount: 100 }],
      status: 'completed',
      reconcileStatus: 'settled',
      reconcileAttempts: 1,
      serverCreatedAt: new Date(),
    });
  });
});

describe('asyncOrders reconcile-control immutability (client updates)', () => {
  it('a pos_void client CANNOT flip reconcileStatus', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { reconcileStatus: 'pending_reconcile' }));
  });

  it('a pos_void client CANNOT change reconcileAttempts (reset the retry cap)', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { reconcileAttempts: 0 }));
  });

  it('the legitimate offline void-intent merge (no reconcile fields) still SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        { voidRequested: true, status: 'voided', voidReason: 'ลูกค้าเปลี่ยนใจ', voidedBy: 'staff1' },
        { merge: true },
      ),
    );
  });

  it('a client without pos_void CAN void if they securely stamp their own voidedBy', async () => {
    const db = testEnv.authenticatedContext('staff2', saleOnly).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        { voidRequested: true, status: 'voided', voidedBy: 'staff2' },
        { merge: true },
      ),
    );
  });

  it('a client DENIED void if they spoof another staff ID in voidedBy', async () => {
    const db = testEnv.authenticatedContext('staff2', saleOnly).firestore();
    await assertFails(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        { voidRequested: true, status: 'voided', voidedBy: 'staff1' },
        { merge: true },
      ),
    );
  });
});

describe('asyncOrders void update — strict value constraints', () => {
  it('update setting voidRequested to false is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a1'), { voidRequested: false, status: 'voided', voidedBy: 'staff1' }, { merge: true })
    );
  });

  it('update setting status to a non-voided value is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a1'), { voidRequested: true, status: 'completed', voidedBy: 'staff1' }, { merge: true })
    );
  });

  it('update spoofing voidedBy to another staff ID is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'a1'), { voidRequested: true, status: 'voided', voidedBy: 'staff2' }, { merge: true })
    );
  });
});

// Every server-owned reconcile/audit field must be frozen on client updates.
const SERVER_OWNED_FIELDS: Record<string, unknown> = {
  reconcileError: 'spoof',
  lastReconcileError: 'spoof',
  lastReconcileErrorAt: 1_700_000_000_000,
  firstFailedAt: 1_700_000_000_000,
  previousReconcileError: 'spoof',
  reconcileRecoveredAt: 1_700_000_000_000,
  adminRetryCount: 9,
  lastRetryBy: 'staff1',
  lastRetryAt: 1_700_000_000_000,
  reconciledAt: 1_700_000_000_000,
};

// Sale-payload fields a pos_void client must NOT be able to mutate.
const SALE_PAYLOAD_MUTATIONS: Record<string, unknown> = {
  lines: [{ productId: 'evil', qtyBase: 999, lineTotal: 0 }],
  payments: [{ method: 'cash', amount: 0 }],
  total: 1,
  creditAmt: 9999,
  staffId: 'someoneElse',
  branchId: 'BKK-002',
};

describe('asyncOrders update — pos_void cannot mutate SALE PAYLOAD fields', () => {
  for (const [field, value] of Object.entries(SALE_PAYLOAD_MUTATIONS)) {
    it(`a pos_void client CANNOT mutate sale-payload field "${field}"`, async () => {
      const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
      await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { [field]: value }));
    });
  }

  it('a void that ALSO edits sale payload (lines) is DENIED (whole update rejected)', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        { voidRequested: true, status: 'voided', voidReason: 'x', lines: [] },
        { merge: true },
      ),
    );
  });

  it('a FULL legitimate void merge (all approved void fields) still SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        {
          voidRequested: true,
          status: 'voided',
          voidReason: 'ลูกค้าเปลี่ยนใจ',
          voidedBy: 'staff1',
          deviceId: 'pos-1',
          voidedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
        { merge: true },
      ),
    );
  });
});

describe('asyncOrders update — freeze ALL server-owned reconcile/audit fields', () => {
  for (const [field, value] of Object.entries(SERVER_OWNED_FIELDS)) {
    it(`a pos_void client CANNOT mutate server-owned field "${field}"`, async () => {
      const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
      await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { [field]: value }));
    });
  }

  it('a void merge that also tries to sneak in an audit field is DENIED (whole update rejected)', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(
        doc(db, 'asyncOrders', 'a1'),
        { voidRequested: true, status: 'voided', voidReason: 'x', adminRetryCount: 1 },
        { merge: true },
      ),
    );
  });
});

// Paranoia: a protected field ABSENT on the stored doc must not be writable even
// as an explicit `null` (the value-equality trap — diff/affectedKeys catches it
// because absent→null adds the key). All these fields are absent on the seed.
const ABSENT_PROTECTED_FIELDS = [
  'reconcileError',
  'lastReconcileError',
  'lastReconcileErrorAt',
  'firstFailedAt',
  'previousReconcileError',
  'reconcileRecoveredAt',
  'adminRetryCount',
  'lastRetryBy',
  'lastRetryAt',
  'reconciledAt',
];

describe('asyncOrders update — absent→null writes on protected fields are DENIED', () => {
  for (const field of ABSENT_PROTECTED_FIELDS) {
    it(`writing ${field}=null (absent → null) is DENIED`, async () => {
      const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
      await assertFails(updateDoc(doc(db, 'asyncOrders', 'a1'), { [field]: null }));
    });
  }
});

describe('asyncOrders create — block server-owned reconcile-field spoofing', () => {
  it('a normal POS checkout intent (safe baseline) still SUCCEEDS', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate()));
  });

  it('create stamping reconcileStatus=settled is DENIED (spoof a sale straight to settled)', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileStatus: 'settled' })));
  });

  it('create seeding reconcileAttempts is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileAttempts: 5 })));
  });

  it('create stamping a non-null reconciledAt (settled-timestamp spoof) is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconciledAt: 1_700_000_000_000 })));
  });

  it('create with reconciledAt=null (the safe initial value) is ALLOWED', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertSucceeds(setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconciledAt: null })));
  });

  it('create seeding error/audit control fields is DENIED', async () => {
    const db = testEnv.authenticatedContext('staff2', saleStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'c1'), posCreate({ reconcileError: 'x', lastReconcileError: 'x' })),
    );
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'c2'), posCreate({ id: 'c2', adminRetryCount: 1, lastRetryBy: 'staff2' })),
    );
  });

  it('the offline void-intent create (tombstone) is entirely DENIED', async () => {
    const db = testEnv.authenticatedContext('staff1', voidStaff).firestore();
    await assertFails(
      setDoc(doc(db, 'asyncOrders', 'v1'), {
        id: 'v1',
        branchId: BRANCH,
        voidRequested: true,
        status: 'voided',
        voidReason: 'ลูกค้าเปลี่ยนใจ',
        voidedBy: 'staff1',
      }),
    );
  });
});
