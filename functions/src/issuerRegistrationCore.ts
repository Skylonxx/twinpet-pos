/**
 * SEC-001 Packet C-A — pure validation/shaping for `registerIssuer` /
 * `revokeIssuerRegistration`. No Firestore/crypto side effects here; see
 * `issuerRegistration.ts` for the wired callables.
 */

import { createHash } from 'node:crypto';
import { canonicalJSON } from './credentialStore';

export const ISSUER_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export interface RegisterIssuerRequest {
  issuerId: string;
  requestId: string;
  bootstrapTokenId: string;
  bootstrapToken: string;
  publicKeyBase64Url: string;
  signature: string;
}

export type RegisterIssuerValidationFailureCode = 'invalid_request_shape';

export type RegisterIssuerValidationResult =
  | { ok: true; value: RegisterIssuerRequest }
  | { ok: false; code: RegisterIssuerValidationFailureCode };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateRegisterIssuerRequest(input: unknown): RegisterIssuerValidationResult {
  if (input == null || typeof input !== 'object') return { ok: false, code: 'invalid_request_shape' };
  const raw = input as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.issuerId) ||
    !ISSUER_ID_RE.test(raw.issuerId) ||
    !isNonEmptyString(raw.requestId) ||
    !isNonEmptyString(raw.bootstrapTokenId) ||
    !isNonEmptyString(raw.bootstrapToken) ||
    !isNonEmptyString(raw.publicKeyBase64Url) ||
    !isNonEmptyString(raw.signature)
  ) {
    return { ok: false, code: 'invalid_request_shape' };
  }
  let publicKeyLen: number;
  try {
    publicKeyLen = Buffer.from(raw.publicKeyBase64Url, 'base64url').length;
  } catch {
    return { ok: false, code: 'invalid_request_shape' };
  }
  if (publicKeyLen !== 32) return { ok: false, code: 'invalid_request_shape' };
  return {
    ok: true,
    value: {
      issuerId: raw.issuerId,
      requestId: raw.requestId,
      bootstrapTokenId: raw.bootstrapTokenId,
      bootstrapToken: raw.bootstrapToken,
      publicKeyBase64Url: raw.publicKeyBase64Url,
      signature: raw.signature,
    },
  };
}

/** Canonical bytes the console signs (with its new issuer private key) as possession proof. */
export function registerIssuerPossessionProofPayload(
  issuerId: string,
  bootstrapTokenId: string,
  requestId: string,
): Buffer {
  return Buffer.from(canonicalJSON({ issuerId, bootstrapTokenId, requestId }), 'utf8');
}

export function sha256HexOfBase64UrlToken(bootstrapToken: string): string {
  return createHash('sha256').update(Buffer.from(bootstrapToken, 'base64url')).digest('hex');
}

export interface BootstrapTokenRecord {
  tokenId: string;
  issuerId: string;
  tokenHash: string;
  status: 'PENDING' | 'CONSUMED' | 'EXPIRED';
  expiresAtServerMs: number;
}

export type BootstrapVerifyFailureCode =
  | 'bootstrap_token_not_found'
  | 'bootstrap_token_already_consumed'
  | 'bootstrap_token_expired'
  | 'bootstrap_token_issuer_mismatch'
  | 'bootstrap_token_hash_mismatch';

export function verifyBootstrapToken(
  doc: BootstrapTokenRecord | null,
  requestIssuerId: string,
  rawToken: string,
  nowMs: number,
): { ok: true } | { ok: false; code: BootstrapVerifyFailureCode } {
  if (!doc) return { ok: false, code: 'bootstrap_token_not_found' };
  if (doc.status !== 'PENDING') return { ok: false, code: 'bootstrap_token_already_consumed' };
  if (nowMs > doc.expiresAtServerMs) return { ok: false, code: 'bootstrap_token_expired' };
  if (doc.issuerId !== requestIssuerId) return { ok: false, code: 'bootstrap_token_issuer_mismatch' };
  if (doc.tokenHash !== sha256HexOfBase64UrlToken(rawToken)) return { ok: false, code: 'bootstrap_token_hash_mismatch' };
  return { ok: true };
}

export interface IssuerRegistrationDoc {
  issuerId: string;
  publicKeyBase64Url: string;
  active: boolean;
  revoked: boolean;
  credentialVersion: number;
  createdAtServerMs: number;
  createdByOps: string;
}

export function buildIssuerRegistrationDoc(
  issuerId: string,
  publicKeyBase64Url: string,
  nowMs: number,
  createdByOps: string,
  priorCredentialVersion: number,
): IssuerRegistrationDoc {
  return {
    issuerId,
    publicKeyBase64Url,
    active: true,
    revoked: false,
    credentialVersion: priorCredentialVersion + 1,
    createdAtServerMs: nowMs,
    createdByOps,
  };
}
