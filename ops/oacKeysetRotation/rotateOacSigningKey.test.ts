import { describe, expect, it } from 'vitest';
import {
  buildRotatedKeysetUpdate,
  generateOacSigningKeypair,
  rawFromJwkCoordinate,
  signingKeyIdFromPublicKey,
} from './rotateOacSigningKey';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const NOW_MS = 1_772_000_000_000;

describe('generateOacSigningKeypair', () => {
  it('generates raw 32-byte Ed25519 coordinates that can sign and verify', () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateOacSigningKeypair();
    const pubRaw = rawFromJwkCoordinate(publicKeyBase64Url);
    const privRaw = rawFromJwkCoordinate(privateKeyBase64Url);
    expect(pubRaw.length).toBe(32);
    expect(privRaw.length).toBe(32);

    const privateKey = createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url, d: privateKeyBase64Url },
      format: 'jwk',
    });
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url },
      format: 'jwk',
    });
    const message = Buffer.from('sec-001 packet c-a');
    const signature = sign(null, message, privateKey);
    expect(signature.length).toBe(64);
    expect(verify(null, message, publicKey, signature)).toBe(true);
  });

  it('generates distinct keys on each call', () => {
    const a = generateOacSigningKeypair();
    const b = generateOacSigningKeypair();
    expect(a.publicKeyBase64Url).not.toBe(b.publicKeyBase64Url);
  });
});

describe('signingKeyIdFromPublicKey', () => {
  it('is deterministic for the same public key', () => {
    const key = Buffer.alloc(32, 0x11);
    expect(signingKeyIdFromPublicKey(key)).toBe(signingKeyIdFromPublicKey(Buffer.alloc(32, 0x11)));
  });

  it('differs for different public keys', () => {
    expect(signingKeyIdFromPublicKey(Buffer.alloc(32, 0x11))).not.toBe(
      signingKeyIdFromPublicKey(Buffer.alloc(32, 0x22)),
    );
  });
});

describe('buildRotatedKeysetUpdate', () => {
  it('builds a consistent key + meta doc pair', () => {
    const { publicKeyBase64Url, privateKeyBase64Url } = generateOacSigningKeypair();
    const update = buildRotatedKeysetUpdate(publicKeyBase64Url, privateKeyBase64Url, NOW_MS, 'ops-bob');

    expect(update.keyDoc.algo).toBe('ed25519');
    expect(update.keyDoc.status).toBe('ACTIVE');
    expect(update.keyDoc.publicKeyBase64Url).toBe(publicKeyBase64Url);
    expect(update.keyDoc.privateKeyBase64Url).toBe(privateKeyBase64Url);
    expect(update.keyDoc.createdAtServerMs).toBe(NOW_MS);
    expect(update.keyDoc.createdByOps).toBe('ops-bob');

    expect(update.metaDoc.activeSigningKeyId).toBe(update.keyDoc.signingKeyId);
    expect(update.metaDoc.rotatedAtServerMs).toBe(NOW_MS);
    expect(update.metaDoc.rotatedByOps).toBe('ops-bob');
  });

  it('rejects a wrong-length public key', () => {
    expect(() =>
      buildRotatedKeysetUpdate(Buffer.alloc(10).toString('base64url'), Buffer.alloc(32).toString('base64url'), NOW_MS, 'ops'),
    ).toThrow(RangeError);
  });

  it('rejects a wrong-length private key', () => {
    expect(() =>
      buildRotatedKeysetUpdate(Buffer.alloc(32).toString('base64url'), Buffer.alloc(10).toString('base64url'), NOW_MS, 'ops'),
    ).toThrow(RangeError);
  });

  it('rejects a blank operator identity', () => {
    expect(() =>
      buildRotatedKeysetUpdate(Buffer.alloc(32).toString('base64url'), Buffer.alloc(32).toString('base64url'), NOW_MS, '  '),
    ).toThrow();
  });
});
