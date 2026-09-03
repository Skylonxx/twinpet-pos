import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { performGetOacKeysetManifest } from '../oacKeysetManifest';
import { decodeOks1 } from '../oacFrame';
import { verifyOacKeysetManifestSignature } from '../oacSigner';
import { publicKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

function fakeDb(opts: {
  meta?: { activeSigningKeyId: string } | null;
  keys?: Record<string, { signingKeyId: string; publicKeyBase64Url: string; privateKeyBase64Url: string; status: string }>;
  revocation?: { revocationEpoch: number; updatedAtServerMs: number; updatedBy: string; reason: string | null } | null;
}): Firestore {
  const keys = opts.keys ?? {};
  return {
    collection: (name: string) => {
      if (name === 'privilegedOacKeysetMeta') {
        return {
          doc: () => ({
            get: async () => ({ exists: opts.meta != null, data: () => opts.meta ?? undefined }),
          }),
        };
      }
      if (name === 'privilegedOacSigningKeys') {
        return {
          doc: (id: string) => ({
            get: async () => ({ exists: id in keys, data: () => keys[id] }),
          }),
          where: () => ({
            get: async () => ({
              docs: Object.values(keys)
                .filter((k) => k.status === 'ACTIVE')
                .map((k) => ({ data: () => k })),
            }),
          }),
        };
      }
      if (name === 'privilegedRevocationState') {
        return {
          doc: () => ({
            get: async () => ({ exists: opts.revocation != null, data: () => opts.revocation ?? undefined }),
          }),
        };
      }
      throw new Error(`unexpected collection: ${name}`);
    },
  } as unknown as Firestore;
}

describe('performGetOacKeysetManifest', () => {
  it('denies unauthenticated requests', async () => {
    const result = await performGetOacKeysetManifest(fakeDb({}), null);
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('fails closed when no active signing key exists', async () => {
    const result = await performGetOacKeysetManifest(fakeDb({ meta: null }), { uid: 'u1' });
    expect(result).toEqual({ ok: false, code: 'signing_key_unavailable' });
  });

  it('returns a base64 OKS1 manifest that verifies and decodes correctly', async () => {
    const active = rawKeypair();
    const db = fakeDb({
      meta: { activeSigningKeyId: 'key-1' },
      keys: {
        'key-1': {
          signingKeyId: 'key-1',
          publicKeyBase64Url: active.publicKeyBase64Url,
          privateKeyBase64Url: active.privateKeyBase64Url,
          status: 'ACTIVE',
        },
      },
      revocation: { revocationEpoch: 2, updatedAtServerMs: 1, updatedBy: 'ops', reason: null },
    });

    const result = await performGetOacKeysetManifest(db, { uid: 'u1' }, 1_772_000_000_000);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const bytes = Buffer.from(result.oks1Base64, 'base64');
    const decoded = decodeOks1(bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('unreachable');
    expect(decoded.value.revocationEpoch).toBe(2);
    expect(decoded.value.keys).toHaveLength(1);

    const publicKey = publicKeyFromRaw(active.publicKeyBase64Url);
    expect(verifyOacKeysetManifestSignature(decoded.value, publicKey)).toBe(true);
  });

  it('defaults revocation epoch to 0 when never bumped (virgin state)', async () => {
    const active = rawKeypair();
    const db = fakeDb({
      meta: { activeSigningKeyId: 'key-1' },
      keys: {
        'key-1': {
          signingKeyId: 'key-1',
          publicKeyBase64Url: active.publicKeyBase64Url,
          privateKeyBase64Url: active.privateKeyBase64Url,
          status: 'ACTIVE',
        },
      },
      revocation: null,
    });
    const result = await performGetOacKeysetManifest(db, { uid: 'u1' }, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const decoded = decodeOks1(Buffer.from(result.oks1Base64, 'base64'));
    expect(decoded).toMatchObject({ ok: true, value: { revocationEpoch: 0 } });
  });
});
