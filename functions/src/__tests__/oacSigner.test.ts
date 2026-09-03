import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  signOacEnvelope,
  signOacKeysetManifest,
  verifyOacEnvelopeSignature,
  verifyOacKeysetManifestSignature,
  type UnsignedOacEnvelopeV1,
} from '../oacSigner';
import { OAC_SCHEMA_VERSION, OAC_VERIFIER_ALGO } from '../privilegedActionRegistry';
import { privateKeyFromRaw, publicKeyFromRaw } from '../signingKeyLoader';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { privateKey: privateKeyFromRaw(x, d), publicKey: publicKeyFromRaw(x) };
}

function unsignedEnvelope(): UnsignedOacEnvelopeV1 {
  return {
    oacId: 'oac-1',
    schemaVersion: OAC_SCHEMA_VERSION,
    managerStaffId: 'staff-1',
    managerRole: 'manager',
    branchId: 'branch-1',
    deviceId: 'device-1',
    allowedActions: ['VOID_PENDING_SALE', 'VOID_SETTLED_SALE'],
    authVersionAtIssue: 1,
    credentialVersionAtIssue: 1,
    revocationEpoch: 0,
    issuedAtServerMs: 1_772_000_000_000,
    freshnessExpiresAtServerMs: 1_772_086_400_000,
    verifierAlgo: OAC_VERIFIER_ALGO,
    verifierParams: { m: 65536, t: 3, p: 1, saltLen: 16, hashLen: 32 },
    verifierSalt: 'c2FsdA==',
    verifier: 'dmVyaWZpZXI=',
    pepperCommitment: 'cGVwcGVy',
  };
}

describe('OAC envelope sign/verify', () => {
  it('round-trips and verifies with the correct public key', () => {
    const { privateKey, publicKey } = keypair();
    const envelope = signOacEnvelope(unsignedEnvelope(), 'key-1', privateKey);
    expect(envelope.signingKeyId).toBe('key-1');
    expect(verifyOacEnvelopeSignature(envelope, publicKey)).toBe(true);
  });

  it('rejects a tampered field', () => {
    const { privateKey, publicKey } = keypair();
    const envelope = signOacEnvelope(unsignedEnvelope(), 'key-1', privateKey);
    const tampered = { ...envelope, revocationEpoch: envelope.revocationEpoch + 1 };
    expect(verifyOacEnvelopeSignature(tampered, publicKey)).toBe(false);
  });

  it('rejects verification with the wrong public key', () => {
    const { privateKey } = keypair();
    const other = keypair();
    const envelope = signOacEnvelope(unsignedEnvelope(), 'key-1', privateKey);
    expect(verifyOacEnvelopeSignature(envelope, other.publicKey)).toBe(false);
  });

  it('rejects a malformed base64 signature without throwing', () => {
    const { publicKey } = keypair();
    const envelope = { ...unsignedEnvelope(), signingKeyId: 'key-1', signature: '***not-base64***' };
    expect(verifyOacEnvelopeSignature(envelope, publicKey)).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    const { publicKey } = keypair();
    const envelope = {
      ...unsignedEnvelope(),
      signingKeyId: 'key-1',
      signature: Buffer.alloc(10).toString('base64'),
    };
    expect(verifyOacEnvelopeSignature(envelope, publicKey)).toBe(false);
  });
});

describe('OAC keyset manifest (OKS1) sign/verify', () => {
  it('round-trips and verifies with the correct public key', () => {
    const { privateKey, publicKey } = keypair();
    const frame = signOacKeysetManifest(
      {
        revocationEpoch: 3,
        generatedAtServerMs: 1_772_000_000_000,
        keys: [{ signingKeyId: 'key-1', publicKey: Buffer.alloc(32, 0x09) }],
      },
      privateKey,
    );
    expect(verifyOacKeysetManifestSignature(frame, publicKey)).toBe(true);
  });

  it('rejects a tampered manifest', () => {
    const { privateKey, publicKey } = keypair();
    const frame = signOacKeysetManifest(
      {
        revocationEpoch: 3,
        generatedAtServerMs: 1_772_000_000_000,
        keys: [{ signingKeyId: 'key-1', publicKey: Buffer.alloc(32, 0x09) }],
      },
      privateKey,
    );
    const tampered = { ...frame, revocationEpoch: 4 };
    expect(verifyOacKeysetManifestSignature(tampered, publicKey)).toBe(false);
  });
});
