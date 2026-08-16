/**
 * D-3 trusted-orchestration-owner contract. Test-only.
 * No production test seam. No fourth file.
 */
import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import * as ts from 'typescript';
import facadeSourceRaw from './trustedOrchestrationOwner.ts?raw';
import confinementContractRaw from './saleSubmissionWriterConfinement.test.ts?raw';
import contractSelfRaw from './trustedOrchestrationOwner.contract.test.ts?raw';

vi.mock('./activeCartSnapshotStore', { spy: true });
vi.mock('./saleSubmissionEvidenceStore', { spy: true });

// C5 cart-first host: relative value-import order is load-bearing and must
// not be auto-sorted. Cart-store value imports MUST precede evidence-store
// value imports so this file enters the two-predicate cycle cart-first.
import {
  acquireSaleSubmissionResumeFence,
  beginActiveCartGeneration,
  isAuthenticAcquiredResumeFenceAuthorization,
  readActiveCartDurableDump,
  readActiveCartSnapshot,
  releaseSaleSubmissionResumeFence,
} from './activeCartSnapshotStore';
import * as cartRuntimeExports from './activeCartSnapshotStore';
import {
  commitSaleSubmissionAbsenceSeal,
  isAuthenticProvenEvidenceAbsence,
} from './saleSubmissionEvidenceStore';
import * as evidenceRuntimeExports from './saleSubmissionEvidenceStore';
import {
  acquireOwnedSaleSubmissionResumeFence,
  beginOwnedActiveCartGeneration,
  claimTrustedOrchestrationOwner,
  commitOwnedSaleSubmissionAbsenceSeal,
  isAuthenticTrustedOrchestrationOwner,
  isTrustedOrchestrationOwnerFor,
  releaseOwnedSaleSubmissionResumeFence,
  releaseTrustedOrchestrationOwner,
  type TrustedOrchestrationOwner,
} from './trustedOrchestrationOwner';
import * as facadeRuntimeExports from './trustedOrchestrationOwner';

const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';
const OPEN_IDLE = { held: false, fenceSeq: 0, fenceNonce: '' } as const;
const CROCKFORD_ID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

const FROZEN_D3_RUNTIME_EXPORTS = [
  'acquireOwnedSaleSubmissionResumeFence',
  'beginOwnedActiveCartGeneration',
  'claimTrustedOrchestrationOwner',
  'commitOwnedSaleSubmissionAbsenceSeal',
  'isAuthenticTrustedOrchestrationOwner',
  'isTrustedOrchestrationOwnerFor',
  'releaseOwnedSaleSubmissionResumeFence',
  'releaseTrustedOrchestrationOwner',
] as const;

const FROZEN_FACADE_CART_IMPORTS = [
  'acquireSaleSubmissionResumeFence',
  'beginActiveCartGeneration',
  'isAuthenticAcquiredResumeFenceAuthorization',
  'releaseSaleSubmissionResumeFence',
] as const;

const FROZEN_FACADE_EVIDENCE_IMPORTS = ['commitSaleSubmissionAbsenceSeal'] as const;

const FROZEN_C5_COMMENT = [
  '// C5 cart-first host: relative value-import order is load-bearing and must',
  '// not be auto-sorted. Cart-store value imports MUST precede evidence-store',
  '// value imports so this file enters the two-predicate cycle cart-first.',
].join('\n');

const FROZEN_V1_SUITE_FILES = [
  '/src/lib/pos/offline/trustedOrchestrationOwner.contract.test.ts',
  '/src/lib/pos/offline/activeCartSnapshotStore.test.ts',
  '/src/lib/pos/offline/saleSubmissionEvidenceStore.test.ts',
  '/src/lib/pos/offline/saleSubmissionAuthorizationLifetime.test.ts',
  '/src/lib/pos/offline/saleSubmissionDurableCurrentness.test.ts',
  '/src/lib/pos/offline/saleSubmissionGenerationProducer.test.ts',
  '/src/lib/pos/offline/saleSubmissionWriterConfinement.test.ts',
] as const;

const V1_SUITE_RAW = import.meta.glob('/src/lib/pos/offline/*.test.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const trackedPrototypeSpies: MockInstance[] = [];

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    req.onblocked = () => resolve();
  });
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(value, (_, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const rec = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(rec).sort().map((k) => [k, rec[k]]));
    }
    return v;
  });
}

async function captureCartDump() {
  const dump = await readActiveCartDurableDump();
  return { dump, serialized: stableSerialize(dump) };
}

async function inspectEvidenceStores(): Promise<{
  pointerKeys: IDBValidKey[];
  entryKeys: IDBValidKey[];
  pointers: unknown[];
}> {
  const dbi = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(EVIDENCE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(POINTER_STORE)) db.createObjectStore(POINTER_STORE);
      if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  try {
    const tx = dbi.transaction([POINTER_STORE, ENTRY_STORE], 'readonly');
    const pointerStore = tx.objectStore(POINTER_STORE);
    const entryStore = tx.objectStore(ENTRY_STORE);
    const pointerKeys = await reqP(pointerStore.getAllKeys());
    const pointers = await reqP(pointerStore.getAll());
    const entryKeys = await reqP(entryStore.getAllKeys());
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
    });
    return { pointerKeys, entryKeys, pointers };
  } finally {
    dbi.close();
  }
}

async function captureEvidenceDump() {
  const inspected = await inspectEvidenceStores();
  return {
    ...inspected,
    serialized: stableSerialize({
      pointerKeys: inspected.pointerKeys,
      entryKeys: inspected.entryKeys,
      pointers: inspected.pointers,
    }),
  };
}

function installIdbMutationSpies(): MockInstance[] {
  const spies = [
    vi.spyOn(IDBObjectStore.prototype, 'put'),
    vi.spyOn(IDBObjectStore.prototype, 'add'),
    vi.spyOn(IDBObjectStore.prototype, 'delete'),
    vi.spyOn(IDBObjectStore.prototype, 'clear'),
  ];
  trackedPrototypeSpies.push(...spies);
  return spies;
}

function idbMutationCount(spies: MockInstance[]): number {
  return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

function parseFacade(): ts.SourceFile {
  return ts.createSourceFile(
    '/src/lib/pos/offline/trustedOrchestrationOwner.ts',
    facadeSourceRaw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function specifierText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function isValueImport(node: ts.ImportDeclaration): boolean {
  return node.importClause === undefined || node.importClause.isTypeOnly !== true;
}

function collectRuntimeExportNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of sf.statements) {
    const hasExport = Boolean(
      ts.canHaveModifiers(stmt) &&
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
    );
    if (ts.isFunctionDeclaration(stmt) && hasExport && stmt.name) {
      names.add(stmt.name.text);
    }
    if (ts.isVariableStatement(stmt) && hasExport) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.add(decl.name.text);
      }
    }
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const element of stmt.exportClause.elements) {
        if (!element.isTypeOnly) names.add(element.name.text);
      }
    }
  }
  return names;
}

function findExportedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  return sf.statements.find(
    (stmt): stmt is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(stmt) && stmt.name?.text === name,
  );
}

function containsNodeKind(root: ts.Node, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function identifierCalleeCalls(root: ts.Node): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      names.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function identifierNewCalleeCalls(root: ts.Node): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      names.push(node.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function asOwner(value: unknown): TrustedOrchestrationOwner {
  return value as TrustedOrchestrationOwner;
}

function canonicalGenerationKey(branchId: string, deviceId: string, generationId: string): string {
  return [branchId, deviceId, generationId].map((part) => `${part.length}:${part}`).join('|');
}

async function assertBeginDurableAfterState(
  control: Awaited<ReturnType<typeof beginActiveCartGeneration>>,
  input: { branchId: string; deviceId: string; asyncOrderId: string; billId: string },
): Promise<void> {
  if (!control.ok) throw new Error('begin control failed');
  const record = await readActiveCartSnapshot(input.branchId, input.deviceId);
  expect(record).toBeDefined();
  if (!record) throw new Error('missing begin durable record');
  expect(record.branchId).toBe(input.branchId);
  expect(record.deviceId).toBe(input.deviceId);
  expect(record.asyncOrderId).toBe(input.asyncOrderId);
  expect(record.billId).toBe(input.billId);
  expect(record.generationId).toBe(control.generationId);
  expect(record.generationSeq).toBe(control.generationSeq);
  expect(record.storeEpochId).toBe(control.storeEpochId);
  expect(record.generationId).toMatch(CROCKFORD_ID);
  expect(record.generationSeq).toBe(1);
  expect(record.storeEpochId).toMatch(CROCKFORD_ID);
  expect(record.schemaVersion).toBe(1);
  expect(record.marker).toBe('S2');
  expect(record.resumeAttempts).toBe(0);
  expect(record.resumeFence).toEqual(OPEN_IDLE);
}

async function assertAcquireDurableAfterState(
  control: Awaited<ReturnType<typeof acquireSaleSubmissionResumeFence>>,
  branchId: string,
  deviceId: string,
): Promise<void> {
  if (!control.ok) throw new Error('acquire control failed');
  const record = await readActiveCartSnapshot(branchId, deviceId);
  expect(record).toBeDefined();
  if (!record) throw new Error('missing acquire durable record');
  expect(record.branchId).toBe(branchId);
  expect(record.deviceId).toBe(deviceId);
  expect(record.resumeFence.held).toBe(true);
  expect(record.resumeFence.fenceSeq).toBe(control.authorization.fenceSeq);
  expect(record.resumeFence.fenceNonce).toBe(control.authorization.fenceNonce);
  expect(record.resumeAttempts).toBe(0);
  expect(record.generationId).toBe(control.authorization.generationId);
  expect(record.generationSeq).toBe(control.authorization.generationSeq);
  expect(record.storeEpochId).toBe(control.authorization.storeEpochId);
  expect(isAuthenticAcquiredResumeFenceAuthorization(control.authorization)).toBe(true);
}

async function assertCommitDurableAfterState(
  control: Awaited<ReturnType<typeof commitSaleSubmissionAbsenceSeal>>,
  authorization: {
    branchId: string;
    deviceId: string;
    generationId: string;
    generationSeq: number;
    storeEpochId: string;
    asyncOrderId: string;
    billId: string;
    fenceSeq: number;
    fenceNonce: string;
  },
): Promise<void> {
  if (!control.ok) throw new Error('commit control failed');
  const generationKey = canonicalGenerationKey(
    authorization.branchId,
    authorization.deviceId,
    authorization.generationId,
  );
  const inspected = await inspectEvidenceStores();
  expect(inspected.pointerKeys).toEqual([generationKey]);
  expect(inspected.entryKeys).toEqual([]);
  const pointer = inspected.pointers[0] as {
    kind?: string;
    generationId?: string;
    generationSeq?: number;
    barrierFenceSeq?: number;
    barrierFenceNonce?: string;
  };
  expect(pointer.kind).toBe('absence_seal');
  expect(pointer.generationId).toBe(authorization.generationId);
  expect(pointer.generationSeq).toBe(authorization.generationSeq);
  expect(pointer.barrierFenceSeq).toBe(authorization.fenceSeq);
  expect(pointer.barrierFenceNonce).toBe(authorization.fenceNonce);
  expect(control.proof.generationId).toBe(authorization.generationId);
  expect(control.proof.generationSeq).toBe(authorization.generationSeq);
  expect(control.proof.barrierFenceSeq).toBe(authorization.fenceSeq);
  expect(control.proof.barrierFenceNonce).toBe(authorization.fenceNonce);
  expect(isAuthenticProvenEvidenceAbsence(control.proof)).toBe(true);
}

async function assertReleaseDurableAfterState(
  branchId: string,
  deviceId: string,
  authorization: {
    generationId: string;
    generationSeq: number;
    fenceSeq: number;
    fenceNonce: string;
  },
): Promise<void> {
  const record = await readActiveCartSnapshot(branchId, deviceId);
  expect(record).toBeDefined();
  if (!record) throw new Error('missing release durable record');
  expect(record.resumeFence.held).toBe(false);
  expect(record.resumeAttempts).toBe(1);
  expect(record.generationId).toBe(authorization.generationId);
  expect(record.generationSeq).toBe(authorization.generationSeq);
  expect(record.resumeFence.fenceSeq).toBe(authorization.fenceSeq);
  expect(record.resumeFence.fenceNonce).toBe(authorization.fenceNonce);
}

async function arrangeOpenIdle(branchId: string, deviceId: string, asyncOrderId: string, billId: string) {
  const begun = await beginActiveCartGeneration({ branchId, deviceId, asyncOrderId, billId });
  if (!begun.ok) throw new Error('arrange begin failed');
  return begun;
}

async function arrangeHeld(branchId: string, deviceId: string, asyncOrderId: string, billId: string) {
  await arrangeOpenIdle(branchId, deviceId, asyncOrderId, billId);
  const acquired = await acquireSaleSubmissionResumeFence({ branchId, deviceId });
  if (!acquired.ok) throw new Error('arrange acquire failed');
  return acquired.authorization;
}

async function arrangeSealed(branchId: string, deviceId: string, asyncOrderId: string, billId: string) {
  const authorization = await arrangeHeld(branchId, deviceId, asyncOrderId, billId);
  const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
  if (!sealed.ok) throw new Error('arrange seal failed');
  return { authorization, proof: sealed.proof };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

afterEach(async () => {
  try {
    await deleteDb(EVIDENCE_DB_NAME);
    await deleteDb(CART_DB_NAME);
  } finally {
    for (const spy of trackedPrototypeSpies) {
      spy.mockRestore();
    }
    trackedPrototypeSpies.length = 0;
  }
});

afterAll(() => {
  expect(trackedPrototypeSpies).toHaveLength(0);
});

describe('D3-T1 legitimate claim', () => {
  test('claim succeeds with frozen zero-field authentic owner and zero durable I/O', async () => {
    const beforeCart = await captureCartDump();
    const beforeEvidence = await captureEvidenceDump();
    const spies = installIdbMutationSpies();
    const claimed = claimTrustedOrchestrationOwner('D3T1-B', 'D3T1-D');
    expect(claimed).toEqual({ ok: true, owner: expect.any(Object) });
    if (!claimed.ok) throw new Error('claim failed');
    expect(isAuthenticTrustedOrchestrationOwner(claimed.owner)).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(claimed.owner, 'D3T1-B', 'D3T1-D')).toBe(true);
    expect(Object.isFrozen(claimed.owner)).toBe(true);
    expect(Reflect.ownKeys(claimed.owner)).toHaveLength(0);
    expect(idbMutationCount(spies)).toBe(0);
    expect(beginActiveCartGeneration).not.toHaveBeenCalled();
    expect(acquireSaleSubmissionResumeFence).not.toHaveBeenCalled();
    expect(commitSaleSubmissionAbsenceSeal).not.toHaveBeenCalled();
    expect(releaseSaleSubmissionResumeFence).not.toHaveBeenCalled();
    const afterCart = await captureCartDump();
    const afterEvidence = await captureEvidenceDump();
    expect(afterCart.serialized).toBe(beforeCart.serialized);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });
});

describe('D3-T2 duplicate same-key claim', () => {
  test('immediate same-job later claim fails and incumbent remains authentic', () => {
    const first = claimTrustedOrchestrationOwner('D3T2-B', 'D3T2-D');
    const later = claimTrustedOrchestrationOwner('D3T2-B', 'D3T2-D');
    expect(first.ok).toBe(true);
    expect(later).toEqual({ ok: false });
    if (!first.ok) throw new Error('first claim failed');
    expect(isAuthenticTrustedOrchestrationOwner(first.owner)).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(first.owner, 'D3T2-B', 'D3T2-D')).toBe(true);
    expect(releaseTrustedOrchestrationOwner(first.owner)).toEqual({ ok: true });
  });
});

describe('D3-T3 semantic tuple isolation', () => {
  test('nested maps isolate (AB,C) from (A,BC) without serialized-key identity', () => {
    const left = claimTrustedOrchestrationOwner('AB', 'C');
    const right = claimTrustedOrchestrationOwner('A', 'BC');
    expect(left.ok).toBe(true);
    expect(right.ok).toBe(true);
    if (!left.ok || !right.ok) throw new Error('independent claims failed');
    expect(left.owner).not.toBe(right.owner);
    expect(isTrustedOrchestrationOwnerFor(left.owner, 'AB', 'C')).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(left.owner, 'A', 'BC')).toBe(false);
    expect(isTrustedOrchestrationOwnerFor(right.owner, 'A', 'BC')).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(right.owner, 'AB', 'C')).toBe(false);
    expect(releaseTrustedOrchestrationOwner(left.owner)).toEqual({ ok: true });
    expect(isTrustedOrchestrationOwnerFor(right.owner, 'A', 'BC')).toBe(true);
    expect(releaseTrustedOrchestrationOwner(right.owner)).toEqual({ ok: true });
  });
});

describe('D3-T4 forgery', () => {
  test('forged, cloned, rebuilt, proxied, released, and foreign-module handles refuse', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T4-B', 'D3T4-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    const empty = asOwner({});
    const clone = asOwner({ ...owner });
    const assigned = asOwner(Object.assign({}, owner));
    const rebuilt = asOwner(JSON.parse(JSON.stringify(owner)));
    const proxied = asOwner(new Proxy(owner, {}));
    const protoShaped = asOwner(Object.create(owner));
    expect(isAuthenticTrustedOrchestrationOwner(empty)).toBe(false);
    expect(isAuthenticTrustedOrchestrationOwner(clone)).toBe(false);
    expect(isAuthenticTrustedOrchestrationOwner(assigned)).toBe(false);
    expect(isAuthenticTrustedOrchestrationOwner(rebuilt)).toBe(false);
    expect(isAuthenticTrustedOrchestrationOwner(proxied)).toBe(false);
    expect(isAuthenticTrustedOrchestrationOwner(protoShaped)).toBe(false);
    expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(false);
    expect(isTrustedOrchestrationOwnerFor(owner, 'D3T4-B', 'D3T4-D')).toBe(false);

    const retained = claimTrustedOrchestrationOwner('D3T4-F', 'D3T4-G');
    if (!retained.ok) throw new Error('retained claim failed');
    vi.resetModules();
    const freshFacade = await import('./trustedOrchestrationOwner');
    const foreign = freshFacade.claimTrustedOrchestrationOwner('D3T4-X', 'D3T4-Y');
    if (!foreign.ok) throw new Error('foreign claim failed');
    expect(isAuthenticTrustedOrchestrationOwner(foreign.owner)).toBe(false);
    expect(freshFacade.isAuthenticTrustedOrchestrationOwner(retained.owner)).toBe(false);
    expect(releaseTrustedOrchestrationOwner(retained.owner)).toEqual({ ok: true });
    expect(freshFacade.releaseTrustedOrchestrationOwner(foreign.owner)).toEqual({ ok: true });
  });
});

describe('D3-T5 freeze / tamper / liveness', () => {
  test('frozen zero-field owner rejects mutation then releases and reclaims a new identity', () => {
    const claimed = claimTrustedOrchestrationOwner('D3T5-B', 'D3T5-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    expect(() => {
      (owner as Record<string, unknown>).branchId = 'nope';
    }).toThrow();
    expect(() => {
      Object.defineProperty(owner, 'deviceId', {
        get() {
          return 'nope';
        },
      });
    }).toThrow();
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(true);
    expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(false);
    const fresh = claimTrustedOrchestrationOwner('D3T5-B', 'D3T5-D');
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) throw new Error('reclaim failed');
    expect(fresh.owner).not.toBe(owner);
    expect(isAuthenticTrustedOrchestrationOwner(fresh.owner)).toBe(true);
    expect(releaseTrustedOrchestrationOwner(fresh.owner)).toEqual({ ok: true });
  });
});

describe('D3-T6 release / reclaim', () => {
  test('successful release permanently invalidates the old owner and mints a new identity', () => {
    const first = claimTrustedOrchestrationOwner('D3T6-B', 'D3T6-D');
    if (!first.ok) throw new Error('claim failed');
    expect(releaseTrustedOrchestrationOwner(first.owner)).toEqual({ ok: true });
    expect(isAuthenticTrustedOrchestrationOwner(first.owner)).toBe(false);
    expect(isTrustedOrchestrationOwnerFor(first.owner, 'D3T6-B', 'D3T6-D')).toBe(false);
    const second = claimTrustedOrchestrationOwner('D3T6-B', 'D3T6-D');
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('reclaim failed');
    expect(second.owner).not.toBe(first.owner);
    expect(isTrustedOrchestrationOwnerFor(second.owner, 'D3T6-B', 'D3T6-D')).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(first.owner, 'D3T6-B', 'D3T6-D')).toBe(false);
    expect(releaseTrustedOrchestrationOwner(second.owner)).toEqual({ ok: true });
  });
});

describe('D3-T7 double / foreign release', () => {
  test('second release fails and a foreign handle cannot clear another key', () => {
    const alpha = claimTrustedOrchestrationOwner('D3T7-A', 'D3T7-1');
    const beta = claimTrustedOrchestrationOwner('D3T7-B', 'D3T7-2');
    if (!alpha.ok || !beta.ok) throw new Error('claims failed');
    expect(releaseTrustedOrchestrationOwner(alpha.owner)).toEqual({ ok: true });
    expect(releaseTrustedOrchestrationOwner(alpha.owner)).toEqual({ ok: false });
    expect(isTrustedOrchestrationOwnerFor(beta.owner, 'D3T7-B', 'D3T7-2')).toBe(true);
    expect(releaseTrustedOrchestrationOwner(beta.owner)).toEqual({ ok: true });
    expect(isAuthenticTrustedOrchestrationOwner(beta.owner)).toBe(false);
  });
});

describe('D3-T8 module reset', () => {
  test('resetModules yields a fresh facade registry while retained autospied raw modules stay the same mocked namespaces', async () => {
    const oldFacade = await import('./trustedOrchestrationOwner');
    const oldClaim = oldFacade.claimTrustedOrchestrationOwner('D3T8-B', 'D3T8-D');
    expect(oldClaim.ok).toBe(true);
    if (!oldClaim.ok) throw new Error('old claim failed');
    expect(oldFacade.isAuthenticTrustedOrchestrationOwner(oldClaim.owner)).toBe(true);

    vi.resetModules();
    const freshFacade = await import('./trustedOrchestrationOwner');
    expect(freshFacade).not.toBe(oldFacade);
    expect(oldFacade.isAuthenticTrustedOrchestrationOwner(oldClaim.owner)).toBe(true);
    expect(oldFacade.isTrustedOrchestrationOwnerFor(oldClaim.owner, 'D3T8-B', 'D3T8-D')).toBe(true);
    expect(freshFacade.isAuthenticTrustedOrchestrationOwner(oldClaim.owner)).toBe(false);
    expect(freshFacade.isTrustedOrchestrationOwnerFor(oldClaim.owner, 'D3T8-B', 'D3T8-D')).toBe(false);
    const freshClaim = freshFacade.claimTrustedOrchestrationOwner('D3T8-B', 'D3T8-D');
    expect(freshClaim.ok).toBe(true);
    if (!freshClaim.ok) throw new Error('fresh claim failed');
    expect(freshClaim.owner).not.toBe(oldClaim.owner);
    expect(freshFacade.isAuthenticTrustedOrchestrationOwner(freshClaim.owner)).toBe(true);
    expect(oldFacade.isAuthenticTrustedOrchestrationOwner(freshClaim.owner)).toBe(false);
    expect(oldFacade.releaseTrustedOrchestrationOwner(oldClaim.owner)).toEqual({ ok: true });
    expect(freshFacade.releaseTrustedOrchestrationOwner(freshClaim.owner)).toEqual({ ok: true });
  });
});

describe('D3-T9 generation rollover through owned wrappers', () => {
  test('same D-3 owner remains authentic across owned TERMINAL successor', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T9-B', 'D3T9-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    const first = await beginOwnedActiveCartGeneration(owner, {
      branchId: 'D3T9-B',
      deviceId: 'D3T9-D',
      asyncOrderId: 'order-1',
      billId: 'B-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('owned begin failed');
    const acquired = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T9-B',
      deviceId: 'D3T9-D',
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('owned acquire failed');
    const sealed = await commitOwnedSaleSubmissionAbsenceSeal(owner, acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('owned seal failed');
    const released = await releaseOwnedSaleSubmissionResumeFence(owner, acquired.authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    const terminal = await readActiveCartSnapshot('D3T9-B', 'D3T9-D');
    expect(terminal?.resumeFence.held).toBe(false);
    expect(terminal?.resumeAttempts).toBe(1);
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(owner, 'D3T9-B', 'D3T9-D')).toBe(true);

    const successor = await beginOwnedActiveCartGeneration(owner, {
      branchId: 'D3T9-B',
      deviceId: 'D3T9-D',
      asyncOrderId: 'order-2',
      billId: 'B-2',
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('owned successor failed');
    expect(successor.generationSeq).toBe((first.generationSeq as number) + 1);
    expect(successor.generationId).not.toBe(first.generationId);
    expect(successor.storeEpochId).toBe(first.storeEpochId);
    expect(successor.generationId).toMatch(CROCKFORD_ID);
    const after = await readActiveCartSnapshot('D3T9-B', 'D3T9-D');
    expect(after?.resumeFence).toEqual(OPEN_IDLE);
    expect(after?.resumeAttempts).toBe(0);
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(owner, 'D3T9-B', 'D3T9-D')).toBe(true);
    expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
  });
});

describe('D3-T10 synchronous claim atomicity', () => {
  test('claim is a non-async non-generator with no await/yield/identifier-callee seam', () => {
    expect(claimTrustedOrchestrationOwner.constructor.name).toBe('Function');
    expect(claimTrustedOrchestrationOwner.constructor.name).not.toBe('AsyncFunction');
    expect(claimTrustedOrchestrationOwner.constructor.name).not.toBe('GeneratorFunction');
    const sf = parseFacade();
    const fn = findExportedFunction(sf, 'claimTrustedOrchestrationOwner');
    expect(fn).toBeDefined();
    if (!fn || !fn.body) throw new Error('claim function missing');
    expect(fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false).toBe(false);
    expect(fn.asteriskToken).toBeUndefined();
    expect(containsNodeKind(fn, (n) => ts.isAwaitExpression(n))).toBe(false);
    expect(containsNodeKind(fn, (n) => ts.isYieldExpression(n))).toBe(false);
    expect(identifierCalleeCalls(fn.body)).toEqual([]);
    const first = claimTrustedOrchestrationOwner('D3T10-B', 'D3T10-D');
    const second = claimTrustedOrchestrationOwner('D3T10-B', 'D3T10-D');
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!first.ok) throw new Error('first claim failed');
    expect(releaseTrustedOrchestrationOwner(first.owner)).toEqual({ ok: true });
  });
});

describe('D3-T11 duplicate recovery through owned facade', () => {
  test('owned duplicate OPEN_HELD remints stay independent with one pointer and one terminal effect', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T11-B', 'D3T11-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    const begun = await beginOwnedActiveCartGeneration(owner, {
      branchId: 'D3T11-B',
      deviceId: 'D3T11-D',
      asyncOrderId: 'order-11',
      billId: 'B-11',
    });
    expect(begun.ok).toBe(true);
    const first = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T11-B',
      deviceId: 'D3T11-D',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first owned acquire failed');
    const remintA = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T11-B',
      deviceId: 'D3T11-D',
    });
    const remintB = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T11-B',
      deviceId: 'D3T11-D',
    });
    expect(remintA.ok).toBe(true);
    expect(remintB.ok).toBe(true);
    if (!remintA.ok || !remintB.ok) throw new Error('owned remint failed');
    expect(remintA.authorization).not.toBe(first.authorization);
    expect(remintB.authorization).not.toBe(first.authorization);
    expect(remintA.authorization).not.toBe(remintB.authorization);
    expect(isAuthenticAcquiredResumeFenceAuthorization(remintA.authorization)).toBe(true);
    expect(isAuthenticAcquiredResumeFenceAuthorization(remintB.authorization)).toBe(true);
    expect(remintA.authorization.fenceSeq).toBe(first.authorization.fenceSeq);
    expect(remintA.authorization.fenceNonce).toBe(first.authorization.fenceNonce);
    expect(remintB.authorization.fenceSeq).toBe(first.authorization.fenceSeq);
    expect(remintB.authorization.fenceNonce).toBe(first.authorization.fenceNonce);

    vi.clearAllMocks();
    const spies = installIdbMutationSpies();
    const [sealA, sealB] = await Promise.all([
      commitOwnedSaleSubmissionAbsenceSeal(owner, remintA.authorization),
      commitOwnedSaleSubmissionAbsenceSeal(owner, remintB.authorization),
    ]);
    expect(sealA.ok).toBe(true);
    expect(sealB.ok).toBe(true);
    if (!sealA.ok || !sealB.ok) throw new Error('owned remint seal refused');
    expect(isAuthenticProvenEvidenceAbsence(sealA.proof)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(sealB.proof)).toBe(true);
    const pointerAdds = spies[1]?.mock.calls.length ?? 0;
    expect(pointerAdds).toBe(1);

    const putBeforeRelease = spies[0]?.mock.calls.length ?? 0;
    const [releaseA, releaseB] = await Promise.all([
      releaseOwnedSaleSubmissionResumeFence(owner, remintA.authorization, {
        outcome: 'evidence_proven_absent',
        proof: sealA.proof,
      }),
      releaseOwnedSaleSubmissionResumeFence(owner, remintB.authorization, {
        outcome: 'evidence_proven_absent',
        proof: sealB.proof,
      }),
    ]);
    const terminalPuts = (spies[0]?.mock.calls.length ?? 0) - putBeforeRelease;
    expect([releaseA.ok, releaseB.ok].filter((ok) => ok)).toHaveLength(1);
    expect(terminalPuts).toBe(1);
    const inspected = await inspectEvidenceStores();
    expect(inspected.pointerKeys).toHaveLength(1);
    const after = await readActiveCartSnapshot('D3T11-B', 'D3T11-D');
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
    expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
  });
});

describe('D3-T12 direct raw-call attribution', () => {
  const wrappers = ['begin', 'acquire', 'commit', 'release'] as const;
  const classes = ['malformed', 'forged', 'released', 'wrong-key'] as const;

  test.each(wrappers.flatMap((wrapper) => classes.map((klass) => [wrapper, klass] as const)))(
    '%s refuses %s owner with zero raw delegate calls and zero IDB mutation, then raw positive control mutates',
    async (wrapper, klass) => {
      const branchId = `D3T12-${wrapper}-${klass}-B`;
      const deviceId = `D3T12-${wrapper}-${klass}-D`;
      const asyncOrderId = `order-${wrapper}-${klass}`;
      const billId = `bill-${wrapper}-${klass}`;
      const otherBranch = `${branchId}-OTHER`;
      const otherDevice = `${deviceId}-OTHER`;

      let liveOwner: TrustedOrchestrationOwner | undefined;
      if (klass === 'released' || klass === 'wrong-key') {
        const claimed = claimTrustedOrchestrationOwner(
          klass === 'wrong-key' ? otherBranch : branchId,
          klass === 'wrong-key' ? otherDevice : deviceId,
        );
        if (!claimed.ok) throw new Error('owner claim failed');
        liveOwner = claimed.owner;
      }

      let auth: Awaited<ReturnType<typeof acquireSaleSubmissionResumeFence>> | undefined;
      let proof: Awaited<ReturnType<typeof commitSaleSubmissionAbsenceSeal>> | undefined;
      if (wrapper === 'acquire' || wrapper === 'commit' || wrapper === 'release') {
        await arrangeOpenIdle(branchId, deviceId, asyncOrderId, billId);
      }
      if (wrapper === 'commit' || wrapper === 'release') {
        auth = await acquireSaleSubmissionResumeFence({ branchId, deviceId });
        if (!auth.ok) throw new Error('fixture acquire failed');
      }
      if (wrapper === 'release') {
        if (!auth || !auth.ok) throw new Error('fixture auth missing');
        proof = await commitSaleSubmissionAbsenceSeal(auth.authorization);
        if (!proof.ok) throw new Error('fixture seal failed');
      }

      if (klass === 'released' && liveOwner) {
        expect(releaseTrustedOrchestrationOwner(liveOwner)).toEqual({ ok: true });
      }

      const invalidOwner =
        klass === 'malformed'
          ? asOwner(undefined)
          : klass === 'forged'
            ? asOwner({})
            : liveOwner
              ? liveOwner
              : asOwner({});

      const beforeCart = await captureCartDump();
      const beforeEvidence = await captureEvidenceDump();
      vi.clearAllMocks();
      const spies = installIdbMutationSpies();

      const input = { branchId, deviceId, asyncOrderId, billId };
      let result: { ok: boolean };
      if (wrapper === 'begin') {
        result = await beginOwnedActiveCartGeneration(invalidOwner, input);
      } else if (wrapper === 'acquire') {
        result = await acquireOwnedSaleSubmissionResumeFence(invalidOwner, { branchId, deviceId });
      } else if (wrapper === 'commit') {
        if (!auth || !auth.ok) throw new Error('missing auth');
        result = await commitOwnedSaleSubmissionAbsenceSeal(invalidOwner, auth.authorization);
      } else {
        if (!auth || !auth.ok || !proof || !proof.ok) throw new Error('missing release fixture');
        result = await releaseOwnedSaleSubmissionResumeFence(invalidOwner, auth.authorization, {
          outcome: 'evidence_proven_absent',
          proof: proof.proof,
        });
      }

      expect(result).toEqual({ ok: false });
      if (wrapper === 'begin') expect(beginActiveCartGeneration).toHaveBeenCalledTimes(0);
      if (wrapper === 'acquire') expect(acquireSaleSubmissionResumeFence).toHaveBeenCalledTimes(0);
      if (wrapper === 'commit') expect(commitSaleSubmissionAbsenceSeal).toHaveBeenCalledTimes(0);
      if (wrapper === 'release') expect(releaseSaleSubmissionResumeFence).toHaveBeenCalledTimes(0);
      expect(idbMutationCount(spies)).toBe(0);
      const afterRefusalCart = await captureCartDump();
      const afterRefusalEvidence = await captureEvidenceDump();
      expect(afterRefusalCart.serialized).toBe(beforeCart.serialized);
      expect(afterRefusalEvidence.serialized).toBe(beforeEvidence.serialized);

      if (wrapper === 'begin') {
        const control = await beginActiveCartGeneration(input);
        expect(control.ok).toBe(true);
        expect(beginActiveCartGeneration).toHaveBeenCalledTimes(1);
        await assertBeginDurableAfterState(control, input);
      } else if (wrapper === 'acquire') {
        const control = await acquireSaleSubmissionResumeFence({ branchId, deviceId });
        expect(control.ok).toBe(true);
        expect(acquireSaleSubmissionResumeFence).toHaveBeenCalledTimes(1);
        await assertAcquireDurableAfterState(control, branchId, deviceId);
      } else if (wrapper === 'commit') {
        if (!auth || !auth.ok) throw new Error('missing auth for control');
        const control = await commitSaleSubmissionAbsenceSeal(auth.authorization);
        expect(control.ok).toBe(true);
        expect(commitSaleSubmissionAbsenceSeal).toHaveBeenCalledTimes(1);
        await assertCommitDurableAfterState(control, auth.authorization);
      } else {
        if (!auth || !auth.ok || !proof || !proof.ok) throw new Error('missing release control fixture');
        const control = await releaseSaleSubmissionResumeFence(auth.authorization, {
          outcome: 'evidence_proven_absent',
          proof: proof.proof,
        });
        expect(control.ok).toBe(true);
        expect(releaseSaleSubmissionResumeFence).toHaveBeenCalledTimes(1);
        await assertReleaseDurableAfterState(branchId, deviceId, auth.authorization);
      }
      expect(idbMutationCount(spies)).toBeGreaterThan(0);

      if (klass === 'wrong-key' && liveOwner) {
        expect(releaseTrustedOrchestrationOwner(liveOwner)).toEqual({ ok: true });
      }
    },
  );
});

describe('D3-T13 static / C-5 / re-export contract', () => {
  test('facade runtime export surface set-equals the frozen D-3 APIs in both directions', () => {
    const sf = parseFacade();
    const astNames = [...collectRuntimeExportNames(sf)].sort();
    const liveNames = Object.keys(facadeRuntimeExports).sort();
    const frozen = [...FROZEN_D3_RUNTIME_EXPORTS].sort();
    expect(astNames).toEqual(frozen);
    expect(liveNames).toEqual(frozen);
    expect(frozen).toEqual(astNames);
    expect(astNames).toEqual(liveNames);
  });

  test('C-5 cart-first value-import order is non-vacuous and the load-bearing comment is present', () => {
    expect(facadeSourceRaw).toContain(FROZEN_C5_COMMENT);
    const sf = parseFacade();
    const cartPositions: number[] = [];
    const evidencePositions: number[] = [];
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt) || !isValueImport(stmt)) continue;
      const spec = specifierText(stmt.moduleSpecifier);
      if (spec === './activeCartSnapshotStore') cartPositions.push(stmt.getStart(sf));
      if (spec === './saleSubmissionEvidenceStore') evidencePositions.push(stmt.getStart(sf));
    }
    expect(cartPositions.length).toBeGreaterThan(0);
    expect(evidencePositions.length).toBeGreaterThan(0);
    expect(Math.max(...cartPositions)).toBeLessThan(Math.min(...evidencePositions));
  });

  test('exact governed island imports and provenance-aware rejection of every re-export form', () => {
    const sf = parseFacade();
    const islandSpecifiers = new Set(['./activeCartSnapshotStore', './saleSubmissionEvidenceStore']);
    const importedLocalToOrigin = new Map<string, { specifier: string; symbol: string }>();
    const cartSymbols: string[] = [];
    const evidenceSymbols: string[] = [];
    const otherIsland = new Set<string>();

    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const spec = specifierText(stmt.moduleSpecifier);
      expect(spec, 'dynamic/nonliteral import').toBeDefined();
      if (spec === undefined) continue;
      expect(spec.startsWith('.')).toBe(true);
      if (!islandSpecifiers.has(spec)) continue;
      const named = stmt.importClause?.namedBindings;
      expect(named && ts.isNamedImports(named)).toBe(true);
      if (!(named && ts.isNamedImports(named))) continue;
      for (const element of named.elements) {
        const symbol = element.propertyName?.text ?? element.name.text;
        importedLocalToOrigin.set(element.name.text, { specifier: spec, symbol });
        if (spec === './activeCartSnapshotStore') cartSymbols.push(symbol);
        if (spec === './saleSubmissionEvidenceStore') evidenceSymbols.push(symbol);
      }
    }

    const allowedCart = new Set<string>(FROZEN_FACADE_CART_IMPORTS);
    const allowedEvidence = new Set<string>(FROZEN_FACADE_EVIDENCE_IMPORTS);
    for (const symbol of cartSymbols) {
      expect(allowedCart.has(symbol), symbol).toBe(true);
      if (!allowedCart.has(symbol)) otherIsland.add(symbol);
    }
    for (const symbol of evidenceSymbols) {
      expect(allowedEvidence.has(symbol), symbol).toBe(true);
      if (!allowedEvidence.has(symbol)) otherIsland.add(symbol);
    }
    expect([...cartSymbols].sort()).toEqual([...FROZEN_FACADE_CART_IMPORTS].sort());
    expect([...evidenceSymbols].sort()).toEqual([...FROZEN_FACADE_EVIDENCE_IMPORTS].sort());
    expect(otherIsland.size).toBe(0);

    let exportAssignmentCount = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isExportAssignment(node)) exportAssignmentCount += 1;
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error('dynamic import present');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(exportAssignmentCount).toBe(0);

    for (const stmt of sf.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      if (stmt.moduleSpecifier) {
        const spec = specifierText(stmt.moduleSpecifier);
        expect(stmt.exportClause, 'export * forbidden').toBeDefined();
        expect(stmt.exportClause && ts.isNamedExports(stmt.exportClause)).toBe(true);
        expect(spec && islandSpecifiers.has(spec)).toBe(false);
        continue;
      }
      expect(stmt.exportClause && ts.isNamedExports(stmt.exportClause)).toBeTruthy();
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) {
          const localName = element.propertyName?.text ?? element.name.text;
          expect(importedLocalToOrigin.has(localName), `local re-export of ${localName}`).toBe(false);
        }
      }
    }

    const forbiddenText = [
      'eval(',
      'fetch(',
      'Function(',
      'new Function',
      'localStorage',
      'sessionStorage',
      'indexedDB.open',
      'BroadcastChannel',
      'XMLHttpRequest',
      'WebSocket',
      'navigator.locks',
      'SharedWorker',
      'Atomics',
      'postMessage',
      "from 'saleSubmissionEvidenceTypes'",
      'from "./saleSubmissionEvidenceTypes"',
    ];
    for (const token of forbiddenText) {
      expect(facadeSourceRaw.includes(token), token).toBe(false);
    }

    const callCallees = identifierCalleeCalls(sf);
    const newCallees = identifierNewCalleeCalls(sf);
    expect(callCallees.filter((name) => name === 'fetch')).toEqual([]);
    expect(callCallees.filter((name) => name === 'Function')).toEqual([]);
    expect(newCallees.filter((name) => name === 'Function')).toEqual([]);
  });
});

describe('D3-T14 Row29 / Row32 topology after narrow update', () => {
  test('raw runtime export counts remain 7 + 2 and the facade is the added production importer', () => {
    expect(Object.keys(cartRuntimeExports).sort()).toHaveLength(7);
    expect(Object.keys(evidenceRuntimeExports).sort()).toHaveLength(2);
    expect([...Object.keys(cartRuntimeExports), ...Object.keys(evidenceRuntimeExports)].sort()).toHaveLength(9);
    expect(Object.keys(facadeRuntimeExports).sort()).toEqual([...FROZEN_D3_RUNTIME_EXPORTS].sort());
    expect(confinementContractRaw).toContain("const FACADE_FILE = '/src/lib/pos/offline/trustedOrchestrationOwner.ts';");
    expect(confinementContractRaw).toContain('const runtimeExportNames = new Set(FROZEN_ALL_NINE_RUNTIME_EXPORTS);');
    expect(confinementContractRaw).toContain('FROZEN_FACADE_CART_RUNTIME_SYMBOLS');
    expect(confinementContractRaw).toContain('FROZEN_FACADE_EVIDENCE_RUNTIME_SYMBOLS');
    expect(confinementContractRaw).not.toContain('FROZEN_ALL_EIGHT_RUNTIME_EXPORTS');
    expect(confinementContractRaw).not.toContain('all-eight');
    expect(confinementContractRaw).not.toContain('eight-name set');
    expect(confinementContractRaw).not.toContain('reachability of the eight');
    expect(confinementContractRaw).not.toMatch(/\bconst eight = /);
  });
});

describe('D3-T15 closed-suite membership', () => {
  test('frozen V1 suite files exist as test sources; execution evidence is the authorized V1 command', () => {
    const keys = Object.keys(V1_SUITE_RAW).map((k) => k.replace(/\\/g, '/'));
    expect(typeof contractSelfRaw).toBe('string');
    expect(contractSelfRaw.length).toBeGreaterThan(0);
    for (const file of FROZEN_V1_SUITE_FILES) {
      const base = file.slice(file.lastIndexOf('/') + 1);
      if (base === 'trustedOrchestrationOwner.contract.test.ts') {
        expect(contractSelfRaw.includes('D3-T15 closed-suite membership')).toBe(true);
        continue;
      }
      expect(
        keys.some((k) => k === file || k.endsWith(`/${base}`) || k.endsWith(base)),
        `missing V1 member ${file}`,
      ).toBe(true);
    }
    expect(FROZEN_V1_SUITE_FILES).toHaveLength(7);
  });
});

describe('D3-T16 exact getter counts and revoke/reclaim', () => {
  test('begin reads each field exactly once and delegates only first-read values', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T16-BEG-B', 'D3T16-BEG-D');
    if (!claimed.ok) throw new Error('claim failed');
    const counts = { branchId: 0, deviceId: 0, asyncOrderId: 0, billId: 0 };
    const input = {
      get branchId() {
        counts.branchId += 1;
        return counts.branchId === 1 ? 'D3T16-BEG-B' : 'FOREIGN-B';
      },
      get deviceId() {
        counts.deviceId += 1;
        return counts.deviceId === 1 ? 'D3T16-BEG-D' : 'FOREIGN-D';
      },
      get asyncOrderId() {
        counts.asyncOrderId += 1;
        return counts.asyncOrderId === 1 ? 'order-beg' : 'foreign-order';
      },
      get billId() {
        counts.billId += 1;
        return counts.billId === 1 ? 'bill-beg' : 'foreign-bill';
      },
    };
    vi.clearAllMocks();
    const result = await beginOwnedActiveCartGeneration(claimed.owner, input);
    expect(result.ok).toBe(true);
    expect(counts).toEqual({ branchId: 1, deviceId: 1, asyncOrderId: 1, billId: 1 });
    expect(beginActiveCartGeneration).toHaveBeenCalledTimes(1);
    const delegated = vi.mocked(beginActiveCartGeneration).mock.calls[0]?.[0];
    expect(delegated).not.toBe(input);
    expect(delegated).toEqual({
      branchId: 'D3T16-BEG-B',
      deviceId: 'D3T16-BEG-D',
      asyncOrderId: 'order-beg',
      billId: 'bill-beg',
    });
    const foreign = await readActiveCartSnapshot('FOREIGN-B', 'FOREIGN-D');
    expect(foreign).toBeUndefined();
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });

  test('acquire reads each field exactly once and delegates only first-read values', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T16-ACQ-B', 'D3T16-ACQ-D');
    if (!claimed.ok) throw new Error('claim failed');
    await arrangeOpenIdle('D3T16-ACQ-B', 'D3T16-ACQ-D', 'order-acq', 'bill-acq');
    const counts = { branchId: 0, deviceId: 0 };
    const input = {
      get branchId() {
        counts.branchId += 1;
        return counts.branchId === 1 ? 'D3T16-ACQ-B' : 'FOREIGN-B';
      },
      get deviceId() {
        counts.deviceId += 1;
        return counts.deviceId === 1 ? 'D3T16-ACQ-D' : 'FOREIGN-D';
      },
    };
    vi.clearAllMocks();
    const result = await acquireOwnedSaleSubmissionResumeFence(claimed.owner, input);
    expect(result.ok).toBe(true);
    expect(counts).toEqual({ branchId: 1, deviceId: 1 });
    expect(acquireSaleSubmissionResumeFence).toHaveBeenCalledTimes(1);
    const delegated = vi.mocked(acquireSaleSubmissionResumeFence).mock.calls[0]?.[0];
    expect(delegated).not.toBe(input);
    expect(delegated).toEqual({ branchId: 'D3T16-ACQ-B', deviceId: 'D3T16-ACQ-D' });
    const foreign = await readActiveCartSnapshot('FOREIGN-B', 'FOREIGN-D');
    expect(foreign).toBeUndefined();
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });

  test('invalid owner executes neither release request getter', async () => {
    const fixture = await arrangeSealed('D3T16-INV-B', 'D3T16-INV-D', 'order-inv', 'bill-inv');
    const counts = { outcome: 0, proof: 0 };
    const request = {
      get outcome() {
        counts.outcome += 1;
        return 'evidence_proven_absent' as const;
      },
      get proof() {
        counts.proof += 1;
        return fixture.proof;
      },
    };
    vi.clearAllMocks();
    const spies = installIdbMutationSpies();
    const result = await releaseOwnedSaleSubmissionResumeFence(asOwner({}), fixture.authorization, request);
    expect(result).toEqual({ ok: false });
    expect(counts).toEqual({ outcome: 0, proof: 0 });
    expect(releaseSaleSubmissionResumeFence).toHaveBeenCalledTimes(0);
    expect(idbMutationCount(spies)).toBe(0);
  });

  test('R-a getter-triggered owner release fails owner check #2 with zero raw release', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T16-RA-B', 'D3T16-RA-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    const begun = await beginOwnedActiveCartGeneration(owner, {
      branchId: 'D3T16-RA-B',
      deviceId: 'D3T16-RA-D',
      asyncOrderId: 'order-ra',
      billId: 'bill-ra',
    });
    expect(begun.ok).toBe(true);
    const acquired = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T16-RA-B',
      deviceId: 'D3T16-RA-D',
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const sealed = await commitOwnedSaleSubmissionAbsenceSeal(owner, acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const beforeCart = await captureCartDump();
    const beforeEvidence = await captureEvidenceDump();
    const counts = { outcome: 0, proof: 0 };
    const request = {
      get outcome() {
        counts.outcome += 1;
        return 'evidence_proven_absent' as const;
      },
      get proof() {
        counts.proof += 1;
        expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
        return sealed.proof;
      },
    };
    vi.clearAllMocks();
    const spies = installIdbMutationSpies();
    const result = await releaseOwnedSaleSubmissionResumeFence(owner, acquired.authorization, request);
    expect(result).toEqual({ ok: false });
    expect(counts.outcome).toBe(1);
    expect(counts.proof).toBe(1);
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(false);
    expect(releaseSaleSubmissionResumeFence).toHaveBeenCalledTimes(0);
    expect(idbMutationCount(spies)).toBe(0);
    const afterCart = await captureCartDump();
    const afterEvidence = await captureEvidenceDump();
    expect(afterCart.serialized).toBe(beforeCart.serialized);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
    expect(beforeCart.dump.records[0]?.resumeFence.held).toBe(true);
    expect(beforeCart.dump.records[0]?.resumeAttempts).toBe(0);
  });

  test('R-b getter-triggered release + reclaim fails stale identity at owner check #2', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T16-RB-B', 'D3T16-RB-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    const begun = await beginOwnedActiveCartGeneration(owner, {
      branchId: 'D3T16-RB-B',
      deviceId: 'D3T16-RB-D',
      asyncOrderId: 'order-rb',
      billId: 'bill-rb',
    });
    expect(begun.ok).toBe(true);
    const acquired = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T16-RB-B',
      deviceId: 'D3T16-RB-D',
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const sealed = await commitOwnedSaleSubmissionAbsenceSeal(owner, acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const beforeCart = await captureCartDump();
    const beforeEvidence = await captureEvidenceDump();
    let replacement: TrustedOrchestrationOwner | undefined;
    const counts = { outcome: 0, proof: 0 };
    const request = {
      get outcome() {
        counts.outcome += 1;
        return 'evidence_proven_absent' as const;
      },
      get proof() {
        counts.proof += 1;
        expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
        const reclaimed = claimTrustedOrchestrationOwner('D3T16-RB-B', 'D3T16-RB-D');
        expect(reclaimed.ok).toBe(true);
        if (!reclaimed.ok) throw new Error('reclaim failed');
        replacement = reclaimed.owner;
        return sealed.proof;
      },
    };
    vi.clearAllMocks();
    const spies = installIdbMutationSpies();
    const result = await releaseOwnedSaleSubmissionResumeFence(owner, acquired.authorization, request);
    expect(result).toEqual({ ok: false });
    expect(counts.outcome).toBe(1);
    expect(counts.proof).toBe(1);
    expect(replacement).toBeDefined();
    if (!replacement) throw new Error('missing replacement');
    expect(isAuthenticTrustedOrchestrationOwner(replacement)).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(replacement, 'D3T16-RB-B', 'D3T16-RB-D')).toBe(true);
    expect(isAuthenticTrustedOrchestrationOwner(owner)).toBe(false);
    expect(isTrustedOrchestrationOwnerFor(owner, 'D3T16-RB-B', 'D3T16-RB-D')).toBe(false);
    expect(releaseSaleSubmissionResumeFence).toHaveBeenCalledTimes(0);
    expect(idbMutationCount(spies)).toBe(0);
    const afterCart = await captureCartDump();
    const afterEvidence = await captureEvidenceDump();
    expect(afterCart.serialized).toBe(beforeCart.serialized);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
    expect(releaseTrustedOrchestrationOwner(replacement)).toEqual({ ok: true });
  });

  test('R-c legitimate identity-preserving delegation forwards a fresh request', async () => {
    const claimed = claimTrustedOrchestrationOwner('D3T16-RC-B', 'D3T16-RC-D');
    if (!claimed.ok) throw new Error('claim failed');
    const owner = claimed.owner;
    const begun = await beginOwnedActiveCartGeneration(owner, {
      branchId: 'D3T16-RC-B',
      deviceId: 'D3T16-RC-D',
      asyncOrderId: 'order-rc',
      billId: 'bill-rc',
    });
    expect(begun.ok).toBe(true);
    const acquired = await acquireOwnedSaleSubmissionResumeFence(owner, {
      branchId: 'D3T16-RC-B',
      deviceId: 'D3T16-RC-D',
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const sealed = await commitOwnedSaleSubmissionAbsenceSeal(owner, acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const counts = { outcome: 0, proof: 0 };
    const request = {
      get outcome() {
        counts.outcome += 1;
        return 'evidence_proven_absent' as const;
      },
      get proof() {
        counts.proof += 1;
        return sealed.proof;
      },
    };
    vi.clearAllMocks();
    const result = await releaseOwnedSaleSubmissionResumeFence(owner, acquired.authorization, request);
    expect(result.ok).toBe(true);
    expect(counts).toEqual({ outcome: 1, proof: 1 });
    expect(releaseSaleSubmissionResumeFence).toHaveBeenCalledTimes(1);
    const rawArgs = vi.mocked(releaseSaleSubmissionResumeFence).mock.calls[0];
    expect(rawArgs?.[0]).toBe(acquired.authorization);
    expect(rawArgs?.[1]).not.toBe(request);
    expect(rawArgs?.[1]?.proof).toBe(sealed.proof);
    expect(rawArgs?.[1]?.outcome).toBe('evidence_proven_absent');
    const after = await readActiveCartSnapshot('D3T16-RC-B', 'D3T16-RC-D');
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
    expect(releaseTrustedOrchestrationOwner(owner)).toEqual({ ok: true });
  });
});
