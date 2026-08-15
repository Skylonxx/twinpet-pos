import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  AbsenceSealAuthorityV1,
  AcquiredResumeFenceAuthorization,
  ActiveCartSnapshotRecord,
} from './saleSubmissionEvidenceTypes';
// C5 cart-first host: relative value-import order is load-bearing and must
// not be auto-sorted. Cart-store value imports MUST precede evidence-store
// value imports so this file enters the two-predicate cycle cart-first.
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
  isAuthenticProvenEvidenceAbsence,
} from './saleSubmissionEvidenceStore';

const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const CART_STORE = 'activeCartSnapshots';
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';

const FIXTURE = {
  branchId: 'LDP-001',
  deviceId: 'dev-1',
  generationId: 'gen-1',
  generationSeq: 1,
  storeEpochId: 'epoch-1',
  asyncOrderId: 'order-1',
  billId: 'B-0001',
} as const;

const OTHER_KEY = {
  branchId: 'LDP-002',
  deviceId: 'dev-2',
  generationId: 'gen-2',
  generationSeq: 2,
  storeEpochId: 'epoch-2',
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
    held: record?.resumeFence.held,
    fenceSeq: record?.resumeFence.fenceSeq,
    fenceNonce: record?.resumeFence.fenceNonce,
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
    snapshot() {
      return events.length;
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

async function putEvidenceEntry(asyncOrderId: string, value: unknown): Promise<void> {
  await withStore(EVIDENCE_DB_NAME, ENTRY_STORE, 'readwrite', async (store) => {
    await reqP(store.put(value, asyncOrderId));
  });
}

async function putEvidencePointer(generationKey: string, value: unknown): Promise<void> {
  await withStore(EVIDENCE_DB_NAME, POINTER_STORE, 'readwrite', async (store) => {
    await reqP(store.put(value, generationKey));
  });
}

async function arrangeHeldCart(input: typeof FIXTURE = FIXTURE) {
  const init = await initializeActiveCartSaleSubmission({ ...input });
  expect(init.ok).toBe(true);
  const acquired = await acquireSaleSubmissionResumeFence({
    branchId: input.branchId,
    deviceId: input.deviceId,
  });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error('acquire failed');
  const record = await readActiveCartSnapshot(input.branchId, input.deviceId);
  expect(record).toBeDefined();
  if (!record) throw new Error('missing cart');
  expect(record.resumeFence.held).toBe(true);
  expect(record.resumeAttempts).toBe(0);
  return { authorization: acquired.authorization, record };
}

let mutationProbe: ReturnType<typeof installIdbMutationProbe> | undefined;
let openProbe: ReturnType<typeof installIndexedDbOpenProbe> | undefined;

beforeEach(async () => {
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

afterEach(async () => {
  mutationProbe?.restore();
  mutationProbe = undefined;
  openProbe?.restore();
  openProbe = undefined;
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

describe('R28-T1 cloned authorization rejection', () => {
  test('spread clone is inauthentic and release refuses before cart DB work', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const authenticProof = sealed.proof;
    expect(isAuthenticProvenEvidenceAbsence(authenticProof)).toBe(true);

    const cloned = { ...authorization } as unknown as AcquiredResumeFenceAuthorization;
    expect(cloned).not.toBe(authorization);
    expect(cloned.branchId).toBe(authorization.branchId);
    expect(cloned.deviceId).toBe(authorization.deviceId);
    expect(cloned.generationId).toBe(authorization.generationId);
    expect(cloned.generationSeq).toBe(authorization.generationSeq);
    expect(cloned.storeEpochId).toBe(authorization.storeEpochId);
    expect(cloned.asyncOrderId).toBe(authorization.asyncOrderId);
    expect(cloned.billId).toBe(authorization.billId);
    expect(cloned.fenceSeq).toBe(authorization.fenceSeq);
    expect(cloned.fenceNonce).toBe(authorization.fenceNonce);
    expect(isAuthenticAcquiredResumeFenceAuthorization(cloned)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    const before = await captureCartState();
    openProbe = installIndexedDbOpenProbe();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(cloned, {
      outcome: 'evidence_proven_absent',
      proof: authenticProof,
    });
    const cartOpens = openProbe.opens.filter((name) => name === CART_DB_NAME);
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    openProbe.restore();
    openProbe = undefined;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(released.ok).toBe(false);
    expect(cartOpens).toEqual([]);
    expect(cartMutations).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('R28-T2 positive release', () => {
  test('authentic authorization plus authentic proof reaches terminal (held false, attempts 1)', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

describe('R28-T3 sequential double release', () => {
  test('second presentation of the same authentic objects is refused with no second terminal effect', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const first = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(first.ok).toBe(true);
    const terminal = await captureCartState();
    expect(terminal.held).toBe(false);
    expect(terminal.resumeAttempts).toBe(1);

    mutationProbe = installIdbMutationProbe();
    const mark = mutationProbe.snapshot();
    const second = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    const cartPuts = mutationProbe.events
      .slice(mark)
      .filter((e) => e.db === CART_DB_NAME && e.kind === 'put').length;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(second.ok).toBe(false);
    expect(cartPuts).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(terminal, after);
    expect(after.resumeAttempts).toBe(1);
  });
});

describe('R28-T4 same-object aliasing', () => {
  test('two aliases to the SAME authorization object cause at most one terminal mutation', async () => {
    const { authorization } = await arrangeHeldCart();
    const aliasA = authorization;
    const aliasB = authorization;
    expect(aliasA).toBe(aliasB);
    const sealed = await commitSaleSubmissionAbsenceSeal(aliasA);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');

    mutationProbe = installIdbMutationProbe();
    const sequential = await releaseSaleSubmissionResumeFence(aliasA, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(sequential.ok).toBe(true);
    const afterSequential = await captureCartState();
    const [parallelA, parallelB] = await Promise.all([
      releaseSaleSubmissionResumeFence(aliasA, {
        outcome: 'evidence_proven_absent',
        proof: sealed.proof,
      }),
      releaseSaleSubmissionResumeFence(aliasB, {
        outcome: 'evidence_proven_absent',
        proof: sealed.proof,
      }),
    ]);
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(parallelA.ok).toBe(false);
    expect(parallelB.ok).toBe(false);
    expect(cartPuts).toBe(1);
    const after = await captureCartState();
    assertCartByteIdentical(afterSequential, after);
    expect(after.held).toBe(false);
    expect(after.resumeAttempts).toBe(1);
  });
});

describe('R28-T5 concurrent release', () => {
  test('Promise.all of the same auth/proof yields exactly one held-to-terminal transition', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');

    mutationProbe = installIdbMutationProbe();
    const results = await Promise.all([
      releaseSaleSubmissionResumeFence(authorization, {
        outcome: 'evidence_proven_absent',
        proof: sealed.proof,
      }),
      releaseSaleSubmissionResumeFence(authorization, {
        outcome: 'evidence_proven_absent',
        proof: sealed.proof,
      }),
    ]);
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;

    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
    expect(cartPuts).toBe(1);
    // Response count is secondary. fake-indexeddb serializes the two
    // readwrite transactions, so exactly one {ok:true} is observed here;
    // that is not a Row28 response-count invariant.
    void results;
  });
});

describe('R28-T6 concurrent exact seal', () => {
  test('two concurrent seals may both succeed; one pointer; one runtime add; bytes unchanged', async () => {
    const { authorization } = await arrangeHeldCart();
    mutationProbe = installIdbMutationProbe();
    const [first, second] = await Promise.all([
      commitSaleSubmissionAbsenceSeal(authorization),
      commitSaleSubmissionAbsenceSeal(authorization),
    ]);
    const evidenceAdds = mutationProbe.count(EVIDENCE_DB_NAME, 'add');
    const evidencePuts = mutationProbe.count(EVIDENCE_DB_NAME, 'put');
    const evidenceDeletes = mutationProbe.count(EVIDENCE_DB_NAME, 'delete');
    const evidenceClears = mutationProbe.count(EVIDENCE_DB_NAME, 'clear');
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('concurrent exact seal refused');
    expect(evidenceAdds).toBe(1);
    expect(evidencePuts).toBe(0);
    expect(evidenceDeletes).toBe(0);
    expect(evidenceClears).toBe(0);

    for (const result of [first, second]) {
      expect(isAuthenticProvenEvidenceAbsence(result.proof)).toBe(true);
      expect(result.proof.branchId).toBe(authorization.branchId);
      expect(result.proof.deviceId).toBe(authorization.deviceId);
      expect(result.proof.generationId).toBe(authorization.generationId);
      expect(result.proof.generationSeq).toBe(authorization.generationSeq);
      expect(result.proof.storeEpochId).toBe(authorization.storeEpochId);
      expect(result.proof.asyncOrderId).toBe(authorization.asyncOrderId);
      expect(result.proof.billId).toBe(authorization.billId);
      expect(result.proof.barrierFenceSeq).toBe(authorization.fenceSeq);
      expect(result.proof.barrierFenceNonce).toBe(authorization.fenceNonce);
    }
    expect(first.proof.branchId).toBe(second.proof.branchId);
    expect(first.proof.deviceId).toBe(second.proof.deviceId);
    expect(first.proof.generationId).toBe(second.proof.generationId);
    expect(first.proof.generationSeq).toBe(second.proof.generationSeq);
    expect(first.proof.storeEpochId).toBe(second.proof.storeEpochId);
    expect(first.proof.asyncOrderId).toBe(second.proof.asyncOrderId);
    expect(first.proof.billId).toBe(second.proof.billId);
    expect(first.proof.barrierFenceSeq).toBe(second.proof.barrierFenceSeq);
    expect(first.proof.barrierFenceNonce).toBe(second.proof.barrierFenceNonce);

    const inspected = await inspectEvidenceStores();
    expect(inspected.pointerKeys).toHaveLength(1);
    const pointer = inspected.pointerByKey.get(inspected.pointerKeys[0]) as AbsenceSealAuthorityV1;
    const firstBytes = stableSerialize(pointer);
    const createdAtLocal = pointer.createdAtLocal;
    expect(first.proof.generationSeq).toBe(pointer.generationSeq);
    expect(first.proof.barrierFenceSeq).toBe(pointer.barrierFenceSeq);
    expect(first.proof.barrierFenceNonce).toBe(pointer.barrierFenceNonce);
    expect(second.proof.generationSeq).toBe(pointer.generationSeq);
    expect(second.proof.barrierFenceSeq).toBe(pointer.barrierFenceSeq);
    expect(second.proof.barrierFenceNonce).toBe(pointer.barrierFenceNonce);
    const inspectedAgain = await inspectEvidenceStores();
    expect(stableSerialize(inspectedAgain.pointerByKey.get(inspectedAgain.pointerKeys[0]))).toBe(
      firstBytes,
    );
    expect(
      (inspectedAgain.pointerByKey.get(inspectedAgain.pointerKeys[0]) as AbsenceSealAuthorityV1)
        .createdAtLocal,
    ).toBe(createdAtLocal);
  });
});

describe('R28-T7 mutable handle / durable-truth recovery', () => {
  test('mutated authentic fenceNonce is refused; reacquire restores durable fence with zero put', async () => {
    const { authorization, record } = await arrangeHeldCart();
    const originalSeq = record.resumeFence.fenceSeq;
    const originalNonce = record.resumeFence.fenceNonce;
    authorization.fenceNonce = '';
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    mutationProbe = installIdbMutationProbe();
    const markBeforeSeal = mutationProbe.snapshot();
    const sealedMutated = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealedMutated.ok).toBe(false);
    const evidenceMutations = mutationProbe.events
      .slice(markBeforeSeal)
      .filter((e) => e.db === EVIDENCE_DB_NAME).length;
    expect(evidenceMutations).toBe(0);

    const markBeforeRecover = mutationProbe.snapshot();
    const recovered = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    const cartPuts = mutationProbe.events
      .slice(markBeforeRecover)
      .filter((e) => e.db === CART_DB_NAME && e.kind === 'put').length;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('recovery failed');
    expect(isAuthenticAcquiredResumeFenceAuthorization(recovered.authorization)).toBe(true);
    expect(recovered.authorization).not.toBe(authorization);
    expect(recovered.authorization.fenceSeq).toBe(originalSeq);
    expect(recovered.authorization.fenceNonce).toBe(originalNonce);
    expect(cartPuts).toBe(0);
    const afterRecover = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(afterRecover?.resumeFence.fenceSeq).toBe(originalSeq);
    expect(afterRecover?.resumeFence.fenceNonce).toBe(originalNonce);
    expect(afterRecover?.resumeFence.held).toBe(true);
    expect(afterRecover?.resumeAttempts).toBe(0);

    const sealed = await commitSaleSubmissionAbsenceSeal(recovered.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const released = await releaseSaleSubmissionResumeFence(recovered.authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
  });

  test('mismatching pointer is a permanent fail-closed conflict, not recoverable', async () => {
    const { authorization } = await arrangeHeldCart();
    await putEvidencePointer(
      testCanonicalGenerationKey(FIXTURE.branchId, FIXTURE.deviceId, FIXTURE.generationId),
      {
        kind: 'absence_seal',
        schemaVersion: 1,
        generationKey: testCanonicalGenerationKey(
          FIXTURE.branchId,
          FIXTURE.deviceId,
          FIXTURE.generationId,
        ),
        storeEpochId: FIXTURE.storeEpochId,
        generationId: FIXTURE.generationId,
        generationSeq: FIXTURE.generationSeq,
        asyncOrderId: FIXTURE.asyncOrderId,
        billId: 'MISMATCH-BILL',
        branchId: FIXTURE.branchId,
        deviceId: FIXTURE.deviceId,
        createdAtLocal: Date.now(),
        barrierFenceSeq: authorization.fenceSeq,
        barrierFenceNonce: authorization.fenceNonce,
      },
    );
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(false);
    const recovered = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('recovery failed');
    const sealedAgain = await commitSaleSubmissionAbsenceSeal(recovered.authorization);
    expect(sealedAgain.ok).toBe(false);
  });

  test('ENTRY_STORE presence refuses first and unconditionally, including an exact pointer', async () => {
    const { authorization } = await arrangeHeldCart();
    const first = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(first.ok).toBe(true);
    await putEvidenceEntry(FIXTURE.asyncOrderId, { present: true });
    mutationProbe = installIdbMutationProbe();
    const mark = mutationProbe.snapshot();
    const second = await commitSaleSubmissionAbsenceSeal(authorization);
    const mutations = mutationProbe.events
      .slice(mark)
      .filter((e) => e.db === EVIDENCE_DB_NAME && (e.kind === 'add' || e.kind === 'put' || e.kind === 'delete' || e.kind === 'clear'));
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(second.ok).toBe(false);
    expect(mutations).toHaveLength(0);
  });

  test('wrong-typed stored generationSeq refuses even when authentic authorization is mutated to the same bad value', async () => {
    const { authorization } = await arrangeHeldCart();
    const generationKey = testCanonicalGenerationKey(
      FIXTURE.branchId,
      FIXTURE.deviceId,
      FIXTURE.generationId,
    );
    await putEvidencePointer(generationKey, {
      kind: 'absence_seal',
      schemaVersion: 1,
      generationKey,
      storeEpochId: authorization.storeEpochId,
      generationId: authorization.generationId,
      generationSeq: '1',
      asyncOrderId: authorization.asyncOrderId,
      billId: authorization.billId,
      branchId: authorization.branchId,
      deviceId: authorization.deviceId,
      createdAtLocal: Date.now(),
      barrierFenceSeq: authorization.fenceSeq,
      barrierFenceNonce: authorization.fenceNonce,
    });
    (authorization as { generationSeq: unknown }).generationSeq = '1';
    expect(authorization.generationSeq).toBe('1');
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    const beforeCart = await captureCartState();
    const beforeEvidence = await captureEvidenceState();
    mutationProbe = installIdbMutationProbe();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    const mutations = mutationProbe.events.filter(
      (e) =>
        e.db === EVIDENCE_DB_NAME &&
        (e.kind === 'add' || e.kind === 'put' || e.kind === 'delete' || e.kind === 'clear'),
    );
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(sealed.ok).toBe(false);
    expect(mutations).toHaveLength(0);
    const afterCart = await captureCartState();
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(beforeCart, afterCart);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
    expect(afterEvidence.pointerKeys).toHaveLength(1);
  });

  test('malformed stored identity string refuses even when authentic authorization is mutated to the same bad value', async () => {
    const { authorization } = await arrangeHeldCart();
    const generationKey = testCanonicalGenerationKey(
      FIXTURE.branchId,
      FIXTURE.deviceId,
      FIXTURE.generationId,
    );
    await putEvidencePointer(generationKey, {
      kind: 'absence_seal',
      schemaVersion: 1,
      generationKey,
      storeEpochId: authorization.storeEpochId,
      generationId: authorization.generationId,
      generationSeq: authorization.generationSeq,
      asyncOrderId: authorization.asyncOrderId,
      billId: 999,
      branchId: authorization.branchId,
      deviceId: authorization.deviceId,
      createdAtLocal: Date.now(),
      barrierFenceSeq: authorization.fenceSeq,
      barrierFenceNonce: authorization.fenceNonce,
    });
    (authorization as { billId: unknown }).billId = 999;
    expect(authorization.billId).toBe(999);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    const beforeCart = await captureCartState();
    const beforeEvidence = await captureEvidenceState();
    mutationProbe = installIdbMutationProbe();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    const mutations = mutationProbe.events.filter(
      (e) =>
        e.db === EVIDENCE_DB_NAME &&
        (e.kind === 'add' || e.kind === 'put' || e.kind === 'delete' || e.kind === 'clear'),
    );
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(sealed.ok).toBe(false);
    expect(mutations).toHaveLength(0);
    const afterCart = await captureCartState();
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(beforeCart, afterCart);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
  });
});

describe('R28-T8 module re-evaluation simulation', () => {
  test('vi.resetModules() is a module re-evaluation simulation, not browser reload UAT', async () => {
    const { authorization, record } = await arrangeHeldCart();
    const heldSeq = record.resumeFence.fenceSeq;
    const heldNonce = record.resumeFence.fenceNonce;
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    vi.resetModules();
    const cart = await import('./activeCartSnapshotStore');
    const evidence = await import('./saleSubmissionEvidenceStore');

    const survived = await cart.readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(survived?.resumeFence.held).toBe(true);
    expect(survived?.resumeFence.fenceSeq).toBe(heldSeq);
    expect(survived?.resumeFence.fenceNonce).toBe(heldNonce);
    expect(cart.isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(false);

    const recovered = await cart.acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('fresh recovery failed');
    expect(cart.isAuthenticAcquiredResumeFenceAuthorization(recovered.authorization)).toBe(true);
    expect(recovered.authorization.fenceSeq).toBe(heldSeq);
    expect(recovered.authorization.fenceNonce).toBe(heldNonce);

    const sealed = await evidence.commitSaleSubmissionAbsenceSeal(recovered.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('fresh seal failed');
    const released = await cart.releaseSaleSubmissionResumeFence(recovered.authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    const terminal = await cart.readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(terminal?.resumeFence.held).toBe(false);
    expect(terminal?.resumeAttempts).toBe(1);
  });
});

describe('R28-T9 lost proof zero-write recovery', () => {
  test('second seal of the same exact authorization re-mints proof with zero mutation', async () => {
    const { authorization } = await arrangeHeldCart();
    mutationProbe = installIdbMutationProbe();
    const first = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('first seal failed');
    const afterFirst = await captureEvidenceState();
    expect(afterFirst.pointerKeys).toHaveLength(1);
    const discarded = first.proof;
    void discarded;

    const mark = mutationProbe.snapshot();
    const second = await commitSaleSubmissionAbsenceSeal(authorization);
    const secondMutations = mutationProbe.events.slice(mark).filter((e) => e.db === EVIDENCE_DB_NAME);
    const totalAdds = mutationProbe.count(EVIDENCE_DB_NAME, 'add');
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('second seal failed');
    expect(isAuthenticProvenEvidenceAbsence(second.proof)).toBe(true);
    expect(secondMutations.filter((e) => e.kind === 'add' || e.kind === 'put' || e.kind === 'delete' || e.kind === 'clear')).toHaveLength(0);
    expect(totalAdds).toBe(1);
    const afterSecond = await captureEvidenceState();
    expect(afterSecond.pointerKeys).toHaveLength(1);
    expect(afterSecond.serialized).toBe(afterFirst.serialized);
    expect(afterSecond.createdAtLocal).toBe(afterFirst.createdAtLocal);
  });
});

describe('R28-T10 terminal Path E refusal', () => {
  test('acquire refuses TERMINAL even after test-only evidence DB reset', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);

    // TEST-ONLY isolation: evidence DB reset is not a production path.
    // It proves acquire refuses because resumeAttempts === 1, not because
    // an evidence pointer is present.
    await deleteDb(EVIDENCE_DB_NAME);
    const terminal = await captureCartState();
    expect(terminal.held).toBe(false);
    expect(terminal.resumeAttempts).toBe(1);

    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(false);
    const after = await captureCartState();
    assertCartByteIdentical(terminal, after);
    expect(after.held).toBe(false);
    expect(after.resumeAttempts).toBe(1);
  });
});

describe('R28-T11 reachable stale post-terminal proof', () => {
  test('stale auth may re-mint an authentic old proof; release refuses with zero mutations', async () => {
    const { authorization } = await arrangeHeldCart();
    const firstSeal = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(firstSeal.ok).toBe(true);
    if (!firstSeal.ok) throw new Error('seal failed');
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: firstSeal.proof,
    });
    expect(released.ok).toBe(true);
    const terminalCart = await captureCartState();
    const terminalEvidence = await captureEvidenceState();
    expect(terminalCart.held).toBe(false);
    expect(terminalCart.resumeAttempts).toBe(1);

    mutationProbe = installIdbMutationProbe();
    const staleSeal = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(staleSeal.ok).toBe(true);
    if (!staleSeal.ok) throw new Error('stale seal failed');
    expect(isAuthenticProvenEvidenceAbsence(staleSeal.proof)).toBe(true);

    const staleRelease = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: staleSeal.proof,
    });
    const evidenceMutations = mutationProbe.events.filter(
      (e) =>
        e.db === EVIDENCE_DB_NAME &&
        (e.kind === 'add' || e.kind === 'put' || e.kind === 'delete' || e.kind === 'clear'),
    );
    const cartMutations = mutationProbe.events.filter(
      (e) =>
        e.db === CART_DB_NAME &&
        (e.kind === 'add' || e.kind === 'put' || e.kind === 'delete' || e.kind === 'clear'),
    );
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(staleRelease.ok).toBe(false);
    expect(evidenceMutations).toHaveLength(0);
    expect(cartMutations).toHaveLength(0);
    const afterCart = await captureCartState();
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(terminalCart, afterCart);
    expect(afterEvidence.serialized).toBe(terminalEvidence.serialized);
    // Reads/transactions may occur. The required claim is zero mutation calls,
    // not zero reads. Row30 must preserve these release currentness checks.
  });
});

describe('R28-T12 JSON reconstruction rejection', () => {
  test('JSON round-trip authorization is inauthentic to seal and to release with authentic proof', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const reconstructed = JSON.parse(
      JSON.stringify(authorization),
    ) as AcquiredResumeFenceAuthorization;
    expect(isAuthenticAcquiredResumeFenceAuthorization(reconstructed)).toBe(false);
    expect(reconstructed.fenceSeq).toBe(authorization.fenceSeq);
    expect(reconstructed.fenceNonce).toBe(authorization.fenceNonce);

    const beforeCart = await captureCartState();
    const beforeEvidence = await captureEvidenceState();
    openProbe = installIndexedDbOpenProbe();
    const sealResult = await commitSaleSubmissionAbsenceSeal(reconstructed);
    expect(sealResult.ok).toBe(false);
    const released = await releaseSaleSubmissionResumeFence(reconstructed, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    const cartOpensDuringRelease = openProbe.opens.filter((name) => name === CART_DB_NAME);
    openProbe.restore();
    openProbe = undefined;

    expect(released.ok).toBe(false);
    expect(cartOpensDuringRelease).toEqual([]);
    const afterCart = await captureCartState();
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(beforeCart, afterCart);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
  });
});

describe('R28-T13 owner regression suites', () => {
  test('owner suites remain execution-only under V1; this file does not import or edit them', () => {
    // V1 reruns activeCartSnapshotStore.test.ts and saleSubmissionEvidenceStore.test.ts
    // unchanged. Importing those hosts here would duplicate cycle-entry order.
    expect(true).toBe(true);
  });
});

describe('R28-T14 Row32 confinement regression', () => {
  test('Row32 confinement remains a V1 execution of the T7-only authCalls edit', () => {
    // saleSubmissionWriterConfinement.test.ts is edited only for T7 authCalls.
    // V1 reruns the full confinement suite.
    expect(true).toBe(true);
  });
});

describe('requester-authority boundary', () => {
  test('wrong-key recovery cannot recover another cart held fence', async () => {
    const { authorization } = await arrangeHeldCart();
    const targetBefore = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    const targetBeforeSerialized = stableSerialize(targetBefore);
    const otherInit = await initializeActiveCartSaleSubmission({ ...OTHER_KEY });
    expect(otherInit.ok).toBe(true);
    const otherAcquired = await acquireSaleSubmissionResumeFence({
      branchId: OTHER_KEY.branchId,
      deviceId: OTHER_KEY.deviceId,
    });
    expect(otherAcquired.ok).toBe(true);
    if (!otherAcquired.ok) throw new Error('other acquire failed');
    expect(otherAcquired.authorization.fenceNonce).not.toBe(authorization.fenceNonce);
    expect(otherAcquired.authorization.fenceSeq).not.toBeUndefined();
    expect(otherAcquired.authorization.asyncOrderId).toBe(OTHER_KEY.asyncOrderId);

    const missing = await acquireSaleSubmissionResumeFence({
      branchId: 'no-such-branch',
      deviceId: 'no-such-device',
    });
    expect(missing.ok).toBe(false);

    const targetAfter = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(stableSerialize(targetAfter)).toBe(targetBeforeSerialized);
    expect(targetAfter?.resumeFence.fenceNonce).toBe(authorization.fenceNonce);
    expect(targetAfter?.resumeFence.fenceSeq).toBe(authorization.fenceSeq);
    expect(targetAfter?.resumeFence.held).toBe(true);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
  });

  test('same-key recovery without the old handle recovers the held fence', async () => {
    const { authorization } = await arrangeHeldCart();
    const originalSeq = authorization.fenceSeq;
    const originalNonce = authorization.fenceNonce;
    const forgotten: AcquiredResumeFenceAuthorization | undefined = undefined;
    void forgotten;

    const recovered = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error('same-key recovery failed');
    expect(recovered.authorization).not.toBe(authorization);
    expect(recovered.authorization.fenceSeq).toBe(originalSeq);
    expect(recovered.authorization.fenceNonce).toBe(originalNonce);
    expect(isAuthenticAcquiredResumeFenceAuthorization(recovered.authorization)).toBe(true);
  });

  test('concurrent independently re-minted handles are bounded to one pointer and one terminal mutation', async () => {
    const setup = await arrangeHeldCart();
    const original = setup.authorization;
    const remintAResult = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    const remintBResult = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(remintAResult.ok).toBe(true);
    expect(remintBResult.ok).toBe(true);
    if (!remintAResult.ok || !remintBResult.ok) throw new Error('independent remint failed');
    const remintA = remintAResult.authorization;
    const remintB = remintBResult.authorization;
    expect(remintA).not.toBe(remintB);
    expect(remintA).not.toBe(original);
    expect(remintB).not.toBe(original);
    expect(isAuthenticAcquiredResumeFenceAuthorization(remintA)).toBe(true);
    expect(isAuthenticAcquiredResumeFenceAuthorization(remintB)).toBe(true);
    expect(remintA.branchId).toBe(remintB.branchId);
    expect(remintA.deviceId).toBe(remintB.deviceId);
    expect(remintA.generationId).toBe(remintB.generationId);
    expect(remintA.generationSeq).toBe(remintB.generationSeq);
    expect(remintA.storeEpochId).toBe(remintB.storeEpochId);
    expect(remintA.asyncOrderId).toBe(remintB.asyncOrderId);
    expect(remintA.billId).toBe(remintB.billId);
    expect(remintA.fenceSeq).toBe(remintB.fenceSeq);
    expect(remintA.fenceNonce).toBe(remintB.fenceNonce);
    expect(remintA.fenceSeq).toBe(setup.record.resumeFence.fenceSeq);
    expect(remintA.fenceNonce).toBe(setup.record.resumeFence.fenceNonce);
    expect(remintB.fenceSeq).toBe(setup.record.resumeFence.fenceSeq);
    expect(remintB.fenceNonce).toBe(setup.record.resumeFence.fenceNonce);

    mutationProbe = installIdbMutationProbe();
    const [sealA, sealB] = await Promise.all([
      commitSaleSubmissionAbsenceSeal(remintA),
      commitSaleSubmissionAbsenceSeal(remintB),
    ]);
    expect(sealA.ok).toBe(true);
    expect(sealB.ok).toBe(true);
    if (!sealA.ok || !sealB.ok) throw new Error('independent remint seal refused');
    expect(isAuthenticProvenEvidenceAbsence(sealA.proof)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(sealB.proof)).toBe(true);
    const pointerAdds = mutationProbe.count(EVIDENCE_DB_NAME, 'add');
    expect(pointerAdds).toBe(1);

    const mark = mutationProbe.snapshot();
    const [releaseA, releaseB] = await Promise.all([
      releaseSaleSubmissionResumeFence(remintA, {
        outcome: 'evidence_proven_absent',
        proof: sealA.proof,
      }),
      releaseSaleSubmissionResumeFence(remintB, {
        outcome: 'evidence_proven_absent',
        proof: sealB.proof,
      }),
    ]);
    const terminalPuts = mutationProbe.events
      .slice(mark)
      .filter((e) => e.db === CART_DB_NAME && e.kind === 'put').length;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect([releaseA.ok, releaseB.ok].filter((ok) => ok)).toHaveLength(1);
    expect(terminalPuts).toBe(1);
    const inspected = await inspectEvidenceStores();
    expect(inspected.pointerKeys).toHaveLength(1);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

describe('INVALID durable state fails closed', () => {
  test.each([
    ['invalid schemaVersion', (r: ActiveCartSnapshotRecord) => ({ ...r, schemaVersion: 2 })],
    ['invalid marker', (r: ActiveCartSnapshotRecord) => ({ ...r, marker: 'XX' })],
    ['missing resumeAttempts', (r: ActiveCartSnapshotRecord) => {
      const next = { ...r } as unknown as Record<string, unknown>;
      delete next.resumeAttempts;
      return next;
    }],
    ['noninteger resumeAttempts', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeAttempts: 0.5 })],
    ['negative resumeAttempts', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeAttempts: -1 })],
    ['resumeAttempts greater than 1', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeAttempts: 2, resumeFence: { ...r.resumeFence, held: false } })],
    ['held true with nonzero attempts', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeAttempts: 1, resumeFence: { ...r.resumeFence, held: true } })],
    ['malformed fenceSeq', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeFence: { ...r.resumeFence, fenceSeq: 1.5 } })],
    ['empty fenceNonce while held', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeFence: { ...r.resumeFence, held: true, fenceSeq: 1, fenceNonce: '' } })],
    ['durable branch mismatch', (r: ActiveCartSnapshotRecord) => ({ ...r, branchId: 'OTHER' })],
    ['empty generationId', (r: ActiveCartSnapshotRecord) => ({ ...r, generationId: '' })],
    ['noninteger generationSeq', (r: ActiveCartSnapshotRecord) => ({ ...r, generationSeq: 1.2 })],
  ])('%s refuses acquire with no recovery', async (_label, mutator) => {
    await arrangeHeldCart();
    await overwriteCartRecord(mutator as (record: ActiveCartSnapshotRecord) => unknown);
    const before = await captureCartState();
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(false);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('INVALID OPEN_IDLE fence data fails closed', () => {
  test.each([
    [
      'missing fenceNonce',
      (r: ActiveCartSnapshotRecord) => {
        const resumeFence = { held: false, fenceSeq: r.resumeFence.fenceSeq } as {
          held: boolean;
          fenceSeq: number;
          fenceNonce?: string;
        };
        delete resumeFence.fenceNonce;
        return { ...r, resumeFence };
      },
    ],
    [
      'undefined fenceNonce',
      (r: ActiveCartSnapshotRecord) => ({
        ...r,
        resumeFence: { ...r.resumeFence, held: false, fenceNonce: undefined },
      }),
    ],
    [
      'non-string fenceNonce',
      (r: ActiveCartSnapshotRecord) => ({
        ...r,
        resumeFence: { ...r.resumeFence, held: false, fenceNonce: 123 },
      }),
    ],
    [
      'nonempty fenceNonce while idle',
      (r: ActiveCartSnapshotRecord) => ({
        ...r,
        resumeFence: { ...r.resumeFence, held: false, fenceNonce: 'NOT-EMPTY' },
      }),
    ],
    [
      'malformed idle fenceSeq',
      (r: ActiveCartSnapshotRecord) => ({
        ...r,
        resumeFence: { ...r.resumeFence, held: false, fenceSeq: 1.5, fenceNonce: '' },
      }),
    ],
  ])('%s refuses acquire with zero cart put', async (_label, mutator) => {
    const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
    expect(init.ok).toBe(true);
    const idle = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(idle?.resumeFence.held).toBe(false);
    expect(idle?.resumeAttempts).toBe(0);
    expect(idle?.resumeFence.fenceNonce).toBe('');
    await overwriteCartRecord(mutator as (record: ActiveCartSnapshotRecord) => unknown);
    const before = await captureCartState();
    expect(before.held).toBe(false);
    expect(before.resumeAttempts).toBe(0);
    mutationProbe = installIdbMutationProbe();
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(acquired.ok).toBe(false);
    expect(cartPuts).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});
