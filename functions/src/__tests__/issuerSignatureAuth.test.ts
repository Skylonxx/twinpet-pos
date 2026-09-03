import { generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyIssuerSignedRequest, parseIssuerRegistration } from '../issuerSignatureAuth';
import { privateKeyFromRaw } from '../signingKeyLoader';
import type { Firestore } from 'firebase-admin/firestore';

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

function fakeDbAllowingFirstReplay(): Firestore {
  const seen = new Set<string>();
  return {
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async () => ({ exists: false }),
        create: (_ref: unknown, data: { purpose: string; requestId: string }) => {
          const key = `${data.purpose}:${data.requestId}`;
          if (seen.has(key)) throw new Error('replay');
          seen.add(key);
        },
      };
      await fn(tx);
    },
    collection: () => ({ doc: (id: string) => ({ id }) }),
  } as unknown as Firestore;
}

describe('parseIssuerRegistration', () => {
  it('parses a well-formed doc', () => {
    expect(
      parseIssuerRegistration({ issuerId: 'i1', publicKeyBase64Url: 'x', active: true, revoked: false, credentialVersion: 1 }),
    ).not.toBeNull();
  });
  it('rejects malformed docs', () => {
    expect(parseIssuerRegistration(null)).toBeNull();
    expect(parseIssuerRegistration({ issuerId: 'i1' })).toBeNull();
  });
});

describe('verifyIssuerSignedRequest', () => {
  const payload = Buffer.from('registerIssuer:possession-proof');

  it('accepts a validly-signed request from an active, non-revoked issuer', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url));
    const db = fakeDbAllowingFirstReplay();
    const result = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'issuer-1', requestId: 'r'.repeat(32), purpose: 'registerIssuer', payload, signature, nowMs: 1 },
      async () => ({ issuerId: 'issuer-1', publicKeyBase64Url, active: true, revoked: false, credentialVersion: 1 }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unregistered issuer', async () => {
    const db = fakeDbAllowingFirstReplay();
    const result = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'ghost', requestId: 'r'.repeat(32), purpose: 'registerIssuer', payload, signature: Buffer.alloc(64), nowMs: 1 },
      async () => undefined,
    );
    expect(result).toEqual({ ok: false, code: 'issuer_not_registered' });
  });

  it('rejects a revoked issuer even with a valid signature', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url));
    const db = fakeDbAllowingFirstReplay();
    const result = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'issuer-1', requestId: 'r'.repeat(32), purpose: 'registerIssuer', payload, signature, nowMs: 1 },
      async () => ({ issuerId: 'issuer-1', publicKeyBase64Url, active: true, revoked: true, credentialVersion: 1 }),
    );
    expect(result).toEqual({ ok: false, code: 'issuer_revoked' });
  });

  it('rejects an inactive issuer', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url));
    const db = fakeDbAllowingFirstReplay();
    const result = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'issuer-1', requestId: 'r'.repeat(32), purpose: 'registerIssuer', payload, signature, nowMs: 1 },
      async () => ({ issuerId: 'issuer-1', publicKeyBase64Url, active: false, revoked: false, credentialVersion: 1 }),
    );
    expect(result).toEqual({ ok: false, code: 'issuer_inactive' });
  });

  it('rejects a credentialVersion mismatch', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url));
    const db = fakeDbAllowingFirstReplay();
    const result = await verifyIssuerSignedRequest(
      db,
      {
        issuerId: 'issuer-1',
        requestId: 'r'.repeat(32),
        purpose: 'registerIssuer',
        payload,
        signature,
        expectedCredentialVersion: 2,
        nowMs: 1,
      },
      async () => ({ issuerId: 'issuer-1', publicKeyBase64Url, active: true, revoked: false, credentialVersion: 1 }),
    );
    expect(result).toEqual({ ok: false, code: 'credential_version_mismatch' });
  });

  it('rejects a bad signature', async () => {
    const { publicKeyBase64Url } = rawKeypair();
    const other = rawKeypair();
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(other.publicKeyBase64Url, other.privateKeyBase64Url));
    const db = fakeDbAllowingFirstReplay();
    const result = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'issuer-1', requestId: 'r'.repeat(32), purpose: 'registerIssuer', payload, signature, nowMs: 1 },
      async () => ({ issuerId: 'issuer-1', publicKeyBase64Url, active: true, revoked: false, credentialVersion: 1 }),
    );
    expect(result).toEqual({ ok: false, code: 'bad_signature' });
  });

  it('rejects a replayed requestId even with a valid signature the second time', async () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = rawKeypair();
    const signature = ed25519Sign(null, payload, privateKeyFromRaw(publicKeyBase64Url, privateKeyBase64Url));
    const db = fakeDbAllowingFirstReplay();
    const readIssuer = async () => ({
      issuerId: 'issuer-1',
      publicKeyBase64Url,
      active: true,
      revoked: false,
      credentialVersion: 1,
    });
    const requestId = 'r'.repeat(32);
    const first = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'issuer-1', requestId, purpose: 'registerIssuer', payload, signature, nowMs: 1 },
      readIssuer,
    );
    expect(first.ok).toBe(true);
    const second = await verifyIssuerSignedRequest(
      db,
      { issuerId: 'issuer-1', requestId, purpose: 'registerIssuer', payload, signature, nowMs: 2 },
      readIssuer,
    );
    expect(second).toEqual({ ok: false, code: 'replayed_request' });
  });
});
