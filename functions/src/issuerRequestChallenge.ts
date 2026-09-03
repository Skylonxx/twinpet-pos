/**
 * SEC-001 Packet C-A — server-side replay record for issuer-signed requests.
 *
 * Per the frozen issuer-trust decision: "a replay-resistant issuer-signed
 * request frame; server verifies issuer registration active, exact issuer
 * public key, credentialVersion/revoked state, Admin identity, and a
 * nonce/requestId replay record." The `requestId` itself is generated
 * CLIENT-side by the Admin Issuance Console (`admin-issuance-console/src/lib/requestId.ts`)
 * and carried inside the signed payload; this module is the server-owned
 * "has this requestId been seen before" record — an internal helper consumed
 * by `registerIssuer`/`beginDeviceEnrollmentAuthorizationIssuance`/etc via
 * `issuerSignatureAuth.ts`, not a callable export of its own (not in the
 * frozen 11-export inventory).
 */

import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export const ISSUER_REQUEST_REPLAY_COLLECTION = 'privilegedIssuerRequestReplayRecords';
export const REQUEST_ID_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — requestId must embed a fresh enough timestamp

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidRequestId(requestId: unknown): requestId is string {
  return typeof requestId === 'string' && REQUEST_ID_RE.test(requestId);
}

export type RequestReplayOutcome = 'accepted' | 'replayed' | 'invalid_request_id';

function replayRecordRef(db: Firestore, purpose: string, requestId: string) {
  return db.collection(ISSUER_REQUEST_REPLAY_COLLECTION).doc(`${purpose}:${requestId}`);
}

/**
 * Atomically records a `requestId` for `purpose` iff it has never been seen
 * before. `create()` inside a transaction fails the whole transaction if the
 * doc already exists, which Firestore surfaces as a thrown error — caught
 * here and turned into `'replayed'` rather than propagating.
 */
export async function recordIssuerRequestOnce(
  database: Firestore,
  purpose: string,
  requestId: string,
  nowMs: number,
): Promise<RequestReplayOutcome> {
  if (!isValidRequestId(requestId)) return 'invalid_request_id';
  const ref = replayRecordRef(database, purpose, requestId);
  try {
    await database.runTransaction(async (tx: Transaction) => {
      const snap = await tx.get(ref);
      if (snap.exists) throw new Error('replayed');
      tx.create(ref, { purpose, requestId, observedAtServerMs: nowMs, observedAt: FieldValue.serverTimestamp() });
    });
    return 'accepted';
  } catch {
    return 'replayed';
  }
}
