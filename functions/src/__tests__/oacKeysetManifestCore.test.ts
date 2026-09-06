import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildOacKeysetManifest } from '../oacKeysetManifestCore';
import { verifyOacKeysetManifestSignature } from '../oacSigner';
import { decodeOks1, encodeOks1 } from '../oacFrame';
import { privateKeyFromRaw, publicKeyFromRaw } from '../signingKeyLoader';

function rawKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const d = (privateKey.export({ format: 'jwk' }) as { d: string }).d;
  return { publicKeyBase64Url: x, privateKeyBase64Url: d };
}

describe('buildOacKeysetManifest', () => {
  it('builds a manifest that decodes and verifies with the active key', () => {
    const active = rawKeypair();
    const other = rawKeypair();
    const result = buildOacKeysetManifest(
      [
        { signingKeyId: 'key-active', publicKeyBase64Url: active.publicKeyBase64Url, status: 'ACTIVE' },
        {
          signingKeyId: 'key-other',
          publicKeyBase64Url: other.publicKeyBase64Url,
          status: 'VERIFY_ONLY',
          verifyUntilServerMs: 1_773_000_000_000,
        },
      ],
      4,
      1_772_000_000_000,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.manifest.revocationEpoch).toBe(4);
    expect(result.manifest.keys).toHaveLength(2);

    const activePublicKey = publicKeyFromRaw(active.publicKeyBase64Url);
    expect(verifyOacKeysetManifestSignature(result.manifest, activePublicKey)).toBe(true);

    const roundTripped = decodeOks1(encodeOks1(result.manifest));
    expect(roundTripped).toEqual({ ok: true, value: result.manifest });
  });

  it('fails when there are no verifiable keys', () => {
    const active = rawKeypair();
    const result = buildOacKeysetManifest(
      [],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result).toEqual({ ok: false, code: 'no_verifiable_keys' });
  });

  it('fails when the active key is not among the verifiable keys', () => {
    const active = rawKeypair();
    const other = rawKeypair();
    const result = buildOacKeysetManifest(
      [{ signingKeyId: 'key-other', publicKeyBase64Url: other.publicKeyBase64Url, status: 'ACTIVE' }],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result).toEqual({ ok: false, code: 'active_key_not_in_verifiable_set' });
  });

  it('fails when the active key has status VERIFY_ONLY (must be ACTIVE)', () => {
    const active = rawKeypair();
    const result = buildOacKeysetManifest(
      [
        {
          signingKeyId: 'key-active',
          publicKeyBase64Url: active.publicKeyBase64Url,
          status: 'VERIFY_ONLY',
          verifyUntilServerMs: 1_800_000_000_000,
        },
      ],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result).toEqual({ ok: false, code: 'active_key_not_in_verifiable_set' });
  });

  it('fails when duplicate key IDs are provided', () => {
    const active = rawKeypair();
    const result = buildOacKeysetManifest(
      [
        { signingKeyId: 'key-active', publicKeyBase64Url: active.publicKeyBase64Url, status: 'ACTIVE' },
        { signingKeyId: 'key-active', publicKeyBase64Url: active.publicKeyBase64Url, status: 'RETIRED' },
      ],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result).toEqual({ ok: false, code: 'duplicate_signing_key_id' });
  });

  it('fails when key status is invalid or VERIFY_ONLY lacks verifyUntilServerMs', () => {
    const active = rawKeypair();
    const result1 = buildOacKeysetManifest(
      [
        { signingKeyId: 'key-active', publicKeyBase64Url: active.publicKeyBase64Url, status: 'ACTIVE' },
        { signingKeyId: 'key-other', publicKeyBase64Url: active.publicKeyBase64Url, status: 'INVALID' as any },
      ],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result1).toEqual({ ok: false, code: 'invalid_key_status' });

    const result2 = buildOacKeysetManifest(
      [
        { signingKeyId: 'key-active', publicKeyBase64Url: active.publicKeyBase64Url, status: 'ACTIVE' },
        { signingKeyId: 'key-other', publicKeyBase64Url: active.publicKeyBase64Url, status: 'VERIFY_ONLY' },
      ],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result2).toEqual({ ok: false, code: 'invalid_key_expiry' });
  });
});
