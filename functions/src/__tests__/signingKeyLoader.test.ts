import { generateKeyPairSync, sign, verify } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadActiveSigningKey,
  loadAllVerifiableSigningKeys,
  loadRootSigningKey,
  validateRootSigningSecret,
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

  // SEC-001 R1: the pre-rotation suite proved the success path by injecting
  // `Buffer.alloc(32, 0x5a)` — the seed of the anchor that was rotated OUT
  // precisely because it was committed in plaintext. After rotation the real
  // loader's success path cannot be exercised here at all: it accepts exactly one
  // seed, that seed is in human custody, and the production anchor is deliberately
  // not runtime-overridable. So the success path is proved at the pure-helper level
  // against an ephemeral root (below), and the real loader keeps every fail-closed
  // proof plus the rotation-specific rejections here. Nothing fakes a positive
  // result for the production anchor.
  it('rejects the old compromised [0x5a;32] root seed after rotation', async () => {
    const oldCompromisedSeed = Buffer.alloc(32, 0x5a).toString('base64url');
    expect(await loadRootSigningKey(oldCompromisedSeed)).toEqual({
      ok: false,
      code: 'root_signing_key_unavailable',
    });

    process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL = oldCompromisedSeed;
    expect(await loadRootSigningKey()).toEqual({ ok: false, code: 'root_signing_key_unavailable' });
  });

  it('pins the rotated canonical root public key and never the old one', () => {
    expect(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL).toBe('81I9aC0XhQGf6VGrlM2KCoMsMJcEhV43ItODxHrYsU8');
    expect(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL).not.toBe('DXVQdU4IAKXSN-71gmA1dmubPloVhoqUCrKJlYeI47A');

    // Byte identity with the native production pin
    // (`PRODUCTION_CANONICAL_OAC_ROOT_PUBLIC_KEY` in enrollment_meta.rs).
    const raw = Buffer.from(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL, 'base64url');
    expect(raw).toHaveLength(32);
    expect(raw.toString('base64url')).toBe(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL);
    expect(raw.toString('hex')).toBe('f3523d682d1785019fe951ab94cd8a0a832c309704855e3722d383c47ad8b14f');

    // The pin must be a usable Ed25519 public key, or every consumer would fail.
    expect(publicKeyFromRaw(CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL).asymmetricKeyType).toBe('ed25519');
  });
});

describe('validateRootSigningSecret (R1/S2 internal validation seam)', () => {
  it('accepts a seed whose derived public half equals the expected anchor', () => {
    const ephemeral = generateRawKeypair();
    const res = validateRootSigningSecret(ephemeral.privateKeyBase64Url, ephemeral.publicKeyBase64Url);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.rootPublicKeyBase64Url).toBe(ephemeral.publicKeyBase64Url);

    // Real sign/verify round-trip: the returned key must actually be the private
    // half of the expected anchor, not merely structurally valid.
    const message = Buffer.from('root-signed-manifest-test');
    const signature = sign(null, message, res.rootPrivateKey);
    expect(verify(null, message, publicKeyFromRaw(ephemeral.publicKeyBase64Url), signature)).toBe(true);
  });

  it('fails closed on absent, empty, malformed, wrong-length and mismatched candidates', () => {
    const ephemeral = generateRawKeypair();
    const expected = ephemeral.publicKeyBase64Url;
    const failure = { ok: false, code: 'root_signing_key_unavailable' };

    expect(validateRootSigningSecret(undefined, expected)).toEqual(failure);
    expect(validateRootSigningSecret('', expected)).toEqual(failure);
    expect(validateRootSigningSecret('   ', expected)).toEqual(failure);
    expect(validateRootSigningSecret('!@#$%^&*()_+', expected)).toEqual(failure);
    expect(validateRootSigningSecret(Buffer.alloc(31, 0x11).toString('base64url'), expected)).toEqual(failure);
    expect(validateRootSigningSecret(Buffer.alloc(33, 0x11).toString('base64url'), expected)).toEqual(failure);
    // Valid 32-byte seed, but of a different keypair.
    expect(validateRootSigningSecret(generateRawKeypair().privateKeyBase64Url, expected)).toEqual(failure);
  });

  it('rejects non-canonical base64url spellings of an otherwise-correct seed', () => {
    const ephemeral = generateRawKeypair();
    // Standard-base64 padding/alphabet is not the canonical base64url spelling the
    // loader requires, so it must be rejected even though it decodes to the right bytes.
    const padded = `${ephemeral.privateKeyBase64Url}=`;
    expect(validateRootSigningSecret(padded, ephemeral.publicKeyBase64Url)).toEqual({
      ok: false,
      code: 'root_signing_key_unavailable',
    });
  });
});

describe('Production Source Audit (No root private seed outside test boundaries)', () => {
  const productionSrcDir = path.resolve(__dirname, '..');

  /** Every tracked production `.ts` under functions/src (tests excluded). */
  function productionSourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
      }
    };
    walk(productionSrcDir);
    return out;
  }

  it('functions production source has no committed root private seed', () => {
    const signingKeyLoaderPath = path.resolve(__dirname, '../signingKeyLoader.ts');
    const content = fs.readFileSync(signingKeyLoaderPath, 'utf8');
    expect(content).not.toContain('CANONICAL_SERVER_ROOT_PRIVATE_KEY_SEED');
    expect(content).not.toContain('Buffer.alloc(32, 0x5a)');
    expect(content).not.toContain('getCanonicalRootSigningKey');
  });

  // SEC-001 R1 rotation audit.
  it('no production source retains the old compromised root public pin', () => {
    const offenders = productionSourceFiles().filter((file) =>
      fs.readFileSync(file, 'utf8').includes('DXVQdU4IAKXSN-71gmA1dmubPloVhoqUCrKJlYeI47A'),
    );
    expect(offenders).toEqual([]);
  });

  it('no tracked source carries the production root private seed', () => {
    // Exact, not heuristic. The R2 private seed's VALUE is deliberately unknown
    // here, so instead of string-comparing against it, every base64url-shaped
    // literal in tracked source is fed to the REAL validator against the
    // production anchor: a literal that validates IS the production root private
    // seed. That proves the seed was never committed without this test — or the
    // implementer — ever needing to know it. Covers the test files too, since the
    // seed must not appear anywhere, not just in production code.
    const candidateLiteral = /['"`]([A-Za-z0-9_-]{43,44}=?)['"`]/g;
    const testFiles = fs
      .readdirSync(__dirname)
      .filter((f) => f.endsWith('.test.ts'))
      .map((f) => path.join(__dirname, f));

    const offenders: string[] = [];
    for (const file of [...productionSourceFiles(), ...testFiles]) {
      const content = fs.readFileSync(file, 'utf8');
      for (const [, literal] of content.matchAll(candidateLiteral)) {
        if (validateRootSigningSecret(literal, CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL).ok) {
          offenders.push(path.basename(file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the production trust anchor non-overridable outside signingKeyLoader.ts', () => {
    // R1/S2 invariant: `validateRootSigningSecret` takes an expected-anchor
    // argument so tests can use an ephemeral root. No OTHER production file may
    // call it, or the production anchor would become selectable at a call site.
    const callers = productionSourceFiles().filter(
      (file) =>
        path.basename(file) !== 'signingKeyLoader.ts' &&
        fs.readFileSync(file, 'utf8').includes('validateRootSigningSecret'),
    );
    expect(callers).toEqual([]);

    // And inside the loader, the only anchor passed is the compile-time constant:
    // no env, request, header or Firestore value may reach that argument.
    const loaderSource = fs.readFileSync(path.resolve(productionSrcDir, 'signingKeyLoader.ts'), 'utf8');
    expect(loaderSource).toContain(
      'return validateRootSigningSecret(secret, CANONICAL_OAC_ROOT_PUBLIC_KEY_BASE64URL);',
    );
    // The loader still reads exactly the one documented env carrier.
    expect(loaderSource).toContain('process.env.OAC_ROOT_PRIVATE_KEY_BASE64URL');
  });
});
