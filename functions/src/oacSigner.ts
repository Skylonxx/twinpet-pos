/**
 * SEC-001 Packet C-A — Ed25519 signing/verification for
 * `OfflineAuthorizationCapabilityV1` envelopes and the OKS1 keyset manifest.
 * Keys come from `signingKeyLoader.ts`. Pure crypto only — no Firestore.
 */

import { sign as ed25519Sign, verify as ed25519Verify, type KeyObject } from 'node:crypto';
import { canonicalJSON } from './credentialStore';
import type { OfflineAuthorizationCapabilityV1 } from './privilegedActionRegistry';
import { oks1SignedPrefix, type OacKeysetManifestFrameV1 } from './oacFrame';

export type UnsignedOacEnvelopeV1 = Omit<OfflineAuthorizationCapabilityV1, 'signature' | 'signingKeyId'>;

/** Canonical bytes an OAC envelope's signature is computed over (everything except the signature itself). */
export function oacEnvelopeSignedPayload(envelope: UnsignedOacEnvelopeV1 & { signingKeyId: string }): Buffer {
  return Buffer.from(canonicalJSON(envelope), 'utf8');
}

export function signOacEnvelope(
  envelope: UnsignedOacEnvelopeV1,
  signingKeyId: string,
  privateKey: KeyObject,
): OfflineAuthorizationCapabilityV1 {
  const withKeyId = { ...envelope, signingKeyId };
  const payload = oacEnvelopeSignedPayload(withKeyId);
  const signature = ed25519Sign(null, payload, privateKey).toString('base64');
  return { ...withKeyId, signature };
}

export function verifyOacEnvelopeSignature(
  envelope: OfflineAuthorizationCapabilityV1,
  publicKey: KeyObject,
): boolean {
  const { signature, ...rest } = envelope;
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  if (signatureBytes.length !== 64) return false;
  const payload = oacEnvelopeSignedPayload(rest);
  try {
    return ed25519Verify(null, payload, publicKey, signatureBytes);
  } catch {
    return false;
  }
}

export function signOacKeysetManifest(
  frame: Omit<OacKeysetManifestFrameV1, 'signature'>,
  privateKey: KeyObject,
): OacKeysetManifestFrameV1 {
  const payload = oks1SignedPrefix(frame);
  const signature = ed25519Sign(null, payload, privateKey);
  return { ...frame, signature };
}

export function verifyOacKeysetManifestSignature(
  frame: OacKeysetManifestFrameV1,
  publicKey: KeyObject,
): boolean {
  if (frame.signature.length !== 64) return false;
  try {
    const payload = oks1SignedPrefix(frame);
    return ed25519Verify(null, payload, publicKey, frame.signature);
  } catch {
    return false;
  }
}
