import { generateKeyPairSync, sign, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadActiveSigningKey,
  loadAllVerifiableSigningKeys,
  loadRootSigningKey,
  privateKeyFromRaw,
  publicKeyFromRaw,
  CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL,
  type SigningKeyReaders,
} from '../signingKeyLoader';

function generateRawKeypair(): { publicKeyBase64Url: string; privateKeyBase64Url: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { publicKeyBase64Url: pubJwk.x, privateKeyBase64Url: privJwk.d };
}

describe('privateKeyFromRaw / publicKeyFromRaw', () => {
  it('round-trip sign/verify against real Ed25519 output', () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateRawKeypair();
    const privateKey = privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url);
    const publicKey = publicKeyFromRaw(publicKeyBase64Url);
    const message = Buffer.from('oac-envelope');
    const signature = sign(null, message, privateKey);
    expect(verify(null, message, publicKey, signature)).toBe(true);
  });
});

describe('loadActiveSigningKey', () => {
  it('loads and imports the active key', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateRawKeypair();
    const readers: SigningKeyReaders = {
      readMeta: async () => ({ activeSigningKeyId: 'key-1' }),
      readSigningKey: async (id) => {
        expect(id).toBe('key-1');
        return { signingKeyId: 'key-1', publicKeyBase64Url, privateKeyBase64Url, status: 'ACTIVE' };
      },
    };
    const result = await loadActiveSigningKey(readers);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.signingKeyId).toBe('key-1');
    expect(result.publicKeyBase64Url).toBe(publicKeyBase64Url);
  });

  it('fails closed when meta doc is missing', async () => {
    const readers: SigningKeyReaders = {
      readMeta: async () => undefined,
      readSigningKey: async () => undefined,
    };
    expect(await loadActiveSigningKey(readers)).toEqual({ ok: false, code: 'meta_missing' });
  });

  it('fails closed when meta doc is malformed', async () => {
    const readers: SigningKeyReaders = {
      readMeta: async () => ({ activeSigningKeyId: 42 }),
      readSigningKey: async () => undefined,
    };
    expect(await loadActiveSigningKey(readers)).toEqual({ ok: false, code: 'meta_missing' });
  });

  it('fails closed when the active key doc is missing', async () => {
    const readers: SigningKeyReaders = {
      readMeta: async () => ({ activeSigningKeyId: 'key-1' }),
      readSigningKey: async () => undefined,
    };
    expect(await loadActiveSigningKey(readers)).toEqual({ ok: false, code: 'active_key_missing' });
  });

  it('fails closed when the active key is retired', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateRawKeypair();
    const readers: SigningKeyReaders = {
      readMeta: async () => ({ activeSigningKeyId: 'key-1' }),
      readSigningKey: async () => ({
        signingKeyId: 'key-1',
        publicKeyBase64Url,
        privateKeyBase64Url,
        status: 'RETIRED',
      }),
    };
    expect(await loadActiveSigningKey(readers)).toEqual({ ok: false, code: 'active_key_retired' });
  });

  it('fails closed when the active key is verify-only', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateRawKeypair();
    const readers: SigningKeyReaders = {
      readMeta: async () => ({ activeSigningKeyId: 'key-1' }),
      readSigningKey: async () => ({
        signingKeyId: 'key-1',
        publicKeyBase64Url,
        privateKeyBase64Url,
        status: 'VERIFY_ONLY',
      }),
    };
    expect(await loadActiveSigningKey(readers)).toEqual({ ok: false, code: 'active_key_not_active' });
  });

  it('fails closed when the fetched key doc id does not match the requested id', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateRawKeypair();
    const readers: SigningKeyReaders = {
      readMeta: async () => ({ activeSigningKeyId: 'key-1' }),
      readSigningKey: async () => ({
        signingKeyId: 'key-mismatch',
        publicKeyBase64Url,
        privateKeyBase64Url,
        status: 'ACTIVE',
      }),
    };
    expect(await loadActiveSigningKey(readers)).toEqual({ ok: false, code: 'active_key_malformed' });
  });
});

describe('loadAllVerifiableSigningKeys', () => {
  it('returns ACTIVE and valid VERIFY_ONLY keys, omitting expired keys', async () => {
    const a = generateRawKeypair();
    const b = generateRawKeypair();
    const c = generateRawKeypair();
    const nowMs = 1_700_000_000_000;
    const activeDocs = [
      { signingKeyId: 'a', publicKeyBase64Url: a.publicKeyBase64Url, privateKeyBase64Url: a.privateKeyBase64Url, status: 'ACTIVE' },
    ];
    const verifyOnlyDocs = [
      {
        signingKeyId: 'b',
        publicKeyBase64Url: b.publicKeyBase64Url,
        privateKeyBase64Url: b.privateKeyBase64Url,
        status: 'VERIFY_ONLY',
        verifyUntilServerMs: nowMs + 10_000, // valid
      },
      {
        signingKeyId: 'c',
        publicKeyBase64Url: c.publicKeyBase64Url,
        privateKeyBase64Url: c.privateKeyBase64Url,
        status: 'VERIFY_ONLY',
        verifyUntilServerMs: nowMs - 10_000, // expired
      },
    ];
    const fakeDb = {
      collection: () => ({
        where: (_field: string, _op: string, val: string) => ({
          get: async () => {
            if (val === 'ACTIVE') return { docs: activeDocs.map((d) => ({ data: () => d })) };
            if (val === 'VERIFY_ONLY') return { docs: verifyOnlyDocs.map((d) => ({ data: () => d })) };
            return { docs: [] };
          },
        }),
      }),
    } as unknown as import('firebase-admin/firestore').Firestore;

    const keys = await loadAllVerifiableSigningKeys(fakeDb, nowMs);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.signingKeyId).sort()).toEqual(['a', 'b']);
  });

  it('fails closed on VERIFY_ONLY records with missing, malformed, or exact-boundary verifyUntilServerMs', async () => {
    const raw = generateRawKeypair();
    const nowMs = 1_700_000_000_000;

    const invalidVerifyOnlyDocs = [
      { signingKeyId: 'missing-expiry', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY' },
      { signingKeyId: 'nan-expiry', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: NaN },
      { signingKeyId: 'inf-expiry', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: Infinity },
      { signingKeyId: 'fractional-expiry', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: nowMs + 10.5 },
      { signingKeyId: 'unsafe-expiry', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: Number.MAX_SAFE_INTEGER + 10 },
      { signingKeyId: 'exact-boundary', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: nowMs },
      { signingKeyId: 'just-expired', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: nowMs - 1 },
      { signingKeyId: 'valid-just-before', publicKeyBase64Url: raw.publicKeyBase64Url, privateKeyBase64Url: raw.privateKeyBase64Url, status: 'VERIFY_ONLY', verifyUntilServerMs: nowMs + 1 },
    ];

    const fakeDb = {
      collection: () => ({
        where: (_field: string, _op: string, val: string) => ({
          get: async () => {
            if (val === 'ACTIVE') return { docs: [] };
            if (val === 'VERIFY_ONLY') return { docs: invalidVerifyOnlyDocs.map((d) => ({ data: () => d })) };
            return { docs: [] };
          },
        }),
      }),
    } as unknown as import('firebase-admin/firestore').Firestore;

    const keys = await loadAllVerifiableSigningKeys(fakeDb, nowMs);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.signingKeyId).toBe('valid-just-before');
  });
});

describe('loadRootSigningKey (IR-005 custody & fail-closed root provider)', () => {
  const originalEnv = process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = originalEnv;
    } else {
      delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    }
  });

  it('fails closed when secret is absent in env and not injected', async () => {
    delete process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL;
    const res = await loadRootSigningKey();
    expect(res).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

  it('fails closed when secret is empty string or whitespace', async () => {
    expect(await loadRootSigningKey('')).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
    expect(await loadRootSigningKey('   ')).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

  it('fails closed when secret is malformed base64url', async () => {
    expect(await loadRootSigningKey('!@#$%^&*()_+')).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

  it('fails closed when secret has wrong length (not exactly 32 bytes)', async () => {
    const tooShort = Buffer.alloc(31, 0x5a).toString('base64url');
    const tooLong = Buffer.alloc(33, 0x5a).toString('base64url');
    expect(await loadRootSigningKey(tooShort)).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
    expect(await loadRootSigningKey(tooLong)).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

  it('fails closed when derived public key does not match canonical root public key', async () => {
    const mismatchSeed = Buffer.alloc(32, 0x42).toString('base64url');
    const res = await loadRootSigningKey(mismatchSeed);
    expect(res).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

  it('succeeds when injected secret derives fixed canonical public root', async () => {
    const testSecret = Buffer.alloc(32, 0x5a).toString('base64url');
    const res = await loadRootSigningKey(testSecret);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.rootPublicKeyBase64Url).toBe(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL);

    const testMsg = Buffer.from('root-signed-manifest-test');
    const sig = sign(null, testMsg, res.rootPrivateKey);
    const pubKey = publicKeyFromRaw(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL);
    expect(verify(null, testMsg, pubKey, sig)).toBe(true);
  });

  it('succeeds via server environment variable OAC_ROOT_PRIVATE_KEY_BASE64URL', async () => {
    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = Buffer.alloc(32, 0x5a).toString('base64url');
    const res = await loadRootSigningKey();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.rootPublicKeyBase64Url).toBe(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL);
  });
});

describe('Production Source Audit (No root private seed outside test boundaries)', () => {
  it('functions production source has no committed root private seed', () => {
    const signingKeyLoaderPath = path.resolve(__dirname, '../signingKeyLoader.ts');
    const content = fs.readFileSync(signingKeyLoaderPath, 'utf8');
    expect(content).not.toContain('CANONICAL_SERVER_ROOT_PRIVATE_KEY_SEED');
    expect(content).not.toContain('Buffer.alloc(32, 0x5a)');
    expect(content).not.toContain('getCanonicalRootSigningKey');
  });
});
