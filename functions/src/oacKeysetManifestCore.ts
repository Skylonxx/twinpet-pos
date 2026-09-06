/**
 * SEC-001 Packet C-A — pure assembly of the OKS1 keyset manifest served by
 * `getOacKeysetManifest`. No Firestore/network — callers pass in already-
 * loaded signing-key material (see `signingKeyLoader.ts`).
 */

import type { KeyObject } from 'node:crypto';
import { signOacKeysetManifest } from './oacSigner';
import type { OacKeysetManifestFrameV1, OacKeyLifecycleStatus } from './oacFrame';
import { isCanonicalIdentifier } from './staffSessionAssertionFrame';

export interface VerifiableSigningKeyInput {
  signingKeyId: string;
  publicKeyBase64Url: string;
  status: OacKeyLifecycleStatus;
  verifyUntilServerMs?: number;
}

export type BuildKeysetManifestFailureCode =
  | 'no_verifiable_keys'
  | 'active_key_not_in_verifiable_set'
  | 'invalid_key_identifier'
  | 'duplicate_signing_key_id'
  | 'invalid_key_status'
  | 'invalid_key_expiry';

export type BuildKeysetManifestResult =
  | { ok: true; manifest: OacKeysetManifestFrameV1 }
  | { ok: false; code: BuildKeysetManifestFailureCode };

/**
 * Builds and root-signs the OKS1 manifest.
 */
export function buildOacKeysetManifest(
  verifiableKeys: readonly VerifiableSigningKeyInput[],
  revocationEpoch: number,
  nowMs: number,
  activeSigningKeyId: string,
  signingPrivateKey: KeyObject,
): BuildKeysetManifestResult {
  if (verifiableKeys.length === 0) return { ok: false, code: 'no_verifiable_keys' };

  const seen = new Set<string>();
  for (const k of verifiableKeys) {
    if (!isCanonicalIdentifier(k.signingKeyId)) return { ok: false, code: 'invalid_key_identifier' };
    if (seen.has(k.signingKeyId)) return { ok: false, code: 'duplicate_signing_key_id' };
    seen.add(k.signingKeyId);

    if (k.status === 'VERIFY_ONLY') {
      if (
        typeof k.verifyUntilServerMs !== 'number' ||
        !Number.isFinite(k.verifyUntilServerMs) ||
        !Number.isSafeInteger(k.verifyUntilServerMs) ||
        k.verifyUntilServerMs <= 0
      ) {
        return { ok: false, code: 'invalid_key_expiry' };
      }
    } else if (k.status === 'ACTIVE' || k.status === 'RETIRED') {
      if (k.verifyUntilServerMs !== undefined) {
        return { ok: false, code: 'invalid_key_expiry' };
      }
    } else {
      return { ok: false, code: 'invalid_key_status' };
    }
  }

  // Exact match without fallback or decoration
  if (!verifiableKeys.some((k) => k.signingKeyId === activeSigningKeyId && k.status === 'ACTIVE')) {
    return { ok: false, code: 'active_key_not_in_verifiable_set' };
  }

  const manifest = signOacKeysetManifest(
    {
      revocationEpoch,
      generatedAtServerMs: nowMs,
      keys: verifiableKeys.map((k) => ({
        signingKeyId: k.signingKeyId,
        publicKey: Buffer.from(k.publicKeyBase64Url, 'base64url'),
        status: k.status,
        ...(k.verifyUntilServerMs !== undefined ? { verifyUntilServerMs: k.verifyUntilServerMs } : {}),
      })),
    },
    signingPrivateKey,
  );
  return { ok: true, manifest };
}
