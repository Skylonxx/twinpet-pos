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
        { signingKeyId: 'key-active', publicKeyBase64Url: active.publicKeyBase64Url },
        { signingKeyId: 'key-other', publicKeyBase64Url: other.publicKeyBase64Url },
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
      [{ signingKeyId: 'key-other', publicKeyBase64Url: other.publicKeyBase64Url }],
      0,
      1,
      'key-active',
      privateKeyFromRaw(active.publicKeyBase64Url, active.privateKeyBase64Url),
    );
    expect(result).toEqual({ ok: false, code: 'active_key_not_in_verifiable_set' });
  });
});
