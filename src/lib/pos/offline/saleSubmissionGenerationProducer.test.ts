import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  AbsenceSealAuthorityV1,
  ActiveCartSnapshotRecord,
} from './saleSubmissionEvidenceTypes';
// C5 cart-first host: relative value-import order is load-bearing and must
// not be auto-sorted. Cart-store value imports MUST precede evidence-store
// value imports so this file enters the two-predicate cycle cart-first.
import {
  acquireSaleSubmissionResumeFence,
  beginActiveCartGeneration,
  initializeActiveCartSaleSubmission,
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
import cartSourceRaw from './activeCartSnapshotStore.ts?raw';
import ownerTestRaw from './activeCartSnapshotStore.test.ts?raw';
import confinementContractRaw from './saleSubmissionWriterConfinement.test.ts?raw';

const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const CART_STORE = 'activeCartSnapshots';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';
const CROCKFORD_ID = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const OPEN_IDLE = { held: false, fenceSeq: 0, fenceNonce: '' } as const;

const FIXTURE = {
  branchId: 'LDP-001',
  deviceId: 'dev-1',
  asyncOrderId: 'order-1',
  billId: 'B-0001',
} as const;

const SUCCESSOR_IDS = {
  asyncOrderId: 'order-2',
  billId: 'B-0002',
} as const;

type IdbMutationKind = 'add' | 'put' | 'delete' | 'clear';

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

function cartKey(branchId: string, deviceId: string): string {
  return `${branchId.length}:${branchId}|${deviceId.length}:${deviceId}`;
}

function testCanonicalGenerationKey(
  branchId: string,
  deviceId: string,
  generationId: string,
): string {
  return [branchId, deviceId, generationId].map((p) => `${p.length}:${p}`).join('|');
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

async function captureCartState(branchId = FIXTURE.branchId, deviceId = FIXTURE.deviceId) {
  const dump = await readActiveCartDurableDump();
  const record = await readActiveCartSnapshot(branchId, deviceId);
  return {
    keys: dump.keys.slice(),
    dumpSerialized: stableSerialize(dump),
    recordSerialized: stableSerialize(record),
    held: record?.resumeFence?.held,
    fenceSeq: record?.resumeFence?.fenceSeq,
    fenceNonce: record?.resumeFence?.fenceNonce,
    resumeAttempts: record?.resumeAttempts,
    generationId: record?.generationId,
    generationSeq: record?.generationSeq,
    storeEpochId: record?.storeEpochId,
    asyncOrderId: record?.asyncOrderId,
    billId: record?.billId,
  };
}

function assertCartByteIdentical(
  before: Awaited<ReturnType<typeof captureCartState>>,
  after: Awaited<ReturnType<typeof captureCartState>>,
) {
  expect(after.dumpSerialized).toBe(before.dumpSerialized);
  expect(after.recordSerialized).toBe(before.recordSerialized);
  expect(after.keys).toEqual(before.keys);
  expect(after.held).toBe(before.held);
  expect(after.fenceSeq).toBe(before.fenceSeq);
  expect(after.fenceNonce).toBe(before.fenceNonce);
  expect(after.resumeAttempts).toBe(before.resumeAttempts);
  expect(after.generationId).toBe(before.generationId);
  expect(after.generationSeq).toBe(before.generationSeq);
  expect(after.storeEpochId).toBe(before.storeEpochId);
  expect(after.asyncOrderId).toBe(before.asyncOrderId);
  expect(after.billId).toBe(before.billId);
}

async function inspectEvidenceStores(): Promise<{
  pointerKeys: IDBValidKey[];
  entryKeys: IDBValidKey[];
  pointerByKey: Map<IDBValidKey, unknown>;
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
    const pointerByKey = new Map<IDBValidKey, unknown>();
    for (let i = 0; i < pointerKeys.length; i++) {
      pointerByKey.set(pointerKeys[i], pointers[i]);
    }
    return { pointerKeys, entryKeys, pointerByKey };
  } finally {
    dbi.close();
  }
}

async function captureEvidenceState() {
  const inspected = await inspectEvidenceStores();
  const pointers = inspected.pointerKeys.map((k) => inspected.pointerByKey.get(k));
  return {
    pointerKeys: inspected.pointerKeys.slice(),
    entryKeys: inspected.entryKeys.slice(),
    serialized: stableSerialize({
      pointerKeys: inspected.pointerKeys,
      entryKeys: inspected.entryKeys,
      pointers,
    }),
    createdAtLocal: (pointers[0] as AbsenceSealAuthorityV1 | undefined)?.createdAtLocal,
  };
}

function installIdbMutationProbe() {
  const proto = IDBObjectStore.prototype;
  const originalAdd = proto.add;
  const originalPut = proto.put;
  const originalDelete = proto.delete;
  const originalClear = proto.clear;
  const events: { kind: IdbMutationKind; db: string; store: string }[] = [];

  proto.add = function (this: IDBObjectStore, value?: unknown, key?: IDBValidKey) {
    events.push({ kind: 'add', db: this.transaction.db.name, store: this.name });
    return originalAdd.call(this, value, key);
  };
  proto.put = function (this: IDBObjectStore, value?: unknown, key?: IDBValidKey) {
    events.push({ kind: 'put', db: this.transaction.db.name, store: this.name });
    return originalPut.call(this, value, key);
  };
  proto.delete = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
    events.push({ kind: 'delete', db: this.transaction.db.name, store: this.name });
    return originalDelete.call(this, query);
  };
  proto.clear = function (this: IDBObjectStore) {
    events.push({ kind: 'clear', db: this.transaction.db.name, store: this.name });
    return originalClear.call(this);
  };

  return {
    events,
    count(db: string, kind?: IdbMutationKind) {
      return events.filter((e) => e.db === db && (kind === undefined || e.kind === kind)).length;
    },
    restore() {
      proto.add = originalAdd;
      proto.put = originalPut;
      proto.delete = originalDelete;
      proto.clear = originalClear;
    },
  };
}

function installIndexedDbOpenProbe() {
  const originalOpen = indexedDB.open.bind(indexedDB);
  const opens: string[] = [];
  indexedDB.open = ((name: string, version?: number) => {
    opens.push(name);
    return originalOpen(name, version);
  }) as typeof indexedDB.open;
  return {
    opens,
    restore() {
      indexedDB.open = originalOpen;
    },
  };
}

async function withStore(
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<void>,
): Promise<void> {
  const dbi = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (dbName === EVIDENCE_DB_NAME) {
        if (!db.objectStoreNames.contains(POINTER_STORE)) db.createObjectStore(POINTER_STORE);
        if (!db.objectStoreNames.contains(ENTRY_STORE)) db.createObjectStore(ENTRY_STORE);
      } else if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('open failed'));
  });
  try {
    const storeNames =
      dbName === EVIDENCE_DB_NAME ? [POINTER_STORE, ENTRY_STORE] : [storeName];
    const tx = dbi.transaction(storeNames, mode);
    await fn(tx.objectStore(storeName));
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('tx failed'));
      tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
    });
  } finally {
    dbi.close();
  }
}

async function overwriteCartRecord(
  mutator: (record: ActiveCartSnapshotRecord) => unknown,
  branchId = FIXTURE.branchId,
  deviceId = FIXTURE.deviceId,
): Promise<void> {
  const key = cartKey(branchId, deviceId);
  await withStore(CART_DB_NAME, CART_STORE, 'readwrite', async (store) => {
    const current = (await reqP(store.get(key))) as ActiveCartSnapshotRecord;
    await reqP(store.put(mutator(current), key));
  });
}

async function createFirstGeneration(
  input: {
    branchId: string;
    deviceId: string;
    asyncOrderId: string;
    billId: string;
  } = FIXTURE,
) {
  const created = await beginActiveCartGeneration(input);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error('first create failed');
  return created;
}

async function arrangeExactTerminal(
  input: {
    branchId: string;
    deviceId: string;
    asyncOrderId: string;
    billId: string;
  } = FIXTURE,
) {
  const created = await createFirstGeneration(input);
  const acquired = await acquireSaleSubmissionResumeFence({
    branchId: input.branchId,
    deviceId: input.deviceId,
  });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error('acquire failed');
  const sealed = await commitSaleSubmissionAbsenceSeal(acquired.authorization);
  expect(sealed.ok).toBe(true);
  if (!sealed.ok) throw new Error('seal failed');
  const released = await releaseSaleSubmissionResumeFence(acquired.authorization, {
    outcome: 'evidence_proven_absent',
    proof: sealed.proof,
  });
  expect(released.ok).toBe(true);
  const record = await readActiveCartSnapshot(input.branchId, input.deviceId);
  expect(record).toBeDefined();
  if (!record) throw new Error('missing terminal cart');
  expect(record.resumeAttempts).toBe(1);
  expect(record.resumeFence.held).toBe(false);
  expect(record.resumeFence.fenceSeq).toBeGreaterThan(0);
  expect(record.resumeFence.fenceNonce.length).toBeGreaterThan(0);
  return {
    created,
    authorization: acquired.authorization,
    proof: sealed.proof,
    record,
  };
}

let mutationProbe: ReturnType<typeof installIdbMutationProbe> | undefined;
let openProbe: ReturnType<typeof installIndexedDbOpenProbe> | undefined;
let restoreEntropy: (() => void) | undefined;

beforeEach(async () => {
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

afterEach(async () => {
  mutationProbe?.restore();
  mutationProbe = undefined;
  openProbe?.restore();
  openProbe = undefined;
  restoreEntropy?.();
  restoreEntropy = undefined;
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

describe('D1-T1 first generation', () => {
  test('returns committed identity matching durable OPEN_IDLE seq-1 record with one put', async () => {
    mutationProbe = installIdbMutationProbe();
    const created = await beginActiveCartGeneration({ ...FIXTURE });
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('first create refused');
    expect(created.generationSeq).toBe(1);
    expect(created.generationId).toMatch(CROCKFORD_ID);
    expect(created.storeEpochId).toMatch(CROCKFORD_ID);
    expect(cartPuts).toBe(1);

    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record).toBeDefined();
    if (!record) throw new Error('missing first record');
    expect(record.generationId).toBe(created.generationId);
    expect(record.generationSeq).toBe(1);
    expect(record.storeEpochId).toBe(created.storeEpochId);
    expect(record.schemaVersion).toBe(1);
    expect(record.marker).toBe('S2');
    expect(record.resumeAttempts).toBe(0);
    expect(record.resumeFence).toEqual(OPEN_IDLE);
    expect(record.branchId).toBe(FIXTURE.branchId);
    expect(record.deviceId).toBe(FIXTURE.deviceId);
    expect(record.asyncOrderId).toBe(FIXTURE.asyncOrderId);
    expect(record.billId).toBe(FIXTURE.billId);

    const dump = await readActiveCartDurableDump();
    expect(dump.records).toHaveLength(1);
    expect(dump.keys).toEqual([cartKey(FIXTURE.branchId, FIXTURE.deviceId)]);
  });
});

describe('D1-T2 concurrent and sequential duplicate first creation', () => {
  test('Arm A: two same-key promises started before either await yield one success, one record, one put', async () => {
    mutationProbe = installIdbMutationProbe();
    const first = beginActiveCartGeneration({ ...FIXTURE });
    const second = beginActiveCartGeneration({ ...FIXTURE });
    const [a, b] = await Promise.all([first, second]);
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(cartPuts).toBe(1);

    const winner = results.find((r) => r.ok);
    expect(winner?.ok).toBe(true);
    if (!winner || !winner.ok) throw new Error('missing winner');
    const dump = await readActiveCartDurableDump();
    expect(dump.records).toHaveLength(1);
    expect(dump.records[0]?.generationId).toBe(winner.generationId);
    expect(dump.records[0]?.generationSeq).toBe(1);
    expect(dump.records[0]?.storeEpochId).toBe(winner.storeEpochId);
  });

  test('Arm B: sequential duplicate after durable create refuses with zero write', async () => {
    const created = await createFirstGeneration();
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const duplicate = await beginActiveCartGeneration({
      ...FIXTURE,
      asyncOrderId: SUCCESSOR_IDS.asyncOrderId,
      billId: SUCCESSOR_IDS.billId,
    });
    const cartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(duplicate.ok).toBe(false);
    expect(cartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
    expect(after.generationId).toBe(created.generationId);
  });
});

describe('D1-T3 terminal successor', () => {
  test('valid TERMINAL advances +1 with fresh id, preserved epoch, OPEN_IDLE, and one put', async () => {
    const terminal = await arrangeExactTerminal();
    mutationProbe = installIdbMutationProbe();
    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('successor refused');
    expect(successor.generationSeq).toBe(terminal.record.generationSeq + 1);
    expect(successor.generationId).not.toBe(terminal.record.generationId);
    expect(successor.storeEpochId).toBe(terminal.record.storeEpochId);
    expect(cartPuts).toBe(1);

    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record).toBeDefined();
    if (!record) throw new Error('missing successor record');
    expect(record.generationId).toBe(successor.generationId);
    expect(record.generationSeq).toBe(successor.generationSeq);
    expect(record.storeEpochId).toBe(successor.storeEpochId);
    expect(record.resumeFence).toEqual(OPEN_IDLE);
    expect(record.resumeAttempts).toBe(0);
    expect(record.schemaVersion).toBe(1);
    expect(record.marker).toBe('S2');
    expect(record.asyncOrderId).toBe(SUCCESSOR_IDS.asyncOrderId);
    expect(record.billId).toBe(SUCCESSOR_IDS.billId);
    expect(record.branchId).toBe(terminal.record.branchId);
    expect(record.deviceId).toBe(terminal.record.deviceId);
  });
});

describe('D1-T4 OPEN_IDLE refusal', () => {
  test('OPEN_IDLE first-create record refuses successor with zero write', async () => {
    await createFirstGeneration();
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const refused = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const cartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(refused.ok).toBe(false);
    expect(cartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('D1-T5 OPEN_HELD refusal', () => {
  test('OPEN_HELD record refuses successor with zero write', async () => {
    await createFirstGeneration();
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    const held = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(held?.resumeFence.held).toBe(true);
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const refused = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const cartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(refused.ok).toBe(false);
    expect(cartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('D1-T6 concurrent successor', () => {
  test('two same-key successor promises started before either await yield one winner, one put, no +2', async () => {
    const terminal = await arrangeExactTerminal();
    mutationProbe = installIdbMutationProbe();
    const input = {
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    };
    const first = beginActiveCartGeneration(input);
    const second = beginActiveCartGeneration(input);
    const [a, b] = await Promise.all([first, second]);
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;

    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(cartPuts).toBe(1);

    const winner = results.find((r) => r.ok);
    expect(winner?.ok).toBe(true);
    if (!winner || !winner.ok) throw new Error('missing successor winner');
    expect(winner.generationSeq).toBe(terminal.record.generationSeq + 1);
    expect(winner.generationSeq).not.toBe(terminal.record.generationSeq + 2);

    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record?.generationSeq).toBe(terminal.record.generationSeq + 1);
    expect(record?.generationId).toBe(winner.generationId);
    expect(record?.storeEpochId).toBe(terminal.record.storeEpochId);
    const dump = await readActiveCartDurableDump();
    expect(dump.records).toHaveLength(1);
  });
});

describe('D1-T7 response loss / retry', () => {
  test('retry after committed successor is durable-effect idempotent only, not result-idempotent', async () => {
    await arrangeExactTerminal();
    const first = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('successor failed');
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const retry = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const cartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(retry.ok).toBe(false);
    expect(cartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
    expect(after.generationId).toBe(first.generationId);
    expect(after.generationSeq).toBe(first.generationSeq);
  });
});

describe('D1-T8 old auth + new proof', () => {
  test('old authentic authorization cannot release N+1 with a proof minted for N+1', async () => {
    const terminal = await arrangeExactTerminal();
    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(successor.ok).toBe(true);
    const nextHeld = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(nextHeld.ok).toBe(true);
    if (!nextHeld.ok) throw new Error('N+1 acquire failed');
    const nextSealed = await commitSaleSubmissionAbsenceSeal(nextHeld.authorization);
    expect(nextSealed.ok).toBe(true);
    if (!nextSealed.ok) throw new Error('N+1 seal failed');

    expect(isAuthenticAcquiredResumeFenceAuthorization(terminal.authorization)).toBe(true);
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(terminal.authorization, {
      outcome: 'evidence_proven_absent',
      proof: nextSealed.proof,
    });
    const cartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(released.ok).toBe(false);
    expect(cartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
    expect(after.held).toBe(true);
    expect(after.generationSeq).toBe(2);
  });
});

describe('D1-T9 new auth + old proof and old-pointer remint', () => {
  test('new auth + old proof refuses; old auth + reminted old-pointer proof cannot release successor', async () => {
    const terminal = await arrangeExactTerminal();
    const oldPointerKey = testCanonicalGenerationKey(
      FIXTURE.branchId,
      FIXTURE.deviceId,
      terminal.record.generationId,
    );
    const evidenceBeforeSuccessor = await captureEvidenceState();
    const oldPointerBytes = evidenceBeforeSuccessor.serialized;

    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(successor.ok).toBe(true);
    const nextHeld = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(nextHeld.ok).toBe(true);
    if (!nextHeld.ok) throw new Error('N+1 acquire failed');

    const beforeNewAuthOldProof = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const newAuthOldProof = await releaseSaleSubmissionResumeFence(nextHeld.authorization, {
      outcome: 'evidence_proven_absent',
      proof: terminal.proof,
    });
    const firstCartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(newAuthOldProof.ok).toBe(false);
    expect(firstCartMutations).toHaveLength(0);
    assertCartByteIdentical(beforeNewAuthOldProof, await captureCartState());

    const reminted = await commitSaleSubmissionAbsenceSeal(terminal.authorization);
    expect(reminted.ok).toBe(true);
    if (!reminted.ok) throw new Error('old-pointer remint failed');
    const evidenceAfterRemint = await captureEvidenceState();
    expect(evidenceAfterRemint.pointerKeys).toContain(oldPointerKey);
    expect(evidenceAfterRemint.serialized).toBe(oldPointerBytes);

    const beforeOldAuthRemint = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const oldAuthRemint = await releaseSaleSubmissionResumeFence(terminal.authorization, {
      outcome: 'evidence_proven_absent',
      proof: reminted.proof,
    });
    const secondCartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(oldAuthRemint.ok).toBe(false);
    expect(secondCartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(beforeOldAuthRemint, after);
    expect(after.generationSeq).toBe(2);
    expect(after.held).toBe(true);
  });
});

describe('D1-T10 pointer coexistence', () => {
  test('old and new pointer keys coexist and old pointer bytes remain intact', async () => {
    const terminal = await arrangeExactTerminal();
    const oldKey = testCanonicalGenerationKey(
      FIXTURE.branchId,
      FIXTURE.deviceId,
      terminal.record.generationId,
    );
    const evidenceAtN = await inspectEvidenceStores();
    const oldPointer = evidenceAtN.pointerByKey.get(oldKey);
    expect(oldPointer).toBeDefined();
    const oldPointerSerialized = stableSerialize(oldPointer);

    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('successor failed');
    const nextHeld = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(nextHeld.ok).toBe(true);
    if (!nextHeld.ok) throw new Error('N+1 acquire failed');
    const nextSealed = await commitSaleSubmissionAbsenceSeal(nextHeld.authorization);
    expect(nextSealed.ok).toBe(true);

    const newKey = testCanonicalGenerationKey(
      FIXTURE.branchId,
      FIXTURE.deviceId,
      successor.generationId,
    );
    const evidence = await inspectEvidenceStores();
    expect(evidence.pointerKeys).toEqual(expect.arrayContaining([oldKey, newKey]));
    expect(evidence.pointerKeys).toHaveLength(2);
    expect(stableSerialize(evidence.pointerByKey.get(oldKey))).toBe(oldPointerSerialized);
    expect(evidence.pointerByKey.get(newKey)).toBeDefined();
  });
});

describe('D1-T11 cart DB reset while evidence survives', () => {
  test('deleting only the cart DB starts a new chain at seq 1 with a new epoch; old pointer survives', async () => {
    const terminal = await arrangeExactTerminal();
    const oldKey = testCanonicalGenerationKey(
      FIXTURE.branchId,
      FIXTURE.deviceId,
      terminal.record.generationId,
    );
    const evidenceBefore = await captureEvidenceState();
    expect(evidenceBefore.pointerKeys).toEqual([oldKey]);

    await deleteDb(CART_DB_NAME);
    expect(await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId)).toBeUndefined();
    const evidenceAfterDelete = await captureEvidenceState();
    expect(evidenceAfterDelete.serialized).toBe(evidenceBefore.serialized);

    const restarted = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      asyncOrderId: 'order-reset',
      billId: 'B-reset',
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) throw new Error('reset create failed');
    expect(restarted.generationSeq).toBe(1);
    expect(restarted.generationId).not.toBe(terminal.record.generationId);
    expect(restarted.storeEpochId).not.toBe(terminal.record.storeEpochId);

    const evidenceAfterCreate = await captureEvidenceState();
    expect(evidenceAfterCreate.serialized).toBe(evidenceBefore.serialized);
    expect(evidenceAfterCreate.pointerKeys).toEqual([oldKey]);
  });
});

describe('D1-T12 epoch preserved across normal successor', () => {
  test('storeEpochId is byte-identical across TERMINAL successor', async () => {
    const terminal = await arrangeExactTerminal();
    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('successor failed');
    expect(successor.storeEpochId).toBe(terminal.record.storeEpochId);
    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record?.storeEpochId).toBe(terminal.record.storeEpochId);
  });
});

describe('D1-T13 fail-closed matrix', () => {
  const successorInput = {
    branchId: FIXTURE.branchId,
    deviceId: FIXTURE.deviceId,
    ...SUCCESSOR_IDS,
  };

  test.each([
    ['resumeFence null', (record: ActiveCartSnapshotRecord) => ({ ...record, resumeFence: null })],
    ['resumeFence non-object', (record: ActiveCartSnapshotRecord) => ({ ...record, resumeFence: 42 })],
    [
      'fenceSeq 0',
      (record: ActiveCartSnapshotRecord) => ({
        ...record,
        resumeFence: { ...record.resumeFence, fenceSeq: 0 },
      }),
    ],
    [
      'fenceSeq negative',
      (record: ActiveCartSnapshotRecord) => ({
        ...record,
        resumeFence: { ...record.resumeFence, fenceSeq: -1 },
      }),
    ],
    [
      'fenceSeq fractional',
      (record: ActiveCartSnapshotRecord) => ({
        ...record,
        resumeFence: { ...record.resumeFence, fenceSeq: 1.5 },
      }),
    ],
    [
      'fenceNonce empty',
      (record: ActiveCartSnapshotRecord) => ({
        ...record,
        resumeFence: { ...record.resumeFence, fenceNonce: '' },
      }),
    ],
    [
      'fenceNonce nonstring',
      (record: ActiveCartSnapshotRecord) => ({
        ...record,
        resumeFence: { ...record.resumeFence, fenceNonce: 1 },
      }),
    ],
    [
      'resumeAttempts missing',
      (record: ActiveCartSnapshotRecord) => {
        const next = { ...record };
        delete (next as { resumeAttempts?: number }).resumeAttempts;
        return next;
      },
    ],
    ['resumeAttempts fractional', (record: ActiveCartSnapshotRecord) => ({ ...record, resumeAttempts: 1.2 })],
    ['resumeAttempts 0', (record: ActiveCartSnapshotRecord) => ({ ...record, resumeAttempts: 0 })],
    ['resumeAttempts 2', (record: ActiveCartSnapshotRecord) => ({ ...record, resumeAttempts: 2 })],
    ['wrong schemaVersion', (record: ActiveCartSnapshotRecord) => ({ ...record, schemaVersion: 2 })],
    ['wrong marker', (record: ActiveCartSnapshotRecord) => ({ ...record, marker: 'S1' })],
    ['branch mismatch', (record: ActiveCartSnapshotRecord) => ({ ...record, branchId: 'OTHER' })],
    ['device mismatch', (record: ActiveCartSnapshotRecord) => ({ ...record, deviceId: 'other-dev' })],
    ['empty generationId', (record: ActiveCartSnapshotRecord) => ({ ...record, generationId: '' })],
    ['empty storeEpochId', (record: ActiveCartSnapshotRecord) => ({ ...record, storeEpochId: '' })],
    ['empty asyncOrderId', (record: ActiveCartSnapshotRecord) => ({ ...record, asyncOrderId: '' })],
    ['empty billId', (record: ActiveCartSnapshotRecord) => ({ ...record, billId: '' })],
    ['generationSeq 0', (record: ActiveCartSnapshotRecord) => ({ ...record, generationSeq: 0 })],
    ['generationSeq negative', (record: ActiveCartSnapshotRecord) => ({ ...record, generationSeq: -1 })],
    ['generationSeq fractional', (record: ActiveCartSnapshotRecord) => ({ ...record, generationSeq: 1.5 })],
    [
      'generationSeq unsafe',
      (record: ActiveCartSnapshotRecord) => ({ ...record, generationSeq: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      'generationSeq Number.MAX_SAFE_INTEGER',
      (record: ActiveCartSnapshotRecord) => ({ ...record, generationSeq: Number.MAX_SAFE_INTEGER }),
    ],
  ] as const)('%s refuses with zero mutation and byte-identical dump', async (_name, mutator) => {
    await arrangeExactTerminal();
    await overwriteCartRecord(mutator);
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const refused = await beginActiveCartGeneration(successorInput);
    const cartMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(refused.ok).toBe(false);
    expect(cartMutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });

  test.each([
    ['invalid first-create branchId', { ...FIXTURE, branchId: '' }],
    ['invalid first-create deviceId', { ...FIXTURE, deviceId: '' }],
    ['invalid first-create asyncOrderId', { ...FIXTURE, asyncOrderId: '' }],
    ['invalid first-create billId', { ...FIXTURE, billId: '' }],
    ['invalid first-create branchId nonstring', { ...FIXTURE, branchId: 0 as unknown as string }],
    ['invalid first-create deviceId null', { ...FIXTURE, deviceId: null as unknown as string }],
  ])('%s returns ok:false with zero DB work', async (_name, input) => {
    const before = await captureCartState();
    openProbe = installIndexedDbOpenProbe();
    mutationProbe = installIdbMutationProbe();
    const refused = await beginActiveCartGeneration(input);
    const opens = openProbe.opens.slice();
    const mutations = mutationProbe.events.slice();
    openProbe.restore();
    openProbe = undefined;
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(refused.ok).toBe(false);
    expect(opens).toEqual([]);
    expect(mutations).toHaveLength(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('D1-T14 real module reset', () => {
  test('fresh predicates reject retained pre-reset auth/proof; durable N+1 survives', async () => {
    const terminal = await arrangeExactTerminal();
    expect(isAuthenticAcquiredResumeFenceAuthorization(terminal.authorization)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(terminal.proof)).toBe(true);

    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('successor failed');

    vi.resetModules();
    const cart = await import('./activeCartSnapshotStore');
    const evidence = await import('./saleSubmissionEvidenceStore');

    expect(cart.isAuthenticAcquiredResumeFenceAuthorization(terminal.authorization)).toBe(false);
    expect(evidence.isAuthenticProvenEvidenceAbsence(terminal.proof)).toBe(false);

    const survived = await cart.readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(survived?.generationId).toBe(successor.generationId);
    expect(survived?.generationSeq).toBe(successor.generationSeq);
    expect(survived?.storeEpochId).toBe(successor.storeEpochId);
    expect(survived?.resumeFence).toEqual(OPEN_IDLE);
    expect(survived?.resumeAttempts).toBe(0);
  });
});

describe('D1-T15 Row28 zero-edit regression', () => {
  test('producer-created generation still completes the closed acquire/seal/release lifetime path', async () => {
    await createFirstGeneration();
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const sealed = await commitSaleSubmissionAbsenceSeal(acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const released = await releaseSaleSubmissionResumeFence(acquired.authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    const terminal = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(terminal?.resumeAttempts).toBe(1);
    expect(terminal?.resumeFence.held).toBe(false);
  });
});

describe('D1-T16 Row30 zero-edit regression', () => {
  test('successor identity remains the durable currentness owner for later acquire/seal/release', async () => {
    await arrangeExactTerminal();
    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('successor failed');
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('N+1 acquire failed');
    expect(acquired.authorization.generationId).toBe(successor.generationId);
    expect(acquired.authorization.generationSeq).toBe(successor.generationSeq);
    expect(acquired.authorization.storeEpochId).toBe(successor.storeEpochId);
    const sealed = await commitSaleSubmissionAbsenceSeal(acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('N+1 seal failed');
    const released = await releaseSaleSubmissionResumeFence(acquired.authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record?.generationId).toBe(successor.generationId);
    expect(record?.resumeAttempts).toBe(1);
  });
});

describe('D1-T17 Row32 corrected exact topology', () => {
  test('authorized 13-site nine/generalized topology is present with no extra eight-name drift', () => {
    const cartNames = Object.keys(cartRuntimeExports).sort();
    const evidenceNames = Object.keys(evidenceRuntimeExports).sort();
    expect(cartNames).toHaveLength(7);
    expect(cartNames).toContain('beginActiveCartGeneration');
    expect(evidenceNames).toHaveLength(2);
    expect([...cartNames, ...evidenceNames].sort()).toHaveLength(9);

    expect(confinementContractRaw).toContain("'beginActiveCartGeneration'");
    expect(confinementContractRaw).toContain('FROZEN_ALL_NINE_RUNTIME_EXPORTS');
    expect(confinementContractRaw).toContain(
      '|beginActiveCartGeneration|put|store:activeCartSnapshots|semantic',
    );
    expect(confinementContractRaw).toContain('const W8_CART_TOTAL_RETAINED_SITE_COUNT = 6;');
    expect(confinementContractRaw).toContain('const W8_CART_DISTINCT_TUPLE_COUNT = 6;');
    expect(confinementContractRaw).toContain('const ROW29_MUTATION_SITE_COUNT = 9;');
    expect(confinementContractRaw).toContain('const runtimeExportNames = new Set(FROZEN_ALL_NINE_RUNTIME_EXPORTS);');
    expect(confinementContractRaw).toContain("resolve (9/0) and transaction domains resolve (2/0)");
    expect(confinementContractRaw).toContain("T7 all-nine runtime-export reachability");
    expect(confinementContractRaw).toContain('frozen nine-name set');
    expect(confinementContractRaw).toContain('reachability of the nine');

    expect(confinementContractRaw).not.toContain('FROZEN_ALL_EIGHT_RUNTIME_EXPORTS');
    expect(confinementContractRaw).not.toContain('all-eight');
    expect(confinementContractRaw).not.toContain('eight-name set');
    expect(confinementContractRaw).not.toContain('reachability of the eight');
    expect(confinementContractRaw).not.toMatch(/\bconst eight = /);

    expect(ownerTestRaw).toContain("'beginActiveCartGeneration'");
    expect(ownerTestRaw).toContain('beginActiveCartGeneration: \'function\'');
    expect(ownerTestRaw.match(/beginActiveCartGeneration/g)?.length).toBeGreaterThanOrEqual(2);

    expect(confinementContractRaw).toContain('const PRODUCTION_INDEXEDDB_OPEN_SITE_COUNT = 8;');
    expect(confinementContractRaw).toContain('const ROW29_TRANSACTION_SITE_COUNT = 2;');
    expect(confinementContractRaw).toContain('const EXPECTED_PRODUCTION_PARSE_DIAGNOSTIC_COUNT = 0;');
  });
});

describe('D1-T18 export surface / initializer coexistence', () => {
  test('producer export is a function; deprecated initializer still exists; no sole-creation claim', () => {
    expect(typeof cartRuntimeExports.beginActiveCartGeneration).toBe('function');
    expect(typeof cartRuntimeExports.initializeActiveCartSaleSubmission).toBe('function');
    expect(typeof initializeActiveCartSaleSubmission).toBe('function');
    expect(cartSourceRaw).toContain('@deprecated test/bootstrap-only');
    expect(cartSourceRaw).toContain('CANONICAL PRODUCTION ALLOCATOR');
    expect(cartSourceRaw).toContain('is not the sole runtime creation API');
  });
});

describe('D1-T19 deterministic generation-ID collision', () => {
  test('immediate predecessor collision refuses with zero write; later distinct retry succeeds', async () => {
    const originalGetRandomValues = crypto.getRandomValues;
    const recorded: Uint8Array[] = [];
    const fillNativeRandom = (arr: Uint8Array): Uint8Array =>
      (originalGetRandomValues as (array: Uint8Array) => Uint8Array).call(crypto, arr);
    crypto.getRandomValues = ((arr: Uint8Array) => {
      fillNativeRandom(arr);
      recorded.push(Uint8Array.from(arr));
      return arr;
    }) as typeof crypto.getRandomValues;
    restoreEntropy = () => {
      crypto.getRandomValues = originalGetRandomValues;
    };

    const terminal = await arrangeExactTerminal();
    const generationBytes = recorded[0];
    expect(generationBytes).toBeDefined();
    if (!generationBytes) throw new Error('missing recorded generation entropy');
    restoreEntropy();
    restoreEntropy = undefined;

    crypto.getRandomValues = ((arr: Uint8Array) => {
      arr.set(generationBytes.subarray(0, arr.length));
      return arr;
    }) as typeof crypto.getRandomValues;
    restoreEntropy = () => {
      crypto.getRandomValues = originalGetRandomValues;
    };

    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const collided = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const collisionMutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(collided.ok).toBe(false);
    expect(collisionMutations).toHaveLength(0);
    assertCartByteIdentical(before, await captureCartState());

    restoreEntropy();
    restoreEntropy = undefined;
    crypto.getRandomValues = originalGetRandomValues;

    mutationProbe = installIdbMutationProbe();
    const retried = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const retryPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error('distinct retry failed');
    expect(retried.generationId).not.toBe(terminal.record.generationId);
    expect(retried.generationSeq).toBe(terminal.record.generationSeq + 1);
    expect(retryPuts).toBe(1);
  });
});

describe('D1-T20 immediate order/bill freshness', () => {
  test('reused async + fresh bill refuses', async () => {
    const terminal = await arrangeExactTerminal();
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const refused = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      asyncOrderId: terminal.record.asyncOrderId,
      billId: SUCCESSOR_IDS.billId,
    });
    const mutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(refused.ok).toBe(false);
    expect(mutations).toHaveLength(0);
    assertCartByteIdentical(before, await captureCartState());
  });

  test('fresh async + reused bill refuses', async () => {
    const terminal = await arrangeExactTerminal();
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const refused = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      asyncOrderId: SUCCESSOR_IDS.asyncOrderId,
      billId: terminal.record.billId,
    });
    const mutations = mutationProbe.events.filter((e) => e.db === CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(refused.ok).toBe(false);
    expect(mutations).toHaveLength(0);
    assertCartByteIdentical(before, await captureCartState());
  });

  test('both fresh succeeds', async () => {
    const terminal = await arrangeExactTerminal();
    mutationProbe = installIdbMutationProbe();
    const successor = await beginActiveCartGeneration({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      ...SUCCESSOR_IDS,
    });
    const puts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(successor.ok).toBe(true);
    if (!successor.ok) throw new Error('fresh successor failed');
    expect(puts).toBe(1);
    expect(successor.generationSeq).toBe(terminal.record.generationSeq + 1);
    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record?.asyncOrderId).toBe(SUCCESSOR_IDS.asyncOrderId);
    expect(record?.billId).toBe(SUCCESSOR_IDS.billId);
  });
});
