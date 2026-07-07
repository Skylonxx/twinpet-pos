// asyncOrderLookup — unwired, read-only `asyncOrders` existence adapter.
//
// Mocking style mirrors src/lib/pos/asyncCheckout.w01.test.ts: `vi.mock` +
// `vi.hoisted` so the (hoisted) mock factories can be reconfigured per test,
// and only the exports under test (`doc`, `getDocFromServer`, `isFirebaseConfigured`,
// `db`) are overridden — every other transitive import stays real.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { normalizeLookupError } from './saleIntentSweepLogic';

const { firebaseState } = vi.hoisted(() => ({
  firebaseState: { isFirebaseConfigured: true as boolean, db: {} as unknown },
}));

vi.mock('../../firebase', () => ({
  get isFirebaseConfigured() {
    return firebaseState.isFirebaseConfigured;
  },
  get db() {
    return firebaseState.db;
  },
}));

const { getDocFromServerMock, docMock } = vi.hoisted(() => ({
  getDocFromServerMock: vi.fn(),
  docMock: vi.fn(() => ({}) as never),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: docMock,
    getDocFromServer: getDocFromServerMock,
  };
});

// Imported AFTER the mocks are declared (vi.mock is hoisted, so this is safe).
import { createAsyncOrderServerLookup } from './asyncOrderLookup';

const permissionDenied = Object.assign(new Error('Missing or insufficient permissions.'), {
  code: 'permission-denied',
});
const unauthenticated = Object.assign(new Error('no auth'), { code: 'unauthenticated' });
const unavailable = Object.assign(new Error('offline'), { code: 'unavailable' });
const unknownError = new Error('boom');

beforeEach(() => {
  firebaseState.isFirebaseConfigured = true;
  firebaseState.db = {};
  getDocFromServerMock.mockReset();
  docMock.mockClear();
});

describe('asyncOrderLookup · existence outcomes', () => {
  test('existing server snapshot returns { exists: true }', async () => {
    getDocFromServerMock.mockResolvedValueOnce({ exists: () => true });
    const lookup = createAsyncOrderServerLookup();
    expect(lookup).not.toBeNull();
    const result = await lookup!('DEV1-000001');
    expect(result).toEqual({ exists: true });
  });

  test(
    'missing server snapshot returns { exists: false } — the clean admin-token path; ' +
      'under branch-scoped asyncOrders rules a staff token reading a missing doc ' +
      'instead hard-errors to permission-denied (covered separately below), so this ' +
      'exists:false branch is only reachable for an admin-scoped lookup token',
    async () => {
      getDocFromServerMock.mockResolvedValueOnce({ exists: () => false });
      const lookup = createAsyncOrderServerLookup();
      const result = await lookup!('DEV1-000002');
      expect(result).toEqual({ exists: false });
    },
  );
});

describe('asyncOrderLookup · error propagation (raw, uncaught) through normalizeLookupError', () => {
  test('permission-denied rejection propagates raw and normalizes to a known ambiguous reason', async () => {
    // Also documents the staff missing-doc route: for a staff-scoped token, rules
    // evaluating resource.data.branchId on a nonexistent doc hard-errors to
    // permission-denied rather than a clean not-found — so this is the path that
    // actually represents "staff reads a missing doc" in production.
    getDocFromServerMock.mockRejectedValueOnce(permissionDenied);
    const lookup = createAsyncOrderServerLookup();
    await expect(lookup!('DEV1-000003')).rejects.toBe(permissionDenied);
    expect(normalizeLookupError(permissionDenied)).toEqual({ kind: 'error', reason: 'permission-denied' });
  });

  test('unauthenticated rejection propagates raw and normalizes correctly', async () => {
    getDocFromServerMock.mockRejectedValueOnce(unauthenticated);
    const lookup = createAsyncOrderServerLookup();
    await expect(lookup!('DEV1-000004')).rejects.toBe(unauthenticated);
    expect(normalizeLookupError(unauthenticated)).toEqual({ kind: 'error', reason: 'unauthenticated' });
  });

  test('unavailable rejection propagates raw and normalizes correctly', async () => {
    getDocFromServerMock.mockRejectedValueOnce(unavailable);
    const lookup = createAsyncOrderServerLookup();
    await expect(lookup!('DEV1-000005')).rejects.toBe(unavailable);
    expect(normalizeLookupError(unavailable)).toEqual({ kind: 'error', reason: 'unavailable' });
  });

  test('unknown error propagates raw and normalizes to reason "unknown"', async () => {
    getDocFromServerMock.mockRejectedValueOnce(unknownError);
    const lookup = createAsyncOrderServerLookup();
    await expect(lookup!('DEV1-000006')).rejects.toBe(unknownError);
    expect(normalizeLookupError(unknownError)).toEqual({ kind: 'error', reason: 'unknown' });
  });
});

describe('asyncOrderLookup · factory gating', () => {
  test('returns null when Firebase is not configured', () => {
    firebaseState.isFirebaseConfigured = false;
    firebaseState.db = {};
    expect(createAsyncOrderServerLookup()).toBeNull();
  });

  test('returns null when db is unavailable', () => {
    firebaseState.isFirebaseConfigured = true;
    firebaseState.db = undefined;
    expect(createAsyncOrderServerLookup()).toBeNull();
  });
});

describe('asyncOrderLookup · existence-only (no payload read)', () => {
  test('never calls snap.data()', async () => {
    const dataSpy = vi.fn(() => {
      throw new Error('snap.data() must never be called by an existence-only adapter');
    });
    getDocFromServerMock.mockResolvedValueOnce({ exists: () => true, data: dataSpy });
    const lookup = createAsyncOrderServerLookup();
    const result = await lookup!('DEV1-000007');
    expect(result).toEqual({ exists: true });
    expect(dataSpy).not.toHaveBeenCalled();
  });
});

// ─── Source-level contract (getDocFromServer-only pin) ───────────────────────
describe('asyncOrderLookup · source contract', () => {
  let source: string;
  beforeEach(async () => {
    source = (await import('./asyncOrderLookup.ts?raw')).default;
  });

  // Scoped to the actual firebase/firestore import specifier list and to call
  // expressions — not a whole-source prose scan — so a doc-comment that
  // explains the getDoc hazard by name (e.g. "a cache-first `getDoc` could
  // return...") can't itself trip a "no plain getDoc" pin. A naive
  // `source.includes('getDoc')` would also be a false negative-check risk in
  // the opposite direction (it happens to not match inside "getDocFromServer"
  // only because of the trailing "From..." rather than by deliberate design),
  // so the import list is asserted precisely instead.
  const importSpecifierList = () =>
    source.match(/import\s*{([^}]*)}\s*from\s*'firebase\/firestore';/)?.[1] ?? '';

  test('uses getDocFromServer', () => {
    expect(source).toContain('getDocFromServer(');
    expect(importSpecifierList()).toMatch(/\bgetDocFromServer\b/);
  });

  test('never imports or calls plain getDoc', () => {
    expect(source).not.toContain('getDoc(');
    expect(importSpecifierList()).not.toMatch(/\bgetDoc\b/);
  });

  test('never imports or calls getDocFromCache', () => {
    expect(source).not.toContain('getDocFromCache(');
    expect(importSpecifierList()).not.toMatch(/\bgetDocFromCache\b/);
  });

  test('never calls snap.data() in source', () => {
    expect(source).not.toContain('.data()');
  });
});
