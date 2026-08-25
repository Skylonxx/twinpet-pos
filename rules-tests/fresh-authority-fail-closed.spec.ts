import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const BRANCH = 'LDP-001';
const stockPath = `products/p1/productStocks/${BRANCH}`;
const perms = ['stock_receive', 'product_view', 'pos_sale'];

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-twinpet-pkt1-failclosed',
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
    await setDoc(doc(ctx.firestore(), stockPath), { branchId: BRANCH, totalStockBase: 10 });
  });
});

function token(over: Record<string, unknown> = {}) {
  return {
    staffId: 'staff1',
    role: 'staff',
    branchIds: [BRANCH],
    permissions: perms,
    ...over,
  };
}

async function writeStock(claims: Record<string, unknown>) {
  const db = testEnv.authenticatedContext('staff1', claims).firestore();
  return setDoc(doc(db, stockPath), { branchId: BRANCH, totalStockBase: 11 }, { merge: true });
}

describe('fresh authority fail-closed', () => {
  it('denies when the live user doc is missing', async () => {
    await assertFails(writeStock(token({ authVersion: 0 })));
  });

  it('denies disabled and deleted users even with matching authVersion', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: false,
        deletedAt: null,
        authVersion: 0,
      });
    });
    await assertFails(writeStock(token({ authVersion: 0 })));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: true,
        deletedAt: '2020-01-01',
        authVersion: 0,
      });
    });
    await assertFails(writeStock(token({ authVersion: 0 })));
  });

  it('denies missing token authVersion against doc default 0', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: true,
        deletedAt: null,
        authVersion: 0,
      });
    });
    await assertFails(writeStock(token()));
  });

  it('denies stale authVersion and allows an exact match', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', 'staff1'), {
        isActive: true,
        deletedAt: null,
        authVersion: 4,
      });
    });
    await assertFails(writeStock(token({ authVersion: 0 })));
    await assertSucceeds(writeStock(token({ authVersion: 4 })));
  });
});
