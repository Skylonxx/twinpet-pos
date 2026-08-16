import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type {
  AcquiredResumeFenceAuthorization,
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
import * as cart from './activeCartSnapshotStore';
import {
  commitSaleSubmissionAbsenceSeal,
  isAuthenticProvenEvidenceAbsence,
} from './saleSubmissionEvidenceStore';
import * as store from './saleSubmissionEvidenceStore';

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

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
    req.onblocked = () => resolve();
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

async function captureDurableState() {
  const dump = await readActiveCartDurableDump();
  const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
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

function assertByteIdentical(
  before: Awaited<ReturnType<typeof captureDurableState>>,
  after: Awaited<ReturnType<typeof captureDurableState>>,
) {
  expect(after.dumpSerialized).toBe(before.dumpSerialized);
  expect(after.recordSerialized).toBe(before.recordSerialized);
  expect(after.keys).toEqual(before.keys);
  expect(after.held).toBe(true);
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

function currentPublicProof(record: NonNullable<Awaited<ReturnType<typeof readActiveCartSnapshot>>>) {
  return {
    kind: 'evidence_proven_absent' as const,
    branchId: record.branchId,
    deviceId: record.deviceId,
    generationId: record.generationId,
    generationSeq: record.generationSeq,
    storeEpochId: record.storeEpochId,
    asyncOrderId: record.asyncOrderId,
    billId: record.billId,
    barrierFenceSeq: record.resumeFence.fenceSeq,
    barrierFenceNonce: record.resumeFence.fenceNonce,
  };
}

async function arrangeHeldCart() {
  const init = await initializeActiveCartSaleSubmission({ ...FIXTURE });
  expect(init.ok).toBe(true);
  const acquired = await acquireSaleSubmissionResumeFence({
    branchId: FIXTURE.branchId,
    deviceId: FIXTURE.deviceId,
  });
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) throw new Error('acquire failed');
  const record = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
  expect(record).toBeDefined();
  if (!record) throw new Error('missing cart');
  expect(record.resumeFence.held).toBe(true);
  return { authorization: acquired.authorization, record };
}

beforeEach(async () => {
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

afterEach(async () => {
  await deleteDb(EVIDENCE_DB_NAME);
  await deleteDb(CART_DB_NAME);
});

describe('F1 structurally perfect caller forge', () => {
  test('current-field unsafe-cast forge is refused with byte-identical durable state', async () => {
    const { authorization, record } = await arrangeHeldCart();
    const forged = currentPublicProof(record) as unknown as ProvenEvidenceAbsence;
    expect(forged.kind).toBe('evidence_proven_absent');
    expect(forged.branchId).toBe(record.branchId);
    expect(forged.deviceId).toBe(record.deviceId);
    expect(forged.generationId).toBe(record.generationId);
    expect(forged.generationSeq).toBe(record.generationSeq);
    expect(forged.storeEpochId).toBe(record.storeEpochId);
    expect(forged.asyncOrderId).toBe(record.asyncOrderId);
    expect(forged.billId).toBe(record.billId);
    expect(forged.barrierFenceSeq).toBe(record.resumeFence.fenceSeq);
    expect(forged.barrierFenceNonce).toBe(record.resumeFence.fenceNonce);
    expect(isAuthenticProvenEvidenceAbsence(forged)).toBe(false);

    const before = await captureDurableState();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: forged,
    });
    expect(released.ok).toBe(false);
    const after = await captureDurableState();
    assertByteIdentical(before, after);
  });
});

describe('F2 ordinary clone', () => {
  test('spread clone is a distinct identity and is refused', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const authentic = sealed.proof;
    const cloned = { ...authentic } as unknown as ProvenEvidenceAbsence;

    expect(cloned.kind).toBe(authentic.kind);
    expect(cloned.branchId).toBe(authentic.branchId);
    expect(cloned.deviceId).toBe(authentic.deviceId);
    expect(cloned.generationId).toBe(authentic.generationId);
    expect(cloned.generationSeq).toBe(authentic.generationSeq);
    expect(cloned.storeEpochId).toBe(authentic.storeEpochId);
    expect(cloned.asyncOrderId).toBe(authentic.asyncOrderId);
    expect(cloned.billId).toBe(authentic.billId);
    expect(cloned.barrierFenceSeq).toBe(authentic.barrierFenceSeq);
    expect(cloned.barrierFenceNonce).toBe(authentic.barrierFenceNonce);
    expect(cloned).not.toBe(authentic);
    expect(isAuthenticProvenEvidenceAbsence(authentic)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(cloned)).toBe(false);

    const before = await captureDurableState();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: cloned,
    });
    expect(released.ok).toBe(false);
    const after = await captureDurableState();
    assertByteIdentical(before, after);
  });

  test('Object.assign clone is a distinct identity and is refused', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const authentic = sealed.proof;
    const cloned = Object.assign({}, authentic) as unknown as ProvenEvidenceAbsence;

    expect(cloned.barrierFenceSeq).toBe(authentic.barrierFenceSeq);
    expect(cloned.barrierFenceNonce).toBe(authentic.barrierFenceNonce);
    expect(cloned).not.toBe(authentic);
    expect(isAuthenticProvenEvidenceAbsence(authentic)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(cloned)).toBe(false);

    const before = await captureDurableState();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: cloned,
    });
    expect(released.ok).toBe(false);
    const after = await captureDurableState();
    assertByteIdentical(before, after);
  });
});

describe('F3 reflective transplant', () => {
  test('descriptor-and-prototype transplant is observationally identical and still refused', async () => {
    const { authorization } = await arrangeHeldCart();
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const authentic = sealed.proof;
    const reflected = Object.create(
      Object.getPrototypeOf(authentic),
      Object.getOwnPropertyDescriptors(authentic),
    ) as ProvenEvidenceAbsence;

    expect(Object.getOwnPropertyNames(reflected)).toEqual(Object.getOwnPropertyNames(authentic));
    expect(Object.getOwnPropertySymbols(reflected)).toEqual(Object.getOwnPropertySymbols(authentic));
    expect(Object.getOwnPropertyDescriptors(reflected)).toEqual(
      Object.getOwnPropertyDescriptors(authentic),
    );
    expect(Object.getPrototypeOf(reflected)).toBe(Object.getPrototypeOf(authentic));
    expect(reflected).not.toBe(authentic);
    expect(isAuthenticProvenEvidenceAbsence(authentic)).toBe(true);
    expect(isAuthenticProvenEvidenceAbsence(reflected)).toBe(false);

    const before = await captureDurableState();
    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: reflected,
    });
    expect(released.ok).toBe(false);
    const after = await captureDurableState();
    assertByteIdentical(before, after);
  });
});

describe('positive contrast', () => {
  test('authentic completed-producer proof is admitted; same public fields as forge arms', async () => {
    const { authorization, record } = await arrangeHeldCart();
    const forged = currentPublicProof(record);
    const sealed = await commitSaleSubmissionAbsenceSeal(authorization);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) throw new Error('seal failed');
    const authentic = sealed.proof;

    expect(authentic.kind).toBe(forged.kind);
    expect(authentic.branchId).toBe(forged.branchId);
    expect(authentic.deviceId).toBe(forged.deviceId);
    expect(authentic.generationId).toBe(forged.generationId);
    expect(authentic.generationSeq).toBe(forged.generationSeq);
    expect(authentic.storeEpochId).toBe(forged.storeEpochId);
    expect(authentic.asyncOrderId).toBe(forged.asyncOrderId);
    expect(authentic.billId).toBe(forged.billId);
    expect(authentic.barrierFenceSeq).toBe(forged.barrierFenceSeq);
    expect(authentic.barrierFenceNonce).toBe(forged.barrierFenceNonce);
    expect(isAuthenticProvenEvidenceAbsence(authentic)).toBe(true);

    const released = await releaseSaleSubmissionResumeFence(authorization, {
      outcome: 'evidence_proven_absent',
      proof: authentic,
    });
    expect(released.ok).toBe(true);
    const after = await readActiveCartSnapshot(FIXTURE.branchId, FIXTURE.deviceId);
    expect(after?.resumeFence.held).toBe(false);
    expect(after?.resumeAttempts).toBe(1);
  });
});

const EXPECTED_CART_EXPORT_NAMES = Object.freeze(
  [
    'acquireSaleSubmissionResumeFence',
    'beginActiveCartGeneration',
    'initializeActiveCartSaleSubmission',
    'isAuthenticAcquiredResumeFenceAuthorization',
    'readActiveCartDurableDump',
    'readActiveCartSnapshot',
    'releaseSaleSubmissionResumeFence',
  ]
    .slice()
    .sort(),
);

const EXPECTED_CART_EXPORT_TYPE: Record<string, string> = {
  acquireSaleSubmissionResumeFence: 'function',
  beginActiveCartGeneration: 'function',
  initializeActiveCartSaleSubmission: 'function',
  isAuthenticAcquiredResumeFenceAuthorization: 'function',
  readActiveCartDurableDump: 'function',
  readActiveCartSnapshot: 'function',
  releaseSaleSubmissionResumeFence: 'function',
};

function isForbiddenSeamName(name: string): boolean {
  if (/^(mint|register|brand)/i.test(name)) return true;
  if (/addAuthentic/i.test(name)) return true;
  if (/^(create|make|new)ProvenEvidenceAbsence$/i.test(name)) return true;
  if (/^(create|make|new)AcquiredResumeFenceAuthorization$/i.test(name)) return true;
  if (/authoriz\w*(mint|register)/i.test(name)) return true;
  return false;
}

describe('A-P authorization predicate matrix', () => {
  // Same-realm WeakSet object-identity semantics only. No cross-realm
  // universality claim. A-P-6/7/8 cover specific Proxy cases, not a general
  // classifier of exotic objects. A wrapping Proxy is refused because it is a
  // different object identity, not because the predicate detects proxies.
  test('A-P-1 authentic authorization is true', async () => {
    const { authorization } = await arrangeHeldCart();
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
  });

  test('A-P-2 structurally perfect fresh forge is false', async () => {
    const { authorization, record } = await arrangeHeldCart();
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
    expect(forged.branchId).toBe(authorization.branchId);
    expect(forged.deviceId).toBe(authorization.deviceId);
    expect(forged.generationId).toBe(authorization.generationId);
    expect(forged.generationSeq).toBe(authorization.generationSeq);
    expect(forged.storeEpochId).toBe(authorization.storeEpochId);
    expect(forged.asyncOrderId).toBe(authorization.asyncOrderId);
    expect(forged.billId).toBe(authorization.billId);
    expect(forged.fenceSeq).toBe(authorization.fenceSeq);
    expect(forged.fenceNonce).toBe(authorization.fenceNonce);
    expect(forged).not.toBe(authorization);
    expect(isAuthenticAcquiredResumeFenceAuthorization(forged)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
  });

  test('A-P-3 spread clone is false', async () => {
    const { authorization } = await arrangeHeldCart();
    const cloned = { ...authorization } as unknown as AcquiredResumeFenceAuthorization;
    expect(cloned).not.toBe(authorization);
    expect(cloned.fenceSeq).toBe(authorization.fenceSeq);
    expect(cloned.fenceNonce).toBe(authorization.fenceNonce);
    expect(isAuthenticAcquiredResumeFenceAuthorization(cloned)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
  });

  test('A-P-4 null is false', () => {
    expect(isAuthenticAcquiredResumeFenceAuthorization(null)).toBe(false);
  });

  test('A-P-5 primitives are false', () => {
    expect(isAuthenticAcquiredResumeFenceAuthorization(undefined)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(0)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization('')).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization('x')).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(true)).toBe(false);
    expect(isAuthenticAcquiredResumeFenceAuthorization(Symbol('x'))).toBe(false);
  });

  test('A-P-6 hostile Proxy is false without throw', () => {
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
    expect(isAuthenticAcquiredResumeFenceAuthorization(hostile)).toBe(false);
  });

  test('A-P-7 revoked Proxy is false without throw', () => {
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(isAuthenticAcquiredResumeFenceAuthorization(revocable.proxy)).toBe(false);
  });

  test('A-P-8 wrapping Proxy over authentic auth: target true / wrapper false', async () => {
    const { authorization } = await arrangeHeldCart();
    const wrapped = new Proxy(authorization, {});
    expect(isAuthenticAcquiredResumeFenceAuthorization(authorization)).toBe(true);
    expect(isAuthenticAcquiredResumeFenceAuthorization(wrapped)).toBe(false);
  });

  test('A-P-9 predicate is pure and returns boolean', () => {
    const forged = {
      branchId: FIXTURE.branchId,
      deviceId: FIXTURE.deviceId,
      generationId: FIXTURE.generationId,
      generationSeq: FIXTURE.generationSeq,
      storeEpochId: FIXTURE.storeEpochId,
      asyncOrderId: FIXTURE.asyncOrderId,
      billId: FIXTURE.billId,
      fenceSeq: 1,
      fenceNonce: 'NONCE',
    };
    const before = JSON.stringify(forged);
    const result = isAuthenticAcquiredResumeFenceAuthorization(forged);
    expect(typeof result).toBe('boolean');
    expect(JSON.stringify(forged)).toBe(before);
  });
});

describe('A-S4x cart-store export audit', () => {
  test('A-S4x-a export-name allowlist equality (names only, not semantics)', () => {
    // Type-only exports (ActiveCartSnapshotRecord, result types) are erased and
    // must not appear in the runtime allowlist.
    expect(Object.keys(cart).slice().sort()).toEqual([...EXPECTED_CART_EXPORT_NAMES]);
  });

  test('A-S4x-b same-module-realm direct-value WeakSet leak regression only', () => {
    for (const name of EXPECTED_CART_EXPORT_NAMES) {
      const value = cart[name as keyof typeof cart];
      expect(value instanceof WeakSet).toBe(false);
    }
  });

  test('A-S4x-c no exported runtime authenticity Symbol value', () => {
    for (const name of EXPECTED_CART_EXPORT_NAMES) {
      expect(typeof cart[name as keyof typeof cart]).not.toBe('symbol');
    }
  });

  test('A-S4x-d forbidden seam names are absent (name-level only)', () => {
    for (const name of Object.keys(cart)) {
      expect(isForbiddenSeamName(name)).toBe(false);
    }
  });

  test('A-S4x-e acquireResumeFenceHoldFields is absent from cart and evidence', () => {
    expect('acquireResumeFenceHoldFields' in cart).toBe(false);
    expect('acquireResumeFenceHoldFields' in store).toBe(false);
  });

  test('A-S4x-f module namespace own symbols are a subset of Symbol.toStringTag', () => {
    const permitted = new Set<symbol>([Symbol.toStringTag]);
    for (const sym of Object.getOwnPropertySymbols(cart)) {
      expect(permitted.has(sym)).toBe(true);
    }
  });

  test('A-S4x-g both predicates are present and callable', () => {
    expect(typeof cart.isAuthenticAcquiredResumeFenceAuthorization).toBe('function');
    expect(cart.isAuthenticAcquiredResumeFenceAuthorization.length).toBe(1);
    expect(typeof store.isAuthenticProvenEvidenceAbsence).toBe('function');
    expect(store.isAuthenticProvenEvidenceAbsence.length).toBe(1);
  });

  test('A-S4x-h every allowlisted runtime export is a function', () => {
    for (const name of EXPECTED_CART_EXPORT_NAMES) {
      expect(typeof cart[name as keyof typeof cart]).toBe(EXPECTED_CART_EXPORT_TYPE[name]);
    }
  });
});
