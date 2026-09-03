/**
 * SEC-001 Packet C-A — verifies an issuer-signed request frame against
 * `privilegedIssuerRegistrations/{issuerId}`. Consumed by any callable that
 * accepts a request originating from a specific, registered Admin Issuance
 * Console instance (registerIssuer's possession proof, device-enrollment
 * authorization issuance). No shared secret is ever involved — only the
 * issuer's own registered Ed25519 public key.
 */

import type { Firestore } from 'firebase-admin/firestore';
import { publicKeyFromRaw } from './signingKeyLoader';
import { recordIssuerRequestOnce } from './issuerRequestChallenge';
import { verify as ed25519Verify } from 'node:crypto';

export const ISSUER_REGISTRATIONS_COLLECTION = 'privilegedIssuerRegistrations';

export interface IssuerRegistrationRecord {
  issuerId: string;
  publicKeyBase64Url: string;
  active: boolean;
  revoked: boolean;
  credentialVersion: number;
}

export type IssuerSignatureFailureCode =
  | 'issuer_not_registered'
  | 'issuer_inactive'
  | 'issuer_revoked'
  | 'credential_version_mismatch'
  | 'bad_signature'
  | 'replayed_request'
  | 'invalid_request_id';

export type VerifyIssuerRequestResult =
  | { ok: true; issuer: IssuerRegistrationRecord }
  | { ok: false; code: IssuerSignatureFailureCode };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseIssuerRegistration(data: unknown): IssuerRegistrationRecord | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.issuerId) ||
    !isNonEmptyString(raw.publicKeyBase64Url) ||
    typeof raw.active !== 'boolean' ||
    typeof raw.revoked !== 'boolean' ||
    typeof raw.credentialVersion !== 'number'
  ) {
    return null;
  }
  return {
    issuerId: raw.issuerId,
    publicKeyBase64Url: raw.publicKeyBase64Url,
    active: raw.active,
    revoked: raw.revoked,
    credentialVersion: raw.credentialVersion,
  };
}

export interface IssuerRegistrationReader {
  (issuerId: string): Promise<unknown>;
}

export function firestoreIssuerRegistrationReader(db: Firestore): IssuerRegistrationReader {
  return async (issuerId: string) => {
    const snap = await db.collection(ISSUER_REGISTRATIONS_COLLECTION).doc(issuerId).get();
    return snap.exists ? snap.data() : undefined;
  };
}

export interface VerifyIssuerSignedRequestParams {
  issuerId: string;
  requestId: string;
  purpose: string;
  payload: Buffer;
  signature: Buffer;
  expectedCredentialVersion?: number;
  nowMs: number;
}

export async function verifyIssuerSignedRequest(
  database: Firestore,
  params: VerifyIssuerSignedRequestParams,
  readIssuer: IssuerRegistrationReader = firestoreIssuerRegistrationReader(database),
): Promise<VerifyIssuerRequestResult> {
  const raw = await readIssuer(params.issuerId);
  const issuer = parseIssuerRegistration(raw);
  if (!issuer) return { ok: false, code: 'issuer_not_registered' };
  if (issuer.revoked) return { ok: false, code: 'issuer_revoked' };
  if (!issuer.active) return { ok: false, code: 'issuer_inactive' };
  if (
    params.expectedCredentialVersion != null &&
    issuer.credentialVersion !== params.expectedCredentialVersion
  ) {
    return { ok: false, code: 'credential_version_mismatch' };
  }

  let signatureValid: boolean;
  try {
    const publicKey = publicKeyFromRaw(issuer.publicKeyBase64Url);
    signatureValid = params.signature.length === 64 && ed25519Verify(null, params.payload, publicKey, params.signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, code: 'bad_signature' };

  const replayOutcome = await recordIssuerRequestOnce(database, params.purpose, params.requestId, params.nowMs);
  if (replayOutcome === 'invalid_request_id') return { ok: false, code: 'invalid_request_id' };
  if (replayOutcome === 'replayed') return { ok: false, code: 'replayed_request' };

  return { ok: true, issuer };
}
