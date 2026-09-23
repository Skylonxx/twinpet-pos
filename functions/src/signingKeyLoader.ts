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

export type OacSigningKeyStatus = 'ACTIVE' | 'VERIFY_ONLY' | 'RETIRED';

export interface OacSigningKeyRecord {
  signingKeyId: string;
  publicKeyBase64Url: string;
  privateKeyBase64Url: string;
  status: OacSigningKeyStatus;
  verifyUntilServerMs?: number;
}

export interface OacKeysetMetaRecord {
  activeSigningKeyId: string;
}

export type SigningKeyLoadFailureCode =
  | 'meta_missing'
  | 'meta_malformed'
  | 'active_key_missing'
  | 'active_key_malformed'
  | 'active_key_retired'
  | 'active_key_not_active';

export type SigningKeyLoadResult =
  | { ok: true; signingKeyId: string; privateKey: KeyObject; publicKeyBase64Url: string }
  | { ok: false; code: SigningKeyLoadFailureCode };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSigningKeyStatus(value: unknown): value is OacSigningKeyStatus {
  return value === 'ACTIVE' || value === 'VERIFY_ONLY' || value === 'RETIRED';
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
  const verifyUntilServerMs = typeof raw.verifyUntilServerMs === 'number' ? raw.verifyUntilServerMs : undefined;
  return {
    signingKeyId: raw.signingKeyId,
    publicKeyBase64Url: raw.publicKeyBase64Url,
    privateKeyBase64Url: raw.privateKeyBase64Url,
    status: raw.status,
    ...(verifyUntilServerMs !== undefined ? { verifyUntilServerMs } : {}),
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
  if (key.status !== 'ACTIVE') {
    return { ok: false, code: key.status === 'RETIRED' ? 'active_key_retired' : 'active_key_not_active' };
  }

  return {
    ok: true,
    signingKeyId: key.signingKeyId,
    privateKey: privateKeyFromRaw(key.publicKeyBase64Url, key.privateKeyBase64Url),
    publicKeyBase64Url: key.publicKeyBase64Url,
  };
}

/**
 * Canonical OAC root trust anchor — the ONLY production root the server accepts.
 *
 * SEC-001 R1 (Gemini-119) rotated this away from the previous anchor, whose
 * private seed was reconstructible from committed test fixtures and must never
 * be trusted again. This is a compile-time source constant on purpose: there is
 * no env, request, header or Firestore path that can select a different anchor.
 * It MUST stay byte-identical to `PRODUCTION_CANONICAL_OAC_ROOT_PUBLIC_KEY` in
 * `src-tauri/src/privileged_auth/enrollment_meta.rs`.
 */
export const CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL = '81I9aC0XhQGf6VGrlM2KCoMsMJcEhV43ItODxHrYsU8';

export interface RootSigningKey {
  rootPrivateKey: KeyObject;
  rootPublicKeyBase64Url: string;
}

export type RootSigningKeyResult =
  | { ok: true; rootPrivateKey: KeyObject; rootPublicKeyBase64Url: string }
  | { ok: false; code: 'root_signing_key_unavailable' };

const ED25519_PKCS8_HEADER = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * SEC-001 R1 seam (`S2`) — the whole candidate-seed validation as a pure function
 * of (candidate secret, expected root public key): canonical-base64url decode,
 * 32-byte length, PKCS#8 reconstruction, public-half derivation, and equality
 * against the expected anchor. Every failure mode returns the same opaque code;
 * absence is indistinguishable from mismatch by design.
 *
 * `loadRootSigningKey` is the ONLY production caller and always passes the
 * compile-time pinned `CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL`, so the
 * production trust anchor is never runtime-selectable. The second parameter
 * exists so `signingKeyLoader.test.ts` can prove the success path against an
 * ephemeral test root without possessing the production root seed — it must
 * never be wired to request data, headers, callable input, env or Firestore.
 */
export function validateRootSigningSecret(
  candidateSecret: string | undefined,
  expectedRootPublicKeyBase64Url: string,
): RootSigningKeyResult {
  if (typeof candidateSecret !== 'string' || candidateSecret.trim().length === 0) {
    return { ok: false, code: 'root_signing_key_unavailable' };
  }
  let secretBuf: Buffer;
  try {
    secretBuf = Buffer.from(candidateSecret, 'base64url');
  } catch {
    return { ok: false, code: 'root_signing_key_unavailable' };
  }
  if (secretBuf.length !== 32 || secretBuf.toString('base64url') !== candidateSecret) {
    return { ok: false, code: 'root_signing_key_unavailable' };
  }

  try {
    const pkcs8 = Buffer.concat([ED25519_PKCS8_HEADER, secretBuf]);
    const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    const pubKey = createPublicKey(privateKey);
    const pubJwk = pubKey.export({ format: 'jwk' }) as { x?: string };
    if (pubJwk.x !== expectedRootPublicKeyBase64Url) {
      return { ok: false, code: 'root_signing_key_unavailable' };
    }
    return {
      ok: true,
      rootPrivateKey: privateKey,
      rootPublicKeyBase64Url: expectedRootPublicKeyBase64Url,
    };
  } catch {
    return { ok: false, code: 'root_signing_key_unavailable' };
  }
}

export async function loadRootSigningKey(injectedSecret?: string): Promise<RootSigningKeyResult> {
  const secret = injectedSecret !== undefined ? injectedSecret : process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
  return validateRootSigningSecret(secret, CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL);
}

export interface VerifiableSigningKey {
  signingKeyId: string;
  publicKey: KeyObject;
  publicKeyBase64Url: string;
  status: OacSigningKeyStatus;
  verifyUntilServerMs?: number;
}

/** Loads every non-retired signing key's public half (ACTIVE + valid VERIFY_ONLY), for OKS1 keyset-manifest assembly. */
export async function loadAllVerifiableSigningKeys(
  db: Firestore,
  nowMs: number = Date.now(),
): Promise<VerifiableSigningKey[]> {
  const [activeSnap, verifyOnlySnap] = await Promise.all([
    db.collection(OAC_SIGNING_KEYS_COLLECTION).where('status', '==', 'ACTIVE').get(),
    db.collection(OAC_SIGNING_KEYS_COLLECTION).where('status', '==', 'VERIFY_ONLY').get(),
  ]);

  const keys: VerifiableSigningKey[] = [];
  for (const doc of activeSnap.docs) {
    const key = parseSigningKeyRecord(doc.data());
    if (!key) continue;
    keys.push({
      signingKeyId: key.signingKeyId,
      publicKey: publicKeyFromRaw(key.publicKeyBase64Url),
      publicKeyBase64Url: key.publicKeyBase64Url,
      status: 'ACTIVE',
    });
  }

  for (const doc of verifyOnlySnap.docs) {
    const key = parseSigningKeyRecord(doc.data());
    if (!key) continue;
    if (
      typeof key.verifyUntilServerMs !== 'number' ||
      !Number.isFinite(key.verifyUntilServerMs) ||
      !Number.isSafeInteger(key.verifyUntilServerMs) ||
      nowMs >= key.verifyUntilServerMs
    ) {
      continue;
    }
    keys.push({
      signingKeyId: key.signingKeyId,
      publicKey: publicKeyFromRaw(key.publicKeyBase64Url),
      publicKeyBase64Url: key.publicKeyBase64Url,
      status: 'VERIFY_ONLY',
      verifyUntilServerMs: key.verifyUntilServerMs,
    });
  }

  return keys;
}
