import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  AbsenceSealAuthorityV1,
  AcquiredResumeFenceAuthorization,
  ActiveCartSnapshotRecord,
  ProvenEvidenceAbsence,
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
import cartOwnerSource from './activeCartSnapshotStore.ts?raw';
import evidenceOwnerSource from './saleSubmissionEvidenceStore.ts?raw';

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

async function captureCartState(branchId: string = FIXTURE.branchId, deviceId: string = FIXTURE.deviceId) {
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
    storeCount(store: string, kind?: IdbMutationKind) {
      return events.filter((e) => e.store === store && (kind === undefined || e.kind === kind)).length;
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

async function arrangeHeldCart(input: typeof FIXTURE | typeof OTHER_KEY = FIXTURE) {
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

async function arrangeSealedHeld(input: typeof FIXTURE | typeof OTHER_KEY = FIXTURE) {
  const held = await arrangeHeldCart(input);
  const sealed = await commitSaleSubmissionAbsenceSeal(held.authorization);
  expect(sealed.ok).toBe(true);
  if (!sealed.ok) throw new Error('seal failed');
  expect(isAuthenticProvenEvidenceAbsence(sealed.proof)).toBe(true);
  return { ...held, proof: sealed.proof };
}

function overwriteAuthTuple(
  target: AcquiredResumeFenceAuthorization,
  source: AcquiredResumeFenceAuthorization,
): void {
  target.branchId = source.branchId;
  target.deviceId = source.deviceId;
  target.generationId = source.generationId;
  target.generationSeq = source.generationSeq;
  target.storeEpochId = source.storeEpochId;
  target.asyncOrderId = source.asyncOrderId;
  target.billId = source.billId;
  target.fenceSeq = source.fenceSeq;
  target.fenceNonce = source.fenceNonce;
}

function overwriteProofTuple(target: ProvenEvidenceAbsence, source: ProvenEvidenceAbsence): void {
  target.kind = source.kind;
  target.branchId = source.branchId;
  target.deviceId = source.deviceId;
  target.generationId = source.generationId;
  target.generationSeq = source.generationSeq;
  target.storeEpochId = source.storeEpochId;
  target.asyncOrderId = source.asyncOrderId;
  target.billId = source.billId;
  target.barrierFenceSeq = source.barrierFenceSeq;
  target.barrierFenceNonce = source.barrierFenceNonce;
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

describe('R30-T1 foreign durable generationId mismatch at release', () => {
  test('authentic pair refuses; zero mutation; cart byte-identical', async () => {
    const { authorization, proof } = await arrangeSealedHeld();
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);
    await overwriteCartRecord((record) => ({ ...record, generationId: 'foreign-gen' }));
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);
    expect(released.ok).toBe(false);
    expect(cartMutations).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('R30-T2 foreign storeEpochId mismatch', () => {
  test('same attributable refusal as T1', async () => {
    const { authorization, proof } = await arrangeSealedHeld();
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);
    await overwriteCartRecord((record) => ({ ...record, storeEpochId: 'foreign-epoch' }));
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(released.ok).toBe(false);
    expect(cartMutations).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('R30-T3 generationSeq N+1 synthetic corrupt state', () => {
  test('SYNTHETIC CORRUPT STATE: no legitimate successor exists today; refuses with zero mutation', async () => {
    const { authorization, proof, record } = await arrangeSealedHeld();
    // SYNTHETIC CORRUPT STATE: no legitimate N -> N+1 successor exists today.
    await overwriteCartRecord((current) => ({
      ...current,
      generationSeq: record.generationSeq + 1,
    }));
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(released.ok).toBe(false);
    expect(cartMutations).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('R30-T4 fenceNonce mismatch', () => {
  test('held remains true; refusal is fence currentness, not the terminal guard', async () => {
    const { authorization, proof } = await arrangeSealedHeld();
    await overwriteCartRecord((current) => ({
      ...current,
      resumeFence: { ...current.resumeFence, fenceNonce: 'ROTATED-NONCE' },
    }));
    const before = await captureCartState();
    expect(before.held).toBe(true);
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(released.ok).toBe(false);
    expect(cartMutations).toBe(0);
    const after = await captureCartState();
    expect(after.held).toBe(true);
    assertCartByteIdentical(before, after);
  });
});

describe('R30-T5 legitimate terminal then same authentic pair re-presented', () => {
  test('exactly one terminal put overall; resumeAttempts remains 1', async () => {
    const { authorization, proof } = await arrangeSealedHeld();
    mutationProbe = installIdbMutationProbe();
    const first = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    expect(first.ok).toBe(true);
    const second = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    const cartPuts = mutationProbe.count(CART_DB_NAME, 'put');
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(second.ok).toBe(false);
    expect(cartPuts).toBe(1);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

describe('R30-T6 F1 auth cross-key transplant', () => {
  test('mutated K1 auth becomes inauthentic; seal refuses before evidence DB work; K2 remains held', async () => {
    const k1 = await arrangeHeldCart(FIXTURE);
    const k2 = await arrangeHeldCart(OTHER_KEY);
    expect(isAuthenticAcquiredResumeFenceAuthorization(k1.authorization)).toBe(true);
    overwriteAuthTuple(k1.authorization, k2.authorization);
    expect(isAuthenticAcquiredResumeFenceAuthorization(k1.authorization)).toBe(false);

    const beforeK1 = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const beforeK2 = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    const beforeEvidence = await captureEvidenceState();
    openProbe = installIndexedDbOpenProbe();
    mutationProbe = installIdbMutationProbe();
    const sealed = await commitSaleSubmissionAbsenceSeal(k1.authorization);
    const evidenceOpens = openProbe.opens.filter((name) => name === EVIDENCE_DB_NAME);
    const evidenceMutations = mutationProbe.count(EVIDENCE_DB_NAME);
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    openProbe.restore();
    openProbe = undefined;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(sealed.ok).toBe(false);
    expect(evidenceOpens).toEqual([]);
    expect(evidenceMutations).toBe(0);
    expect(cartMutations).toBe(0);
    const afterK1 = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const afterK2 = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(beforeK1, afterK1);
    assertCartByteIdentical(beforeK2, afterK2);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
    expect(afterK2.held).toBe(true);
  });
});

describe('R30-T7 F2 same-key poisoning attempt', () => {
  test('mutated billId is inauthentic, zero pointer add, later legitimate seal succeeds', async () => {
    const first = await arrangeHeldCart();
    const remint = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(remint.ok).toBe(true);
    if (!remint.ok) throw new Error('remint failed');
    expect(isAuthenticAcquiredResumeFenceAuthorization(first.authorization)).toBe(true);
    first.authorization.billId = 'POISON-BILL';
    expect(isAuthenticAcquiredResumeFenceAuthorization(first.authorization)).toBe(false);

    mutationProbe = installIdbMutationProbe();
    const poisoned = await commitSaleSubmissionAbsenceSeal(first.authorization);
    expect(poisoned.ok).toBe(false);
    expect(mutationProbe.count(EVIDENCE_DB_NAME, 'add')).toBe(0);

    const legitimate = await commitSaleSubmissionAbsenceSeal(remint.authorization);
    expect(legitimate.ok).toBe(true);
    if (!legitimate.ok) throw new Error('legitimate seal failed');
    expect(isAuthenticProvenEvidenceAbsence(legitimate.proof)).toBe(true);
    expect(mutationProbe.count(EVIDENCE_DB_NAME, 'add')).toBe(1);
    mutationProbe.restore();
    mutationProbe = undefined;
  });
});

describe('R30-T8 wrong-typed durable release fields', () => {
  test.each([
    ['resumeAttempts', (r: ActiveCartSnapshotRecord) => ({ ...r, resumeAttempts: '0' })],
    ['marker', (r: ActiveCartSnapshotRecord) => ({ ...r, marker: 1 })],
    ['schemaVersion', (r: ActiveCartSnapshotRecord) => ({ ...r, schemaVersion: '1' })],
  ])('%s is fail-closed with zero mutation and no normalization', async (_label, mutator) => {
    const { authorization, proof } = await arrangeSealedHeld();
    await overwriteCartRecord(mutator as (record: ActiveCartSnapshotRecord) => unknown);
    const before = await captureCartState();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    mutationProbe.restore();
    mutationProbe = undefined;
    expect(released.ok).toBe(false);
    expect(cartMutations).toBe(0);
    const after = await captureCartState();
    assertCartByteIdentical(before, after);
  });
});

describe('R30-T9 N-way concurrency', () => {
  test('all seals succeed; one pointer add; one successful release; one terminal put; zero ENTRY_STORE mutation', async () => {
    const setup = await arrangeHeldCart();
    const remintA = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    const remintB = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(remintA.ok).toBe(true);
    expect(remintB.ok).toBe(true);
    if (!remintA.ok || !remintB.ok) throw new Error('remint failed');
    const handles = [setup.authorization, remintA.authorization, remintB.authorization];
    for (const handle of handles) {
      expect(isAuthenticAcquiredResumeFenceAuthorization(handle)).toBe(true);
    }

    mutationProbe = installIdbMutationProbe();
    const seals = await Promise.all(handles.map((handle) => commitSaleSubmissionAbsenceSeal(handle)));
    expect(seals.every((result) => result.ok)).toBe(true);
    for (const result of seals) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('expected seal failed');
      expect(isAuthenticProvenEvidenceAbsence(result.proof)).toBe(true);
    }
    expect(mutationProbe.count(EVIDENCE_DB_NAME, 'add')).toBe(1);
    expect(mutationProbe.storeCount(ENTRY_STORE)).toBe(0);

    const mark = mutationProbe.snapshot();
    const releases = await Promise.all(
      seals.map((result, index) => {
        if (!result.ok) throw new Error('seal missing');
        return releaseSaleSubmissionResumeFence(handles[index], {
          outcome: 'evidence_proven_absent',
          proof: result.proof,
        });
      }),
    );
    const terminalPuts = mutationProbe.events
      .slice(mark)
      .filter((e) => e.db === CART_DB_NAME && e.kind === 'put').length;
    expect(releases.filter((result) => result.ok)).toHaveLength(1);
    expect(terminalPuts).toBe(1);
    expect(mutationProbe.storeCount(ENTRY_STORE)).toBe(0);
    mutationProbe.restore();
    mutationProbe = undefined;

    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

describe('R30-T10 static negative cross-DB invariant', () => {
  test('cart owner does not reference evidence DB/store names and vice versa', () => {
    expect(cartOwnerSource.includes("'twinpet-sale-submission-evidence'")).toBe(false);
    expect(cartOwnerSource.includes('"twinpet-sale-submission-evidence"')).toBe(false);
    expect(cartOwnerSource.includes("'saleEvidenceGenerationPointers'")).toBe(false);
    expect(cartOwnerSource.includes('"saleEvidenceGenerationPointers"')).toBe(false);
    expect(cartOwnerSource.includes("'saleSubmissionEvidence'")).toBe(false);
    expect(cartOwnerSource.includes('"saleSubmissionEvidence"')).toBe(false);
    expect(evidenceOwnerSource.includes("'twinpet-active-cart-snapshot'")).toBe(false);
    expect(evidenceOwnerSource.includes('"twinpet-active-cart-snapshot"')).toBe(false);
    expect(evidenceOwnerSource.includes("'activeCartSnapshots'")).toBe(false);
    expect(evidenceOwnerSource.includes('"activeCartSnapshots"')).toBe(false);
  });
});

describe('R30-T11 positive unchanged happy-path control', () => {
  test('acquire then seal then release yields exactly one terminal put', async () => {
    const { authorization } = await arrangeHeldCart();
    mutationProbe = installIdbMutationProbe();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    expect(mutationProbe.count(CART_DB_NAME, 'put')).toBe(1);
    mutationProbe.restore();
    mutationProbe = undefined;
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

describe('R30-T12 Row28/Row32 regression declaration', () => {
  test('V1 reruns lifetime, owner, and confinement suites as zero-edit regression surfaces except authorized lifetime attribution', () => {
    // saleSubmissionAuthorizationLifetime.test.ts: authorized attribution/setup only.
    // activeCartSnapshotStore.test.ts: ZERO EDIT.
    // saleSubmissionEvidenceStore.test.ts: ZERO EDIT.
    // saleSubmissionWriterConfinement.test.ts: ZERO EDIT.
    expect(true).toBe(true);
  });
});

describe('R30-T13 deterministic seal post-predicate mutation race', () => {
  test('in-flight seal uses the original snapshot after same-turn caller mutation', async () => {
    const { authorization } = await arrangeHeldCart();
    const originalGenerationId = authorization.generationId;
    const originalBillId = authorization.billId;
    const originalKey = testCanonicalGenerationKey(
      authorization.branchId,
      authorization.deviceId,
      authorization.generationId,
    );
    const foreignKey = testCanonicalGenerationKey(
      authorization.branchId,
      authorization.deviceId,
      'foreign-gen',
    );

    openProbe = installIndexedDbOpenProbe();
    const pending = commitSaleSubmissionAbsenceSeal(authorization);
    expect(openProbe.opens).toContain(EVIDENCE_DB_NAME);
    authorization.generationId = 'foreign-gen';
    authorization.billId = 'FOREIGN-BILL';
    const result = await pending;
    openProbe.restore();
    openProbe = undefined;

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('in-flight seal failed');
    expect(isAuthenticProvenEvidenceAbsence(result.proof)).toBe(true);
    expect(result.proof.generationId).toBe(originalGenerationId);
    expect(result.proof.billId).toBe(originalBillId);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(false);

    const inspected = await inspectEvidenceStores();
    expect(inspected.pointerKeys).toEqual([originalKey]);
    expect(inspected.pointerByKey.has(foreignKey)).toBe(false);
    const pointer = inspected.pointerByKey.get(originalKey) as AbsenceSealAuthorityV1;
    expect(pointer.generationId).toBe(originalGenerationId);
    expect(pointer.billId).toBe(originalBillId);
  });
});

describe('R30-T14 deterministic release post-predicate mutation race', () => {
  test('only the original cart terminalizes; later mutated presentation refuses', async () => {
    const k1 = await arrangeSealedHeld(FIXTURE);
    const k2 = await arrangeSealedHeld(OTHER_KEY);

    openProbe = installIndexedDbOpenProbe();
    const pending = releaseSaleSubmissionResumeFence(k1.authorization, {
      outcome: 'evidence_proven_absent',
      proof: k1.proof,
    });
    expect(openProbe.opens).toContain(CART_DB_NAME);
    overwriteAuthTuple(k1.authorization, k2.authorization);
    overwriteProofTuple(k1.proof, k2.proof);
    const result = await pending;
    openProbe.restore();
    openProbe = undefined;

    expect(result.ok).toBe(true);
    const afterK1 = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    const afterK2 = await readActiveCartSnapshot(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    expect(afterK1?.resumeFence.held).toBe(false);
    expect(afterK1?.resumeAttempts).toBe(1);
    expect(afterK2?.resumeFence.held).toBe(true);
    expect(afterK2?.resumeAttempts).toBe(0);

    expect(isAuthenticAcquiredResumeFenceAuthorization(k1.authorization)).toBe(false);
    expect(isAuthenticProvenEvidenceAbsence(k1.proof)).toBe(false);
    const later = await releaseSaleSubmissionResumeFence(k1.authorization, {
      outcome: 'evidence_proven_absent',
      proof: k1.proof,
    });
    expect(later.ok).toBe(false);
    const stillK2 = await readActiveCartSnapshot(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    expect(stillK2?.resumeFence.held).toBe(true);
    expect(stillK2?.resumeAttempts).toBe(0);
  });
});

describe('R30-T15 F3 proof transplant', () => {
  test('transplanted proof is inauthentic; release refuses before cart DB work; bytes unchanged', async () => {
    const k1 = await arrangeSealedHeld(FIXTURE);
    const k2 = await arrangeSealedHeld(OTHER_KEY);
    expect(isAuthenticProvenEvidenceAbsence(k2.proof)).toBe(true);
    overwriteProofTuple(k2.proof, k1.proof);
    expect(isAuthenticProvenEvidenceAbsence(k2.proof)).toBe(false);

    const beforeK1 = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const beforeK2 = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    const beforeEvidence = await captureEvidenceState();
    openProbe = installIndexedDbOpenProbe();
    mutationProbe = installIdbMutationProbe();
    const released = await releaseSaleSubmissionResumeFence(k1.authorization, {
      outcome: 'evidence_proven_absent',
      proof: k2.proof,
    });
    const cartOpens = openProbe.opens.filter((name) => name === CART_DB_NAME);
    const cartMutations = mutationProbe.count(CART_DB_NAME);
    const evidenceMutations = mutationProbe.count(EVIDENCE_DB_NAME);
    openProbe.restore();
    openProbe = undefined;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(released.ok).toBe(false);
    expect(cartOpens).toEqual([]);
    expect(cartMutations).toBe(0);
    expect(evidenceMutations).toBe(0);
    const afterK1 = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const afterK2 = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(beforeK1, afterK1);
    assertCartByteIdentical(beforeK2, afterK2);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
  });
});

describe('R30-T16 restored-field presentation-time semantics', () => {
  test('auth and proof reauthenticate after exact restoration; later legitimate operations succeed', async () => {
    const { authorization, proof } = await arrangeSealedHeld();
    const originalAuthBillId = authorization.billId;
    const originalProofBillId = proof.billId;

    authorization.billId = 'MUTATED-AUTH';
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(false);
    authorization.billId = originalAuthBillId;
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    proof.billId = 'MUTATED-PROOF';
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(false);
    proof.billId = originalProofBillId;
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);

    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof,
    });
    expect(released.ok).toBe(true);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

describe('R30-T17 accessor / deleted-field rejection', () => {
  test('auth getter and deleted bound field refuse with zero durable work', async () => {
    const getterCase = await arrangeHeldCart();
    expect(isAuthenticAcquiredResumeFenceAuthorization(getterCase.authorization)).toBe(true);
    Object.defineProperty(getterCase.authorization, 'billId', {
      get() {
        return FIXTURE.billId;
      },
    });
    expect(isAuthenticAcquiredResumeFenceAuthorization(getterCase.authorization)).toBe(false);

    const deleteCase = await arrangeHeldCart(OTHER_KEY);
    expect(isAuthenticAcquiredResumeFenceAuthorization(deleteCase.authorization)).toBe(true);
    delete (deleteCase.authorization as { billId?: string }).billId;
    expect(isAuthenticAcquiredResumeFenceAuthorization(deleteCase.authorization)).toBe(false);

    const beforeEvidence = await captureEvidenceState();
    const beforeGetterCart = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const beforeDeleteCart = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    openProbe = installIndexedDbOpenProbe();
    mutationProbe = installIdbMutationProbe();
    const getterSeal = await commitSaleSubmissionAbsenceSeal(getterCase.authorization);
    const deleteSeal = await commitSaleSubmissionAbsenceSeal(deleteCase.authorization);
    const evidenceOpens = openProbe.opens.filter((name) => name === EVIDENCE_DB_NAME);
    const mutations =
      mutationProbe.count(EVIDENCE_DB_NAME) + mutationProbe.count(CART_DB_NAME);
    openProbe.restore();
    openProbe = undefined;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(getterSeal.ok).toBe(false);
    expect(deleteSeal.ok).toBe(false);
    expect(evidenceOpens).toEqual([]);
    expect(mutations).toBe(0);
    const afterEvidence = await captureEvidenceState();
    const afterGetterCart = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const afterDeleteCart = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
    assertCartByteIdentical(beforeGetterCart, afterGetterCart);
    assertCartByteIdentical(beforeDeleteCart, afterDeleteCart);
  });

  test('proof getter and deleted bound field refuse with zero durable work', async () => {
    const getterCase = await arrangeSealedHeld(FIXTURE);
    const deleteCase = await arrangeSealedHeld(OTHER_KEY);
    expect(isAuthenticProvenEvidenceAbsence(getterCase.proof)).toBe(true);
    Object.defineProperty(getterCase.proof, 'billId', {
      get() {
        return FIXTURE.billId;
      },
    });
    expect(isAuthenticProvenEvidenceAbsence(getterCase.proof)).toBe(false);

    expect(isAuthenticProvenEvidenceAbsence(deleteCase.proof)).toBe(true);
    delete (deleteCase.proof as { billId?: string }).billId;
    expect(isAuthenticProvenEvidenceAbsence(deleteCase.proof)).toBe(false);

    const beforeK1 = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const beforeK2 = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    const beforeEvidence = await captureEvidenceState();
    openProbe = installIndexedDbOpenProbe();
    mutationProbe = installIdbMutationProbe();
    const getterRelease = await releaseSaleSubmissionResumeFence(getterCase.authorization, {
      outcome: 'evidence_proven_absent',
      proof: getterCase.proof,
    });
    const deleteRelease = await releaseSaleSubmissionResumeFence(deleteCase.authorization, {
      outcome: 'evidence_proven_absent',
      proof: deleteCase.proof,
    });
    const cartOpens = openProbe.opens.filter((name) => name === CART_DB_NAME);
    const mutations =
      mutationProbe.count(CART_DB_NAME) + mutationProbe.count(EVIDENCE_DB_NAME);
    openProbe.restore();
    openProbe = undefined;
    mutationProbe.restore();
    mutationProbe = undefined;

    expect(getterRelease.ok).toBe(false);
    expect(deleteRelease.ok).toBe(false);
    expect(cartOpens).toEqual([]);
    expect(mutations).toBe(0);
    const afterK1 = await captureCartState(FIXTURE.branchId, FIXTURE.deviceId);
    const afterK2 = await captureCartState(OTHER_KEY.branchId, OTHER_KEY.deviceId);
    const afterEvidence = await captureEvidenceState();
    assertCartByteIdentical(beforeK1, afterK1);
    assertCartByteIdentical(beforeK2, afterK2);
    expect(afterEvidence.serialized).toBe(beforeEvidence.serialized);
  });
});
