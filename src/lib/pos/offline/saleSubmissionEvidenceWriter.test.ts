/**
 * AI-2 ENTRY_STORE writer / presence prover / facade static-read-once contract.
 * Families A, B, C, E, F, G, H, I, J, T. U-A07 and U-A08 remain two distinct arms.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as ts from 'typescript';
import facadeSourceRaw from './trustedOrchestrationOwner.ts?raw';
import orchestratorSourceRaw from './trustedSaleSubmissionOrchestrator.ts?raw';
import evidenceSourceRaw from './saleSubmissionEvidenceStore.ts?raw';
import cartSourceRaw from './activeCartSnapshotStore.ts?raw';
import type { AcquiredResumeFenceAuthorization } from './saleSubmissionEvidenceTypes';
import {
  acquireSaleSubmissionResumeFence,
  initializeActiveCartSaleSubmission,
  isAuthenticAcquiredResumeFenceAuthorization,
  readActiveCartDurableDump,
  readActiveCartSnapshot,
  releaseSaleSubmissionResumeFence,
} from './activeCartSnapshotStore';
import {
  commitSaleSubmissionAbsenceSeal,
  commitSaleSubmissionEvidenceEntry,
  isAuthenticProvenEvidencePresence,
  proveSaleSubmissionEvidencePresence,
} from './saleSubmissionEvidenceStore';
import {
  beginOwnedActiveCartGeneration,
  claimTrustedOrchestrationOwner,
  commitOwnedSaleSubmissionEvidenceEntry,
  isTrustedOrchestrationOwnerFor,
  proveOwnedSaleSubmissionEvidencePresence,
  releaseTrustedOrchestrationOwner,
} from './trustedOrchestrationOwner';
import {
  beginTrustedSaleSubmission,
  completeTrustedSaleSubmission,
  runTrustedResumeSweep,
} from './trustedSaleSubmissionOrchestrator';

vi.mock('./saleSubmissionEvidenceStore', { spy: true });

const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';

const FIXTURE = {
  branchId: 'WR-B',
  deviceId: 'WR-D',
  generationId: 'WR-GEN',
  generationSeq: 1,
  storeEpochId: 'WR-EPOCH',
  asyncOrderId: 'WR-D-1',
  billId: 'B-WR-1',
} as const;

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

async function inspectEvidenceStores(): Promise<{
  pointerKeys: IDBValidKey[];
  entryKeys: IDBValidKey[];
  entries: unknown[];
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
    const entries = await reqP(entryStore.getAll());
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
    });
    return { pointerKeys, entryKeys, entries, pointers };
  } finally {
    dbi.close();
  }
}

async function putEntry(key: string, value: unknown): Promise<void> {
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
    const tx = dbi.transaction([ENTRY_STORE], 'readwrite');
    tx.objectStore(ENTRY_STORE).put(value, key);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'));
    });
  } finally {
    dbi.close();
  }
}

async function arrangeHeldAuthorization(overrides: {
  branchId?: string;
  deviceId?: string;
  generationId?: string;
  generationSeq?: number;
  storeEpochId?: string;
  asyncOrderId?: string;
  billId?: string;
} = {}): Promise<{
  authorization: AcquiredResumeFenceAuthorization;
}> {
  const fixture = { ...FIXTURE, ...overrides };
  const init = await initializeActiveCartSaleSubmission(fixture);
  expect(init.ok).toBe(true);
  const acquired = await acquireSaleSubmissionResumeFence({
    branchId: fixture.branchId,
    deviceId: fixture.deviceId,
  });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error('acquire failed');
  return { authorization: acquired.authorization };
}

function parseFacade(): ts.SourceFile {
  return ts.createSourceFile(
    'trustedOrchestrationOwner.ts',
    facadeSourceRaw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function findExportedFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
  }
  throw new Error(`missing function ${name}`);
}

function authorizationAliasNames(fn: ts.FunctionDeclaration): Set<string> {
  const aliases = new Set<string>(['authorization']);
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isIdentifier(node.initializer) &&
      aliases.has(node.initializer.text) &&
      ts.isIdentifier(node.name)
    ) {
      aliases.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return aliases;
}

function countMemberAccess(fn: ts.FunctionDeclaration, member: 'branchId' | 'deviceId'): number {
  const aliases = authorizationAliasNames(fn);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      aliases.has(node.expression.text) &&
      node.name.text === member
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return count;
}

function firstCallOffset(fn: ts.FunctionDeclaration, callee: string): number {
  let found = Number.POSITIVE_INFINITY;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      found = Math.min(found, node.getStart());
    }
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function assertStaticReadOnce(fnName: string): void {
  const sf = parseFacade();
  const fn = findExportedFunction(sf, fnName);
  expect(countMemberAccess(fn, 'branchId'), `${fnName} branchId`).toBe(1);
  expect(countMemberAccess(fn, 'deviceId'), `${fnName} deviceId`).toBe(1);
  const authPos = firstCallOffset(fn, 'isAuthenticAcquiredResumeFenceAuthorization');
  const ownerPos = firstCallOffset(fn, 'isTrustedOrchestrationOwnerFor');
  expect(authPos).toBeLessThan(ownerPos);
}

beforeEach(async () => {
  await deleteDb(CART_DB_NAME);
  await deleteDb(EVIDENCE_DB_NAME);
});

afterEach(async () => {
  vi.mocked(commitSaleSubmissionEvidenceEntry).mockRestore();
  vi.mocked(proveSaleSubmissionEvidencePresence).mockRestore();
  await deleteDb(CART_DB_NAME);
  await deleteDb(EVIDENCE_DB_NAME);
});

describe('A writer authenticity / confinement', () => {
  test('U-A01 authentic owner + authentic authorization writes exactly one ENTRY row', async () => {
    const claimed = claimTrustedOrchestrationOwner(FIXTURE.branchId, FIXTURE.deviceId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    await beginOwnedActiveCartGeneration(claimed.owner, {
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      asyncOrderId: FIXTURE.asyncOrderId,
      billId: FIXTURE.billId,
    });
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const written = await commitOwnedSaleSubmissionEvidenceEntry(claimed.owner, acquired.authorization);
    expect(written.ok).toBe(true);
    const evidence = await inspectEvidenceStores();
    expect(evidence.entryKeys).toEqual([FIXTURE.asyncOrderId]);
    expect(evidence.entries).toHaveLength(1);
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });

  test('U-A02 inauthentic authorization → {ok:false}, zero durable mutation', async () => {
    const claimed = claimTrustedOrchestrationOwner(FIXTURE.branchId, FIXTURE.deviceId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    const before = stableSerialize(await inspectEvidenceStores());
    const forged = {
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      generationId: 'g',
      generationSeq: 1,
      storeEpochId: 'e',
      asyncOrderId: 'o',
      billId: 'b',
      fenceSeq: 1,
      fenceNonce: 'n',
    } as unknown as AcquiredResumeFenceAuthorization;
    const result = await commitOwnedSaleSubmissionEvidenceEntry(claimed.owner, forged);
    expect(result).toEqual({ ok: false });
    expect(stableSerialize(await inspectEvidenceStores())).toBe(before);
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });

  test('U-A03 cloned / JSON-reconstructed authorization → {ok:false}, zero durable mutation', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const claimed = claimTrustedOrchestrationOwner(FIXTURE.branchId, FIXTURE.deviceId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    const clone = JSON.parse(JSON.stringify(authorization)) as AcquiredResumeFenceAuthorization;
    const before = stableSerialize(await inspectEvidenceStores());
    const result = await commitOwnedSaleSubmissionEvidenceEntry(claimed.owner, clone);
    expect(result).toEqual({ ok: false });
    expect(stableSerialize(await inspectEvidenceStores())).toBe(before);
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });

  test('U-A04 foreign owner → {ok:false}, zero durable mutation', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const foreign = claimTrustedOrchestrationOwner('FOREIGN-B', 'FOREIGN-D');
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw new Error('claim failed');
    const before = stableSerialize(await inspectEvidenceStores());
    const result = await commitOwnedSaleSubmissionEvidenceEntry(foreign.owner, authorization);
    expect(result).toEqual({ ok: false });
    expect(stableSerialize(await inspectEvidenceStores())).toBe(before);
    expect(releaseTrustedOrchestrationOwner(foreign.owner)).toEqual({ ok: true });
  });

  test('U-A05 released owner → {ok:false}, zero durable mutation', async () => {
    const claimed = claimTrustedOrchestrationOwner(FIXTURE.branchId, FIXTURE.deviceId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    const { authorization } = await arrangeHeldAuthorization();
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
    const before = stableSerialize(await inspectEvidenceStores());
    const result = await commitOwnedSaleSubmissionEvidenceEntry(claimed.owner, authorization);
    expect(result).toEqual({ ok: false });
    expect(stableSerialize(await inspectEvidenceStores())).toBe(before);
  });

  test('U-A06 stableSerialize dump on A-negative plus writer-name confinement', async () => {
    expect(orchestratorSourceRaw).not.toMatch(/\bcommitSaleSubmissionEvidenceEntry\b/);
    expect(orchestratorSourceRaw).not.toMatch(/\bproveSaleSubmissionEvidencePresence\b/);
  });

  test('U-A07 commitOwnedSaleSubmissionEvidenceEntry STATIC_EXACT_ONE_MEMBER_ACCESS_PLUS_ORDERING', async () => {
    assertStaticReadOnce('commitOwnedSaleSubmissionEvidenceEntry');
    const claimed = claimTrustedOrchestrationOwner(FIXTURE.branchId, FIXTURE.deviceId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    const { authorization } = await arrangeHeldAuthorization();
    vi.mocked(commitSaleSubmissionEvidenceEntry).mockClear();
    const result = await commitOwnedSaleSubmissionEvidenceEntry(claimed.owner, authorization);
    expect(result.ok).toBe(true);
    expect(commitSaleSubmissionEvidenceEntry).toHaveBeenCalledTimes(1);
    expect(vi.mocked(commitSaleSubmissionEvidenceEntry).mock.calls[0]?.[0]).toBe(authorization);
    vi.mocked(commitSaleSubmissionEvidenceEntry).mockClear();
    const foreign = claimTrustedOrchestrationOwner('FOREIGN-B', 'FOREIGN-D');
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) throw new Error('foreign claim failed');
    const refused = await commitOwnedSaleSubmissionEvidenceEntry(foreign.owner, authorization);
    expect(refused).toEqual({ ok: false });
    expect(commitSaleSubmissionEvidenceEntry).not.toHaveBeenCalled();
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
    expect(releaseTrustedOrchestrationOwner(foreign.owner)).toEqual({ ok: true });
  });

  test('U-A08 proveOwnedSaleSubmissionEvidencePresence STATIC_EXACT_ONE_MEMBER_ACCESS_PLUS_ORDERING', async () => {
    assertStaticReadOnce('proveOwnedSaleSubmissionEvidencePresence');
    const claimed = claimTrustedOrchestrationOwner(FIXTURE.branchId, FIXTURE.deviceId);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    const { authorization } = await arrangeHeldAuthorization();
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    vi.mocked(proveSaleSubmissionEvidencePresence).mockClear();
    const proven = await proveOwnedSaleSubmissionEvidencePresence(claimed.owner, authorization);
    expect(proven.ok).toBe(true);
    expect(proveSaleSubmissionEvidencePresence).toHaveBeenCalledTimes(1);
    expect(vi.mocked(proveSaleSubmissionEvidencePresence).mock.calls[0]?.[0]).toBe(authorization);
    vi.mocked(proveSaleSubmissionEvidencePresence).mockClear();
    const invalid = await proveOwnedSaleSubmissionEvidencePresence(
      claimed.owner,
      { branchId: FIXTURE.branchId } as unknown as AcquiredResumeFenceAuthorization,
    );
    expect(invalid).toEqual({ ok: false });
    expect(proveSaleSubmissionEvidencePresence).not.toHaveBeenCalled();
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });
});

describe('B entry key / tuple binding', () => {
  test('U-B01 row keyed by asyncOrderId with twelve isomorphic fields', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    const evidence = await inspectEvidenceStores();
    expect(evidence.entryKeys).toEqual([authorization.asyncOrderId]);
    const row = evidence.entries[0] as Record<string, unknown>;
    expect(row.kind).toBe('submission_evidence');
    expect(row.schemaVersion).toBe(1);
    expect(row.entryKey).toBe(authorization.asyncOrderId);
    expect(row.branchId).toBe(authorization.branchId);
    expect(row.deviceId).toBe(authorization.deviceId);
    expect(row.generationId).toBe(authorization.generationId);
    expect(row.generationSeq).toBe(authorization.generationSeq);
    expect(row.storeEpochId).toBe(authorization.storeEpochId);
    expect(row.asyncOrderId).toBe(authorization.asyncOrderId);
    expect(row.billId).toBe(authorization.billId);
    expect(row.barrierFenceSeq).toBe(authorization.fenceSeq);
    expect(row.barrierFenceNonce).toBe(authorization.fenceNonce);
    expect(typeof row.createdAtLocal).toBe('number');
    expect(Number.isFinite(row.createdAtLocal as number)).toBe(true);
  });

  test('U-B04 no caller-supplied application field reaches the row', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    Object.defineProperty(authorization, 'customerName', { value: 'secret', enumerable: true });
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    const row = (await inspectEvidenceStores()).entries[0] as Record<string, unknown>;
    expect(row.customerName).toBeUndefined();
    expect(Object.keys(row).sort()).toEqual([
      'asyncOrderId',
      'barrierFenceNonce',
      'barrierFenceSeq',
      'billId',
      'branchId',
      'createdAtLocal',
      'deviceId',
      'entryKey',
      'generationId',
      'generationSeq',
      'kind',
      'schemaVersion',
      'storeEpochId',
    ]);
  });
});

describe('C writer idempotency', () => {
  test('U-C01 second identical call is zero-write remint', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const first = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first write failed');
    const afterFirst = stableSerialize(await inspectEvidenceStores());
    const second = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second write failed');
    expect(isAuthenticProvenEvidencePresence(second.proof)).toBe(true);
    expect(second.proof).not.toBe(first.proof);
    expect(stableSerialize(await inspectEvidenceStores())).toBe(afterFirst);
    expect((await inspectEvidenceStores()).entries).toHaveLength(1);
  });

  test('U-C03 non-matching existing row is refused and never overwritten', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    await putEntry(authorization.asyncOrderId, {
      kind: 'submission_evidence',
      schemaVersion: 1,
      entryKey: authorization.asyncOrderId,
      branchId: authorization.branchId,
      deviceId: authorization.deviceId,
      generationId: 'OTHER-GEN',
      generationSeq: authorization.generationSeq,
      storeEpochId: authorization.storeEpochId,
      asyncOrderId: authorization.asyncOrderId,
      billId: authorization.billId,
      createdAtLocal: 1,
      barrierFenceSeq: authorization.fenceSeq,
      barrierFenceNonce: authorization.fenceNonce,
    });
    const before = stableSerialize(await inspectEvidenceStores());
    const result = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(result).toEqual({ ok: false });
    expect(stableSerialize(await inspectEvidenceStores())).toBe(before);
  });
});

describe('E presence-proof authenticity', () => {
  test('U-E01 minted proof is authentic; clone/JSON/mutation/absence are not', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('write failed');
    expect(isAuthenticProvenEvidencePresence(written.proof)).toBe(true);
    const clone = { ...written.proof };
    expect(isAuthenticProvenEvidencePresence(clone)).toBe(false);
    const roundTrip = JSON.parse(JSON.stringify(written.proof));
    expect(isAuthenticProvenEvidencePresence(roundTrip)).toBe(false);
    (written.proof as { billId: string }).billId = 'mutated';
    expect(isAuthenticProvenEvidencePresence(written.proof)).toBe(false);
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(false);
    expect(isAuthenticProvenEvidencePresence({ kind: 'evidence_present' })).toBe(false);
  });
});

describe('F stale / mismatch refusal', () => {
  test('U-F01..F05 presence proof cannot release a foreign/rolled/changed/TERMINAL record', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('write failed');
    const before = stableSerialize(await readActiveCartDurableDump());
    const foreignAuth = { ...authorization, branchId: 'OTHER' } as AcquiredResumeFenceAuthorization;
    expect(
      await releaseSaleSubmissionResumeFence(foreignAuth, {
        outcome: 'evidence_present',
        proof: written.proof,
      }),
    ).toEqual({ ok: false });
    expect(stableSerialize(await readActiveCartDurableDump())).toBe(before);
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_present',
      proof: written.proof,
    });
    expect(released.ok).toBe(true);
    const terminalDump = stableSerialize(await readActiveCartDurableDump());
    expect(
      await releaseSaleSubmissionResumeFence(authorization, {
        outcome: 'evidence_present',
        proof: written.proof,
      }),
    ).toEqual({ ok: false });
    expect(stableSerialize(await readActiveCartDurableDump())).toBe(terminalDump);
  });

  test('U-G04/G05 cross-outcome forgery is refused', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('write failed');
    const before = stableSerialize(await readActiveCartDurableDump());
    expect(
      await releaseSaleSubmissionResumeFence(authorization, {
        outcome: 'evidence_proven_absent',
        proof: written.proof as never,
      }),
    ).toEqual({ ok: false });
    expect(stableSerialize(await readActiveCartDurableDump())).toBe(before);
  });
});

describe('G second release exact transition', () => {
  test('U-G01 evidence_present → resumeAttempts 1, held false, fence preserved, zero evidence mutation', async () => {
    const { authorization } = await arrangeHeldAuthorization();
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('write failed');
    const held = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    const fenceSeq = held?.resumeFence.fenceSeq;
    const nonce = held?.resumeFence.fenceNonce;
    const evidenceBefore = stableSerialize(await inspectEvidenceStores());
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_present',
      proof: written.proof,
    });
    expect(released.ok).toBe(true);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeAttempts).toBe(1);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeFence.fenceSeq).toBe(fenceSeq);
    expect(after?.resumeFence.fenceNonce).toBe(nonce);
    expect(stableSerialize(await inspectEvidenceStores())).toBe(evidenceBefore);
  });
});

describe('I crash-state matrix', () => {
  test('U-I03 OPEN_HELD no entry: sweep absence is SOUND for never-submitted', async () => {
    vi.mocked(commitSaleSubmissionEvidenceEntry).mockResolvedValueOnce({ ok: false });
    const begun = await beginTrustedSaleSubmission({
      branchId: 'I03-B',
      deviceId: 'I03-D',
      asyncOrderId: 'I03-D-1',
      billId: 'B-I03',
    });
    expect(begun).toEqual({ ok: false, reason: 'evidence_write_refused' });
    const held = await readActiveCartSnapshot('I03-B', 'I03-D');
    expect(held?.resumeFence.held).toBe(true);
    expect((await inspectEvidenceStores()).entryKeys).toHaveLength(0);
    const firstSweep = await runTrustedResumeSweep({ branchId: 'I03-B', deviceId: 'I03-D' });
    expect(firstSweep).toEqual({ ok: true, outcome: 'released' });
    const after = await readActiveCartSnapshot('I03-B', 'I03-D');
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
    expect((await inspectEvidenceStores()).entryKeys).toHaveLength(0);
  });

  test('U-I04/I05 OPEN_HELD + ENTRY: sweep presence-releases without claiming the server', async () => {
    const begun = await beginTrustedSaleSubmission({
      branchId: 'I05-B',
      deviceId: 'I05-D',
      asyncOrderId: 'I05-D-1',
      billId: 'B-I05',
    });
    expect(begun.ok).toBe(true);
    const held = await readActiveCartSnapshot('I05-B', 'I05-D');
    expect(held?.resumeFence.held).toBe(true);
    expect(held?.resumeAttempts).toBe(0);
    expect((await inspectEvidenceStores()).entryKeys).toEqual(['I05-D-1']);
    const sweep = await runTrustedResumeSweep({ branchId: 'I05-B', deviceId: 'I05-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    const after = await readActiveCartSnapshot('I05-B', 'I05-D');
    expect(after?.resumeAttempts).toBe(1);
    expect(after?.resumeFence.held).toBe(false);
    expect((await inspectEvidenceStores()).pointerKeys).toHaveLength(0);
  });

  test('U-I06 after S5 TERMINAL + ENTRY: acquire not_eligible', async () => {
    const begun = await beginTrustedSaleSubmission({
      branchId: 'I06-B',
      deviceId: 'I06-D',
      asyncOrderId: 'I06-D-1',
      billId: 'B-I06',
    });
    expect(begun.ok).toBe(true);
    const completed = await completeTrustedSaleSubmission({
      branchId: 'I06-B',
      deviceId: 'I06-D',
      asyncOrderId: 'I06-D-1',
    });
    expect(completed).toEqual({ ok: true, outcome: 'released' });
    const sweep = await runTrustedResumeSweep({ branchId: 'I06-B', deviceId: 'I06-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'not_eligible' });
    const record = await readActiveCartSnapshot('I06-B', 'I06-D');
    expect(record?.resumeAttempts).toBe(1);
  });

  test('U-I16 corrupt ENTRY: both proofs refuse; key stranded', async () => {
    const { authorization } = await arrangeHeldAuthorization({
      branchId: 'I16-B',
      deviceId: 'I16-D',
      asyncOrderId: 'I16-D-1',
      billId: 'B-I16',
    });
    await putEntry('I16-D-1', { kind: 'not-an-entry' });
    const written = await commitSaleSubmissionEvidenceEntry(authorization);
    expect(written).toEqual({ ok: false });
    const proven = await proveSaleSubmissionEvidencePresence(authorization);
    expect(proven).toEqual({ ok: false });
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed).toEqual({ ok: false });
    const record = await readActiveCartSnapshot('I16-B', 'I16-D');
    expect(record?.resumeFence.held).toBe(true);
    expect(record?.resumeAttempts).toBe(0);
  });

  test('U-I17 S4 fail-open: checkout proceeds; later absence is UNSOUND on AI2-D1-B carve-out', async () => {
    vi.mocked(commitSaleSubmissionEvidenceEntry).mockResolvedValue({ ok: false });
    const begun = await beginTrustedSaleSubmission({
      branchId: 'I17-B',
      deviceId: 'I17-D',
      asyncOrderId: 'I17-D-1',
      billId: 'B-I17',
    });
    expect(begun).toEqual({ ok: false, reason: 'evidence_write_refused' });
    const held = await readActiveCartSnapshot('I17-B', 'I17-D');
    expect(held?.resumeFence.held).toBe(true);
    expect(held?.resumeAttempts).toBe(0);
    expect((await inspectEvidenceStores()).entryKeys).toHaveLength(0);
    const sweep = await runTrustedResumeSweep({ branchId: 'I17-B', deviceId: 'I17-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    const after = await readActiveCartSnapshot('I17-B', 'I17-D');
    expect(after?.resumeAttempts).toBe(1);
    expect((await inspectEvidenceStores()).pointerKeys).toHaveLength(1);
    expect((await inspectEvidenceStores()).entryKeys).toHaveLength(0);
  });
});

describe('J AI-1 legacy compatibility', () => {
  test('U-J01 AI-1-shaped OPEN_IDLE is adopted with no migration', async () => {
    const init = await initializeActiveCartSaleSubmission({
      branchId: 'J01-B',
      deviceId: 'J01-D',
      generationId: 'J01-GEN',
      generationSeq: 1,
      storeEpochId: 'J01-EPOCH',
      asyncOrderId: 'J01-D-1',
      billId: 'B-J01',
    });
    expect(init.ok).toBe(true);
    const sweep = await runTrustedResumeSweep({ branchId: 'J01-B', deviceId: 'J01-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    const record = await readActiveCartSnapshot('J01-B', 'J01-D');
    expect(record?.schemaVersion).toBe(1);
    expect(record?.marker).toBe('S2');
    expect(record?.resumeAttempts).toBe(1);
  });
});

describe('K/L/M/N orchestrator lifecycle', () => {
  test('U-K02/K03 boot sweep presence-releases and never creates an entry', async () => {
    const begun = await beginTrustedSaleSubmission({
      branchId: 'K02-B',
      deviceId: 'K02-D',
      asyncOrderId: 'K02-D-1',
      billId: 'B-K02',
    });
    expect(begun.ok).toBe(true);
    const before = (await inspectEvidenceStores()).entryKeys.slice();
    const sweep = await runTrustedResumeSweep({ branchId: 'K02-B', deviceId: 'K02-D' });
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    expect((await inspectEvidenceStores()).entryKeys).toEqual(before);
  });

  test('U-M02 pendingCycle dropped on re-key so stale complete cannot satisfy the new key', async () => {
    const first = await beginTrustedSaleSubmission({
      branchId: 'M02-A',
      deviceId: 'M02-D',
      asyncOrderId: 'M02-D-1',
      billId: 'B-M02-A',
    });
    expect(first.ok).toBe(true);
    const second = await beginTrustedSaleSubmission({
      branchId: 'M02-B',
      deviceId: 'M02-D',
      asyncOrderId: 'M02-B-1',
      billId: 'B-M02-B',
    });
    expect(second.ok).toBe(true);
    const stale = await completeTrustedSaleSubmission({
      branchId: 'M02-A',
      deviceId: 'M02-D',
      asyncOrderId: 'M02-D-1',
    });
    expect(stale).toEqual({ ok: false, reason: 'no_pending_cycle' });
  });

  test('U-N01 gate: interleaved sweep cannot seal absence between S3 and S4', async () => {
    let releaseWrite: (() => void) | undefined;
    const hang = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.mocked(commitSaleSubmissionEvidenceEntry).mockImplementationOnce(async (authorization) => {
      await hang;
      vi.mocked(commitSaleSubmissionEvidenceEntry).mockRestore();
      return commitSaleSubmissionEvidenceEntry(authorization);
    });
    const beginPromise = beginTrustedSaleSubmission({
      branchId: 'N01-B',
      deviceId: 'N01-D',
      asyncOrderId: 'N01-D-1',
      billId: 'B-N01',
    });
    await Promise.resolve();
    await Promise.resolve();
    let sweepSettled = false;
    const sweepPromise = runTrustedResumeSweep({ branchId: 'N01-B', deviceId: 'N01-D' }).then((r) => {
      sweepSettled = true;
      return r;
    });
    await Promise.resolve();
    expect(sweepSettled).toBe(false);
    releaseWrite?.();
    const begun = await beginPromise;
    expect(begun.ok).toBe(true);
    const sweep = await sweepPromise;
    expect(sweep).toEqual({ ok: true, outcome: 'released' });
    expect((await inspectEvidenceStores()).pointerKeys).toHaveLength(0);
    expect((await inspectEvidenceStores()).entryKeys).toEqual(['N01-D-1']);
  });

  test('U-N03/N04 deletion control: begin, complete, and sweep all await the per-key gate', () => {
    expect(orchestratorSourceRaw).toContain('withCartKeyGate');
    const beginIdx = orchestratorSourceRaw.indexOf('export async function beginTrustedSaleSubmission');
    const completeIdx = orchestratorSourceRaw.indexOf('export async function completeTrustedSaleSubmission');
    const sweepIdx = orchestratorSourceRaw.indexOf('export async function runTrustedResumeSweep');
    const gateBegin = orchestratorSourceRaw.indexOf('withCartKeyGate(key', orchestratorSourceRaw.indexOf('async function runBegin'));
    const gateComplete = orchestratorSourceRaw.indexOf('withCartKeyGate(key', orchestratorSourceRaw.indexOf('async function runComplete'));
    const gateSweep = orchestratorSourceRaw.indexOf('withCartKeyGate(key', sweepIdx);
    expect(gateBegin).toBeGreaterThan(-1);
    expect(gateComplete).toBeGreaterThan(-1);
    expect(gateSweep).toBeGreaterThan(-1);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(completeIdx).toBeGreaterThan(-1);
  });
});

describe('Q/R/T confinement and prune prohibition', () => {
  test('U-Q01 zero firebase/firestore tokens in island + orchestrator', () => {
    for (const text of [evidenceSourceRaw, cartSourceRaw, facadeSourceRaw, orchestratorSourceRaw]) {
      expect(text).not.toMatch(/\bfirebase\b/);
      expect(text).not.toMatch(/\bfirestore\b/i);
      expect(text).not.toContain('setDoc');
      expect(text).not.toContain('onSnapshot');
      expect(text).not.toContain('httpsCallable');
    }
  });

  test('U-T01/T02 no production delete/clear; EvidenceTxn stays get/add', () => {
    expect(evidenceSourceRaw).not.toMatch(/txn\.delete\(/);
    expect(evidenceSourceRaw).not.toMatch(/txn\.clear\(/);
    expect(evidenceSourceRaw).toContain('get<T>(store: EvidenceStoreName, key: string): Promise<T | undefined>');
    expect(evidenceSourceRaw).toContain('add(store: EvidenceStoreName, key: string, value: unknown): Promise<void>');
    expect(evidenceSourceRaw).not.toContain('delete(store:');
    expect(cartSourceRaw).not.toContain('delete(store:');
  });
});

describe('facade owner helper non-vacuity', () => {
  test('isTrustedOrchestrationOwnerFor is load-bearing for U-A07', () => {
    const claimed = claimTrustedOrchestrationOwner('NV-B', 'NV-D');
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error('claim failed');
    expect(isTrustedOrchestrationOwnerFor(claimed.owner, 'NV-B', 'NV-D')).toBe(true);
    expect(isTrustedOrchestrationOwnerFor(claimed.owner, 'OTHER', 'NV-D')).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization({})).toBe(false);
    expect(releaseTrustedOrchestrationOwner(claimed.owner)).toEqual({ ok: true });
  });
});
