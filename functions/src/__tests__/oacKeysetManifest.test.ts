import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { performGetOacKeysetManifest } from '../oacKeysetManifest';
import { decodeOks1 } from '../oacFrame';
import { verifyOacKeysetManifestSignature } from '../oacSigner';
import { publicKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

/**
 * SEC-001 R1 root-loader seam.
 *
 * The production root anchor was rotated to a key whose private seed lives only in
 * human custody, so this suite can no longer manufacture a valid production root by
 * setting the env var to a committed seed. It therefore substitutes an ephemeral
 * per-run root: `loadRootSigningKey` is replaced by a call to the REAL
 * `validateRootSigningSecret` with this suite's expected anchor, so every validation
 * rule the production loader applies (absence, non-canonical base64url, 32-byte
 * length, derived-public mismatch) still governs these tests — only the expected
 * anchor differs. Fail-closed coverage of the real production loader itself lives in
 * `signingKeyLoader.test.ts` and is NOT claimed here. No production code changes.
 */
const testRootHolder = vi.hoisted(() => ({ publicKeyBase64Url: '' }));

vi.mock('../signingKeyLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signingKeyLoader')>();
  return {
    ...actual,
    loadRootSigningKey: async (injectedSecret?: string) =>
      actual.validateRootSigningSecret(
        injectedSecret !== undefined ? injectedSecret : process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL,
        testRootHolder.publicKeyBase64Url,
      ),
  };
});

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const testRoot = rawKeypair();
testRootHolder.publicKeyBase64Url = testRoot.publicKeyBase64Url;

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
          where: (_field: string, _op: string, val: string) => ({
            get: async () => ({
              docs: Object.values(keys)
                .filter((k) => k.status === val)
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
  const originalEnv = process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;

  beforeEach(() => {
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = testRoot.privateKeyBase64Url;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = originalEnv;
    } else {
      delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    }
  });

  it('fails closed when root signing key secret is unavailable', async () => {
    delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
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
    });
    const result = await performGetOacKeysetManifest(db, { uid: 'u1' });
    expect(result).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

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

    const rootPublicKey = publicKeyFromRaw(testRoot.publicKeyBase64Url);
    expect(verifyOacKeysetManifestSignature(decoded.value, rootPublicKey)).toBe(true);
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
