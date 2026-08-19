/**
 * Cart-currentness owner, consumer of ProvenEvidenceAbsence, and owner of the
 * authorization capability. Runtime authenticity for
 * AcquiredResumeFenceAuthorization is a module-private WeakSet of exact object
 * identities plus presentation-time 9-field mint integrity over ordinary own
 * data properties. The public acquire is one-step: a successful durable hold
 * always returns the exact registered authorization identity. There is
 * deliberately no low-level durable-acquire export. Cycle invariants C-1..C-4:
 * only hoisted function declarations cross the cycle; no peer call during
 * evaluation; no peer-dependent top-level initializer; exactly two production
 * runtime edges. Proofs travel by direct in-process reference; this module does
 * not clone, spread, serialize, or wrap them.
 */
import { isAuthenticProvenEvidenceAbsence, isAuthenticProvenEvidencePresence } from './saleSubmissionEvidenceStore';
import type {
  AcquiredResumeFenceAuthorization,
  ActiveCartSnapshotRecord,
  ProvenEvidenceAbsence,
  ProvenEvidencePresence,
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

type ProofFieldSnapshot = {
  kind: 'evidence_proven_absent' | 'evidence_present';
  branchId: string;
  deviceId: string;
  generationId: string;
  generationSeq: number;
  storeEpochId: string;
  asyncOrderId: string;
  billId: string;
  barrierFenceSeq: number;
  barrierFenceNonce: string;
};

const CART_DB_NAME = 'twinpet-active-cart-snapshot';
const CART_DB_VERSION = 1;
const CART_STORE = 'activeCartSnapshots';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const INITIAL_GENERATION_SEQ = 1;
const authenticAcquiredResumeFenceAuthorizations = new WeakSet<object>();
const acquiredResumeFenceAuthorizationMints = new WeakMap<object, FenceAuthorizationFields>();

type CartStoreName = typeof CART_STORE;

interface CartTxn {
  get<T>(store: CartStoreName, key: string): Promise<T | undefined>;
  put(store: CartStoreName, key: string, value: unknown): Promise<void>;
  getAllKeys(store: CartStoreName): Promise<IDBValidKey[]>;
  getAll<T>(store: CartStoreName): Promise<T[]>;
}

export type InitializeActiveCartResult = { ok: true } | { ok: false };

export type BeginActiveCartGenerationResult =
  | {
      ok: true;
      generationId: string;
      generationSeq: number;
      storeEpochId: string;
    }
  | { ok: false };

export type AcquireSaleSubmissionResumeFenceResult =
  | { ok: true; authorization: AcquiredResumeFenceAuthorization }
  | { ok: false };

function cartKey(branchId: string, deviceId: string): string {
  return `${branchId.length}:${branchId}|${deviceId.length}:${deviceId}`;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isOwnDataProperty(value: object, field: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined && 'value' in descriptor;
}

function copyAuthorizationFields(source: FenceAuthorizationFields): FenceAuthorizationFields {
  const snapshot: FenceAuthorizationFields = {
    branchId: source.branchId,
    deviceId: source.deviceId,
    generationId: source.generationId,
    generationSeq: source.generationSeq,
    storeEpochId: source.storeEpochId,
    asyncOrderId: source.asyncOrderId,
    billId: source.billId,
    fenceSeq: source.fenceSeq,
    fenceNonce: source.fenceNonce,
  };
  Object.freeze(snapshot);
  return snapshot;
}

function copyProofFields(source: ProofFieldSnapshot): ProofFieldSnapshot {
  const snapshot: ProofFieldSnapshot = {
    kind: source.kind,
    branchId: source.branchId,
    deviceId: source.deviceId,
    generationId: source.generationId,
    generationSeq: source.generationSeq,
    storeEpochId: source.storeEpochId,
    asyncOrderId: source.asyncOrderId,
    billId: source.billId,
    barrierFenceSeq: source.barrierFenceSeq,
    barrierFenceNonce: source.barrierFenceNonce,
  };
  Object.freeze(snapshot);
  return snapshot;
}

function authorizationFieldsFromRecord(record: ActiveCartSnapshotRecord): FenceAuthorizationFields {
  return {
    branchId: record.branchId,
    deviceId: record.deviceId,
    generationId: record.generationId,
    generationSeq: record.generationSeq,
    storeEpochId: record.storeEpochId,
    asyncOrderId: record.asyncOrderId,
    billId: record.billId,
    fenceSeq: record.resumeFence.fenceSeq,
    fenceNonce: record.resumeFence.fenceNonce,
  };
}

function isDurableIdentityValid(
  record: ActiveCartSnapshotRecord,
  branchId: string,
  deviceId: string,
): boolean {
  return (
    record.branchId === branchId &&
    record.deviceId === deviceId &&
    isNonemptyString(record.branchId) &&
    isNonemptyString(record.deviceId) &&
    isNonemptyString(record.generationId) &&
    isNonemptyString(record.storeEpochId) &&
    isNonemptyString(record.asyncOrderId) &&
    isNonemptyString(record.billId) &&
    isInteger(record.generationSeq)
  );
}

function isOpenAcquireEligible(
  record: ActiveCartSnapshotRecord,
  branchId: string,
  deviceId: string,
): boolean {
  return (
    record.schemaVersion === 1 &&
    record.marker === 'S2' &&
    isInteger(record.resumeAttempts) &&
    record.resumeAttempts === 0 &&
    isDurableIdentityValid(record, branchId, deviceId) &&
    record.resumeFence !== null &&
    typeof record.resumeFence === 'object'
  );
}

function isValidOpenHeldFence(record: ActiveCartSnapshotRecord): boolean {
  return (
    record.resumeFence.held === true &&
    isInteger(record.resumeFence.fenceSeq) &&
    record.resumeFence.fenceSeq > 0 &&
    isNonemptyString(record.resumeFence.fenceNonce)
  );
}

function isValidOpenIdleFence(record: ActiveCartSnapshotRecord): boolean {
  return (
    record.resumeFence.held === false &&
    isInteger(record.resumeFence.fenceSeq) &&
    record.resumeFence.fenceSeq >= 0 &&
    typeof record.resumeFence.fenceNonce === 'string' &&
    record.resumeFence.fenceNonce === ''
  );
}

function isExactValidTerminalSuccessor(
  record: ActiveCartSnapshotRecord,
  branchId: string,
  deviceId: string,
  asyncOrderId: string,
  billId: string,
): boolean {
  if (record.schemaVersion !== 1) return false;
  if (record.marker !== 'S2') return false;
  if (!Number.isInteger(record.resumeAttempts) || record.resumeAttempts !== 1) return false;
  const fence = record.resumeFence;
  if (fence === null || typeof fence !== 'object') return false;
  if (fence.held !== false) return false;
  if (!Number.isInteger(fence.fenceSeq) || fence.fenceSeq <= 0) return false;
  if (typeof fence.fenceNonce !== 'string' || fence.fenceNonce.length === 0) return false;
  if (!isDurableIdentityValid(record, branchId, deviceId)) return false;
  if (!Number.isSafeInteger(record.generationSeq)) return false;
  if (record.generationSeq < INITIAL_GENERATION_SEQ) return false;
  if (record.generationSeq >= Number.MAX_SAFE_INTEGER) return false;
  if (asyncOrderId === record.asyncOrderId) return false;
  if (billId === record.billId) return false;
  return true;
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

/**
 * @deprecated test/bootstrap-only
 *
 * Retained for closed-suite / test / bootstrap use. Runtime behavior is unchanged.
 */
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

/**
 * CANONICAL PRODUCTION ALLOCATOR for current active-cart generation identity.
 *
 * Owns first generation creation and exact valid TERMINAL N -> N+1 successor.
 * Success returns plain committed identity after transaction completion.
 * It is not a capability and is not the sole runtime creation API.
 */
export async function beginActiveCartGeneration(input: {
  branchId: string;
  deviceId: string;
  asyncOrderId: string;
  billId: string;
}): Promise<BeginActiveCartGenerationResult> {
  if (!(typeof input.branchId === 'string' && input.branchId.length > 0)) {
    return { ok: false };
  }
  if (!(typeof input.deviceId === 'string' && input.deviceId.length > 0)) {
    return { ok: false };
  }
  if (!(typeof input.asyncOrderId === 'string' && input.asyncOrderId.length > 0)) {
    return { ok: false };
  }
  if (!(typeof input.billId === 'string' && input.billId.length > 0)) {
    return { ok: false };
  }

  try {
    const committed = await transactCart('readwrite', async (txn) => {
      const key = cartKey(input.branchId, input.deviceId);
      const record = await txn.get<ActiveCartSnapshotRecord>(CART_STORE, key);
      let next: ActiveCartSnapshotRecord;
      if (record === undefined) {
        const generationId = freshCrockford128();
        const storeEpochId = freshCrockford128();
        next = {
          schemaVersion: 1,
          branchId: input.branchId,
          deviceId: input.deviceId,
          generationId,
          generationSeq: INITIAL_GENERATION_SEQ,
          storeEpochId,
          asyncOrderId: input.asyncOrderId,
          billId: input.billId,
          resumeFence: { held: false, fenceSeq: 0, fenceNonce: '' },
          resumeAttempts: 0,
          marker: 'S2',
        };
      } else {
        if (
          !isExactValidTerminalSuccessor(
            record,
            input.branchId,
            input.deviceId,
            input.asyncOrderId,
            input.billId,
          )
        ) {
          throw new Error('generation_refused');
        }
        const generationId = freshCrockford128();
        if (generationId === record.generationId) {
          throw new Error('generation_refused');
        }
        const generationSeq = record.generationSeq + 1;
        next = {
          schemaVersion: 1,
          branchId: record.branchId,
          deviceId: record.deviceId,
          generationId,
          generationSeq,
          storeEpochId: record.storeEpochId,
          asyncOrderId: input.asyncOrderId,
          billId: input.billId,
          resumeFence: { held: false, fenceSeq: 0, fenceNonce: '' },
          resumeAttempts: 0,
          marker: 'S2',
        };
      }
      await txn.put(CART_STORE, key, next);
      return {
        generationId: next.generationId,
        generationSeq: next.generationSeq,
        storeEpochId: next.storeEpochId,
      };
    });
    return {
      ok: true,
      generationId: committed.generationId,
      generationSeq: committed.generationSeq,
      storeEpochId: committed.storeEpochId,
    };
  } catch {
    return { ok: false };
  }
}

export async function acquireSaleSubmissionResumeFence(input: {
  branchId: string;
  deviceId: string;
}): Promise<AcquireSaleSubmissionResumeFenceResult> {
  // ONE_TRUSTED_ORCHESTRATION_OWNER_PER_CART_KEY: same-key recovery is
  // device/cart-key scoped. Do not add a holder credential. Do not expose
  // this primitive to arbitrary application callers (Row30/integration).
  let minted: FenceAuthorizationFields;
  try {
    minted = await transactCart('readwrite', async (txn) => {
      const key = cartKey(input.branchId, input.deviceId);
      const record = await txn.get<ActiveCartSnapshotRecord>(CART_STORE, key);
      if (record === undefined || !isOpenAcquireEligible(record, input.branchId, input.deviceId)) {
        throw new Error('acquire_refused');
      }
      if (record.resumeFence.held === true) {
        if (!isValidOpenHeldFence(record)) {
          throw new Error('acquire_refused');
        }
        // Valid OPEN_HELD recovery: same fenceSeq/fenceNonce, zero put,
        // no nonce generation, no sequence increment. Returns before the
        // sole existing acquire put site below.
        return authorizationFieldsFromRecord(record);
      }
      if (!isValidOpenIdleFence(record)) {
        throw new Error('acquire_refused');
      }
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
  acquiredResumeFenceAuthorizationMints.set(authorization, copyAuthorizationFields(authorization));
  return { ok: true, authorization: authorization as AcquiredResumeFenceAuthorization };
}

export function isAuthenticAcquiredResumeFenceAuthorization(
  value: unknown,
): value is AcquiredResumeFenceAuthorization {
  if (value === null || typeof value !== 'object') return false;
  if (!authenticAcquiredResumeFenceAuthorizations.has(value)) return false;
  const minted = acquiredResumeFenceAuthorizationMints.get(value);
  if (minted === undefined) return false;
  if (!isOwnDataProperty(value, 'branchId')) return false;
  if (!isOwnDataProperty(value, 'deviceId')) return false;
  if (!isOwnDataProperty(value, 'generationId')) return false;
  if (!isOwnDataProperty(value, 'generationSeq')) return false;
  if (!isOwnDataProperty(value, 'storeEpochId')) return false;
  if (!isOwnDataProperty(value, 'asyncOrderId')) return false;
  if (!isOwnDataProperty(value, 'billId')) return false;
  if (!isOwnDataProperty(value, 'fenceSeq')) return false;
  if (!isOwnDataProperty(value, 'fenceNonce')) return false;
  const current = value as FenceAuthorizationFields;
  return (
    current.branchId === minted.branchId &&
    current.deviceId === minted.deviceId &&
    current.generationId === minted.generationId &&
    current.generationSeq === minted.generationSeq &&
    current.storeEpochId === minted.storeEpochId &&
    current.asyncOrderId === minted.asyncOrderId &&
    current.billId === minted.billId &&
    current.fenceSeq === minted.fenceSeq &&
    current.fenceNonce === minted.fenceNonce
  );
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
 * Consumer of ProvenEvidenceAbsence or ProvenEvidencePresence. Proof authenticity
 * and authorization authenticity both run at function top level before transactCart
 * / any cart DB open or work. Presence release terminalizes the same way as
 * absence: resumeAttempts 0→1, held true→false, fenceSeq/nonce preserved, no
 * pointer mint, no ENTRY mutation. Cross-outcome forgery is refused by WeakSet.
 *
 * Row30 must preserve: authorization authenticity, proof authenticity,
 * branch/device, generationId/generationSeq, storeEpochId, asyncOrderId/billId,
 * schema/marker, held, fenceSeq/fenceNonce, and resumeAttempts. Row30 must
 * rerun the Row28 lifetime suite. This island has no cart-key reset owner;
 * TERMINAL is permanent for the key (D-1 / integration lifecycle).
 */
export async function releaseSaleSubmissionResumeFence(
  authorization: AcquiredResumeFenceAuthorization,
  request:
    | { outcome: 'evidence_proven_absent'; proof: ProvenEvidenceAbsence }
    | { outcome: 'evidence_present'; proof: ProvenEvidencePresence },
): Promise<ReleaseSaleSubmissionResumeFenceResult> {
  const proof = request.proof;
  if (request.outcome === 'evidence_proven_absent') {
    if (!isAuthenticProvenEvidenceAbsence(proof)) {
      return { ok: false };
    }
  } else {
    if (!isAuthenticProvenEvidencePresence(proof)) {
      return { ok: false };
    }
  }
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }

  const authSnapshot = copyAuthorizationFields(authorization);
  const proofSnapshot = copyProofFields(proof);
  const key = cartKey(authSnapshot.branchId, authSnapshot.deviceId);

  try {
    await transactCart('readwrite', async (txn) => {
      const record = await txn.get<ActiveCartSnapshotRecord>(CART_STORE, key);
      if (record === undefined || record.schemaVersion !== 1) {
        throw new Error('release_refused');
      }
      if (
        authSnapshot.generationId !== record.generationId ||
        authSnapshot.generationSeq !== record.generationSeq ||
        authSnapshot.storeEpochId !== record.storeEpochId ||
        proofSnapshot.generationId !== record.generationId ||
        proofSnapshot.generationSeq !== record.generationSeq ||
        proofSnapshot.storeEpochId !== record.storeEpochId
      ) {
        throw new Error('release_refused');
      }
      if (
        authSnapshot.asyncOrderId !== record.asyncOrderId ||
        authSnapshot.billId !== record.billId ||
        proofSnapshot.asyncOrderId !== record.asyncOrderId ||
        proofSnapshot.billId !== record.billId ||
        proofSnapshot.branchId !== record.branchId ||
        proofSnapshot.deviceId !== record.deviceId
      ) {
        throw new Error('release_refused');
      }
      if (record.resumeFence.held !== true) throw new Error('release_refused');
      if (
        proofSnapshot.barrierFenceSeq !== record.resumeFence.fenceSeq ||
        proofSnapshot.barrierFenceNonce !== record.resumeFence.fenceNonce ||
        authSnapshot.fenceSeq !== record.resumeFence.fenceSeq ||
        authSnapshot.fenceNonce !== record.resumeFence.fenceNonce
      ) {
        throw new Error('release_refused');
      }
      if (record.marker !== 'S2') throw new Error('release_refused');
      if (!isInteger(record.resumeAttempts) || record.resumeAttempts !== 0) {
        throw new Error('release_refused');
      }

      const next: ActiveCartSnapshotRecord = {
        ...record,
        resumeFence: { ...record.resumeFence, held: false },
        resumeAttempts: 1,
      };
      await txn.put(CART_STORE, key, next);
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
