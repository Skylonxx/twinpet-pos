import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { performRegisterIssuer, performRevokeIssuerRegistration } from '../issuerRegistration';
import { registerIssuerPossessionProofPayload, sha256HexOfBase64UrlToken } from '../issuerRegistrationCore';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

// Minimal in-memory Firestore fake: collection/doc get+set+update, plus a
// runTransaction that operates on the same store synchronously.
function fakeFirestore(seed: Record<string, Record<string, unknown>> = {}) {
  const store = new Map<string, Map<string, unknown>>();
  for (const [collection, docs] of Object.entries(seed)) {
    const m = new Map<string, unknown>();
    for (const [id, data] of Object.entries(docs)) m.set(id, data);
    store.set(collection, m);
  }

  function collectionMap(name: string): Map<string, unknown> {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  }

  function docHandle(collectionName: string, id: string) {
    return {
      get: async () => {
        const m = collectionMap(collectionName);
        return { exists: m.has(id), data: () => m.get(id) };
      },
      update: async (patch: Record<string, unknown>) => {
        const m = collectionMap(collectionName);
        m.set(id, { ...(m.get(id) as Record<string, unknown>), ...patch });
      },
      set: (data: unknown) => {
        collectionMap(collectionName).set(id, data);
      },
      create: (data: unknown) => {
        const m = collectionMap(collectionName);
        if (m.has(id)) throw new Error('already exists');
        m.set(id, data);
      },
    };
  }

  const db = {
    collection: (name: string) => ({
      doc: (id: string) => docHandle(name, id),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { get: () => Promise<unknown> }, data: unknown) => {
          (ref as unknown as { set: (d: unknown) => void }).set(data);
        },
        update: (ref: { get: () => Promise<unknown> }, patch: unknown) => {
          (ref as unknown as { update: (p: unknown) => void }).update(patch);
        },
        create: (ref: { get: () => Promise<unknown> }, data: unknown) => {
          (ref as unknown as { create: (d: unknown) => void }).create(data);
        },
      };
      await fn(tx);
    },
  } as unknown as Firestore;

  return { db, store };
}

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

const ADMIN_UID = 'admin-1';

function seedAdmin() {
  return { users: { [ADMIN_UID]: { role: 'admin', isActive: true, deletedAt: null } } };
}

describe('performRegisterIssuer', () => {
  it('registers a new issuer given a valid bootstrap token and possession proof', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x11).toString('base64url');
    const { db, store } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-1': {
          tokenId: 'token-1',
          issuerId: 'hq-console-01',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    });

    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-1', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );

    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      {
        issuerId: 'hq-console-01',
        requestId: 'r'.repeat(32),
        bootstrapTokenId: 'token-1',
        bootstrapToken: rawToken,
        publicKeyBase64Url,
        signature,
      },
      1000,
    );

    expect(result).toEqual({ ok: true, issuerId: 'hq-console-01' });
    expect((store.get('privilegedIssuerBootstrapTokens')!.get('token-1') as { status: string }).status).toBe(
      'CONSUMED',
    );
    const registration = store.get('privilegedIssuerRegistrations')!.get('hq-console-01') as {
      active: boolean;
      revoked: boolean;
      publicKeyBase64Url: string;
    };
    expect(registration.active).toBe(true);
    expect(registration.revoked).toBe(false);
    expect(registration.publicKeyBase64Url).toBe(publicKeyBase64Url);
  });

  it('rejects a non-admin caller', async () => {
    const { db } = fakeFirestore({ users: { u1: { role: 'staff', isActive: true, deletedAt: null } } });
    const result = await performRegisterIssuer(db, { uid: 'u1', token: { role: 'staff' } }, {}, 1);
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });

  it('rejects an already-consumed bootstrap token', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x22).toString('base64url');
    const { db } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-2': {
          tokenId: 'token-2',
          issuerId: 'hq-console-01',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'CONSUMED',
          expiresAtServerMs: 10_000,
        },
      },
    });
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-2', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );
    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', requestId: 'r'.repeat(32), bootstrapTokenId: 'token-2', bootstrapToken: rawToken, publicKeyBase64Url, signature },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'bootstrap_token_already_consumed' });
  });

  it('rejects a possession-proof signature from the wrong key', async () => {
    const { publicKeyBase64Url } = rawKeypair();
    const other = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x33).toString('base64url');
    const { db } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-3': {
          tokenId: 'token-3',
          issuerId: 'hq-console-01',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    });
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-3', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(other.publicKeyBase64Url, other.privateKeyBase64Url)).toString(
      'base64',
    );
    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', requestId: 'r'.repeat(32), bootstrapTokenId: 'token-3', bootstrapToken: rawToken, publicKeyBase64Url, signature },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'bad_possession_proof' });
  });

  it('rejects a wrong-issuer bootstrap token binding', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const rawToken = Buffer.alloc(32, 0x44).toString('base64url');
    const { db } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerBootstrapTokens: {
        'token-4': {
          tokenId: 'token-4',
          issuerId: 'some-other-issuer',
          tokenHash: sha256HexOfBase64UrlToken(rawToken),
          status: 'PENDING',
          expiresAtServerMs: 10_000,
        },
      },
    });
    const payload = registerIssuerPossessionProofPayload('hq-console-01', 'token-4', 'r'.repeat(32));
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url)).toString(
      'base64',
    );
    const result = await performRegisterIssuer(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', requestId: 'r'.repeat(32), bootstrapTokenId: 'token-4', bootstrapToken: rawToken, publicKeyBase64Url, signature },
      1000,
    );
    expect(result).toEqual({ ok: false, code: 'bootstrap_token_issuer_mismatch' });
  });
});

describe('performRevokeIssuerRegistration', () => {
  it('revokes a registered issuer', async () => {
    const { db, store } = fakeFirestore({
      ...seedAdmin(),
      privilegedIssuerRegistrations: {
        'hq-console-01': { issuerId: 'hq-console-01', active: true, revoked: false, publicKeyBase64Url: 'x', credentialVersion: 1 },
      },
    });
    const result = await performRevokeIssuerRegistration(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'hq-console-01', reason: 'device lost' },
      2000,
    );
    expect(result).toEqual({ ok: true, issuerId: 'hq-console-01' });
    const registration = store.get('privilegedIssuerRegistrations')!.get('hq-console-01') as {
      revoked: boolean;
      active: boolean;
    };
    expect(registration.revoked).toBe(true);
    expect(registration.active).toBe(false);
  });

  it('rejects revoking an unregistered issuer', async () => {
    const { db } = fakeFirestore(seedAdmin());
    const result = await performRevokeIssuerRegistration(
      db,
      { uid: ADMIN_UID, token: { role: 'admin' } },
      { issuerId: 'ghost' },
      1,
    );
    expect(result).toEqual({ ok: false, code: 'issuer_not_registered' });
  });

  it('rejects a non-admin caller', async () => {
    const { db } = fakeFirestore({ users: { u1: { role: 'manager', isActive: true, deletedAt: null } } });
    const result = await performRevokeIssuerRegistration(db, { uid: 'u1', token: { role: 'manager' } }, { issuerId: 'x' }, 1);
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
  });
});
