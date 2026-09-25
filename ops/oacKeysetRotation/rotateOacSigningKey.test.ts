import { beforeEach, describe, expect, it, vi } from 'vitest';

// getFirestore is replaced by a spy so database selection is observable; everything
// else (FieldValue etc.) stays real. No test here ever reaches a real Firestore.
vi.mock('firebase-admin/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase-admin/firestore')>();
  return { ...actual, getFirestore: vi.fn(() => ({ __fakeFirestore: true })) };
});

import {
  buildRotatedKeysetUpdate,
  generateOacSigningKeypair,
  FIRESTORE_DATABASE_ID_RE,
  isUuidLikeDatabaseId,
  isValidNamedDatabaseId,
  locateFirebaseJson,
  normalizePriorActiveKeys,
  openTargetFirestore,
  persistRotatedKeyset,
  rawFromJwkCoordinate,
  readCanonicalDatabaseId,
  resolveTargetDatabaseId,
  signingKeyIdFromPublicKey,
} from './rotateOacSigningKey';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

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

describe('target database selection (R6-D2)', () => {
  const CANONICAL = 'pos-db';
  const UUID_LIKE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const UUID_LIKE_COMPACT = 'abcdef0123456789abcdef0123456789';

  it('resolves an explicit --database that matches the canonical database', () => {
    expect(resolveTargetDatabaseId(['node', 'x', '--database=pos-db'], CANONICAL)).toBe('pos-db');
  });

  it('fails closed when --database is missing (no implicit (default) fallback)', () => {
    expect(() => resolveTargetDatabaseId(['node', 'x'], CANONICAL)).toThrow(/--database=.*required/);
  });

  it.each([
    ['bare flag without "="', ['--database', 'pos-db']],
    ['empty value', ['--database=']],
    ['(default)', ['--database=(default)']],
    ['malformed id', ['--database=POS_DB']],
    ['too-short id', ['--database=ab']],
    ['non-canonical id', ['--database=other-db']],
    ['duplicated flag', ['--database=pos-db', '--database=pos-db']],
  ])('fails closed on %s', (_label, args) => {
    expect(() => resolveTargetDatabaseId(['node', 'x', ...args], CANONICAL)).toThrow();
  });

  it.each([undefined, '', '   '])('fails closed when the canonical database id is unavailable (%j)', (canonical) => {
    expect(() => resolveTargetDatabaseId(['node', 'x', '--database=pos-db'], canonical)).toThrow(/canonical/);
  });

  describe('firebase.json canonical source', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'r6d2-rot-'));
      return () => rmSync(tmp, { recursive: true, force: true });
    });

    it('reads firestore.database from the object form', () => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore: { database: 'pos-db', location: 'asia-southeast1' } }));
      expect(readCanonicalDatabaseId(p)).toBe('pos-db');
    });

    it('reads firestore.database from the multi-database array form', () => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore: [{ rules: 'x' }, { database: 'pos-db' }] }));
      expect(readCanonicalDatabaseId(p)).toBe('pos-db');
    });

    it('fails closed when firestore.database is missing', () => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore: { location: 'asia-southeast1' } }));
      expect(() => readCanonicalDatabaseId(p)).toThrow(/firestore\.database is missing/);
    });

    it('fails closed when firebase.json does not exist', () => {
      expect(() => readCanonicalDatabaseId(join(tmp, 'nope.json'))).toThrow(/not found/);
    });

    it('locates firebase.json from the compiled ops/lib/<dir> layout', () => {
      writeFileSync(join(tmp, 'firebase.json'), '{}');
      const compiledDir = join(tmp, 'ops', 'lib', 'oacKeysetRotation');
      mkdirSync(compiledDir, { recursive: true });
      expect(locateFirebaseJson(compiledDir)).toBe(join(tmp, 'firebase.json'));
    });

    it('fails closed when no firebase.json is within the search depth', () => {
      const deep = join(tmp, 'a', 'b', 'c', 'd', 'e', 'f', 'g');
      mkdirSync(deep, { recursive: true });
      expect(() => locateFirebaseJson(deep)).toThrow(/firebase\.json not found/);
    });
  });

  describe('fail-closed canonical validation (R6D2-B-001)', () => {
    let tmp: string;
    beforeEach(() => {
      vi.mocked(getFirestore).mockClear();
      tmp = mkdtempSync(join(tmpdir(), 'r6d2r-rot-'));
      return () => {
        rmSync(tmp, { recursive: true, force: true });
        // No rejected value may ever reach a Firestore handle.
        expect(getFirestore).not.toHaveBeenCalled();
      };
    });
    const writeFirestore = (firestore: unknown): string => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore }));
      return p;
    };

    it('UUID-like fixtures pass the base grammar, so only the UUID guard rejects them', () => {
      for (const id of [UUID_LIKE, UUID_LIKE_COMPACT]) {
        expect(FIRESTORE_DATABASE_ID_RE.test(id)).toBe(true);
        expect(isUuidLikeDatabaseId(id)).toBe(true);
        expect(isValidNamedDatabaseId(id)).toBe(false);
      }
      expect(isUuidLikeDatabaseId('pos-db')).toBe(false);
      expect(isValidNamedDatabaseId('pos-db')).toBe(true);
    });

    it.each([
      ['empty array', []],
      ['entries without database', [{ rules: 'x' }, { indexes: 'y' }]],
      ['only blank/null databases', [{ database: '' }, { database: '   ' }, { database: null }, null]],
    ])('array with zero populated database ids throws (%s)', (_label, firestore) => {
      expect(() => readCanonicalDatabaseId(writeFirestore(firestore))).toThrow(/firestore.database is missing/);
    });

    it('array with exactly one populated database id is accepted', () => {
      expect(readCanonicalDatabaseId(writeFirestore([{ rules: 'x' }, { database: '' }, { database: 'pos-db' }]))).toBe('pos-db');
    });

    it.each([
      ['two distinct', [{ database: 'pos-db' }, { database: 'other-db' }]],
      ['two identical', [{ database: 'pos-db' }, { database: 'pos-db' }]],
      ['three incl. (default)', [{ database: '(default)' }, { rules: 'x' }, { database: 'pos-db' }, { database: 'third-db' }]],
      ['one valid plus one non-string', [{ database: 'pos-db' }, { database: 42 }]],
    ])('array with two or more populated database ids throws as ambiguous (%s)', (_label, firestore) => {
      expect(() => readCanonicalDatabaseId(writeFirestore(firestore))).toThrow(/ambiguous/);
    });

    it.each([
      ['(default)', '(default)'],
      ['malformed', 'POS_DB'],
      ['too short', 'ab'],
      ['non-string', 42],
      ['UUID-like', UUID_LIKE],
      ['UUID-like compact', UUID_LIKE_COMPACT],
    ])('canonical %s id throws (object and single-entry array form)', (_label, database) => {
      expect(() => readCanonicalDatabaseId(writeFirestore({ database }))).toThrow(/not a valid named database id/);
      expect(() => readCanonicalDatabaseId(writeFirestore([{ database }]))).toThrow(/not a valid named database id/);
    });

    it.each(['(default)', 'POS_DB', UUID_LIKE, UUID_LIKE_COMPACT])(
      'resolveTargetDatabaseId rejects an invalid canonical id %j even when the CLI value matches it',
      (canonical) => {
        expect(() => resolveTargetDatabaseId([...['node', 'x'], `--database=${canonical}`], canonical)).toThrow();
        expect(() => resolveTargetDatabaseId([...['node', 'x'], '--database=pos-db'], canonical)).toThrow(/canonical/);
      },
    );

    it.each([UUID_LIKE, UUID_LIKE_COMPACT, 'abcd-ef012345-6789abcd-ef0123456789'])('CLI UUID-like id %j throws', (id) => {
      expect(() => resolveTargetDatabaseId([...['node', 'x'], `--database=${id}`], CANONICAL)).toThrow(/malformed database id/);
    });
  });

  it('resolves the repository firebase.json canonical database to pos-db', () => {
    expect(readCanonicalDatabaseId(locateFirebaseJson(TEST_DIR))).toBe('pos-db');
  });

  describe('openTargetFirestore', () => {
    const app = { name: 'fake-app' } as unknown as App;
    beforeEach(() => vi.mocked(getFirestore).mockClear());

    it('opens exactly the named database with a two-argument getFirestore call', () => {
      openTargetFirestore(app, 'pos-db');
      expect(getFirestore).toHaveBeenCalledTimes(1);
      expect(vi.mocked(getFirestore).mock.calls[0]).toHaveLength(2);
      expect(getFirestore).toHaveBeenCalledWith(app, 'pos-db');
    });

    it.each(['(default)', '', 'POS_DB', UUID_LIKE, UUID_LIKE_COMPACT])('refuses %j without calling getFirestore', (id) => {
      expect(() => openTargetFirestore(app, id)).toThrow(/valid named database/);
      expect(getFirestore).not.toHaveBeenCalled();
    });
  });

  it('source never calls getFirestore with a single argument and resolves the target before app init', () => {
    const src = readFileSync(join(TEST_DIR, 'rotateOacSigningKey.ts'), 'utf8');
    expect(src).not.toMatch(/getFirestore\(\s*[\w$.]+\s*\)/);
    const mainBody = src.slice(src.indexOf('async function main()'));
    expect(mainBody).toContain('openTargetFirestore(app, databaseId)');
    expect(mainBody.indexOf('resolveTargetDatabaseId(')).toBeGreaterThan(-1);
    expect(mainBody.indexOf('resolveTargetDatabaseId(')).toBeLessThan(mainBody.indexOf('initAdminApp()'));
  });
});
