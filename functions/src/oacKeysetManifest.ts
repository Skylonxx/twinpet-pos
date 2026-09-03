/**
 * getOacKeysetManifest — serves the OKS1 keyset manifest (active + verifiable
 * Ed25519 OAC-signing public keys, current revocation epoch) that native
 * Tauri terminals cache while online and use to verify OAC signatures
 * offline. Read-only, authenticated, no privileged-role gate (public key
 * material only).
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import type { AuthLike } from './authorityFence';
import { buildOacKeysetManifest, type BuildKeysetManifestFailureCode } from './oacKeysetManifestCore';
import { encodeOks1 } from './oacFrame';
import { loadActiveSigningKey, loadAllVerifiableSigningKeys, firestoreSigningKeyReaders } from './signingKeyLoader';
import { readRevocationEpoch } from './privilegedRevocationState';

export type GetOacKeysetManifestResponse =
  | { ok: true; oks1Base64: string }
  | { ok: false; code: 'not_authorized' | BuildKeysetManifestFailureCode | 'signing_key_unavailable' };

export async function performGetOacKeysetManifest(
  database: Firestore,
  auth: AuthLike,
  nowMs: number = Date.now(),
): Promise<GetOacKeysetManifestResponse> {
  if (!auth) return { ok: false, code: 'not_authorized' };

  const activeKey = await loadActiveSigningKey(firestoreSigningKeyReaders(database));
  if (!activeKey.ok) return { ok: false, code: 'signing_key_unavailable' };

  const [verifiableKeys, revocationEpoch] = await Promise.all([
    loadAllVerifiableSigningKeys(database),
    readRevocationEpoch(database),
  ]);

  const result = buildOacKeysetManifest(
    verifiableKeys.map((k) => ({ signingKeyId: k.signingKeyId, publicKeyBase64Url: k.publicKeyBase64Url })),
    revocationEpoch,
    nowMs,
    activeKey.signingKeyId,
    activeKey.privateKey,
  );
  if (!result.ok) return { ok: false, code: result.code };

  return { ok: true, oks1Base64: encodeOks1(result.manifest).toString('base64') };
}

export const getOacKeysetManifest = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  try {
    return await performGetOacKeysetManifest(db, request.auth as AuthLike);
  } catch {
    throw new HttpsError('internal', 'ระบบขัดข้อง กรุณาลองใหม่');
  }
});
