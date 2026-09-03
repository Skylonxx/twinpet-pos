/**
 * SEC-001 Packet C-A — global OAC revocation epoch.
 *
 * A single monotonically-increasing counter. Every newly-issued OAC stamps
 * the epoch that was current at issuance (`revocationEpoch` on
 * `OfflineAuthorizationCapabilityV1`); every OKS1 keyset manifest carries the
 * *current* epoch. A device that has cached a manifest with a higher epoch
 * than an OAC's stamped epoch must treat that OAC as revoked — entirely
 * offline, with no per-OAC revocation list to distribute. Bumping the epoch
 * (an emergency-revoke primitive) instantly invalidates every OAC issued
 * before the bump, once the device syncs a fresher manifest.
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export const REVOCATION_STATE_COLLECTION = 'privilegedRevocationState';
export const REVOCATION_STATE_DOC_ID = 'current';

/** Virgin state (doc never written) is epoch 0 — nothing has ever been revoked. */
export const VIRGIN_REVOCATION_EPOCH = 0;

export interface RevocationStateRecord {
  revocationEpoch: number;
  updatedAtServerMs: number;
  updatedBy: string;
  reason: string | null;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function parseRevocationState(data: unknown): RevocationStateRecord | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (!isNonNegativeInt(raw.revocationEpoch)) return null;
  if (!isNonNegativeInt(raw.updatedAtServerMs)) return null;
  if (typeof raw.updatedBy !== 'string') return null;
  if (!(raw.reason === null || typeof raw.reason === 'string')) return null;
  return {
    revocationEpoch: raw.revocationEpoch,
    updatedAtServerMs: raw.updatedAtServerMs,
    updatedBy: raw.updatedBy,
    reason: raw.reason,
  };
}

function revocationStateRef(db: Firestore) {
  return db.collection(REVOCATION_STATE_COLLECTION).doc(REVOCATION_STATE_DOC_ID);
}

/** Reads the current global revocation epoch. Virgin (doc missing) reads as 0, not an error. */
export async function readRevocationEpoch(db: Firestore, tx?: Transaction): Promise<number> {
  const ref = revocationStateRef(db);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return VIRGIN_REVOCATION_EPOCH;
  const parsed = parseRevocationState(snap.data());
  return parsed ? parsed.revocationEpoch : VIRGIN_REVOCATION_EPOCH;
}

/** Pure core: compute the next epoch write given the currently-read epoch. */
export function buildBumpedRevocationState(
  currentEpoch: number,
  nowMs: number,
  updatedBy: string,
  reason: string | null,
): RevocationStateRecord {
  if (!updatedBy.trim()) throw new Error('updatedBy is required (audit trail)');
  return { revocationEpoch: currentEpoch + 1, updatedAtServerMs: nowMs, updatedBy, reason };
}

/** Transactionally bumps the global revocation epoch by exactly 1. Returns the new epoch. */
export async function bumpRevocationEpoch(
  db: Firestore,
  tx: Transaction,
  updatedBy: string,
  reason: string | null,
): Promise<number> {
  const currentEpoch = await readRevocationEpoch(db, tx);
  const next = buildBumpedRevocationState(currentEpoch, Date.now(), updatedBy, reason);
  tx.set(revocationStateRef(db), { ...next, updatedAt: FieldValue.serverTimestamp() });
  return next.revocationEpoch;
}
