import { beforeEach, describe, expect, it, vi } from 'vitest';

// getFirestore is replaced by a spy so database selection is observable; everything
// else stays real. No test here ever reaches a real Firestore.
vi.mock('firebase-admin/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase-admin/firestore')>();
  return { ...actual, getFirestore: vi.fn(() => ({ __fakeFirestore: true })) };
});

import {
  BOOTSTRAP_TOKEN_BYTES,
  BOOTSTRAP_TOKEN_DEFAULT_TTL_MS,
  buildBootstrapAuthorization,
  isValidIssuerId,
  FIRESTORE_DATABASE_ID_RE,
  isUuidLikeDatabaseId,
  isValidNamedDatabaseId,
  locateFirebaseJson,
  openTargetFirestore,
  readCanonicalDatabaseId,
  resolveTargetDatabaseId,
  sha256HexOfBytes,
} from './createIssuerBootstrapAuthorization';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

const TOKEN_BYTES = Buffer.alloc(BOOTSTRAP_TOKEN_BYTES, 0x42);
const TOKEN_ID_BYTES = Buffer.alloc(16, 0x01);
const NOW_MS = 1_772_000_000_000;

describe('isValidIssuerId', () => {
  it('accepts lowercase-alnum-hyphen ids of sufficient length', () => {
    expect(isValidIssuerId('hq-console-01')).toBe(true);
  });

  it('rejects empty, uppercase, and too-short ids', () => {
    expect(isValidIssuerId('')).toBe(false);
    expect(isValidIssuerId('HQ')).toBe(false);
    expect(isValidIssuerId('ab')).toBe(false);
    expect(isValidIssuerId('has spaces')).toBe(false);
  });
});

describe('buildBootstrapAuthorization', () => {
  it('produces a PENDING doc with a hashed (never raw) token', () => {
    const auth = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops-alice', TOKEN_BYTES, TOKEN_ID_BYTES);
    expect(auth.doc.issuerId).toBe('hq-console-01');
    expect(auth.doc.status).toBe('PENDING');
    expect(auth.doc.createdAtServerMs).toBe(NOW_MS);
    expect(auth.doc.expiresAtServerMs).toBe(NOW_MS + BOOTSTRAP_TOKEN_DEFAULT_TTL_MS);
    expect(auth.doc.consumedAtServerMs).toBeNull();
    expect(auth.doc.createdByOps).toBe('ops-alice');
    expect(auth.doc.tokenHash).toBe(sha256HexOfBytes(TOKEN_BYTES));
    // The raw token must never appear anywhere in the persisted doc.
    expect(JSON.stringify(auth.doc)).not.toContain(auth.rawToken);
  });

  it('derives tokenId from a separate random source than the secret token', () => {
    const auth = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops-alice', TOKEN_BYTES, TOKEN_ID_BYTES);
    expect(auth.tokenId).toBe(TOKEN_ID_BYTES.toString('hex'));
    expect(auth.tokenId).not.toBe(auth.rawToken);
  });

  it('respects a custom TTL', () => {
    const auth = buildBootstrapAuthorization(
      'hq-console-01',
      NOW_MS,
      'ops-alice',
      TOKEN_BYTES,
      TOKEN_ID_BYTES,
      60_000,
    );
    expect(auth.doc.expiresAtServerMs).toBe(NOW_MS + 60_000);
  });

  it('rejects an invalid issuerId', () => {
    expect(() => buildBootstrapAuthorization('BAD ID', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES)).toThrow();
  });

  it('rejects a wrong-length token', () => {
    expect(() =>
      buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', Buffer.alloc(10), TOKEN_ID_BYTES),
    ).toThrow(RangeError);
  });

  it('rejects a non-positive TTL', () => {
    expect(() =>
      buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES, 0),
    ).toThrow(RangeError);
  });

  it('rejects a blank operator identity', () => {
    expect(() => buildBootstrapAuthorization('hq-console-01', NOW_MS, '  ', TOKEN_BYTES, TOKEN_ID_BYTES)).toThrow();
  });

  it('is deterministic given the same injected randomness/clock', () => {
    const a = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES);
    const b = buildBootstrapAuthorization('hq-console-01', NOW_MS, 'ops', TOKEN_BYTES, TOKEN_ID_BYTES);
    expect(a).toEqual(b);
  });
});

describe('target database selection (R6-D2)', () => {
  const CANONICAL = 'pos-db';
  const UUID_LIKE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
  const UUID_LIKE_COMPACT = 'abcdef0123456789abcdef0123456789';
  const ARGV = ['node', 'x', '--issuerId=admin-console-01'];

  it('resolves an explicit --database that matches the canonical database', () => {
    expect(resolveTargetDatabaseId([...ARGV, '--database=pos-db'], CANONICAL)).toBe('pos-db');
  });

  it('fails closed when --database is missing (no implicit (default) fallback)', () => {
    expect(() => resolveTargetDatabaseId(ARGV, CANONICAL)).toThrow(/--database=.*required/);
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
    expect(() => resolveTargetDatabaseId([...ARGV, ...args], CANONICAL)).toThrow();
  });

  it.each([undefined, '', '   '])('fails closed when the canonical database id is unavailable (%j)', (canonical) => {
    expect(() => resolveTargetDatabaseId([...ARGV, '--database=pos-db'], canonical)).toThrow(/canonical/);
  });

  describe('firebase.json canonical source', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'r6d2-iss-'));
      return () => rmSync(tmp, { recursive: true, force: true });
    });

    it('reads firestore.database from the object form', () => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore: { database: 'pos-db' } }));
      expect(readCanonicalDatabaseId(p)).toBe('pos-db');
    });

    it('reads firestore.database from the multi-database array form', () => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore: [{ rules: 'x' }, { database: 'pos-db' }] }));
      expect(readCanonicalDatabaseId(p)).toBe('pos-db');
    });

    it('fails closed when firestore.database is missing', () => {
      const p = join(tmp, 'firebase.json');
      writeFileSync(p, JSON.stringify({ firestore: {} }));
      expect(() => readCanonicalDatabaseId(p)).toThrow(/firestore\.database is missing/);
    });

    it('fails closed when firebase.json does not exist', () => {
      expect(() => readCanonicalDatabaseId(join(tmp, 'nope.json'))).toThrow(/not found/);
    });

    it('locates firebase.json from the compiled ops/lib/<dir> layout', () => {
      writeFileSync(join(tmp, 'firebase.json'), '{}');
      const compiledDir = join(tmp, 'ops', 'lib', 'issuerBootstrap');
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
      tmp = mkdtempSync(join(tmpdir(), 'r6d2r-iss-'));
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
        expect(() => resolveTargetDatabaseId([...ARGV, `--database=${canonical}`], canonical)).toThrow();
        expect(() => resolveTargetDatabaseId([...ARGV, '--database=pos-db'], canonical)).toThrow(/canonical/);
      },
    );

    it.each([UUID_LIKE, UUID_LIKE_COMPACT, 'abcd-ef012345-6789abcd-ef0123456789'])('CLI UUID-like id %j throws', (id) => {
      expect(() => resolveTargetDatabaseId([...ARGV, `--database=${id}`], CANONICAL)).toThrow(/malformed database id/);
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
    const src = readFileSync(join(TEST_DIR, 'createIssuerBootstrapAuthorization.ts'), 'utf8');
    expect(src).not.toMatch(/getFirestore\(\s*[\w$.]+\s*\)/);
    const mainBody = src.slice(src.indexOf('async function main()'));
    expect(mainBody).toContain('openTargetFirestore(app, databaseId)');
    expect(mainBody.indexOf('resolveTargetDatabaseId(')).toBeGreaterThan(-1);
    expect(mainBody.indexOf('resolveTargetDatabaseId(')).toBeLessThan(mainBody.indexOf('initAdminApp()'));
  });
});
