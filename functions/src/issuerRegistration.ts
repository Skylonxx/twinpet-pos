/**
 * registerIssuer / revokeIssuerRegistration — SEC-001 Packet C-A issuer
 * trust bootstrap (`OPTION_I1_PER_INSTALL_ASYMMETRIC_ISSUER_KEYPAIR_OPS_BOOTSTRAP`).
 *
 * `registerIssuer` consumes a one-time Ops-issued bootstrap token
 * (`ops/issuerBootstrap/createIssuerBootstrapAuthorization.ts`) plus a
 * signature proving possession of the Admin Issuance Console's newly
 * generated Ed25519 private key, and registers only the resulting public
 * key under `privilegedIssuerRegistrations/{issuerId}`. No shared secret is
 * ever compiled into any client.
 */

import { verify as ed25519Verify } from 'node:crypto';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import {
  buildIssuerRegistrationDoc,
  registerIssuerPossessionProofPayload,
  validateRegisterIssuerRequest,
  verifyBootstrapToken,
  type BootstrapTokenRecord,
} from './issuerRegistrationCore';
import { publicKeyFromRaw } from './signingKeyLoader';
import { recordIssuerRequestOnce } from './issuerRequestChallenge';
import { ISSUER_REGISTRATIONS_COLLECTION } from './issuerSignatureAuth';

/** Mirrors ops/issuerBootstrap/createIssuerBootstrapAuthorization.ts — separate npm package, no shared module. */
const ISSUER_BOOTSTRAP_TOKENS_COLLECTION = 'privilegedIssuerBootstrapTokens';

export type RegisterIssuerFailureCode =
  | 'not_authorized'
  | 'invalid_request_shape'
  | 'bootstrap_token_not_found'
  | 'bootstrap_token_already_consumed'
  | 'bootstrap_token_expired'
  | 'bootstrap_token_issuer_mismatch'
  | 'bootstrap_token_hash_mismatch'
  | 'bad_possession_proof'
  | 'replayed_request'
  | 'invalid_request_id';

export type RegisterIssuerResponse = { ok: true; issuerId: string } | { ok: false; code: RegisterIssuerFailureCode };

async function isLiveAdmin(database: Firestore, uid: string): Promise<boolean> {
  const snap = await database.collection('users').doc(uid).get();
  if (!snap.exists) return false;
  const user = (snap.data() ?? {}) as DocumentData;
  return user.role === 'admin' && user.isActive === true && user.deletedAt == null;
}

function bootstrapDocFromData(data: DocumentData | undefined): BootstrapTokenRecord | null {
  if (!data) return null;
  if (
    typeof data.tokenId !== 'string' ||
    typeof data.issuerId !== 'string' ||
    typeof data.tokenHash !== 'string' ||
    typeof data.status !== 'string' ||
    typeof data.expiresAtServerMs !== 'number'
  ) {
    return null;
  }
  if (data.status !== 'PENDING' && data.status !== 'CONSUMED' && data.status !== 'EXPIRED') return null;
  return {
    tokenId: data.tokenId,
    issuerId: data.issuerId,
    tokenHash: data.tokenHash,
    status: data.status,
    expiresAtServerMs: data.expiresAtServerMs,
  };
}

export async function performRegisterIssuer(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<RegisterIssuerResponse> {
  if (!auth?.uid || auth.token?.role !== 'admin' || !(await isLiveAdmin(database, auth.uid))) {
    return { ok: false, code: 'not_authorized' };
  }

  const validated = validateRegisterIssuerRequest(requestData);
  if (!validated.ok) return { ok: false, code: validated.code };
  const req = validated.value;

  const replay = await recordIssuerRequestOnce(database, 'registerIssuer', req.requestId, nowMs);
  if (replay === 'invalid_request_id') return { ok: false, code: 'invalid_request_id' };
  if (replay === 'replayed') return { ok: false, code: 'replayed_request' };

  const bootstrapRef = database.collection(ISSUER_BOOTSTRAP_TOKENS_COLLECTION).doc(req.bootstrapTokenId);
  const bootstrapSnap = await bootstrapRef.get();
  const bootstrapDoc = bootstrapDocFromData(bootstrapSnap.exists ? bootstrapSnap.data() : undefined);
  const bootstrapCheck = verifyBootstrapToken(bootstrapDoc, req.issuerId, req.bootstrapToken, nowMs);
  if (!bootstrapCheck.ok) return { ok: false, code: bootstrapCheck.code };

  const payload = registerIssuerPossessionProofPayload(req.issuerId, req.bootstrapTokenId, req.requestId);
  let signatureValid: boolean;
  try {
    const signatureBytes = Buffer.from(req.signature, 'base64');
    signatureValid =
      signatureBytes.length === 64 &&
      ed25519Verify(null, payload, publicKeyFromRaw(req.publicKeyBase64Url), signatureBytes);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, code: 'bad_possession_proof' };

  const registrationRef = database.collection(ISSUER_REGISTRATIONS_COLLECTION).doc(req.issuerId);

  await database.runTransaction(async (tx) => {
    const priorSnap = await tx.get(registrationRef);
    const priorCredentialVersion =
      priorSnap.exists && typeof priorSnap.data()?.credentialVersion === 'number'
        ? (priorSnap.data()!.credentialVersion as number)
        : 0;
    const registration = buildIssuerRegistrationDoc(
      req.issuerId,
      req.publicKeyBase64Url,
      nowMs,
      auth.uid as string,
      priorCredentialVersion,
    );
    tx.set(registrationRef, { ...registration, createdAt: FieldValue.serverTimestamp() });
    tx.update(bootstrapRef, { status: 'CONSUMED', consumedAtServerMs: nowMs, consumedAt: FieldValue.serverTimestamp() });
  });

  return { ok: true, issuerId: req.issuerId };
}

export type RevokeIssuerFailureCode = 'not_authorized' | 'invalid_request_shape' | 'issuer_not_registered';

export type RevokeIssuerResponse = { ok: true; issuerId: string } | { ok: false; code: RevokeIssuerFailureCode };

export async function performRevokeIssuerRegistration(
  database: Firestore,
  auth: AuthLike,
  requestData: unknown,
  nowMs: number = Date.now(),
): Promise<RevokeIssuerResponse> {
  if (!auth?.uid || auth.token?.role !== 'admin' || !(await isLiveAdmin(database, auth.uid))) {
    return { ok: false, code: 'not_authorized' };
  }
  const raw = (requestData ?? {}) as { issuerId?: unknown; reason?: unknown };
  if (typeof raw.issuerId !== 'string' || !raw.issuerId.trim()) {
    return { ok: false, code: 'invalid_request_shape' };
  }
  const reason = typeof raw.reason === 'string' ? raw.reason : null;

  const ref = database.collection(ISSUER_REGISTRATIONS_COLLECTION).doc(raw.issuerId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, code: 'issuer_not_registered' };

  await ref.update({
    revoked: true,
    active: false,
    revokedAtServerMs: nowMs,
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: auth.uid,
    revokedReason: reason,
  });
  return { ok: true, issuerId: raw.issuerId };
}

export const registerIssuer = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performRegisterIssuer(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});

export const revokeIssuerRegistration = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performRevokeIssuerRegistration(db, request.auth as AuthLike, request.data);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
