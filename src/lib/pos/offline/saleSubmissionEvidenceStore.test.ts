import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  AcquiredResumeFenceAuthorization,
  ProvenEvidenceAbsence,
} from './saleSubmissionEvidenceTypes';
// C5 evidence-first host: relative value-import order is load-bearing and must
// not be auto-sorted. Evidence-store value imports MUST precede cart-store
// value imports so this file enters the two-predicate cycle evidence-first.
import {
  commitSaleSubmissionAbsenceSeal,
  isAuthenticProvenEvidenceAbsence,
} from './saleSubmissionEvidenceStore';
import * as store from './saleSubmissionEvidenceStore';
import {
  acquireSaleSubmissionResumeFence,
  initializeActiveCartSaleSubmission,
  isAuthenticAcquiredResumeFenceAuthorization,
  readActiveCartSnapshot,
  releaseSaleSubmissionResumeFence,
} from './activeCartSnapshotStore';

const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const CART_DB_NAME = 'twinpet-active-cart-snapshot';

const FIXTURE = {
  branchId: 'LDP-001',
  deviceId: 'dev-1',
  generationId: 'gen-1',
  generationSeq: 1,
  storeEpochId: 'epoch-1',
  asyncOrderId: 'order-1',
  billId: 'B-0001',
} as const;

const EXPECTED_EXPORT_NAMES = Object.freeze(
  ['commitSaleSubmissionAbsenceSeal', 'isAuthenticProvenEvidenceAbsence'].slice().sort(),
);

const EXPECTED_EXPORT_TYPE: Record<string, string> = {
  commitSaleSubmissionAbsenceSeal: 'function',
  isAuthenticProvenEvidenceAbsence: 'function',
};

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    req.onblocked = () => resolve();
  });
}

function publicProofShape(overrides: Partial<{
  kind: 'evidence_proven_absent';
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  barrierFenceSeq: number;
  barrierFenceNonce: string;
}> = {}) {
  return {
    kind: 'evidence_proven_absent' as const,
    branchId: FIXTURE.branchId,
    deviceId: FIXTURE.deviceId,
    generationId: FIXTURE.generationId,
    generationSeq: FIXTURE.generationSeq,
    storeEpochId: FIXTURE.storeEpochId,
    asyncOrderId: FIXTURE.asyncOrderId,
    billId: FIXTURE.billId,
    barrierFenceSeq: 1,
    barrierFenceNonce: 'NONCE',
    ...overrides,
  };
}

function isForbiddenSeamName(name: string): boolean {
  if (/^(mint|register|brand)/i.test(name)) return true;
  if (/addAuthentic/i.test(name)) return true;
  if (/^(create|make|new)ProvenEvidenceAbsence$/i.test(name)) return true;
  if (/^(create|make|new)AcquiredResumeFenceAuthorization$/i.test(name)) return true;
  if (/authoriz\w*(mint|register)/i.test(name)) return true;
  return false;
}

const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';

function testCanonicalGenerationKey(
  branchId: string,
  deviceId: string,
  generationId: string,
): string {
  return [branchId, deviceId, generationId].map((p) => `${p.length}:${p}`).join('|');
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
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

async function mintAuthenticProof(): Promise<ProvenEvidenceAbsence> {
  const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
  expect(init.ok).toBe(true);
  const acquired = await acquireSaleSubmissionResumeFence({
    branchId: FIXTURE.branchId,
    deviceId: FIXTURE.deviceId,
  });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error('acquire failed');
  const sealed = await commitSaleSubmissionAbsenceSeal(acquired.authorization);
  expect(sealed.ok).toBe(true);
  if (!sealed.ok) throw new Error('seal failed');
  return sealed.proof;
}

beforeEach(async () => {
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

afterEach(async () => {
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

describe('S1 exported ProvenEvidenceAbsence type is externally usable', () => {
  test('type can annotate parameters, variables, and returns', () => {
    function accept(proof: ProvenEvidenceAbsence): ProvenEvidenceAbsence {
      const held: ProvenEvidenceAbsence = proof;
      return held;
    }
    void accept;
    expect(typeof accept).toBe('function');
  });
});

describe('S2 ordinary full-shape construction is rejected by opacity', () => {
  test('full public-field literal is not assignable to ProvenEvidenceAbsence', () => {
    // Opacity failure: every public field is present and well-typed; the
    // error is the missing non-exported unique-symbol brand, not a malformed field.
    // @ts-expect-error ProvenEvidenceAbsence is opaque to external construction
    const constructed: ProvenEvidenceAbsence = {
      kind: 'evidence_proven_absent',
      branchId: 'LDP-001',
      deviceId: 'dev-1',
      generationId: 'gen-1',
      generationSeq: 1,
      storeEpochId: 'epoch-1',
      asyncOrderId: 'order-1',
      billId: 'B-0001',
      barrierFenceSeq: 1,
      barrierFenceNonce: 'NONCE',
    };
    void constructed;
    expect(true).toBe(true);
  });
});

describe('S3 unsafe double cast crosses compile-time opacity', () => {
  test('unregistered full-shape object is still rejected at runtime', () => {
    const forged = publicProofShape() as unknown as ProvenEvidenceAbsence;
    expect(isAuthenticProvenEvidenceAbsence(forged)).toBe(false);
  });
});

describe('S4 export audit', () => {
  test('S4-a export-name allowlist equality (names only, not semantics)', () => {
    expect(Object.keys(store).slice().sort()).toEqual([...EXPECTED_EXPORT_NAMES]);
  });

  test('S4-b same-module-realm direct-value WeakSet leak regression only', () => {
    for (const name of EXPECTED_EXPORT_NAMES) {
      const value = store[name as keyof typeof store];
      expect(value instanceof WeakSet).toBe(false);
    }
  });

  test('S4-c no exported runtime authenticity Symbol value', () => {
    for (const name of EXPECTED_EXPORT_NAMES) {
      expect(typeof store[name as keyof typeof store]).not.toBe('symbol');
    }
  });

  test('S4-d forbidden seam names are absent (name-level only)', () => {
    for (const name of Object.keys(store)) {
      expect(isForbiddenSeamName(name)).toBe(false);
    }
  });

  test('S4-e module namespace own symbols are a subset of Symbol.toStringTag', () => {
    const permitted = new Set<symbol>([Symbol.toStringTag]);
    for (const sym of Object.getOwnPropertySymbols(store)) {
      expect(permitted.has(sym)).toBe(true);
    }
  });

  test('S4-f types module emits no runtime export names', async () => {
    const typesNs = await import('./saleSubmissionEvidenceTypes');
    expect(Object.keys(typesNs).length).toBe(0);
  });

  test('S4-g validator export exists and is callable', () => {
    expect(typeof store.isAuthenticProvenEvidenceAbsence).toBe('function');
    expect(store.isAuthenticProvenEvidenceAbsence.length).toBe(1);
  });
});

describe('S5 validator contract', () => {
  test('authentic object is true; structurally identical unregistered object is false', async () => {
    const authentic = await mintAuthenticProof();
    expect(isAuthenticProvenEvidenceAbsence(authentic)).toBe(true);
    const twin = publicProofShape({
      barrierFenceSeq: authentic.barrierFenceSeq,
      barrierFenceNonce: authentic.barrierFenceNonce,
    });
    expect(isAuthenticProvenEvidenceAbsence(twin)).toBe(false);
  });

  test('null and primitives are false', () => {
    expect(isAuthenticProvenEvidenceAbsence(null)).toBe(false);
    expect(isAuthenticProvenEvidenceAbsence(undefined)).toBe(false);
    expect(isAuthenticProvenEvidenceAbsence(0)).toBe(false);
    expect(isAuthenticProvenEvidenceAbsence('x')).toBe(false);
    expect(isAuthenticProvenEvidenceAbsence(true)).toBe(false);
  });

  test('hostile and revoked Proxy inputs fail closed without throw', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
        has() {
          throw new Error('trap');
        },
        getOwnPropertyDescriptor() {
          throw new Error('trap');
        },
        ownKeys() {
          throw new Error('trap');
        },
      },
    );
    expect(isAuthenticProvenEvidenceAbsence(hostile)).toBe(false);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(isAuthenticProvenEvidenceAbsence(revocable.proxy)).toBe(false);
  });

  test('Proxy wrapping an authentic proof is a new identity and is refused', async () => {
    const authentic = await mintAuthenticProof();
    const wrapped = new Proxy(authentic, {});
    expect(isAuthenticProvenEvidenceAbsence(authentic)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(wrapped)).toBe(false);
  });

  test('validator mutates neither argument nor return type besides boolean', () => {
    const forged = publicProofShape();
    const before = JSON.stringify(forged);
    const result = isAuthenticProvenEvidenceAbsence(forged);
    expect(typeof result).toBe('boolean');
    expect(JSON.stringify(forged)).toBe(before);
  });
});

describe('S6 producer / free-mint structural guard', () => {
  test('S6-a/c allowlist contains authorized producer and validator; types match; no forbidden seam', () => {
    // commitSaleSubmissionAbsenceSeal is permitted because it now gates on the
    // cart store's authorization predicate before any seal / evidence-DB work.
    // It yields a proof only after a real completed seal against durable state.
    // Behavioural half of S6 (forged/clone refuse; authentic succeeds) is A-F1,
    // A-F2, and A-POSITIVE — not duplicated here.
    expect(EXPECTED_EXPORT_NAMES).toContain('commitSaleSubmissionAbsenceSeal');
    // isAuthenticProvenEvidenceAbsence is a boolean predicate and confers no mint.
    expect(EXPECTED_EXPORT_NAMES).toContain('isAuthenticProvenEvidenceAbsence');
    for (const name of EXPECTED_EXPORT_NAMES) {
      expect(typeof store[name as keyof typeof store]).toBe(EXPECTED_EXPORT_TYPE[name]);
      expect(isForbiddenSeamName(name)).toBe(false);
    }
  });

  test('S6-d real completed producer is the positive authentic path', async () => {
    const proof = await mintAuthenticProof();
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);
  });
});

describe('S7 no public test mint / backdoor', () => {
  test('authentic proofs come only through the real authorized producer', async () => {
    // Fact 1: exactly one proof membership grant (producer post-terminal .add).
    // Fact 2: exactly one authorization membership grant (one-step acquire .add).
    // Fact 3: exactly one public durable held:false -> held:true transition, and
    // successful execution always grants authorization membership before return.
    // Conditions: no public auth/proof registration seam; no test-only mint;
    // authentic authorization only from the real one-step acquire (A-F1 vs
    // A-POSITIVE); authentic proof only from the producer given an authentic
    // authorization (A-F1 emptiness + G5). Not duplicated here.
    const keys = Object.keys(store);
    expect(keys.some(isForbiddenSeamName)).toBe(false);
    const proof = await mintAuthenticProof();
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);
  });
});

describe('A-F1 structurally perfect forged authorization', () => {
  test('identity is the sole causal difference; forged producer call leaves evidence empty', async () => {
    const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
    expect(init.ok).toBe(true);
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const authentic = acquired.authorization;
    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record).toBeDefined();
    if (!record) throw new Error('missing cart');
    expect(record.resumeFence.held).toBe(true);

    const forged = {
      branchId: record.branchId,
      deviceId: record.deviceId,
      generationId: record.generationId,
      generationSeq: record.generationSeq,
      storeEpochId: record.storeEpochId,
      asyncOrderId: record.asyncOrderId,
      billId: record.billId,
      fenceSeq: record.resumeFence.fenceSeq,
      fenceNonce: record.resumeFence.fenceNonce,
    } as unknown as AcquiredResumeFenceAuthorization;

    expect(forged.branchId).toBe(authentic.branchId);
    expect(forged.deviceId).toBe(authentic.deviceId);
    expect(forged.generationId).toBe(authentic.generationId);
    expect(forged.generationSeq).toBe(authentic.generationSeq);
    expect(forged.storeEpochId).toBe(authentic.storeEpochId);
    expect(forged.asyncOrderId).toBe(authentic.asyncOrderId);
    expect(forged.billId).toBe(authentic.billId);
    expect(forged.fenceSeq).toBe(authentic.fenceSeq);
    expect(forged.fenceNonce).toBe(authentic.fenceNonce);
    expect(forged).not.toBe(authentic);
    expect(Number.isInteger(forged.fenceSeq) && forged.fenceSeq > 0).toBe(true);
    expect(typeof forged.fenceNonce === 'string' && forged.fenceNonce.length > 0).toBe(true);
    expect(isAuthenticAcquiredResumeFenceAuthorization(forged)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authentic)).toBe(true);

    const before = await inspectEvidenceStores();
    expect(before.pointerKeys).toEqual([]);
    expect(before.entryKeys).toEqual([]);
    expect(
      before.pointerByKey.has(
        testCanonicalGenerationKey(FIXTURE.branchId, FIXTURE.deviceId, FIXTURE.generationId),
      ),
    ).toBe(false);

    const forgedResult = await commitSaleSubmissionAbsenceSeal(forged);
    expect(forgedResult.ok).toBe(false);
    expect('proof' in forgedResult).toBe(false);

    const afterForged = await inspectEvidenceStores();
    expect(afterForged.pointerKeys).toEqual([]);
    expect(afterForged.entryKeys).toEqual([]);

    const sealed = await commitSaleSubmissionAbsenceSeal(authentic);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('authentic seal failed');
    expect(isAuthenticProvenEvidenceAbsence(sealed.proof)).toBe(true);
  });
});

describe('A-F2 clone-first of an authentic authorization', () => {
  test('spread clone is refused first; original succeeds second; evidence empty after clone', async () => {
    const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
    expect(init.ok).toBe(true);
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const authentic = acquired.authorization;
    const cloned = { ...authentic } as unknown as AcquiredResumeFenceAuthorization;

    expect(cloned.branchId).toBe(authentic.branchId);
    expect(cloned.deviceId).toBe(authentic.deviceId);
    expect(cloned.generationId).toBe(authentic.generationId);
    expect(cloned.generationSeq).toBe(authentic.generationSeq);
    expect(cloned.storeEpochId).toBe(authentic.storeEpochId);
    expect(cloned.asyncOrderId).toBe(authentic.asyncOrderId);
    expect(cloned.billId).toBe(authentic.billId);
    expect(cloned.fenceSeq).toBe(authentic.fenceSeq);
    expect(cloned.fenceNonce).toBe(authentic.fenceNonce);
    expect(cloned).not.toBe(authentic);
    expect(isAuthenticAcquiredResumeFenceAuthorization(cloned)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authentic)).toBe(true);

    const cloneResult = await commitSaleSubmissionAbsenceSeal(cloned);
    expect(cloneResult.ok).toBe(false);

    const afterClone = await inspectEvidenceStores();
    expect(afterClone.pointerKeys).toEqual([]);
    expect(afterClone.entryKeys).toEqual([]);

    const sealed = await commitSaleSubmissionAbsenceSeal(authentic);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('authentic seal failed');
    expect(isAuthenticProvenEvidenceAbsence(sealed.proof)).toBe(true);
  });
});

describe('A-POSITIVE authentic one-step acquire to producer', () => {
  test('exact authorization reference yields authentic proof after terminal seal', async () => {
    // Bounded to Row29 proof-mint/admission. Does not test a second acquire,
    // reuse of the same authorization, staleness, revocation, authorization
    // expiry, release accounting, resumeAttempts arithmetic, or successor-epoch
    // behaviour.
    const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
    expect(init.ok).toBe(true);
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    const authorization = acquired.authorization;
    const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(record).toBeDefined();
    if (!record) throw new Error('missing cart');
    expect(record.resumeFence.held).toBe(true);
    expect(record.resumeFence.fenceSeq).toBe(authorization.fenceSeq);
    expect(record.resumeFence.fenceNonce).toBe(authorization.fenceNonce);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);

    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const proof = sealed.proof;
    expect(proof).toBe(sealed.proof);

    const generationKey = testCanonicalGenerationKey(
      authorization.branchId,
      authorization.deviceId,
      authorization.generationId,
    );
    const inspected = await inspectEvidenceStores();
    expect(inspected.pointerKeys).toEqual([generationKey]);
    const pointer = inspected.pointerByKey.get(generationKey) as {
      kind?: string;
      barrierFenceSeq?: number;
      barrierFenceNonce?: string;
    };
    expect(pointer.kind).toBe('absence_seal');
    expect(pointer.barrierFenceSeq).toBe(authorization.fenceSeq);
    expect(pointer.barrierFenceNonce).toBe(authorization.fenceNonce);
    expect(isAuthenticProvenEvidenceAbsence(proof)).toBe(true);
  });
});

describe('A-C5-E evidence-first entry executes the cart→evidence proof-predicate edge', () => {
  test('authentic acquire → seal → release traverses both cycle edges under evidence-first entry', async () => {
    // Direct host calls to isAuthenticProvenEvidenceAbsence are host→evidence,
    // not the cycle edge. The load-bearing cart→evidence traversal is the call
    // inside releaseSaleSubmissionResumeFence. Symmetrically, a direct host
    // call to isAuthenticAcquiredResumeFenceAuthorization is host→cart; the
    // load-bearing evidence→cart traversal is inside commitSaleSubmissionAbsenceSeal.
    const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
    expect(init.ok).toBe(true);
    const acquired = await acquireSaleSubmissionResumeFence({
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('acquire failed');
    expect(isAuthenticAcquiredResumeFenceAuthorization(acquired.authorization)).toBe(true);

    const sealed = await commitSaleSubmissionAbsenceSeal(acquired.authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');

    const released = await releaseSaleSubmissionResumeFence(acquired.authorization, {
      outcome: 'evidence_proven_absent',
      proof: sealed.proof,
    });
    expect(released.ok).toBe(true);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
  });
});
