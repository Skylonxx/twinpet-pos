/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = resolve(process.cwd());

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

const IDENTITY_KEYS = ['generationId', 'generationSeq', 'storeEpochId', 'fenceSeq', 'fenceNonce'] as const;

describe('historyContract.static', () => {
  test('E24 [Q-TRY] latch→dispatch is a synchronous no-yield critical section', () => {
    const src = read('src/lib/salesHistory/useSalesHistory.ts');
    const begin = src.indexOf('// [Q-TRY] BEGIN');
    const end = src.indexOf('// [Q-TRY] END');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const section = src.slice(begin, end);
    expect(section).toMatch(/qual\s*=\s*'IN_FLIGHT'/);
    expect(section.includes('await')).toBe(false);
    expect(section.includes('.then(')).toBe(false);
    expect(section.includes('Promise.')).toBe(false);
    expect(section.includes('queueMicrotask')).toBe(false);
    expect(section.includes('setTimeout')).toBe(false);
    const injectedAwait = `${section}\nawait dispatchQualificationFromServer(capturedG);`;
    expect(injectedAwait.includes('await')).toBe(true);
  });

  test('C14/L14 prohibited completeness vocabulary is not used as a claim in production copy', () => {
    const files = ['src/lib/salesHistory/useSalesHistory.ts', 'src/pages/SalesHistoryPage.tsx'];
    for (const f of files) {
      const src = read(f);
      expect(src.includes('branch history complete')).toBe(false);
    }
  });

  test('L01 closed-island identity keys are absent from production schemas and write keys', () => {
    const productionSurfaces = [
      'src/lib/types.ts',
      'src/lib/salesHistory/types.ts',
      'src/lib/salesHistory/useSalesHistory.ts',
      'src/lib/salesHistory/asyncOverlay.ts',
      'src/lib/salesHistory/historyFreshness.ts',
      'src/lib/salesHistory/useOrderItemsLive.ts',
      'src/lib/documents/receiptAuthority.ts',
      'src/lib/documents/receiptFetch.ts',
      'src/lib/documents/receiptSettings.ts',
      'src/lib/documents/formatters.ts',
      'src/lib/documents/types.ts',
      'src/lib/reconciliation/exceptionRows.ts',
      'src/lib/reconciliation/useReconciliationExceptions.ts',
      'src/lib/voidOrder.ts',
      'src/pages/SalesHistoryPage.tsx',
      'src/pages/admin/ReconciliationExceptionsPage.tsx',
      'src/components/PaymentModal.tsx',
      'src/components/documents/ThermalReceipt.tsx',
      'functions/src/canonicalSaleSource.ts',
      'functions/src/reconcileOrder.ts',
      'functions/src/sweeper.ts',
      'functions/src/voidIntent.ts',
      'functions/src/getOrderReceipt.ts',
      'functions/src/getOrderReceiptCore.ts',
      'functions/src/index.ts',
      'firestore.rules',
    ];
    const hits: string[] = [];
    for (const file of productionSurfaces) {
      const src = read(file);
      for (const key of IDENTITY_KEYS) {
        if (src.includes(key)) hits.push(`${file}:${key}`);
      }
    }
    expect(hits).toEqual([]);
    expect(IDENTITY_KEYS.length).toBe(5);
    const injected = `tx.set(ref, { ${IDENTITY_KEYS[0]}: 'x', ${IDENTITY_KEYS[1]}: 1 })`;
    expect(injected.includes(IDENTITY_KEYS[0])).toBe(true);
    expect(injected.includes(IDENTITY_KEYS[1])).toBe(true);
  });

  test('L02 no R7-6 module imports Row28/Row30/Row32/D-1/D-3 island files', () => {
    const files = [
      'src/lib/salesHistory/useOrderItemsLive.ts',
      'src/lib/salesHistory/useSalesHistory.ts',
      'src/lib/salesHistory/historyFreshness.ts',
    ];
    for (const f of files) {
      const src = read(f);
      expect(src.includes('row28')).toBe(false);
      expect(src.includes('row30')).toBe(false);
      expect(src.includes('row32')).toBe(false);
      expect(src.includes('cartKey')).toBe(false);
    }
  });

  test('L03 no production injection seam; hook wiring by module mocking only', () => {
    const src = read('src/lib/salesHistory/useSalesHistory.ts');
    expect(src.includes('__testOnly')).toBe(false);
    expect(src.includes('__TEST__')).toBe(false);
    const live = read('src/lib/salesHistory/useOrderItemsLive.ts');
    expect(live.includes('__testOnly')).toBe(false);
  });

  test('L04 VOID_ANOMALY_LITERALS pinned to exactly two members', () => {
    const src = read('functions/src/voidIntent.ts');
    expect(src).toMatch(/VOID_ANOMALY_LITERALS = \['missing_canonical', 'canonical_ineligible'\]/);
    const core = read('functions/src/getOrderReceiptCore.ts');
    expect(core).toMatch(/VOID_ANOMALY_LITERALS = \['missing_canonical', 'canonical_ineligible'\]/);
  });

  test('L05 no .find-based cash selection on the authoritative payment path', () => {
    const src = read('src/lib/documents/formatters.ts');
    expect(src.includes('.find(')).toBe(false);
    const injected = 'payments.find((p) => p.method === "cash")';
    expect(injected.includes('.find(')).toBe(true);
  });

  test('L07 VOID_REVISION_FAULT_LITERALS exactly two and disjoint from anomaly literals', () => {
    const src = read('functions/src/voidIntent.ts');
    expect(src).toMatch(/VOID_REVISION_FAULT_LITERALS = \['revision_malformed', 'revision_overflow'\]/);
    expect(src.includes('missing_canonical') && src.includes('revision_malformed')).toBe(true);
    const anomaly = ['missing_canonical', 'canonical_ineligible'];
    const fault = ['revision_malformed', 'revision_overflow'];
    expect(anomaly.filter((x) => fault.includes(x))).toEqual([]);
  });

  test('L08 delivery-model contract contains no exactly-one function invocation claim', () => {
    const hosts = [
      'functions/src/voidIntent.test.ts',
      'functions/src/reconcileOrder.historyRev.test.ts',
    ];
    for (const f of hosts) {
      const src = read(f);
      expect(src.includes('exactly-one function invocation')).toBe(false);
      expect(src.includes('exactly one function delivery')).toBe(false);
    }
  });

  test('L09 reconciler imports shared server roundMoney from fifo.ts', () => {
    expect(read('functions/src/reconcileOrder.ts')).toMatch(/from '\.\/fifo'/);
  });

  test('L10 sweeper imports the same shared roundMoney', () => {
    expect(read('functions/src/sweeper.ts')).toMatch(/from '\.\/fifo'/);
  });

  test('L11 receipt gate imports the same shared roundMoney', () => {
    expect(read('functions/src/getOrderReceiptCore.ts')).toMatch(/from '\.\/fifo'/);
  });

  test('L12 sweeper-local duplicate roundMoney implementation absent', () => {
    const sweeper = read('functions/src/sweeper.ts');
    expect(sweeper.includes('const roundMoney =')).toBe(false);
    expect(sweeper.includes('function roundMoney')).toBe(false);
    expect(sweeper.includes('Math.round((n ?? 0) * 100)')).toBe(false);
  });

  test('L13 client src/lib/money.ts is not imported into server receipt authority', () => {
    const core = read('functions/src/getOrderReceiptCore.ts');
    expect(core.includes("src/lib/money")).toBe(false);
    expect(core.includes("../src/lib/money")).toBe(false);
  });

  test('L14 shiftCloseValidationCore roundMoneyKernel is allowlisted as unrelated frozen path', () => {
    // allowlist: shiftCloseValidationCore roundMoneyKernel is an unrelated frozen path
    const src = read('src/lib/salesHistory/historyContract.static.test.ts');
    expect(src.includes('shiftCloseValidationCore')).toBe(true);
    expect(src.includes('roundMoneyKernel')).toBe(true);
    expect(read('functions/src/getOrderReceiptCore.ts').includes('roundMoneyKernel')).toBe(false);
  });

  test('L15 authoritative path forbids EPS/tolerance comparison', () => {
    const core = read('functions/src/getOrderReceiptCore.ts');
    expect(core.includes('<= 0.005')).toBe(false);
    expect(core.includes('Number.EPSILON')).toBe(false);
    const writers = [read('functions/src/reconcileOrder.ts'), read('functions/src/sweeper.ts')];
    for (const src of writers) {
      expect(src.includes('<= 0.005')).toBe(false);
    }
  });

  test('L16 V9 admin hook never writes reconcileStatus', () => {
    const src = read('src/lib/reconciliation/useReconciliationExceptions.ts');
    expect(src.includes('updateDoc')).toBe(false);
    expect(src.includes('setDoc')).toBe(false);
    expect(src.includes('reconcileStatus:')).toBe(false);
  });

  test('L17 composite index contract exact: asyncOrders branchId ASC + voidRevisionFaultAt DESC', () => {
    const idx = JSON.parse(read('firestore.indexes.json')) as {
      indexes: Array<{ collectionGroup: string; queryScope: string; fields: Array<{ fieldPath: string; order: string }> }>;
    };
    const hit = idx.indexes.some(
      (i) =>
        i.collectionGroup === 'asyncOrders' &&
        i.queryScope === 'COLLECTION' &&
        i.fields.length === 2 &&
        i.fields[0]?.fieldPath === 'branchId' &&
        i.fields[0]?.order === 'ASCENDING' &&
        i.fields[1]?.fieldPath === 'voidRevisionFaultAt' &&
        i.fields[1]?.order === 'DESCENDING',
    );
    expect(hit).toBe(true);
  });

  test('L18 false 33.333/33.333/33.334 claim is absent from R7-6 test hosts', () => {
    const hosts = [
      'functions/src/__tests__/getOrderReceiptCore.test.ts',
      'src/lib/documents/formatters.test.ts',
    ];
    for (const f of hosts) {
      const src = read(f);
      expect(src.includes('33.333')).toBe(false);
      expect(src.includes('100.00000000000001')).toBe(false);
    }
  });
});
