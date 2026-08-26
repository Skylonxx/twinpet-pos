import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const adminAppMocks = vi.hoisted(() => ({
  initializeApp: vi.fn((opts: { projectId?: string; credential?: unknown } = {}) => ({
    name: '[DEFAULT]',
    options: { projectId: opts.projectId },
  })),
  cert: vi.fn((value: unknown) => ({ __operatorCert: value })),
  getApps: vi.fn((): unknown[] => []),
  applicationDefault: vi.fn(),
}));

const firestoreAdminMocks = vi.hoisted(() => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
  getFirestore: vi.fn((app: unknown, databaseId?: string) => ({
    __operatorTestFirestore: true,
    app,
    databaseId,
  })),
}));

const authAdminMocks = vi.hoisted(() => {
  const getUser = vi.fn();
  const listUsers = vi.fn();
  const revokeRefreshTokens = vi.fn();
  const setCustomUserClaims = vi.fn();
  const createCustomToken = vi.fn();
  const createUser = vi.fn();
  const updateUser = vi.fn();
  const deleteUser = vi.fn();
  return {
    getUser,
    listUsers,
    revokeRefreshTokens,
    setCustomUserClaims,
    createCustomToken,
    createUser,
    updateUser,
    deleteUser,
    getAuth: vi.fn(() => ({
      getUser,
      listUsers,
      revokeRefreshTokens,
      setCustomUserClaims,
      createCustomToken,
      createUser,
      updateUser,
      deleteUser,
    })),
  };
});

vi.mock('firebase-admin/app', () => adminAppMocks);
vi.mock('firebase-admin/firestore', () => firestoreAdminMocks);
vi.mock('firebase-admin/auth', () => authAdminMocks);

import {
  AUTH_LIST_USERS_PAGE_SIZE,
  executeForceReauthActiveStaffCli,
  formatForceReauthActiveStaffResult,
  isForceReauthActiveStaffCliEntry,
  parseForceReauthActiveStaffCliArgs,
  planForceReauthActiveStaff,
  runForceReauthActiveStaff,
  type ForceReauthAuth,
  type ForceReauthListedUser,
} from '../forceReauthActiveStaff';
import {
  executeSetUsernameMigrationMaintenanceModeCli,
  parseSetUsernameMigrationMaintenanceModeCliArgs,
  runDisableUsernameMigrationMaintenanceMode,
  runSetUsernameMigrationMaintenanceMode,
} from '../setUsernameMigrationMaintenanceMode';

type Doc = Record<string, unknown>;
type WriteOp = { op: string; path?: string };
type ReadOp = { op: 'get'; path: string };

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const writes: WriteOp[] = [];
  const reads: ReadOp[] = [];
  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    }
    return v;
  };
  function docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => {
        reads.push({ op: 'get', path });
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
      set: async (data: Doc, opts?: { merge?: boolean }) => {
        writes.push({ op: 'set', path });
        if (!opts?.merge) {
          store.set(path, { ...data });
          return;
        }
        const existing = store.get(path) ?? {};
        const next: Doc = { ...existing };
        for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
        store.set(path, next);
      },
      update: async (data: Doc) => {
        writes.push({ op: 'update', path });
        const existing = store.get(path) ?? {};
        store.set(path, { ...existing, ...data });
      },
      create: async (data: Doc) => {
        writes.push({ op: 'create', path });
        store.set(path, { ...data });
      },
      delete: async () => {
        writes.push({ op: 'delete', path });
        store.delete(path);
      },
    };
  }
  return {
    collection: (c: string) => ({
      doc: (id: string) => docRef(`${c}/${id}`),
      get: async () => {
        reads.push({ op: 'get', path: c });
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${c}/`) && !p.slice(c.length + 1).includes('/'))
          .map(([p, data]) => ({
            id: p.slice(p.lastIndexOf('/') + 1),
            data: () => data,
            ref: docRef(p),
          }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    }),
    batch: () => {
      writes.push({ op: 'batch' });
      return {
        set: () => undefined,
        update: () => undefined,
        delete: () => undefined,
        commit: async () => {
          writes.push({ op: 'batch.commit' });
        },
      };
    },
    runTransaction: async () => {
      writes.push({ op: 'runTransaction' });
    },
    __store: store,
    __writes: writes,
    __reads: reads,
  };
}

function snapshot(store: Map<string, Doc>): string {
  return JSON.stringify([...store.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function makeAuth(
  users: ForceReauthListedUser[],
  opts: { pageSize?: number; failOnPage?: number } = {},
): ForceReauthAuth & {
  setCustomUserClaims: ReturnType<typeof vi.fn>;
  createCustomToken: ReturnType<typeof vi.fn>;
  createUser: ReturnType<typeof vi.fn>;
  updateUser: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  listUsers: ReturnType<typeof vi.fn>;
  revokeRefreshTokens: ReturnType<typeof vi.fn>;
} {
  const pageSize = Math.max(1, opts.pageSize ?? Math.max(users.length, 1));
  let pageCalls = 0;
  const listUsers = vi.fn(async (_max?: number, pageToken?: string) => {
    pageCalls += 1;
    if (opts.failOnPage !== undefined && pageCalls === opts.failOnPage) {
      throw new Error('forced-listUsers-failure');
    }
    const start = pageToken ? Number.parseInt(pageToken, 10) : 0;
    if (!Number.isFinite(start) || start < 0) throw new Error('bad-page-token');
    const slice = users.slice(start, start + pageSize);
    const next = start + pageSize;
    return {
      users: slice,
      pageToken: next < users.length ? String(next) : undefined,
    };
  });
  const setCustomUserClaims = vi.fn();
  const createCustomToken = vi.fn();
  const createUser = vi.fn();
  const updateUser = vi.fn();
  const deleteUser = vi.fn();
  const revokeRefreshTokens = vi.fn(async () => undefined);
  return {
    listUsers,
    revokeRefreshTokens,
    setCustomUserClaims,
    createCustomToken,
    createUser,
    updateUser,
    deleteUser,
  };
}

function assertZeroAuthMutation(
  auth: ReturnType<typeof makeAuth>,
  opts: { revokeCount?: number } = {},
) {
  expect(auth.setCustomUserClaims).not.toHaveBeenCalled();
  expect(auth.createCustomToken).not.toHaveBeenCalled();
  expect(auth.createUser).not.toHaveBeenCalled();
  expect(auth.updateUser).not.toHaveBeenCalled();
  expect(auth.deleteUser).not.toHaveBeenCalled();
  expect(auth.revokeRefreshTokens).toHaveBeenCalledTimes(opts.revokeCount ?? 0);
}

function assertZeroFirestoreMutation(db: ReturnType<typeof makeDb>, before: string) {
  expect(snapshot(db.__store)).toBe(before);
  expect(db.__writes).toEqual([]);
}

function assertPlanningFinishedBeforeRevoke(auth: ReturnType<typeof makeAuth>) {
  const listOrders = auth.listUsers.mock.invocationCallOrder;
  const revokeOrders = auth.revokeRefreshTokens.mock.invocationCallOrder;
  expect(listOrders.length).toBeGreaterThan(0);
  if (revokeOrders.length === 0) return;
  expect(Math.max(...listOrders)).toBeLessThan(Math.min(...revokeOrders));
}

function assertSafePrinted(printed: string) {
  expect(printed).not.toMatch(/pinHash|private_key|password|refreshToken|idToken|customClaims/i);
}

const BINDING = ['--project=demo-twinpet', '--database=pos-db', '--credentials=unused-sa.json'];
const EMPTY_ENV: NodeJS.ProcessEnv = {};
const PROJECT_A = 'twinpet-cli-project-a';
const PROJECT_B = 'twinpet-cli-project-b';
const DATABASE_ID = 'pos-db-exact-bound';

const ACTIVE_SEED = {
  'users/admin': {
    id: 'admin',
    username: 'admin',
    isActive: true,
    deletedAt: null,
    authVersion: 1,
  },
  'users/nara': {
    id: 'nara',
    username: 'nara',
    isActive: true,
    deletedAt: null,
    authVersion: 1,
  },
  'users/inactive': {
    id: 'inactive',
    username: 'inactive',
    isActive: false,
    deletedAt: null,
    authVersion: 0,
  },
  'users/deleted': {
    id: 'deleted',
    username: 'deleted',
    isActive: true,
    deletedAt: '2026-01-01T00:00:00.000Z',
    authVersion: 0,
  },
};

const ADMIN_ONLY_SEED = {
  'users/admin': ACTIVE_SEED['users/admin'],
  'users/inactive': ACTIVE_SEED['users/inactive'],
  'users/deleted': ACTIVE_SEED['users/deleted'],
};

const CANONICAL_ADMIN_NARA: ForceReauthListedUser[] = [{ uid: 'admin' }, { uid: 'nara' }];

describe('forceReauthActiveStaff parser / binding', () => {
  test('accepts --dry-run and --apply independently', () => {
    const dry = parseForceReauthActiveStaffCliArgs([...BINDING, '--dry-run'], EMPTY_ENV);
    expect(dry).toEqual({
      projectId: 'demo-twinpet',
      databaseId: 'pos-db',
      credentialsPath: 'unused-sa.json',
      apply: false,
      dryRun: true,
    });
    const apply = parseForceReauthActiveStaffCliArgs([...BINDING, '--apply'], EMPTY_ENV);
    expect(apply.apply).toBe(true);
    expect(apply.dryRun).toBe(false);
  });

  test('rejects --dry-run combined with --apply', () => {
    expect(() => parseForceReauthActiveStaffCliArgs([...BINDING, '--dry-run', '--apply'], EMPTY_ENV))
      .toThrow(/INVALID_MODE/);
  });

  test('rejects neither mode', () => {
    expect(() => parseForceReauthActiveStaffCliArgs([...BINDING], EMPTY_ENV)).toThrow(/MISSING_MODE/);
  });

  test('requires explicit project, database, and credentials', () => {
    expect(() => parseForceReauthActiveStaffCliArgs(
      ['--database=pos-db', '--credentials=x.json', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_PROJECT/);
    expect(() => parseForceReauthActiveStaffCliArgs(
      ['--project=demo', '--credentials=x.json', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_DATABASE/);
    expect(() => parseForceReauthActiveStaffCliArgs(
      ['--project=demo', '--database=pos-db', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_CREDENTIALS/);
  });

  test('does not silently default FIRESTORE_DATABASE_ID and does not use ADC or forbidden Auth APIs in source', () => {
    const src = readFileSync(resolve(__dirname, '../forceReauthActiveStaff.ts'), 'utf8');
    expect(src).not.toMatch(/FIRESTORE_DATABASE_ID/);
    expect(src).not.toMatch(/applicationDefault\s*\(/);
    expect(src).not.toMatch(/\.setCustomUserClaims\s*\(/);
    expect(src).not.toMatch(/createCustomToken/);
    expect(src).not.toMatch(/createUser\s*\(/);
    expect(src).not.toMatch(/deleteUser\s*\(/);
    expect(src).not.toMatch(/\.getUser\s*\(/);
    expect(src).toMatch(/listUsers/);
    expect(src).toMatch(/revokeRefreshTokens/);
    expect(src).toMatch(/customClaims\?\.staffId|claims\.staffId/);
  });

  test('GOOGLE_APPLICATION_CREDENTIALS may supply the credentials path; ADC is still unused', () => {
    const args = parseForceReauthActiveStaffCliArgs(
      ['--project=demo', '--database=pos-db', '--dry-run'],
      { GOOGLE_APPLICATION_CREDENTIALS: 'from-env.json' },
    );
    expect(args.credentialsPath).toBe('from-env.json');
  });
});

describe('forceReauthActiveStaff identity mapping (F-001)', () => {
  test('Case A — anonymous PIN identity is revoked; canonical staff id is not required', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth([{ uid: 'anon-uid-1', customClaims: { staffId: 'admin' } }]);
    const before = snapshot(db.__store);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(true);
    expect(res.complete).toBe(true);
    expect(res.mappedAuthUidCount).toBe(1);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0])).toEqual(['anon-uid-1']);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0])).not.toContain('admin');
    assertZeroAuthMutation(auth, { revokeCount: 1 });
    assertZeroFirestoreMutation(db, before);
    assertPlanningFinishedBeforeRevoke(auth);
  });

  test('Case B — canonical + anonymous identities are both revoked exactly once', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth([
      { uid: 'admin' },
      { uid: 'anon-uid-1', customClaims: { staffId: 'admin' } },
    ]);
    const plan = await planForceReauthActiveStaff(db as never, auth);
    expect(plan.ok).toBe(true);
    expect(plan.revokeUids.sort()).toEqual(['admin', 'anon-uid-1']);
    expect(new Set(plan.revokeUids).size).toBe(2);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.revokedCount).toBe(2);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0]).sort()).toEqual(['admin', 'anon-uid-1']);
    expect(auth.revokeRefreshTokens).toHaveBeenCalledTimes(2);
  });

  test('Case C — multiple anonymous sessions for one staff are all revoked', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth([
      { uid: 'anon-1', customClaims: { staffId: 'admin' } },
      { uid: 'anon-2', customClaims: { staffId: 'admin' } },
    ]);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(true);
    expect(res.mappedAuthUidCount).toBe(2);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0]).sort()).toEqual(['anon-1', 'anon-2']);
  });

  test('Case D — multiple staff with distinct anonymous session UIDs', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth([
      { uid: 'anon-admin', customClaims: { staffId: 'admin' } },
      { uid: 'anon-nara', customClaims: { staffId: 'nara' } },
    ]);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(true);
    expect(res.activeStaffCount).toBe(2);
    expect(res.mappedAuthUidCount).toBe(2);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0]).sort()).toEqual(['anon-admin', 'anon-nara']);
  });

  test('Case E — planning reads every listUsers page before the first revoke', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth(
      [
        { uid: 'unrelated-uid' },
        { uid: 'anon-uid-late', customClaims: { staffId: 'admin' } },
      ],
      { pageSize: 1 },
    );
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(true);
    expect(auth.listUsers.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(auth.listUsers.mock.calls.every((c) => c[0] === AUTH_LIST_USERS_PAGE_SIZE)).toBe(true);
    expect(res.authPagesScanned).toBeGreaterThanOrEqual(2);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0])).toEqual(['anon-uid-late']);
    assertPlanningFinishedBeforeRevoke(auth);
  });

  test('Case F — later page enumeration failure causes zero revokes', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth(
      [
        { uid: 'anon-uid-1', customClaims: { staffId: 'admin' } },
        { uid: 'anon-uid-2', customClaims: { staffId: 'admin' } },
      ],
      { pageSize: 1, failOnPage: 2 },
    );
    const before = snapshot(db.__store);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.error).toMatch(/^AUTH_ENUMERATION_FAILED:/);
    expect(res.revokedCount).toBe(0);
    expect(res.failedCount).toBe(0);
    expect(res.mappedAuthUidCount).toBe(0);
    assertZeroAuthMutation(auth);
    assertZeroFirestoreMutation(db, before);
  });

  test('Case G — claims pointing at inactive/deleted staff are excluded', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth([
      { uid: 'anon-inactive', customClaims: { staffId: 'inactive' } },
      { uid: 'anon-deleted', customClaims: { staffId: 'deleted' } },
      { uid: 'anon-admin', customClaims: { staffId: 'admin' } },
    ]);
    const plan = await planForceReauthActiveStaff(db as never, auth);
    expect(plan.ok).toBe(true);
    expect(plan.revokeUids).toEqual(['anon-admin']);
    expect(plan.revokeUids).not.toContain('anon-inactive');
    expect(plan.revokeUids).not.toContain('anon-deleted');
    expect(plan.nonTargetClaimCount).toBe(2);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0])).toEqual(['anon-admin']);
  });

  test('Case H — active staff with zero mapped Auth UIDs does not fabricate or create a user', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth([]);
    const before = snapshot(db.__store);
    const plan = await planForceReauthActiveStaff(db as never, auth);
    expect(plan.ok).toBe(true);
    expect(plan.activeStaffCount).toBe(2);
    expect(plan.mappedAuthUidCount).toBe(0);
    expect(plan.perStaffMappedUidCount).toEqual([
      { userId: 'admin', mappedUidCount: 0 },
      { userId: 'nara', mappedUidCount: 0 },
    ]);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(true);
    expect(res.complete).toBe(true);
    expect(res.revokedCount).toBe(0);
    expect(auth.createUser).not.toHaveBeenCalled();
    assertZeroAuthMutation(auth);
    assertZeroFirestoreMutation(db, before);
  });

  test('Case I — canonical UID that also carries matching staffId is revoked once', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth([
      { uid: 'admin', customClaims: { staffId: 'admin', authVersion: 1 } },
    ]);
    const plan = await planForceReauthActiveStaff(db as never, auth);
    expect(plan.ok).toBe(true);
    expect(plan.revokeUids).toEqual(['admin']);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(auth.revokeRefreshTokens).toHaveBeenCalledTimes(1);
    expect(auth.revokeRefreshTokens).toHaveBeenCalledWith('admin');
  });

  test('Case J — dry-run executes full mapping and performs zero revokes', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth([
      { uid: 'admin' },
      { uid: 'anon-nara', customClaims: { staffId: 'nara' } },
    ]);
    const before = snapshot(db.__store);
    const args = parseForceReauthActiveStaffCliArgs([...BINDING, '--dry-run'], EMPTY_ENV);
    const res = await executeForceReauthActiveStaffCli(args, { database: db as never, auth });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    expect(res.complete).toBe(false);
    expect(res.activeStaffCount).toBe(2);
    expect(res.mappedAuthUidCount).toBe(2);
    expect(res.authUsersScanned).toBe(2);
    expect(res.authPagesScanned).toBeGreaterThanOrEqual(1);
    expect(res.revokedCount).toBe(0);
    expect(res.failedCount).toBe(0);
    expect(res.targets).toEqual([
      { userId: 'admin', username: 'admin' },
      { userId: 'nara', username: 'nara' },
    ]);
    const printed = formatForceReauthActiveStaffResult(res);
    expect(printed).toMatch(/"dryRun":true/);
    expect(printed).toMatch(/"mappedAuthUidCount":2/);
    assertSafePrinted(printed);
    expect(auth.listUsers).toHaveBeenCalled();
    assertZeroAuthMutation(auth);
    assertZeroFirestoreMutation(db, before);
    expect(db.__store.get('users/admin')).toMatchObject({ authVersion: 1 });
    expect(db.__store.get('users/nara')).toMatchObject({ authVersion: 1 });
  });

  test('Case K — apply never writes custom claims, custom tokens, Firestore, or authVersion', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth([
      { uid: 'anon-admin', customClaims: { staffId: 'admin' } },
      { uid: 'nara' },
    ]);
    const before = snapshot(db.__store);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(true);
    expect(auth.setCustomUserClaims).not.toHaveBeenCalled();
    expect(auth.createCustomToken).not.toHaveBeenCalled();
    expect(auth.createUser).not.toHaveBeenCalled();
    expect(auth.deleteUser).not.toHaveBeenCalled();
    assertZeroFirestoreMutation(db, before);
    expect(db.__store.get('users/admin')).toMatchObject({ authVersion: 1 });
    expect(db.__store.get('users/nara')).toMatchObject({ authVersion: 1 });
  });

  test('Case L — partial revoke failure across multiple mapped UIDs does not claim completion', async () => {
    const db = makeDb(ADMIN_ONLY_SEED);
    const auth = makeAuth([
      { uid: 'anon-1', customClaims: { staffId: 'admin' } },
      { uid: 'anon-2', customClaims: { staffId: 'admin' } },
    ]);
    auth.revokeRefreshTokens.mockImplementation(async (uid: string) => {
      if (uid === 'anon-2') throw new Error('forced-revoke-failure');
    });
    const before = snapshot(db.__store);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.error).toBe('PARTIAL_REVOKE_FAILURE');
    expect(res.targetCount).toBe(2);
    expect(res.revokedCount).toBe(1);
    expect(res.failedCount).toBe(1);
    expect(res.failed).toEqual([
      { userId: 'admin', username: 'admin', authUid: 'anon-2', error: 'forced-revoke-failure' },
    ]);
    expect(auth.revokeRefreshTokens).toHaveBeenCalledTimes(2);
    expect(auth.setCustomUserClaims).not.toHaveBeenCalled();
    assertZeroFirestoreMutation(db, before);
    const printed = formatForceReauthActiveStaffResult(res);
    expect(printed).toMatch(/"complete":false/);
    expect(printed).toMatch(/PARTIAL_REVOKE_FAILURE/);
    expect(printed).not.toMatch(/"ok":true/);
  });
});

describe('forceReauthActiveStaff target eligibility', () => {
  test('enumerates only active non-deleted staff, excluding inactive and deleted', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth(CANONICAL_ADMIN_NARA);
    const plan = await planForceReauthActiveStaff(db as never, auth);
    expect(plan.ok).toBe(true);
    expect(plan.targets.map((t) => t.userId)).toEqual(['admin', 'nara']);
    expect(auth.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  test('inconsistent embedded user id fails before any Auth enumeration or revoke', async () => {
    const db = makeDb({
      'users/admin': { id: 'other-id', username: 'admin', isActive: true, deletedAt: null, authVersion: 1 },
    });
    const auth = makeAuth([{ uid: 'admin' }]);
    const before = snapshot(db.__store);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('USER_ID_INCONSISTENT');
    expect(auth.listUsers).not.toHaveBeenCalled();
    assertZeroAuthMutation(auth);
    assertZeroFirestoreMutation(db, before);
  });

  test('empty active set fails closed before Auth enumeration or mutation', async () => {
    const db = makeDb({
      'users/inactive': { username: 'inactive', isActive: false, deletedAt: null },
    });
    const auth = makeAuth([]);
    const res = await runForceReauthActiveStaff(db as never, auth, { dryRun: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('TARGET_SET_EMPTY');
    expect(res.revokedCount).toBe(0);
    expect(auth.listUsers).not.toHaveBeenCalled();
    assertZeroAuthMutation(auth);
  });
});

describe('forceReauthActiveStaff apply canonical coverage', () => {
  test('revokes exactly once per mapped UID including preserved canonical accounts', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth(CANONICAL_ADMIN_NARA);
    const before = snapshot(db.__store);
    const args = parseForceReauthActiveStaffCliArgs([...BINDING, '--apply'], EMPTY_ENV);
    const res = await executeForceReauthActiveStaffCli(args, { database: db as never, auth });
    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(false);
    expect(res.complete).toBe(true);
    expect(res.targetCount).toBe(2);
    expect(res.revokedCount).toBe(2);
    expect(res.failedCount).toBe(0);
    expect(auth.revokeRefreshTokens.mock.calls.map((c) => c[0])).toEqual(['admin', 'nara']);
    assertZeroAuthMutation(auth, { revokeCount: 2 });
    assertZeroFirestoreMutation(db, before);
    expect(db.__store.get('users/admin')).toMatchObject({ authVersion: 1 });
  });

  test('repeat apply is safe and invokes revoke again', async () => {
    const db = makeDb(ACTIVE_SEED);
    const auth = makeAuth(CANONICAL_ADMIN_NARA);
    const first = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    const second = await runForceReauthActiveStaff(db as never, auth, { dryRun: false });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(auth.revokeRefreshTokens).toHaveBeenCalledTimes(4);
    expect(first.complete).toBe(true);
    expect(second.complete).toBe(true);
  });
});

function stringifyCliLog(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message;
    return String(a);
  }).join(' ');
}

function resetAdminMocks() {
  adminAppMocks.initializeApp.mockClear();
  adminAppMocks.cert.mockClear();
  adminAppMocks.getApps.mockClear();
  adminAppMocks.applicationDefault.mockClear();
  adminAppMocks.getApps.mockImplementation(() => []);
  firestoreAdminMocks.getFirestore.mockReset();
  firestoreAdminMocks.getFirestore.mockImplementation((app: unknown, databaseId?: string) => ({
    __operatorTestFirestore: true,
    app,
    databaseId,
  }));
  authAdminMocks.getAuth.mockClear();
  authAdminMocks.getUser.mockReset();
  authAdminMocks.listUsers.mockReset();
  authAdminMocks.revokeRefreshTokens.mockReset();
  authAdminMocks.setCustomUserClaims.mockReset();
  authAdminMocks.createCustomToken.mockReset();
  authAdminMocks.createUser.mockReset();
  authAdminMocks.updateUser.mockReset();
  authAdminMocks.deleteUser.mockReset();
  authAdminMocks.getUser.mockImplementation(async (uid: string) => ({ uid }));
  authAdminMocks.listUsers.mockImplementation(async () => ({ users: CANONICAL_ADMIN_NARA }));
  authAdminMocks.revokeRefreshTokens.mockImplementation(async () => undefined);
}

async function runCliMain(
  argvFlags: string[],
  setup?: () => void,
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  resetAdminMocks();
  setup?.();

  const originalArgv = process.argv.slice();
  const envSnapshot = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    FIRESTORE_DATABASE_ID: process.env.FIRESTORE_DATABASE_ID,
    GCLOUD_PROJECT: process.env.GCLOUD_PROJECT,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  };
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.FIRESTORE_DATABASE_ID;
  delete process.env.GCLOUD_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;

  const stdout: string[] = [];
  const stderr: string[] = [];
  let exitCode: number | undefined;

  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    stdout.push(stringifyCliLog(args));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(stringifyCliLog(args));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    exitCode = typeof code === 'number' ? code : code == null ? 0 : Number(code) || 1;
    return undefined as never;
  }) as typeof process.exit);

  process.argv = [originalArgv[0] ?? process.execPath, resolve(__dirname, '../forceReauthActiveStaff.ts'), ...argvFlags];

  try {
    vi.resetModules();
    await import('../forceReauthActiveStaff');
    await vi.dynamicImportSettled();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (exitCode !== undefined || stdout.length > 0 || stderr.length > 0) break;
      await new Promise<void>((r) => setImmediate(r));
    }
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = originalArgv;
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (exitCode === undefined && stdout.length === 0 && stderr.length === 0) {
    throw new Error('forceReauthActiveStaff CLI produced no exit/stdout/stderr; main() likely did not run');
  }

  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
}

describe('forceReauthActiveStaff real main() boundary', () => {
  const tempDirs: string[] = [];

  function writeCredentialFixture(projectId: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'twinpet-force-reauth-cli-'));
    tempDirs.push(dir);
    const path = join(dir, 'sa.json');
    writeFileSync(path, JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      client_email: 'operator-cli-test@example.invalid',
      private_key: '-----BEGIN PRIVATE KEY-----\nNOT_A_REAL_KEY\n-----END PRIVATE KEY-----\n',
    }));
    return path;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('importing the module from vitest is not treated as an operator entry', () => {
    expect(isForceReauthActiveStaffCliEntry(process.argv[1] ?? '')).toBe(false);
    expect(isForceReauthActiveStaffCliEntry('lib/scripts/forceReauthActiveStaff.js')).toBe(true);
    expect(isForceReauthActiveStaffCliEntry('src/scripts/__tests__/forceReauthActiveStaff.test.ts')).toBe(false);
  });

  test('main() neither mode fails before credentials/Admin/Firestore/Auth', async () => {
    const credentialsPath = join(tmpdir(), 'twinpet-operator-cli-must-not-open', 'force-reauth.json');
    const result = await runCliMain([
      `--project=${PROJECT_A}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/MISSING_MODE/);
    expect(result.stderr).not.toMatch(/CREDENTIALS_FILE_MISSING/);
    expect(adminAppMocks.initializeApp).not.toHaveBeenCalled();
    expect(adminAppMocks.applicationDefault).not.toHaveBeenCalled();
    expect(firestoreAdminMocks.getFirestore).not.toHaveBeenCalled();
    expect(authAdminMocks.getAuth).not.toHaveBeenCalled();
    expect(authAdminMocks.listUsers).not.toHaveBeenCalled();
    expect(authAdminMocks.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  test('main() --dry-run + --apply rejects before credentials/Admin', async () => {
    const credentialsPath = join(tmpdir(), 'twinpet-operator-cli-must-not-open', 'force-reauth-both.json');
    const result = await runCliMain([
      `--project=${PROJECT_A}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
      '--dry-run',
      '--apply',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/INVALID_MODE/);
    expect(adminAppMocks.initializeApp).not.toHaveBeenCalled();
    expect(authAdminMocks.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  test('main() rejects credential project mismatch before Firestore/Auth return', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const result = await runCliMain([
      `--project=${PROJECT_B}`,
      `--database=${DATABASE_ID}`,
      `--credentials=${credentialsPath}`,
      '--dry-run',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/PROJECT_MISMATCH/);
    expect(result.stderr).toContain(PROJECT_B);
    expect(result.stderr).toContain(PROJECT_A);
    expect(adminAppMocks.initializeApp).not.toHaveBeenCalled();
    expect(adminAppMocks.cert).not.toHaveBeenCalled();
    expect(adminAppMocks.applicationDefault).not.toHaveBeenCalled();
    expect(firestoreAdminMocks.getFirestore).not.toHaveBeenCalled();
    expect(authAdminMocks.getAuth).not.toHaveBeenCalled();
    expect(authAdminMocks.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  test('main() --dry-run binds exact requested project and database, maps Auth, and does not revoke', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ACTIVE_SEED);
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--dry-run',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
      },
    );
    expect(adminAppMocks.applicationDefault).not.toHaveBeenCalled();
    expect(adminAppMocks.cert).toHaveBeenCalledTimes(1);
    expect(adminAppMocks.initializeApp).toHaveBeenCalledTimes(1);
    const initOpts = adminAppMocks.initializeApp.mock.calls[0]?.[0] as {
      projectId?: string;
    };
    expect(initOpts.projectId).toBe(PROJECT_A);
    expect(firestoreAdminMocks.getFirestore).toHaveBeenCalledTimes(1);
    const fsCall = firestoreAdminMocks.getFirestore.mock.calls[0] ?? [];
    expect(fsCall).toHaveLength(2);
    expect(fsCall[1]).toBe(DATABASE_ID);
    expect(result.stdout).toMatch(/"dryRun":true/);
    expect(result.stdout).toMatch(/"revokedCount":0/);
    expect(result.stdout).toMatch(/"mappedAuthUidCount":2/);
    expect(result.exitCode).toBeUndefined();
    expect(authAdminMocks.listUsers).toHaveBeenCalled();
    expect(authAdminMocks.revokeRefreshTokens).not.toHaveBeenCalled();
    expect(authAdminMocks.setCustomUserClaims).not.toHaveBeenCalled();
    expect(authAdminMocks.createCustomToken).not.toHaveBeenCalled();
    expect(db.__writes).toEqual([]);
    assertSafePrinted(result.stdout);
  });

  test('main() --apply revokes exactly the planned Auth UIDs including canonical accounts', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ACTIVE_SEED);
    const before = snapshot(db.__store);
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
      },
    );
    expect(result.stdout).toMatch(/"ok":true/);
    expect(result.stdout).toMatch(/"complete":true/);
    expect(result.stdout).toMatch(/"revokedCount":2/);
    expect(result.exitCode).toBeUndefined();
    expect(authAdminMocks.revokeRefreshTokens).toHaveBeenCalledTimes(2);
    expect(authAdminMocks.revokeRefreshTokens.mock.calls.map((c) => c[0])).toEqual(['admin', 'nara']);
    expect(authAdminMocks.setCustomUserClaims).not.toHaveBeenCalled();
    expect(authAdminMocks.createUser).not.toHaveBeenCalled();
    expect(snapshot(db.__store)).toBe(before);
    expect(db.__writes).toEqual([]);
  });

  test('main() --apply revokes anonymous PIN-session UIDs from claim mapping', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ACTIVE_SEED);
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
        authAdminMocks.listUsers.mockImplementation(async () => ({
          users: [
            { uid: 'anon-uid-1', customClaims: { staffId: 'admin' } },
            { uid: 'anon-uid-2', customClaims: { staffId: 'nara' } },
          ],
        }));
      },
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toMatch(/"ok":true/);
    expect(result.stdout).toMatch(/"complete":true/);
    expect(authAdminMocks.revokeRefreshTokens.mock.calls.map((c) => c[0]).sort()).toEqual([
      'anon-uid-1',
      'anon-uid-2',
    ]);
    expect(authAdminMocks.revokeRefreshTokens.mock.calls.map((c) => c[0])).not.toContain('admin');
    expect(authAdminMocks.setCustomUserClaims).not.toHaveBeenCalled();
  });

  test('main() --apply paginates listUsers fully before the first revoke, including a late-page UID', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ADMIN_ONLY_SEED);
    const order: string[] = [];
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
        authAdminMocks.listUsers.mockImplementation(async (_max?: number, pageToken?: string) => {
          order.push(`listUsers:${pageToken ?? 'start'}`);
          if (!pageToken) {
            return { users: [{ uid: 'unrelated' }], pageToken: 'p2' };
          }
          return { users: [{ uid: 'anon-uid-late', customClaims: { staffId: 'admin' } }] };
        });
        authAdminMocks.revokeRefreshTokens.mockImplementation(async (uid: string) => {
          order.push(`revoke:${uid}`);
        });
      },
    );
    expect(result.exitCode).toBeUndefined();
    expect(order).toEqual([
      'listUsers:start',
      'listUsers:p2',
      'revoke:anon-uid-late',
    ]);
    expect(authAdminMocks.revokeRefreshTokens.mock.calls.map((c) => c[0])).toEqual(['anon-uid-late']);
  });

  test('main() --apply later-page listUsers failure exits non-zero with zero revokes', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ACTIVE_SEED);
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
        let page = 0;
        authAdminMocks.listUsers.mockImplementation(async () => {
          page += 1;
          if (page === 1) return { users: [{ uid: 'admin' }], pageToken: 'p2' };
          throw new Error('forced-listUsers-failure');
        });
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/AUTH_ENUMERATION_FAILED/);
    expect(result.stdout).toMatch(/"revokedCount":0/);
    expect(result.stdout).toMatch(/"complete":false/);
    expect(authAdminMocks.revokeRefreshTokens).not.toHaveBeenCalled();
    expect(db.__writes).toEqual([]);
  });

  test('main() --apply with zero mapped Auth UIDs does not fabricate users and reports mappedAuthUidCount 0', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ACTIVE_SEED);
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
        authAdminMocks.listUsers.mockImplementation(async () => ({ users: [] }));
      },
    );
    expect(result.exitCode).toBeUndefined();
    expect(result.stdout).toMatch(/"ok":true/);
    expect(result.stdout).toMatch(/"mappedAuthUidCount":0/);
    expect(result.stdout).toMatch(/"revokedCount":0/);
    expect(authAdminMocks.createUser).not.toHaveBeenCalled();
    expect(authAdminMocks.revokeRefreshTokens).not.toHaveBeenCalled();
  });

  test('main() --apply partial revoke reports failure and does not claim complete', async () => {
    const credentialsPath = writeCredentialFixture(PROJECT_A);
    const db = makeDb(ACTIVE_SEED);
    const result = await runCliMain(
      [
        `--project=${PROJECT_A}`,
        `--database=${DATABASE_ID}`,
        `--credentials=${credentialsPath}`,
        '--apply',
      ],
      () => {
        firestoreAdminMocks.getFirestore.mockImplementation(() => db);
        authAdminMocks.revokeRefreshTokens.mockImplementation(async (uid: string) => {
          if (uid === 'nara') throw new Error('forced-revoke-failure');
        });
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/PARTIAL_REVOKE_FAILURE/);
    expect(result.stdout).toMatch(/"complete":false/);
    expect(result.stdout).toMatch(/"revokedCount":1/);
    expect(result.stdout).toMatch(/"failedCount":1/);
    expect(result.stdout).not.toMatch(/"ok":true/);
    expect(authAdminMocks.setCustomUserClaims).not.toHaveBeenCalled();
    expect(authAdminMocks.createCustomToken).not.toHaveBeenCalled();
  });
});

describe('username-migration maintenance off-ramp (allowlisted test placement)', () => {
  const MAINT_BINDING = ['--project=demo-twinpet', '--database=pos-db', '--credentials=unused-sa.json'];

  test('enable path regression: requested false still rejected; false→true and true no-op unchanged', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': {
        maintenanceMode: false,
        complete: true,
        epoch: 1,
        extra: 'keep',
      },
    });
    await expect(runSetUsernameMigrationMaintenanceMode(db as never, false))
      .rejects.toThrow('MAINTENANCE_FALSE_REJECTED');
    expect(db.__store.get('migrationControl/usernameReservations')).toMatchObject({
      maintenanceMode: false,
      complete: true,
      epoch: 1,
      extra: 'keep',
    });
    const first = await runSetUsernameMigrationMaintenanceMode(db as never, true);
    expect(first.ok).toBe(true);
    expect(first.noop).toBe(false);
    expect(first.maintenanceMode).toBe(true);
    const second = await runSetUsernameMigrationMaintenanceMode(db as never, true);
    expect(second.noop).toBe(true);
    expect(db.__store.get('migrationControl/usernameReservations')).toMatchObject({
      maintenanceMode: true,
      complete: true,
      epoch: 1,
      extra: 'keep',
    });
  });

  test('enable CLI parser still accepts --enable --apply', () => {
    const args = parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...MAINT_BINDING, '--enable', '--apply'],
      EMPTY_ENV,
    );
    expect(args.mode).toBe('enable');
    expect(args.apply).toBe(true);
  });

  test('--enable and --disable are mutually exclusive', () => {
    expect(() => parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...MAINT_BINDING, '--enable', '--disable', '--apply'],
      EMPTY_ENV,
    )).toThrow(/INVALID_MODE/);
  });

  test('--requested=false remains rejected and is not a disable alias', () => {
    expect(() => parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...MAINT_BINDING, '--requested=false', '--apply'],
      EMPTY_ENV,
    )).toThrow(/MAINTENANCE_FALSE_REJECTED/);
  });

  test('disable without --apply fails before mutation', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { maintenanceMode: true, complete: true, epoch: 1 },
    });
    const before = snapshot(db.__store);
    const args = parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...MAINT_BINDING, '--disable'],
      EMPTY_ENV,
    );
    expect(args.mode).toBe('disable');
    expect(args.apply).toBe(false);
    await expect(executeSetUsernameMigrationMaintenanceModeCli(args, { database: db as never }))
      .rejects.toThrow(/MISSING_APPLY/);
    expect(snapshot(db.__store)).toBe(before);
    expect(db.__writes).toEqual([]);
  });

  test('disable when complete=false fails with no write', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { maintenanceMode: true, complete: false, epoch: 1 },
    });
    const before = snapshot(db.__store);
    const args = parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...MAINT_BINDING, '--disable', '--apply'],
      EMPTY_ENV,
    );
    await expect(executeSetUsernameMigrationMaintenanceModeCli(args, { database: db as never }))
      .rejects.toThrow('COMPLETE_NOT_TRUE');
    expect(snapshot(db.__store)).toBe(before);
    expect(db.__writes).toEqual([]);
  });

  test('disable when maintenanceMode=false is a deterministic no-op with no write', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': {
        maintenanceMode: false,
        complete: true,
        epoch: 1,
        extra: 'keep',
      },
    });
    const before = snapshot(db.__store);
    const res = await runDisableUsernameMigrationMaintenanceMode(db as never);
    expect(res).toMatchObject({
      ok: true,
      maintenanceMode: false,
      noop: true,
      complete: true,
      epoch: 1,
    });
    expect(snapshot(db.__store)).toBe(before);
    expect(db.__writes).toEqual([]);
  });

  test('disable true→false succeeds and preserves complete, epoch, and unrelated fields', async () => {
    const db = makeDb({
      'users/admin': { username: 'admin', isActive: true, deletedAt: null },
      'usernames/admin': { userId: 'admin' },
      'userCredentials/admin': { pinHash: '$2b$10$not.a.real.hash', credentialState: 'rotated_authoritative' },
      'migrationControl/usernameReservations': {
        maintenanceMode: true,
        complete: true,
        epoch: 1,
        extra: 'keep',
      },
    });
    const usersBefore = JSON.stringify(db.__store.get('users/admin'));
    const usernamesBefore = JSON.stringify(db.__store.get('usernames/admin'));
    const credsBefore = JSON.stringify(db.__store.get('userCredentials/admin'));
    const args = parseSetUsernameMigrationMaintenanceModeCliArgs(
      [...MAINT_BINDING, '--disable', '--apply'],
      EMPTY_ENV,
    );
    const res = await executeSetUsernameMigrationMaintenanceModeCli(args, { database: db as never });
    expect(res).toMatchObject({
      ok: true,
      maintenanceMode: false,
      noop: false,
      complete: true,
      epoch: 1,
    });
    const doc = db.__store.get('migrationControl/usernameReservations');
    expect(doc).toMatchObject({
      maintenanceMode: false,
      complete: true,
      epoch: 1,
      extra: 'keep',
    });
    expect(typeof doc?.updatedAt).toBe('string');
    expect(db.__writes).toEqual([{ op: 'set', path: 'migrationControl/usernameReservations' }]);
    expect(JSON.stringify(db.__store.get('users/admin'))).toBe(usersBefore);
    expect(JSON.stringify(db.__store.get('usernames/admin'))).toBe(usernamesBefore);
    expect(JSON.stringify(db.__store.get('userCredentials/admin'))).toBe(credsBefore);
  });
});
