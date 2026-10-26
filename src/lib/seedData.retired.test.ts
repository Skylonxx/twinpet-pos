/**
 * 019 — Seed Zone is retired. `seedMockData` upserted FIXED ids (PROD-001, CUST-001, …)
 * with merge, overwriting the real stock (`productStocks.totalStockBase`), the FIFO
 * layer (`stockLots.qtyRemaining`) and credit usage of any colliding record. It must now
 * refuse before its first read, auth call, batch or write, and no other tracked source
 * file may reach the fixtures or the old writer.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('firebase/firestore', async () => (await import('./admin/clearTestData.fakeFirestore')).fakeFirestoreModule);
vi.mock('./firebase', async () => (await import('./admin/clearTestData.fakeFirestore')).fakeFirebaseModule);
vi.mock('./firebaseAuth', async () => (await import('./admin/clearTestData.fakeFirestore')).fakeFirebaseAuthModule);

import { fakeDb } from './admin/clearTestData.fakeFirestore';
import { UatToolRetiredError, UAT_TOOL_RETIRED_CODE } from './admin/uatToolRetired';
import { seedMockData } from './seedData';

/** A live-shaped database whose real records collide with the seeder's fixed ids. */
function seedCollidingLiveData(): void {
  fakeDb.seed('branches/B1', { name: 'สาขาหลัก', isActive: true });
  fakeDb.seed('branches/B2', { name: 'สาขา 2', isActive: true });
  // Real PROD-001: partly sold. The seeder would reset both of these to 60.
  fakeDb.seed('products/PROD-001', { name: 'สินค้าจริง', cost: 410, avgCost: 415 });
  fakeDb.seed('products/PROD-001/productStocks/B1', { branchId: 'B1', totalStockBase: 7 });
  fakeDb.seed('products/PROD-001/productStocks/B2', { branchId: 'B2', totalStockBase: 12 });
  fakeDb.seed('stockLots/PROD-001_B1_seed', {
    productId: 'PROD-001',
    branchId: 'B1',
    qtyReceived: 60,
    qtyRemaining: 3,
    isDepleted: false,
  });
  // Real customer on a fixed seed id with an open credit balance.
  fakeDb.seed('customers/CUST-001', { name: 'ลูกค้าจริง', outstandingBalance: 900, totalSpent: 5000 });
  fakeDb.seed('creditAccounts/CUST-001', { creditLimit: 50000, creditUsed: 900, creditBalance: 49100 });
  fakeDb.seed('suppliers/SUPP-001', { name: 'ซัพพลายเออร์จริง' });
  fakeDb.seed('categories/general', { name: 'ทั่วไป' });
}

function snapshot(): Map<string, unknown> {
  return new Map([...fakeDb.docs].map(([path, data]) => [path, structuredClone(data)]));
}

async function expectSeedRefused() {
  const before = snapshot();
  const outcome = await seedMockData().then(
    (summary) => ({ ok: true as const, summary }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(outcome.ok, 'a retired seeder must never resolve as success').toBe(false);
  const error = (outcome as { error: unknown }).error;
  expect(error).toBeInstanceOf(UatToolRetiredError);
  const typed = error as UatToolRetiredError;
  expect(typed.code).toBe(UAT_TOOL_RETIRED_CODE);
  expect(typed.action).toBe('seedMockData');
  expect(typed.message).toContain('ยกเลิกเครื่องมือนี้แล้ว');
  expect(typed.message).toContain('ไม่ได้เขียนข้อมูลใด ๆ');
  // Zero Firestore reads, auth calls, batch commits or writes.
  expect(fakeDb.ops).toEqual([]);
  expect(fakeDb.committedWrites).toBe(0);
  // Byte-for-byte: nothing about the colliding records moved.
  expect(snapshot()).toEqual(before);
}

beforeEach(() => {
  fakeDb.reset();
});

describe('019 — seedMockData refuses and preserves colliding live records', () => {
  test('direct module call: zero reads / auth / writes, snapshot unchanged', async () => {
    seedCollidingLiveData();
    await expectSeedRefused();
  });

  test('stock and FIFO risk: real totalStockBase and lot qtyRemaining are not overwritten with the fixture stock', async () => {
    seedCollidingLiveData();
    await expectSeedRefused();
    expect(fakeDb.docs.get('products/PROD-001/productStocks/B1')).toEqual({ branchId: 'B1', totalStockBase: 7 });
    expect(fakeDb.docs.get('products/PROD-001/productStocks/B2')).toEqual({ branchId: 'B2', totalStockBase: 12 });
    expect(fakeDb.docs.get('stockLots/PROD-001_B1_seed')).toMatchObject({ qtyRemaining: 3, isDepleted: false });
    expect(fakeDb.docs.get('products/PROD-001')).toMatchObject({ cost: 410, avgCost: 415 });
  });

  test('credit risk: a real customer on a fixed seed id keeps its credit usage', async () => {
    seedCollidingLiveData();
    await expectSeedRefused();
    expect(fakeDb.docs.get('creditAccounts/CUST-001')).toMatchObject({ creditUsed: 900, creditBalance: 49100 });
    expect(fakeDb.docs.get('customers/CUST-001')).toMatchObject({ outstandingBalance: 900 });
  });

  test.each(['permission-denied', 'unavailable'])(
    'denied / offline Firestore (%s) still yields the typed retirement',
    async (code) => {
      seedCollidingLiveData();
      fakeDb.readFailure = code;
      await expectSeedRefused();
    },
  );

  test('unconfigured Firebase (local / dev runtime) is refused too, not given the old dev-mode notice', async () => {
    fakeDb.configured = false;
    await expectSeedRefused();
  });

  test('empty database: still a refusal, never a "seeded" success', async () => {
    await expectSeedRefused();
  });
});

// Source-path audit: which tracked files can reach the seeder / the fixtures / the hard deletes.
const sources = import.meta.glob(['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function importersOf(pattern: RegExp, exclude: string[]): string[] {
  return Object.entries(sources)
    .filter(([path, text]) => !exclude.includes(path) && pattern.test(text))
    .map(([path]) => path)
    .sort();
}

describe('019 — no indirect route to the old seeder', () => {
  test('no non-test source imports seedData other than itself (the page no longer wires Seed Zone)', () => {
    expect(importersOf(/from\s+['"][^'"]*\/seedData['"]/, ['/src/lib/seedData.ts'])).toEqual([]);
  });

  test('no non-test source imports the mock fixtures any more', () => {
    expect(importersOf(/mocks\/mock-[a-z]+\.json/, [])).toEqual([]);
  });

  test('only the Branch Management page imports the Danger Zone helpers', () => {
    expect(
      importersOf(/from\s+['"][^'"]*\/clearTestData['"]/, ['/src/lib/admin/clearTestData.ts']),
    ).toEqual(['/src/pages/admin/BranchManagementPage.tsx']);
  });

  test('the retired modules contain no Firestore write or auth API at all', () => {
    for (const path of ['/src/lib/seedData.ts', '/src/lib/admin/clearTestData.ts', '/src/lib/admin/uatToolRetired.ts']) {
      const text = sources[path]!;
      expect(text, path).toBeDefined();
      expect(text, path).not.toMatch(/firebase\/firestore|from\s+['"][^'"]*\/firebase(Auth)?['"]/);
      expect(text, path).not.toMatch(/\b(writeBatch|setDoc|updateDoc|deleteDoc|addDoc|runTransaction|ensureFirebaseAuth)\b\s*\(/);
    }
  });
});
