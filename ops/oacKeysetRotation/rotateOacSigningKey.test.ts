import { describe, expect, it } from 'vitest';
import {
  buildRotatedKeysetUpdate,
  generateOacSigningKeypair,
  normalizePriorActiveKeys,
  persistRotatedKeyset,
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

describe('normalizePriorActiveKeys', () => {
  it('normalizes surplus active keys to VERIFY_ONLY with 96h window and retires expired verify-only keys', () => {
    const existing = [
      { signingKeyId: 'key-old-1', status: 'ACTIVE' as const },
      { signingKeyId: 'key-old-2', status: 'ACTIVE' as const },
      { signingKeyId: 'key-unexpired', status: 'VERIFY_ONLY' as const, verifyUntilServerMs: NOW_MS + 10_000 },
      { signingKeyId: 'key-expired', status: 'VERIFY_ONLY' as const, verifyUntilServerMs: NOW_MS - 10_000 },
      { signingKeyId: 'key-retired', status: 'RETIRED' as const },
      { signingKeyId: 'key-new', status: 'ACTIVE' as const },
    ];
    const updates = normalizePriorActiveKeys(existing, 'key-new', NOW_MS);
    expect(updates).toEqual([
      { signingKeyId: 'key-old-1', status: 'VERIFY_ONLY', verifyUntilServerMs: NOW_MS + 345_600_000 },
      { signingKeyId: 'key-old-2', status: 'VERIFY_ONLY', verifyUntilServerMs: NOW_MS + 345_600_000 },
      { signingKeyId: 'key-expired', status: 'RETIRED' },
    ]);
  });

  it('retires VERIFY_ONLY keys at exact expiry boundary (<= nowMs)', () => {
    const existing = [
      { signingKeyId: 'key-exact-boundary', status: 'VERIFY_ONLY' as const, verifyUntilServerMs: NOW_MS },
      { signingKeyId: 'key-just-after-now', status: 'VERIFY_ONLY' as const, verifyUntilServerMs: NOW_MS + 1 },
    ];
    const updates = normalizePriorActiveKeys(existing, 'key-new', NOW_MS);
    expect(updates).toEqual([
      { signingKeyId: 'key-exact-boundary', status: 'RETIRED' },
    ]);
  });
});

describe('persistRotatedKeyset concurrency & persistence', () => {
  interface MockDocState {
    data: Record<string, any>;
    version: number;
  }

  function createMockFirestore() {
    const store = new Map<string, MockDocState>();

    const db: any = {
      _store: store,
      collection: (col: string) => ({
        id: col,
        doc: (id: string) => ({
          id,
          path: `${col}/${id}`,
        }),
      }),
      runTransaction: async <T>(updateFn: (t: any) => Promise<T>): Promise<T> => {
        let attempts = 0;
        const maxAttempts = 10;
        while (attempts < maxAttempts) {
          attempts++;
          const readVersions = new Map<string, number>();
          const pendingWrites: Array<() => void> = [];

          const tx = {
            get: async (target: any) => {
              if (target.path) {
                const path = target.path;
                const entry = store.get(path);
                readVersions.set(path, entry ? entry.version : 0);
                return {
                  exists: !!entry,
                  id: target.id,
                  data: () => (entry ? JSON.parse(JSON.stringify(entry.data)) : undefined),
                };
              } else {
                const colName = target.id;
                const prefix = `${colName}/`;
                const docs: Array<{ id: string; data: () => any }> = [];
                for (const [key, entry] of store.entries()) {
                  if (key.startsWith(prefix)) {
                    const id = key.slice(prefix.length);
                    readVersions.set(key, entry.version);
                    docs.push({ id, data: () => JSON.parse(JSON.stringify(entry.data)) });
                  }
                }
                // Also track meta version if querying keys
                return { docs };
              }
            },
            set: (docRef: any, data: any) => {
              pendingWrites.push(() => {
                const current = store.get(docRef.path);
                store.set(docRef.path, {
                  data: { ...data },
                  version: (current ? current.version : 0) + 1,
                });
              });
            },
            update: (docRef: any, data: any) => {
              pendingWrites.push(() => {
                const current = store.get(docRef.path);
                if (!current) throw new Error(`Document not found: ${docRef.path}`);
                store.set(docRef.path, {
                  data: { ...current.data, ...data },
                  version: current.version + 1,
                });
              });
            },
          };

          const result = await updateFn(tx);

          let conflict = false;
          for (const [path, expectedVer] of readVersions.entries()) {
            const current = store.get(path);
            const currentVer = current ? current.version : 0;
            if (currentVer !== expectedVer) {
              conflict = true;
              break;
            }
          }

          if (conflict) {
            // Small delay to simulate backoff before retry
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }

          for (const write of pendingWrites) {
            write();
          }
          return result;
        }
        throw new Error('Transaction exceeded max retry attempts');
      },
    };

    return db;
  }

  it('handles concurrent rotations, ensuring exactly one ACTIVE key and updating meta doc atomically', async () => {
    const db = createMockFirestore();

    const keypairA = generateOacSigningKeypair();
    const updateA = buildRotatedKeysetUpdate(keypairA.publicKeyBase64Url, keypairA.privateKeyBase64Url, NOW_MS, 'ops-a');

    const keypairB = generateOacSigningKeypair();
    const updateB = buildRotatedKeysetUpdate(keypairB.publicKeyBase64Url, keypairB.privateKeyBase64Url, NOW_MS + 100, 'ops-b');

    // Run both rotations concurrently
    const [resA, resB] = await Promise.all([
      persistRotatedKeyset(db, updateA, NOW_MS),
      persistRotatedKeyset(db, updateB, NOW_MS + 100),
    ]);

    expect(resA).toBeDefined();
    expect(resB).toBeDefined();

    // Inspect final store state
    const metaEntry = db._store.get('privilegedOacKeysetMeta/current');
    expect(metaEntry).toBeDefined();
    expect(metaEntry.data.generation).toBe(2);

    const activeSigningKeyId = metaEntry.data.activeSigningKeyId;
    expect([updateA.keyDoc.signingKeyId, updateB.keyDoc.signingKeyId]).toContain(activeSigningKeyId);

    // Count ACTIVE keys
    const allKeys: any[] = [];
    for (const [k, v] of db._store.entries()) {
      if (k.startsWith('privilegedOacSigningKeys/')) {
        allKeys.push(v.data);
      }
    }

    const activeKeys = allKeys.filter((k) => k.status === 'ACTIVE');
    const verifyOnlyKeys = allKeys.filter((k) => k.status === 'VERIFY_ONLY');

    expect(activeKeys.length).toBe(1);
    expect(activeKeys[0].signingKeyId).toBe(activeSigningKeyId);
    expect(verifyOnlyKeys.length).toBe(1);
  });

  it('retires expired VERIFY_ONLY keys on subsequent rotation', async () => {
    const db = createMockFirestore();

    const kp1 = generateOacSigningKeypair();
    const u1 = buildRotatedKeysetUpdate(kp1.publicKeyBase64Url, kp1.privateKeyBase64Url, NOW_MS, 'ops');
    await persistRotatedKeyset(db, u1, NOW_MS);

    // Rotate 2nd time: kp1 becomes VERIFY_ONLY until NOW_MS + 345_600_000
    const kp2 = generateOacSigningKeypair();
    const u2 = buildRotatedKeysetUpdate(kp2.publicKeyBase64Url, kp2.privateKeyBase64Url, NOW_MS + 1000, 'ops');
    await persistRotatedKeyset(db, u2, NOW_MS + 1000);

    const doc1AfterRot2 = db._store.get(`privilegedOacSigningKeys/${u1.keyDoc.signingKeyId}`);
    expect(doc1AfterRot2.data.status).toBe('VERIFY_ONLY');

    // Rotate 3rd time after expiration window: kp1 should be RETIRED
    const expiredTime = NOW_MS + 345_600_000 + 10_000;
    const kp3 = generateOacSigningKeypair();
    const u3 = buildRotatedKeysetUpdate(kp3.publicKeyBase64Url, kp3.privateKeyBase64Url, expiredTime, 'ops');
    const norm3 = await persistRotatedKeyset(db, u3, expiredTime);

    const doc1AfterRot3 = db._store.get(`privilegedOacSigningKeys/${u1.keyDoc.signingKeyId}`);
    expect(doc1AfterRot3.data.status).toBe('RETIRED');
    expect(doc1AfterRot3.data.retiredAtServerMs).toBe(expiredTime);

    const doc2AfterRot3 = db._store.get(`privilegedOacSigningKeys/${u2.keyDoc.signingKeyId}`);
    expect(doc2AfterRot3.data.status).toBe('VERIFY_ONLY');

    const doc3AfterRot3 = db._store.get(`privilegedOacSigningKeys/${u3.keyDoc.signingKeyId}`);
    expect(doc3AfterRot3.data.status).toBe('ACTIVE');

    expect(norm3).toContainEqual(
      expect.objectContaining({
        signingKeyId: u1.keyDoc.signingKeyId,
        status: 'RETIRED',
      }),
    );
  });
});
