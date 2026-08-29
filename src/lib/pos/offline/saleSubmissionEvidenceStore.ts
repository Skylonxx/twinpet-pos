/**
 * Sole raw owner of the sale-submission evidence IndexedDB.
 * Runtime authenticity for ProvenEvidenceAbsence and ProvenEvidencePresence is
 * a module-private WeakSet of exact object identities plus presentation-time
 * 10-field mint integrity over ordinary own data properties, including kind.
 * There is no exported registry, mint, or add seam. ENTRY_STORE presence is
 * local durable submission intent only. It does not mean a remote submit
 * issued, queued, acked, settled, or reconciled.
 *
 * AI2_ABSENCE_SOUNDNESS_SCOPE: SINGLE_TAB_PER_CART_KEY
 * AI2_ABSENCE_SOUNDNESS_FAILURE_PATH_CARVEOUT:
 * ENTRY_WRITE_FAILED_AFTER_FENCE_ACQUISITION_AND_CHECKOUT_PROCEEDED The producer gates on the cart store's
 * authorization predicate before any evidence-DB work, then consumes only a
 * synchronous named-field authorization snapshot. Cycle invariants C-1..C-4:
 * only hoisted function declarations cross the cycle; no peer call during
 * evaluation; no peer-dependent top-level initializer; exactly two production
 * runtime edges.
 */
import type {
  AbsenceSealAuthorityV1,
  AcquiredResumeFenceAuthorization,
  CommitSaleSubmissionAbsenceSealResult,
  CommitSaleSubmissionEvidenceEntryResult,
  ProveSaleSubmissionEvidencePresenceResult,
  ProvenEvidenceAbsence,
  ProvenEvidencePresence,
  SaleSubmissionEvidenceEntryV1,
} from './saleSubmissionEvidenceTypes';
import { isAuthenticAcquiredResumeFenceAuthorization } from './activeCartSnapshotStore';
import {
  getCommittedDurableStore,
  nativeTxnGet,
  nativeTxnGetAllKeys,
  nativeTxnPut,
  registerDomainDumper,
} from '../../platform/durableStore/bootDurableStore';

const authenticProvenEvidenceAbsences = new WeakSet<object>();
const provenEvidenceAbsenceMints = new WeakMap<object, ProofFields>();
const authenticProvenEvidencePresences = new WeakSet<object>();
const provenEvidencePresenceMints = new WeakMap<object, PresenceProofFields>();

const EVIDENCE_DB_NAME = 'twinpet-sale-submission-evidence';
const EVIDENCE_DB_VERSION = 1;
const POINTER_STORE = 'saleEvidenceGenerationPointers';
const ENTRY_STORE = 'saleSubmissionEvidence';
const EVIDENCE_STORES = [POINTER_STORE, ENTRY_STORE] as const;
type EvidenceStoreName = (typeof EVIDENCE_STORES)[number];

type ProofFields = {
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
};

type PresenceProofFields = {
  kind: 'evidence_present';
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

type AuthorizationFieldSnapshot = {
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

interface EvidenceTxn {
  get<T>(store: EvidenceStoreName, key: string): Promise<T | undefined>;
  add(store: EvidenceStoreName, key: string, value: unknown): Promise<void>;
  getAllKeys(store: EvidenceStoreName): Promise<string[]>;
}

function isOwnDataProperty(value: object, field: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined && 'value' in descriptor;
}

function copyAuthorizationFields(source: AuthorizationFieldSnapshot): AuthorizationFieldSnapshot {
  const snapshot: AuthorizationFieldSnapshot = {
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

function copyProofFields(source: ProofFields): ProofFields {
  const snapshot: ProofFields = {
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

function copyPresenceProofFields(source: PresenceProofFields): PresenceProofFields {
  const snapshot: PresenceProofFields = {
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

function canonicalGenerationKey(branchId: string, deviceId: string, generationId: string): string {
  return [branchId, deviceId, generationId].map((p) => `${p.length}:${p}`).join('|');
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function openEvidenceDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const req = indexedDB.open(EVIDENCE_DB_NAME, EVIDENCE_DB_VERSION);
      req.onupgradeneeded = () => {
        const dbi = req.result;
        for (const s of EVIDENCE_STORES) {
          if (!dbi.objectStoreNames.contains(s)) dbi.createObjectStore(s);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function transactEvidence<T>(
  mode: 'readonly' | 'readwrite',
  fn: (txn: EvidenceTxn) => Promise<T>,
): Promise<T> {
  const native = getCommittedDurableStore('twinpet-sale-submission-evidence');
  if (native) {
    return native.transact([...EVIDENCE_STORES], mode, (txn) =>
      fn({
        get: (store, key) => nativeTxnGet(txn, store, key),
        add: async (store, key, value) => {
          const existing = await nativeTxnGet(txn, store, key);
          if (existing !== undefined) throw new Error('Key already exists in the object store.');
          await nativeTxnPut(txn, store, key, value);
        },
        getAllKeys: (store) =>
          nativeTxnGetAllKeys(txn, store).then((keys) =>
            keys.map((key) => {
              if (typeof key !== 'string') throw new Error('evidence native key must be a string');
              return key;
            }),
          ),
      }),
    );
  }
  return openEvidenceDb().then(
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
          tx = dbi.transaction([...EVIDENCE_STORES], mode);
        } catch (err) {
          fail(err);
          return;
        }

        const txn: EvidenceTxn = {
          get: (store, key) => reqP(tx.objectStore(store).get(key)),
          add: (store, key, value) =>
            reqP(tx.objectStore(store).add(value, key)).then(() => undefined),
          getAllKeys: (store) =>
            reqP(tx.objectStore(store).getAllKeys()).then((keys) =>
              keys.map((key) => {
                if (typeof key !== 'string') {
                  throw new Error(`evidence store "${store}" returned a non-string key`);
                }
                return key;
              }),
            ),
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

function isWellFormedFence(seq: number, nonce: string): boolean {
  return Number.isInteger(seq) && seq > 0 && typeof nonce === 'string' && nonce.length > 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isExactAbsenceSealPointer(
  pointer: unknown,
  authSnapshot: AuthorizationFieldSnapshot,
  generationKey: string,
): pointer is AbsenceSealAuthorityV1 {
  if (pointer === null || typeof pointer !== 'object') return false;
  const stored = pointer as Record<string, unknown>;
  if (stored.kind !== 'absence_seal') return false;
  if (stored.schemaVersion !== 1) return false;
  if (stored.generationKey !== generationKey) return false;
  if (typeof stored.createdAtLocal !== 'number' || !Number.isFinite(stored.createdAtLocal)) {
    return false;
  }
  if (!isNonemptyString(stored.branchId)) return false;
  if (!isNonemptyString(stored.deviceId)) return false;
  if (!isNonemptyString(stored.generationId)) return false;
  if (!isInteger(stored.generationSeq)) return false;
  if (!isNonemptyString(stored.storeEpochId)) return false;
  if (!isNonemptyString(stored.asyncOrderId)) return false;
  if (!isNonemptyString(stored.billId)) return false;
  if (!isInteger(stored.barrierFenceSeq) || stored.barrierFenceSeq <= 0) return false;
  if (!isNonemptyString(stored.barrierFenceNonce)) return false;
  if (stored.branchId !== authSnapshot.branchId) return false;
  if (stored.deviceId !== authSnapshot.deviceId) return false;
  if (stored.generationId !== authSnapshot.generationId) return false;
  if (stored.generationSeq !== authSnapshot.generationSeq) return false;
  if (stored.storeEpochId !== authSnapshot.storeEpochId) return false;
  if (stored.asyncOrderId !== authSnapshot.asyncOrderId) return false;
  if (stored.billId !== authSnapshot.billId) return false;
  if (stored.barrierFenceSeq !== authSnapshot.fenceSeq) return false;
  if (stored.barrierFenceNonce !== authSnapshot.fenceNonce) return false;
  return true;
}

function isExactSaleSubmissionEvidenceEntry(
  entry: unknown,
  authSnapshot: AuthorizationFieldSnapshot,
): entry is SaleSubmissionEvidenceEntryV1 {
  if (entry === null || typeof entry !== 'object') return false;
  const stored = entry as Record<string, unknown>;
  if (stored.kind !== 'submission_evidence') return false;
  if (stored.schemaVersion !== 1) return false;
  if (stored.entryKey !== authSnapshot.asyncOrderId) return false;
  if (typeof stored.createdAtLocal !== 'number' || !Number.isFinite(stored.createdAtLocal)) {
    return false;
  }
  if (!isNonemptyString(stored.branchId)) return false;
  if (!isNonemptyString(stored.deviceId)) return false;
  if (!isNonemptyString(stored.generationId)) return false;
  if (!isInteger(stored.generationSeq)) return false;
  if (!isNonemptyString(stored.storeEpochId)) return false;
  if (!isNonemptyString(stored.asyncOrderId)) return false;
  if (!isNonemptyString(stored.billId)) return false;
  if (!isInteger(stored.barrierFenceSeq) || stored.barrierFenceSeq <= 0) return false;
  if (!isNonemptyString(stored.barrierFenceNonce)) return false;
  if (stored.branchId !== authSnapshot.branchId) return false;
  if (stored.deviceId !== authSnapshot.deviceId) return false;
  if (stored.generationId !== authSnapshot.generationId) return false;
  if (stored.generationSeq !== authSnapshot.generationSeq) return false;
  if (stored.storeEpochId !== authSnapshot.storeEpochId) return false;
  if (stored.asyncOrderId !== authSnapshot.asyncOrderId) return false;
  if (stored.billId !== authSnapshot.billId) return false;
  if (stored.barrierFenceSeq !== authSnapshot.fenceSeq) return false;
  if (stored.barrierFenceNonce !== authSnapshot.fenceNonce) return false;
  return true;
}

function presenceFieldsFromStored(stored: SaleSubmissionEvidenceEntryV1): PresenceProofFields {
  return {
    kind: 'evidence_present',
    branchId: stored.branchId,
    deviceId: stored.deviceId,
    generationId: stored.generationId,
    generationSeq: stored.generationSeq,
    storeEpochId: stored.storeEpochId,
    asyncOrderId: stored.asyncOrderId,
    billId: stored.billId,
    barrierFenceSeq: stored.barrierFenceSeq,
    barrierFenceNonce: stored.barrierFenceNonce,
  };
}

function presenceFieldsFromAuth(authSnapshot: AuthorizationFieldSnapshot): PresenceProofFields {
  return {
    kind: 'evidence_present',
    branchId: authSnapshot.branchId,
    deviceId: authSnapshot.deviceId,
    generationId: authSnapshot.generationId,
    generationSeq: authSnapshot.generationSeq,
    storeEpochId: authSnapshot.storeEpochId,
    asyncOrderId: authSnapshot.asyncOrderId,
    billId: authSnapshot.billId,
    barrierFenceSeq: authSnapshot.fenceSeq,
    barrierFenceNonce: authSnapshot.fenceNonce,
  };
}

async function runAuthorizedSealTransaction(
  authSnapshot: AuthorizationFieldSnapshot,
): Promise<ProofFields> {
  return transactEvidence('readwrite', async (txn) => {
    const generationKey = canonicalGenerationKey(
      authSnapshot.branchId,
      authSnapshot.deviceId,
      authSnapshot.generationId,
    );
    if (!isWellFormedFence(authSnapshot.fenceSeq, authSnapshot.fenceNonce)) {
      throw new Error('seal_refused');
    }

    const pointer = await txn.get<AbsenceSealAuthorityV1 | { kind: string }>(
      POINTER_STORE,
      generationKey,
    );
    const entry = await txn.get<unknown>(ENTRY_STORE, authSnapshot.asyncOrderId);
    if (entry !== undefined) {
      throw new Error('seal_refused');
    }
    if (pointer === undefined) {
      const seal: AbsenceSealAuthorityV1 = {
        kind: 'absence_seal',
        schemaVersion: 1,
        generationKey,
        storeEpochId: authSnapshot.storeEpochId,
        generationId: authSnapshot.generationId,
        generationSeq: authSnapshot.generationSeq,
        asyncOrderId: authSnapshot.asyncOrderId,
        billId: authSnapshot.billId,
        branchId: authSnapshot.branchId,
        deviceId: authSnapshot.deviceId,
        createdAtLocal: Date.now(),
        barrierFenceSeq: authSnapshot.fenceSeq,
        barrierFenceNonce: authSnapshot.fenceNonce,
      };
      await txn.add(POINTER_STORE, generationKey, seal);

      return {
        kind: 'evidence_proven_absent',
        branchId: authSnapshot.branchId,
        deviceId: authSnapshot.deviceId,
        generationId: authSnapshot.generationId,
        generationSeq: authSnapshot.generationSeq,
        storeEpochId: authSnapshot.storeEpochId,
        asyncOrderId: authSnapshot.asyncOrderId,
        billId: authSnapshot.billId,
        barrierFenceSeq: authSnapshot.fenceSeq,
        barrierFenceNonce: authSnapshot.fenceNonce,
      };
    }
    if (!isExactAbsenceSealPointer(pointer, authSnapshot, generationKey)) {
      throw new Error('seal_refused');
    }
    // Exact-pointer zero-write re-mint. Every proof field comes from the
    // stored pointer only. No add/put/delete/clear.
    return {
      kind: 'evidence_proven_absent',
      branchId: pointer.branchId,
      deviceId: pointer.deviceId,
      generationId: pointer.generationId,
      generationSeq: pointer.generationSeq,
      storeEpochId: pointer.storeEpochId,
      asyncOrderId: pointer.asyncOrderId,
      billId: pointer.billId,
      barrierFenceSeq: pointer.barrierFenceSeq,
      barrierFenceNonce: pointer.barrierFenceNonce,
    };
  });
}

/**
 * Authorized post-seal producer. Yields an authentic proof only after the
 * seal transaction's terminal `tx.oncomplete`. Not a free mint: fields are
 * taken from the completed seal, never from a caller-supplied proof object.
 */
export async function commitSaleSubmissionAbsenceSeal(
  authorization: AcquiredResumeFenceAuthorization,
): Promise<CommitSaleSubmissionAbsenceSealResult> {
  if (authorization === null || typeof authorization !== 'object') {
    return { ok: false };
  }
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }

  const authSnapshot = copyAuthorizationFields(authorization);

  let fields: ProofFields;
  try {
    fields = await runAuthorizedSealTransaction(authSnapshot);
  } catch {
    return { ok: false };
  }

  const proof: ProofFields = {
    kind: 'evidence_proven_absent',
    branchId: fields.branchId,
    deviceId: fields.deviceId,
    generationId: fields.generationId,
    generationSeq: fields.generationSeq,
    storeEpochId: fields.storeEpochId,
    asyncOrderId: fields.asyncOrderId,
    billId: fields.billId,
    barrierFenceSeq: fields.barrierFenceSeq,
    barrierFenceNonce: fields.barrierFenceNonce,
  };
  // SOLE authorized registry membership grant point. Adjacent to construction;
  // no await/yield/escape between construct, add, and return.
  authenticProvenEvidenceAbsences.add(proof);
  provenEvidenceAbsenceMints.set(proof, copyProofFields(proof));
  return { ok: true, proof: proof as ProvenEvidenceAbsence };
}

export function isAuthenticProvenEvidenceAbsence(
  value: unknown,
): value is ProvenEvidenceAbsence {
  if (value === null || typeof value !== 'object') return false;
  if (!authenticProvenEvidenceAbsences.has(value)) return false;
  const minted = provenEvidenceAbsenceMints.get(value);
  if (minted === undefined) return false;
  if (!isOwnDataProperty(value, 'kind')) return false;
  if (!isOwnDataProperty(value, 'branchId')) return false;
  if (!isOwnDataProperty(value, 'deviceId')) return false;
  if (!isOwnDataProperty(value, 'generationId')) return false;
  if (!isOwnDataProperty(value, 'generationSeq')) return false;
  if (!isOwnDataProperty(value, 'storeEpochId')) return false;
  if (!isOwnDataProperty(value, 'asyncOrderId')) return false;
  if (!isOwnDataProperty(value, 'billId')) return false;
  if (!isOwnDataProperty(value, 'barrierFenceSeq')) return false;
  if (!isOwnDataProperty(value, 'barrierFenceNonce')) return false;
  const current = value as ProofFields;
  return (
    current.kind === minted.kind &&
    current.branchId === minted.branchId &&
    current.deviceId === minted.deviceId &&
    current.generationId === minted.generationId &&
    current.generationSeq === minted.generationSeq &&
    current.storeEpochId === minted.storeEpochId &&
    current.asyncOrderId === minted.asyncOrderId &&
    current.billId === minted.billId &&
    current.barrierFenceSeq === minted.barrierFenceSeq &&
    current.barrierFenceNonce === minted.barrierFenceNonce
  );
}

async function runAuthorizedEntryWriteTransaction(
  authSnapshot: AuthorizationFieldSnapshot,
): Promise<PresenceProofFields> {
  return transactEvidence('readwrite', async (txn) => {
    if (!isWellFormedFence(authSnapshot.fenceSeq, authSnapshot.fenceNonce)) {
      throw new Error('entry_refused');
    }
    const existing = await txn.get<unknown>(ENTRY_STORE, authSnapshot.asyncOrderId);
    if (existing !== undefined) {
      if (isExactSaleSubmissionEvidenceEntry(existing, authSnapshot)) {
        return presenceFieldsFromStored(existing);
      }
      throw new Error('entry_refused');
    }
    const entry: SaleSubmissionEvidenceEntryV1 = {
      kind: 'submission_evidence',
      schemaVersion: 1,
      entryKey: authSnapshot.asyncOrderId,
      branchId: authSnapshot.branchId,
      deviceId: authSnapshot.deviceId,
      generationId: authSnapshot.generationId,
      generationSeq: authSnapshot.generationSeq,
      storeEpochId: authSnapshot.storeEpochId,
      asyncOrderId: authSnapshot.asyncOrderId,
      billId: authSnapshot.billId,
      createdAtLocal: Date.now(),
      barrierFenceSeq: authSnapshot.fenceSeq,
      barrierFenceNonce: authSnapshot.fenceNonce,
    };
    await txn.add(ENTRY_STORE, authSnapshot.asyncOrderId, entry);
    return presenceFieldsFromAuth(authSnapshot);
  });
}

async function runAuthorizedPresenceProveTransaction(
  authSnapshot: AuthorizationFieldSnapshot,
): Promise<PresenceProofFields> {
  return transactEvidence('readonly', async (txn) => {
    if (!isWellFormedFence(authSnapshot.fenceSeq, authSnapshot.fenceNonce)) {
      throw new Error('presence_refused');
    }
    const existing = await txn.get<unknown>(ENTRY_STORE, authSnapshot.asyncOrderId);
    if (existing === undefined) {
      throw new Error('presence_refused');
    }
    if (!isExactSaleSubmissionEvidenceEntry(existing, authSnapshot)) {
      throw new Error('presence_refused');
    }
    return presenceFieldsFromStored(existing);
  });
}

function mintAuthenticPresenceProof(fields: PresenceProofFields): ProvenEvidencePresence {
  const proof: PresenceProofFields = {
    kind: 'evidence_present',
    branchId: fields.branchId,
    deviceId: fields.deviceId,
    generationId: fields.generationId,
    generationSeq: fields.generationSeq,
    storeEpochId: fields.storeEpochId,
    asyncOrderId: fields.asyncOrderId,
    billId: fields.billId,
    barrierFenceSeq: fields.barrierFenceSeq,
    barrierFenceNonce: fields.barrierFenceNonce,
  };
  authenticProvenEvidencePresences.add(proof);
  provenEvidencePresenceMints.set(proof, copyPresenceProofFields(proof));
  return proof as ProvenEvidencePresence;
}

/**
 * Sole ENTRY_STORE writer. IndexedDB `add` only — never put/delete/clear.
 * Duplicate exact entry is a zero-write remint. Mismatched/corrupt entry fails closed.
 * Presence means local durable intent only.
 */
export async function commitSaleSubmissionEvidenceEntry(
  authorization: AcquiredResumeFenceAuthorization,
): Promise<CommitSaleSubmissionEvidenceEntryResult> {
  if (authorization === null || typeof authorization !== 'object') {
    return { ok: false };
  }
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }

  const authSnapshot = copyAuthorizationFields(authorization);

  let fields: PresenceProofFields;
  try {
    fields = await runAuthorizedEntryWriteTransaction(authSnapshot);
  } catch {
    return { ok: false };
  }

  return { ok: true, proof: mintAuthenticPresenceProof(fields) };
}

/**
 * Read-only presence prover. Never creates an ENTRY row. Re-mints an authentic
 * capability from an exact stored entry after tx.oncomplete.
 */
export async function proveSaleSubmissionEvidencePresence(
  authorization: AcquiredResumeFenceAuthorization,
): Promise<ProveSaleSubmissionEvidencePresenceResult> {
  if (authorization === null || typeof authorization !== 'object') {
    return { ok: false };
  }
  if (!isAuthenticAcquiredResumeFenceAuthorization(authorization)) {
    return { ok: false };
  }

  const authSnapshot = copyAuthorizationFields(authorization);

  let fields: PresenceProofFields;
  try {
    fields = await runAuthorizedPresenceProveTransaction(authSnapshot);
  } catch {
    return { ok: false };
  }

  return { ok: true, proof: mintAuthenticPresenceProof(fields) };
}

export function isAuthenticProvenEvidencePresence(
  value: unknown,
): value is ProvenEvidencePresence {
  if (value === null || typeof value !== 'object') return false;
  if (!authenticProvenEvidencePresences.has(value)) return false;
  const minted = provenEvidencePresenceMints.get(value);
  if (minted === undefined) return false;
  if (!isOwnDataProperty(value, 'kind')) return false;
  if (!isOwnDataProperty(value, 'branchId')) return false;
  if (!isOwnDataProperty(value, 'deviceId')) return false;
  if (!isOwnDataProperty(value, 'generationId')) return false;
  if (!isOwnDataProperty(value, 'generationSeq')) return false;
  if (!isOwnDataProperty(value, 'storeEpochId')) return false;
  if (!isOwnDataProperty(value, 'asyncOrderId')) return false;
  if (!isOwnDataProperty(value, 'billId')) return false;
  if (!isOwnDataProperty(value, 'barrierFenceSeq')) return false;
  if (!isOwnDataProperty(value, 'barrierFenceNonce')) return false;
  const current = value as PresenceProofFields;
  return (
    current.kind === minted.kind &&
    current.branchId === minted.branchId &&
    current.deviceId === minted.deviceId &&
    current.generationId === minted.generationId &&
    current.generationSeq === minted.generationSeq &&
    current.storeEpochId === minted.storeEpochId &&
    current.asyncOrderId === minted.asyncOrderId &&
    current.billId === minted.billId &&
    current.barrierFenceSeq === minted.barrierFenceSeq &&
    current.barrierFenceNonce === minted.barrierFenceNonce
  );
}

registerDomainDumper('evidence', async () => {
  return transactEvidence('readonly', async (txn) => {
    const rows: Array<{ store: string; key: string; value: unknown }> = [];
    const read = txn.get.bind(txn);
    for (const store of EVIDENCE_STORES) {
      for (const key of await txn.getAllKeys(store)) {
        rows.push({ store, key, value: await read(store, key) });
      }
    }
    return rows;
  });
});
