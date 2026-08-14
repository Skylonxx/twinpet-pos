/**
 * Cart-currentness owner, consumer of ProvenEvidenceAbsence, and owner of the
 * authorization capability. Runtime authenticity for
 * AcquiredResumeFenceAuthorization is a module-private WeakSet of exact object
 * identities. The public acquire is one-step: a successful durable hold always
 * returns the exact registered authorization identity. There is deliberately no
 * low-level durable-acquire export. Cycle invariants C-1..C-4: only hoisted
 * function declarations cross the cycle; no peer call during evaluation; no
 * peer-dependent top-level initializer; exactly two production runtime edges.
 * Proofs travel by direct in-process reference; this module does not clone,
 * spread, serialize, or wrap them.
 */
import { isAuthenticProvenEvidenceAbsence } from './saleSubmissionEvidenceStore';
import type {
  AcquiredResumeFenceAuthorization,
  ActiveCartSnapshotRecord,
  ProvenEvidenceAbsence,
  ReleaseSaleSubmissionResumeFenceResult,
} from './saleSubmissionEvidenceTypes';

export type { ActiveCartSnapshotRecord, ReleaseSaleSubmissionResumeFenceResult };

type FenceAuthorizationFields = {
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  fenceSeq: number;
  fenceNonce: string;
};

const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const CART_DB_VERSION = 1;
const CART_STORE = 'activeCartSnapshots';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const authenticAcquiredResumeFenceAuthorizations = new WeakSet<object>();

type CartStoreName = typeof CART_STORE;

interface CartTxn {
  get<T>(store: CartStoreName, key: string): Promise<T | undefined>;
  put(store: CartStoreName, key: string, value: unknown): Promise<void>;
  getAllKeys(store: CartStoreName): Promise<IDBValidKey[]>;
  getAll<T>(store: CartStoreName): Promise<T[]>;
}

export type InitializeActiveCartResult = { ok: true } | { ok: false };

export type AcquireSaleSubmissionResumeFenceResult =
  | { ok: true; authorization: AcquiredResumeFenceAuthorization }
  | { ok: false };

function cartKey(branchId: string, deviceId: string): string {
  return `${branchId.length}:${branchId}|${deviceId.length}:${deviceId}`;
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openCartDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(CART_DB_NAME, CART_DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        if (!dbi.objectStoreNames.contains(CART_STORE)) dbi.createObjectStore(CART_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function transactCart<T>(
  mode: 'readonly' | 'readwrite',
  fn: (txn: CartTxn) => Promise<T>,
): Promise<T> {
  return openCartDb().then(
    (dbi) =>
      new Promise<T>((resolve, reject) => {
        if (!dbi) {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        let result: T;
        let settled = false;
        const fail = (err: unknown) => {
          if (settled) return;
          settled = true;
          dbi.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        let tx: IDBTransaction;
        try {
          tx = dbi.transaction([CART_STORE], mode);
        } catch (err) {
          fail(err);
          return;
        }

        const txn: CartTxn = {
          get: (store, key) => reqP(tx.objectStore(store).get(key)),
          put: (store, key, value) =>
            reqP(tx.objectStore(store).put(value, key)).then(() => undefined),
          getAllKeys: (store) => reqP(tx.objectStore(store).getAllKeys()),
          getAll: (store) => reqP(tx.objectStore(store).getAll()),
        };

        tx.oncomplete = () => {
          if (settled) return;
          settled = true;
          dbi.close();
          resolve(result);
        };
        tx.onabort = () => fail(tx.error ?? new Error('IndexedDB transaction aborted'));

        Promise.resolve()
          .then(() => fn(txn))
          .then((r) => {
            result = r;
          })
          .catch((err) => {
            try {
              tx.abort();
            } catch {
              /* already aborting */
            }
            fail(err);
          });
      }),
  );
}

function freshCrockford128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

export async function initializeActiveCartSaleSubmission(input: {
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
}): Promise<InitializeActiveCartResult> {
  try {
    await transactCart('readwrite', async (txn) => {
      const key = cartKey(input.branchId, input.deviceId);
      const existing = await txn.get<ActiveCartSnapshotRecord>(CART_STORE, key);
      if (existing !== undefined) throw new Error('cart_exists');
      const record: ActiveCartSnapshotRecord = {
        schemaVersion: 1,
        branchId: input.branchId,
        deviceId: input.deviceId,
        generationId: input.generationId,
        generationSeq: input.generationSeq,
        storeEpochId: input.storeEpochId,
        asyncOrderId: input.asyncOrderId,
        billId: input.billId,
        resumeFence: { held: false, fenceSeq: 0, fenceNonce: '' },
        resumeAttempts: 0,
        marker: 'S2',
      };
      await txn.put(CART_STORE, key, record);
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function acquireSaleSubmissionResumeFence(input: {
  branchId: string;
  deviceId: string;
}): Promise<AcquireSaleSubmissionResumeFenceResult> {
  let minted: FenceAuthorizationFields;
  try {
    minted = await transactCart('readwrite', async (txn) => {
      const key = cartKey(input.branchId, input.deviceId);
      const record = await txn.get<ActiveCartSnapshotRecord>(CART_STORE, key);
      if (record === undefined || record.schemaVersion !== 1) {
        throw new Error('acquire_refused');
      }
      if (record.resumeFence.held) throw new Error('acquire_refused');
      const nextSeq = record.resumeFence.fenceSeq + 1;
      const nextNonce = freshCrockford128();
      const next: ActiveCartSnapshotRecord = {
        ...record,
        resumeFence: { held: true, fenceSeq: nextSeq, fenceNonce: nextNonce },
      };
      await txn.put(CART_STORE, key, next);
      return {
        branchId: next.branchId,
        deviceId: next.deviceId,
        generationId: next.generationId,
        generationSeq: next.generationSeq,
        storeEpochId: next.storeEpochId,
        asyncOrderId: next.asyncOrderId,
        billId: next.billId,
        fenceSeq: nextSeq,
        fenceNonce: nextNonce,
      };
    });
  } catch {
    return { ok: false };
  }

  const authorization = {
    branchId: minted.branchId,
    deviceId: minted.deviceId,
    generationId: minted.generationId,
    generationSeq: minted.generationSeq,
    storeEpochId: minted.storeEpochId,
    asyncOrderId: minted.asyncOrderId,
    billId: minted.billId,
    fenceSeq: minted.fenceSeq,
    fenceNonce: minted.fenceNonce,
  };
  // SOLE authorized registry membership grant point. Adjacent to construction;
  // no await/yield/escape between construct, add, and return. Outside the
  // transaction/refusal try/catch.
  authenticAcquiredResumeFenceAuthorizations.add(authorization);
  return { ok: true, authorization: authorization as AcquiredResumeFenceAuthorization };
}

export function isAuthenticAcquiredResumeFenceAuthorization(
  value: unknown,
): value is AcquiredResumeFenceAuthorization {
  if (value === null || typeof value !== 'object') return false;
  return authenticAcquiredResumeFenceAuthorizations.has(value);
}

export async function readActiveCartSnapshot(
  branchId: string,
  deviceId: string,
): Promise<ActiveCartSnapshotRecord | undefined> {
  try {
    return await transactCart('readonly', async (txn) => {
      return txn.get<ActiveCartSnapshotRecord>(CART_STORE, cartKey(branchId, deviceId));
    });
  } catch {
    return undefined;
  }
}

export async function readActiveCartDurableDump(): Promise<{
  keys: IDBValidKey[];
  records: ActiveCartSnapshotRecord[];
}> {
  try {
    return await transactCart('readonly', async (txn) => {
      const keys = await txn.getAllKeys(CART_STORE);
      const records = await txn.getAll<ActiveCartSnapshotRecord>(CART_STORE);
      return { keys, records };
    });
  } catch {
    return { keys: [], records: [] };
  }
}

/**
 * Consumer of ProvenEvidenceAbsence. Check 10 (authenticity) runs first and
 * unconditionally before the first mutation. No twelfth check. No new refusal
 * kind. Forged proofs gain no replay/resume authority.
 */
export async function releaseSaleSubmissionResumeFence(
  authorization: AcquiredResumeFenceAuthorization,
  request: { outcome: 'evidence_proven_absent'; proof: ProvenEvidenceAbsence },
): Promise<ReleaseSaleSubmissionResumeFenceResult> {
  const proof = request.proof;
  if (!isAuthenticProvenEvidenceAbsence(proof)) {
    return { ok: false };
  }

  try {
    await transactCart('readwrite', async (txn) => {
      const key = cartKey(authorization.branchId, authorization.deviceId);
      const record = await txn.get<ActiveCartSnapshotRecord>(CART_STORE, key);
      if (record === undefined || record.schemaVersion !== 1) {
        throw new Error('release_refused');
      }
      if (
        authorization.generationId !== record.generationId ||
        authorization.generationSeq !== record.generationSeq ||
        authorization.storeEpochId !== record.storeEpochId ||
        proof.generationId !== record.generationId ||
        proof.generationSeq !== record.generationSeq ||
        proof.storeEpochId !== record.storeEpochId
      ) {
        throw new Error('release_refused');
      }
      if (
        authorization.asyncOrderId !== record.asyncOrderId ||
        authorization.billId !== record.billId ||
        proof.asyncOrderId !== record.asyncOrderId ||
        proof.billId !== record.billId ||
        proof.branchId !== record.branchId ||
        proof.deviceId !== record.deviceId
      ) {
        throw new Error('release_refused');
      }
      if (record.resumeFence.held !== true) throw new Error('release_refused');
      if (
        proof.barrierFenceSeq !== record.resumeFence.fenceSeq ||
        proof.barrierFenceNonce !== record.resumeFence.fenceNonce ||
        authorization.fenceSeq !== record.resumeFence.fenceSeq ||
        authorization.fenceNonce !== record.resumeFence.fenceNonce
      ) {
        throw new Error('release_refused');
      }
      if (record.marker !== 'S2') throw new Error('release_refused');

      const next: ActiveCartSnapshotRecord = {
        ...record,
        resumeFence: { ...record.resumeFence, held: false },
        resumeAttempts: record.resumeAttempts + 1,
      };
      await txn.put(CART_STORE, key, next);
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
