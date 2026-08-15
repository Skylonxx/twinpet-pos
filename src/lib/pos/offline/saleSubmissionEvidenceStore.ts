/**
 * Sole raw owner of the sale-submission evidence IndexedDB.
 * Runtime authenticity for ProvenEvidenceAbsence is a module-private WeakSet
 * of exact object identities. There is no exported registry, mint, or add seam.
 * The producer gates on the cart store's non-minting authorization predicate
 * before any evidence-DB work. Cycle invariants C-1..C-4: only hoisted function
 * declarations cross the cycle; no peer call during evaluation; no
 * peer-dependent top-level initializer; exactly two production runtime edges.
 */
import type {
  AbsenceSealAuthorityV1,
  AcquiredResumeFenceAuthorization,
  CommitSaleSubmissionAbsenceSealResult,
  ProvenEvidenceAbsence,
} from './saleSubmissionEvidenceTypes';
import { isAuthenticAcquiredResumeFenceAuthorization } from './activeCartSnapshotStore';

const authenticProvenEvidenceAbsences = new WeakSet<object>();

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

interface EvidenceTxn {
  get<T>(store: EvidenceStoreName, key: string): Promise<T | undefined>;
  add(store: EvidenceStoreName, key: string, value: unknown): Promise<void>;
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
  authorization: AcquiredResumeFenceAuthorization,
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
  if (stored.branchId !== authorization.branchId) return false;
  if (stored.deviceId !== authorization.deviceId) return false;
  if (stored.generationId !== authorization.generationId) return false;
  if (stored.generationSeq !== authorization.generationSeq) return false;
  if (stored.storeEpochId !== authorization.storeEpochId) return false;
  if (stored.asyncOrderId !== authorization.asyncOrderId) return false;
  if (stored.billId !== authorization.billId) return false;
  if (stored.barrierFenceSeq !== authorization.fenceSeq) return false;
  if (stored.barrierFenceNonce !== authorization.fenceNonce) return false;
  return true;
}

async function runAuthorizedSealTransaction(
  authorization: AcquiredResumeFenceAuthorization,
): Promise<ProofFields> {
  return transactEvidence('readwrite', async (txn) => {
    const generationKey = canonicalGenerationKey(
      authorization.branchId,
      authorization.deviceId,
      authorization.generationId,
    );
    if (!isWellFormedFence(authorization.fenceSeq, authorization.fenceNonce)) {
      throw new Error('seal_refused');
    }

    const pointer = await txn.get<AbsenceSealAuthorityV1 | { kind: string }>(
      POINTER_STORE,
      generationKey,
    );
    const entry = await txn.get<unknown>(ENTRY_STORE, authorization.asyncOrderId);
    if (entry !== undefined) {
      throw new Error('seal_refused');
    }
    if (pointer === undefined) {
      const seal: AbsenceSealAuthorityV1 = {
        kind: 'absence_seal',
        schemaVersion: 1,
        generationKey,
        storeEpochId: authorization.storeEpochId,
        generationId: authorization.generationId,
        generationSeq: authorization.generationSeq,
        asyncOrderId: authorization.asyncOrderId,
        billId: authorization.billId,
        branchId: authorization.branchId,
        deviceId: authorization.deviceId,
        createdAtLocal: Date.now(),
        barrierFenceSeq: authorization.fenceSeq,
        barrierFenceNonce: authorization.fenceNonce,
      };
      await txn.add(POINTER_STORE, generationKey, seal);

      return {
        kind: 'evidence_proven_absent',
        branchId: authorization.branchId,
        deviceId: authorization.deviceId,
        generationId: authorization.generationId,
        generationSeq: authorization.generationSeq,
        storeEpochId: authorization.storeEpochId,
        asyncOrderId: authorization.asyncOrderId,
        billId: authorization.billId,
        barrierFenceSeq: authorization.fenceSeq,
        barrierFenceNonce: authorization.fenceNonce,
      };
    }
    if (!isExactAbsenceSealPointer(pointer, authorization, generationKey)) {
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

  let fields: ProofFields;
  try {
    fields = await runAuthorizedSealTransaction(authorization);
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
  return { ok: true, proof: proof as ProvenEvidenceAbsence };
}

export function isAuthenticProvenEvidenceAbsence(
  value: unknown,
): value is ProvenEvidenceAbsence {
  if (value === null || typeof value !== 'object') return false;
  return authenticProvenEvidenceAbsences.has(value);
}
