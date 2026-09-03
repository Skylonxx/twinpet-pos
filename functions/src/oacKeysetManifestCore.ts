/**
 * SEC-001 Packet C-A — pure assembly of the OKS1 keyset manifest served by
 * `getOacKeysetManifest`. No Firestore/network — callers pass in already-
 * loaded signing-key material (see `signingKeyLoader.ts`).
 */

import type { KeyObject } from 'node:crypto';
import { signOacKeysetManifest } from './oacSigner';
import type { OacKeysetManifestFrameV1 } from './oacFrame';

export interface VerifiableSigningKeyInput {
  signingKeyId: string;
  publicKeyBase64Url: string;
}

export type BuildKeysetManifestFailureCode = 'no_verifiable_keys' | 'active_key_not_in_verifiable_set';

export type BuildKeysetManifestResult =
  | { ok: true; manifest: OacKeysetManifestFrameV1 }
  | { ok: false; code: BuildKeysetManifestFailureCode };

/**
 * Builds and self-signs the OKS1 manifest. The manifest is signed with the
 * currently *active* signing key (which must be one of the verifiable keys
 * being listed) — a lightweight at-rest integrity check for the cached copy;
 * authenticity in transit is already provided by the authenticated
 * Functions-callable/TLS channel that delivers it.
 */
export function buildOacKeysetManifest(
  verifiableKeys: readonly VerifiableSigningKeyInput[],
  revocationEpoch: number,
  nowMs: number,
  activeSigningKeyId: string,
  activePrivateKey: KeyObject,
): BuildKeysetManifestResult {
  if (verifiableKeys.length === 0) return { ok: false, code: 'no_verifiable_keys' };
  if (!verifiableKeys.some((k) => k.signingKeyId === activeSigningKeyId)) {
    return { ok: false, code: 'active_key_not_in_verifiable_set' };
  }
  const manifest = signOacKeysetManifest(
    {
      revocationEpoch,
      generatedAtServerMs: nowMs,
      keys: verifiableKeys.map((k) => ({
        signingKeyId: k.signingKeyId,
        publicKey: Buffer.from(k.publicKeyBase64Url, 'base64url'),
      })),
    },
    activePrivateKey,
  );
  return { ok: true, manifest };
}
