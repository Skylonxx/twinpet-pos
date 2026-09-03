import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  loadActiveSigningKey,
  loadAllVerifiableSigningKeys,
  privateKeyFromRaw,
  publicKeyFromRaw,
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
  it('returns only ACTIVE keys imported as public KeyObjects', async () => {
    const a = generateRawKeypair();
    const b = generateRawKeypair();
    const docs = [
      { signingKeyId: 'a', publicKeyBase64Url: a.publicKeyBase64Url, privateKeyBase64Url: a.privateKeyBase64Url, status: 'ACTIVE' },
      { signingKeyId: 'b', publicKeyBase64Url: b.publicKeyBase64Url, privateKeyBase64Url: b.privateKeyBase64Url, status: 'ACTIVE' },
    ];
    const fakeDb = {
      collection: () => ({
        where: () => ({
          get: async () => ({ docs: docs.map((d) => ({ data: () => d })) }),
        }),
      }),
    } as unknown as import('firebase-admin/firestore').Firestore;

    const keys = await loadAllVerifiableSigningKeys(fakeDb);
    expect(keys).toHaveLength(2);
    expect(keys.map((k) => k.signingKeyId).sort()).toEqual(['a', 'b']);
  });
});
