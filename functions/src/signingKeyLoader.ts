/**
 * SEC-001 Packet C-A — loads the active/verifiable Ed25519 OAC-signing keys
 * written by `ops/oacKeysetRotation/rotateOacSigningKey.ts`. Collection
 * names/shapes MUST stay in sync with that script (separate npm package, no
 * shared module).
 *
 * Never caches the active signing key in memory: a just-rotated key must take
 * effect on the very next sign, not after some TTL.
 */

import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';

export const OAC_SIGNING_KEYS_COLLECTION = 'privilegedOacSigningKeys';
export const OAC_KEYSET_META_COLLECTION = 'privilegedOacKeysetMeta';
export const OAC_KEYSET_META_DOC_ID = 'current';

export type OacSigningKeyStatus = 'ACTIVE' | 'RETIRED';

export interface OacSigningKeyRecord {
  signingKeyId: string;
  publicKeyBase64Url: string;
  privateKeyBase64Url: string;
  status: OacSigningKeyStatus;
}

export interface OacKeysetMetaRecord {
  activeSigningKeyId: string;
}

export type SigningKeyLoadFailureCode =
  | 'meta_missing'
  | 'meta_malformed'
  | 'active_key_missing'
  | 'active_key_malformed'
  | 'active_key_retired';

export type SigningKeyLoadResult =
  | { ok: true; signingKeyId: string; privateKey: KeyObject; publicKeyBase64Url: string }
  | { ok: false; code: SigningKeyLoadFailureCode };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSigningKeyStatus(value: unknown): value is OacSigningKeyStatus {
  return value === 'ACTIVE' || value === 'RETIRED';
}

export function parseKeysetMeta(data: unknown): OacKeysetMetaRecord | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (!isNonEmptyString(raw.activeSigningKeyId)) return null;
  return { activeSigningKeyId: raw.activeSigningKeyId };
}

export function parseSigningKeyRecord(data: unknown): OacSigningKeyRecord | null {
  if (data == null || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (
    !isNonEmptyString(raw.signingKeyId) ||
    !isNonEmptyString(raw.publicKeyBase64Url) ||
    !isNonEmptyString(raw.privateKeyBase64Url) ||
    !isSigningKeyStatus(raw.status)
  ) {
    return null;
  }
  return {
    signingKeyId: raw.signingKeyId,
    publicKeyBase64Url: raw.publicKeyBase64Url,
    privateKeyBase64Url: raw.privateKeyBase64Url,
    status: raw.status,
  };
}

/** Raw-JWK Ed25519 private-key import — mirrors ops/oacKeysetRotation/rotateOacSigningKey.ts. */
export function privateKeyFromRaw(publicKeyBase64Url: string, privateKeyBase64Url: string): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url, d: privateKeyBase64Url },
    format: 'jwk',
  });
}

export function publicKeyFromRaw(publicKeyBase64Url: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url }, format: 'jwk' });
}

export interface SigningKeyReaders {
  readMeta: () => Promise<unknown>;
  readSigningKey: (signingKeyId: string) => Promise<unknown>;
}

export function firestoreSigningKeyReaders(db: Firestore): SigningKeyReaders {
  return {
    readMeta: async () => {
      const snap = await db.collection(OAC_KEYSET_META_COLLECTION).doc(OAC_KEYSET_META_DOC_ID).get();
      return snap.exists ? snap.data() : undefined;
    },
    readSigningKey: async (signingKeyId: string) => {
      const snap = await db.collection(OAC_SIGNING_KEYS_COLLECTION).doc(signingKeyId).get();
      return snap.exists ? snap.data() : undefined;
    },
  };
}

/** Loads the currently-active signing key for new OAC/manifest signatures. Fails closed on any malformed/missing state. */
export async function loadActiveSigningKey(readers: SigningKeyReaders): Promise<SigningKeyLoadResult> {
  const metaData = await readers.readMeta();
  const meta = parseKeysetMeta(metaData);
  if (!meta) return { ok: false, code: 'meta_missing' };

  const keyData = await readers.readSigningKey(meta.activeSigningKeyId);
  const key = parseSigningKeyRecord(keyData);
  if (!key) return { ok: false, code: 'active_key_missing' };
  if (key.signingKeyId !== meta.activeSigningKeyId) return { ok: false, code: 'active_key_malformed' };
  if (key.status === 'RETIRED') return { ok: false, code: 'active_key_retired' };

  return {
    ok: true,
    signingKeyId: key.signingKeyId,
    privateKey: privateKeyFromRaw(key.publicKeyBase64Url, key.privateKeyBase64Url),
    publicKeyBase64Url: key.publicKeyBase64Url,
  };
}

export interface VerifiableSigningKey {
  signingKeyId: string;
  publicKey: KeyObject;
  publicKeyBase64Url: string;
}

/** Loads every non-retired signing key's public half, for OKS1 keyset-manifest assembly. */
export async function loadAllVerifiableSigningKeys(db: Firestore): Promise<VerifiableSigningKey[]> {
  const snap = await db.collection(OAC_SIGNING_KEYS_COLLECTION).where('status', '==', 'ACTIVE').get();
  const keys: VerifiableSigningKey[] = [];
  for (const doc of snap.docs) {
    const key = parseSigningKeyRecord(doc.data());
    if (!key) continue;
    keys.push({
      signingKeyId: key.signingKeyId,
      publicKey: publicKeyFromRaw(key.publicKeyBase64Url),
      publicKeyBase64Url: key.publicKeyBase64Url,
    });
  }
  return keys;
}
