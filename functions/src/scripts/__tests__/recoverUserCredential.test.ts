import { beforeEach, describe, expect, test, vi } from 'vitest';

const recoverCoreMocks = vi.hoisted(() => ({
  performSetUserAccount: vi.fn(),
}));

const authAdminMocks = vi.hoisted(() => {
  const createUser = vi.fn();
  const updateUser = vi.fn();
  const deleteUser = vi.fn();
  const setCustomUserClaims = vi.fn();
  return {
    createUser,
    updateUser,
    deleteUser,
    setCustomUserClaims,
    getAuth: vi.fn(() => ({ createUser, updateUser, deleteUser, setCustomUserClaims })),
  };
});

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
}));

vi.mock('firebase-admin/auth', () => authAdminMocks);

vi.mock('../../setUserAccountCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../setUserAccountCore')>();
  recoverCoreMocks.performSetUserAccount.mockImplementation((...args) =>
    actual.performSetUserAccount(...args as Parameters<typeof actual.performSetUserAccount>),
  );
  return {
    ...actual,
    performSetUserAccount: (...args: Parameters<typeof actual.performSetUserAccount>) =>
      recoverCoreMocks.performSetUserAccount(...args),
  };
});

import {
  executeRecoverUserCredentialCli,
  formatRecoverUserCredentialDryRunResult,
  parseRecoverUserCredentialCliArgs,
  resolveRecoveryUserId,
  runRecoverUserCredential,
  runRecoverUserCredentialDryRun,
} from '../recoverUserCredential';

type Doc = Record<string, unknown>;
type WriteOp = { op: string; path?: string };
type ReadOp = { op: 'get'; path: string };

function userCredentialReads(reads: ReadOp[]): ReadOp[] {
  return reads.filter((r) => r.path === 'userCredentials' || r.path.startsWith('userCredentials/'));
}

function makeDb(seed: Record<string, Doc>) {
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
      set: async (data: Doc) => {
        writes.push({ op: 'set', path });
        store.set(path, { ...data });
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
          .map(([p, data]) => ({ id: p.slice(p.lastIndexOf('/') + 1), data: () => data }));
        return { docs };
      },
    }),
    batch: () => {
      writes.push({ op: 'batch' });
      const ops: Array<() => void> = [];
      return {
        set: (ref: { path: string }, data: Doc) => {
          writes.push({ op: 'batch.set', path: ref.path });
          ops.push(() => {
            store.set(ref.path, { ...data });
          });
        },
        update: (ref: { path: string }, data: Doc) => {
          writes.push({ op: 'batch.update', path: ref.path });
          ops.push(() => {
            const existing = store.get(ref.path) ?? {};
            store.set(ref.path, { ...existing, ...data });
          });
        },
        delete: (ref: { path: string }) => {
          writes.push({ op: 'batch.delete', path: ref.path });
          ops.push(() => {
            store.delete(ref.path);
          });
        },
        commit: async () => {
          writes.push({ op: 'batch.commit' });
          for (const op of ops) op();
        },
      };
    },
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      writes.push({ op: 'runTransaction' });
      const tx = {
        get: async (r: { path: string }) => {
          reads.push({ op: 'get', path: r.path });
          const data = store.get(r.path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          writes.push({ op: 'tx.set', path: r.path });
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          writes.push({ op: 'tx.update', path: r.path });
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        delete: (r: { path: string }) => {
          writes.push({ op: 'tx.delete', path: r.path });
          store.delete(r.path);
        },
      };
      return fn(tx);
    },
    __store: store,
    __writes: writes,
    __reads: reads,
  };
}

function snapshot(store: Map<string, Doc>): string {
  return JSON.stringify([...store.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

const BINDING = ['--project=demo-twinpet', '--database=pos-db', '--credentials=unused-sa.json'];
const EMPTY_ENV: NodeJS.ProcessEnv = {};
const PIN_HASH = '$2b$10$not.a.real.hash.for.dry.run.tests';

describe('recoverUserCredential P2', () => {
  test('username ambiguity lists candidate userIds only', async () => {
    const db = makeDb({
      'users/a': { username: 'Same', deletedAt: null },
      'users/b': { username: 'same', deletedAt: null },
    });
    const res = await resolveRecoveryUserId(db as never, { username: 'same' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('USERNAME_AMBIGUOUS');
      expect(res.candidateUserIds).toEqual(['a', 'b']);
    }
  });

  test('operator rotate calls canonical core in-process', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 },
      'users/target': { username: 'admin', role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
    });
    const res = await runRecoverUserCredential(db as never, { userId: 'target' }, '7777', 'rec-1');
    expect(res.ok).toBe(true);
    expect(res.status).toBe('rotated');
    expect(JSON.stringify(db.__store)).not.toContain('7777');
    expect(recoverCoreMocks.performSetUserAccount).toHaveBeenCalled();
  });
});

describe('recoverUserCredential --dry-run parser', () => {
  test('accepts --dry-run without PIN or rotateIdempotencyKey', () => {
    const args = parseRecoverUserCredentialCliArgs([...BINDING, '--userId=target', '--dry-run'], EMPTY_ENV);
    expect(args.dryRun).toBe(true);
    expect(args.apply).toBe(false);
    expect(args.projectId).toBe('demo-twinpet');
    expect(args.databaseId).toBe('pos-db');
    expect(args.credentialsPath).toBe('unused-sa.json');
    expect(args.target).toEqual({ userId: 'target' });
    expect(args.pin).toBe('');
    expect(args.rotateIdempotencyKey).toBe('');
  });

  test('rejects --dry-run combined with --apply before PIN is required', () => {
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--userId=target', '--dry-run', '--apply'],
      EMPTY_ENV,
    )).toThrow(/INVALID_MODE/);
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--userId=target', '--pin=1234', '--rotateIdempotencyKey=k', '--dry-run', '--apply'],
      EMPTY_ENV,
    )).toThrow(/INVALID_MODE/);
  });

  test('requires explicit project, database, credentials, and exactly one target', () => {
    expect(() => parseRecoverUserCredentialCliArgs(
      ['--database=pos-db', '--credentials=x.json', '--userId=target', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_PROJECT/);
    expect(() => parseRecoverUserCredentialCliArgs(
      ['--project=demo', '--credentials=x.json', '--userId=target', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_DATABASE/);
    expect(() => parseRecoverUserCredentialCliArgs(
      ['--project=demo', '--database=pos-db', '--userId=target', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_CREDENTIALS/);
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_TARGET/);
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--userId=a', '--username=ann', '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/INVALID_TARGET/);
  });

  test('does not require PIN, RECOVER_USER_PIN, or rotateIdempotencyKey', () => {
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--username=ann', '--dry-run'],
      EMPTY_ENV,
    )).not.toThrow();
    const withEnvPin = parseRecoverUserCredentialCliArgs(
      [...BINDING, '--userId=target', '--dry-run'],
      { RECOVER_USER_PIN: '9999' },
    );
    expect(withEnvPin.dryRun).toBe(true);
    expect(withEnvPin.pin).toBe('');
    expect(withEnvPin.rotateIdempotencyKey).toBe('');
  });

  test('malformed target fails closed before mutation and apply path still requires PIN and key', () => {
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--dry-run'],
      EMPTY_ENV,
    )).toThrow(/MISSING_TARGET/);
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--userId=target', '--apply'],
      EMPTY_ENV,
    )).toThrow(/MISSING_PIN/);
    expect(() => parseRecoverUserCredentialCliArgs(
      [...BINDING, '--userId=target', '--pin=1234', '--apply'],
      EMPTY_ENV,
    )).toThrow(/MISSING_ROTATE_IDEMPOTENCY_KEY/);
  });
});

describe('recoverUserCredential --dry-run resolution and zero-write', () => {
  beforeEach(() => {
    recoverCoreMocks.performSetUserAccount.mockClear();
    authAdminMocks.getAuth.mockClear();
    authAdminMocks.createUser.mockClear();
    authAdminMocks.updateUser.mockClear();
    authAdminMocks.deleteUser.mockClear();
    authAdminMocks.setCustomUserClaims.mockClear();
  });

  function assertZeroMutation(db: ReturnType<typeof makeDb>, before: string) {
    expect(snapshot(db.__store)).toBe(before);
    expect(db.__writes).toEqual([]);
    expect(recoverCoreMocks.performSetUserAccount).not.toHaveBeenCalled();
    expect(authAdminMocks.getAuth).not.toHaveBeenCalled();
    expect(authAdminMocks.createUser).not.toHaveBeenCalled();
    expect(authAdminMocks.updateUser).not.toHaveBeenCalled();
    expect(authAdminMocks.deleteUser).not.toHaveBeenCalled();
    expect(authAdminMocks.setCustomUserClaims).not.toHaveBeenCalled();
  }

  function assertNoUserCredentialReads(db: ReturnType<typeof makeDb>) {
    expect(userCredentialReads(db.__reads)).toEqual([]);
  }

  test('fake read ledger records userCredentials document gets so dry-run absence is observable', async () => {
    const db = makeDb({
      'users/target': { username: 'admin', deletedAt: null },
      'userCredentials/target': { pinHash: PIN_HASH },
    });
    await db.collection('userCredentials').doc('target').get();
    expect(userCredentialReads(db.__reads)).toEqual([{ op: 'get', path: 'userCredentials/target' }]);
    expect(userCredentialReads(db.__reads)).toHaveLength(1);
  });

  test('resolves userId without calling performSetUserAccount or writing', async () => {
    const db = makeDb({
      'users/target': {
        username: 'admin',
        role: 'admin',
        isActive: true,
        deletedAt: null,
        authVersion: 0,
        pin: PIN_HASH,
      },
      'userCredentials/target': { pinHash: PIN_HASH, credentialState: 'backfilled_not_trusted', disabled: false },
    });
    const before = snapshot(db.__store);
    const res = await runRecoverUserCredentialDryRun(db as never, { userId: 'target' });
    expect(res).toEqual({
      ok: true,
      dryRun: true,
      userId: 'target',
      targetKind: 'userId',
      resolvable: true,
      status: 'RESOLVED',
    });
    const printed = formatRecoverUserCredentialDryRunResult(res);
    expect(printed).toMatch(/"dryRun":true/);
    expect(printed).not.toContain(PIN_HASH);
    expect(printed).not.toMatch(/pinHash|private_key|password/i);
    expect(db.__reads).toEqual([{ op: 'get', path: 'users/target' }]);
    expect(userCredentialReads(db.__reads)).toHaveLength(0);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });

  test('successful userId dry-run does not read userCredentials even when that document is absent', async () => {
    const db = makeDb({
      'users/target': { username: 'admin', deletedAt: null, isActive: true },
    });
    const before = snapshot(db.__store);
    const res = await runRecoverUserCredentialDryRun(db as never, { userId: 'target' });
    expect(res).toEqual({
      ok: true,
      dryRun: true,
      userId: 'target',
      targetKind: 'userId',
      resolvable: true,
      status: 'RESOLVED',
    });
    expect(db.__reads).toEqual([{ op: 'get', path: 'users/target' }]);
    expect(userCredentialReads(db.__reads)).toHaveLength(0);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });

  test('resolves username without calling performSetUserAccount or writing', async () => {
    const db = makeDb({
      'users/u1': { username: 'Ann', deletedAt: null, isActive: true },
      'userCredentials/u1': { pinHash: PIN_HASH, disabled: false },
    });
    const before = snapshot(db.__store);
    const res = await runRecoverUserCredentialDryRun(db as never, { username: 'ann' });
    expect(res.ok).toBe(true);
    expect(res.userId).toBe('u1');
    expect(res.targetKind).toBe('username');
    expect(res.resolvable).toBe(true);
    expect(formatRecoverUserCredentialDryRunResult(res)).not.toContain(PIN_HASH);
    expect(db.__reads).toEqual([
      { op: 'get', path: 'users' },
      { op: 'get', path: 'users/u1' },
    ]);
    expect(userCredentialReads(db.__reads)).toHaveLength(0);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });

  test('missing userId fails closed with zero writes', async () => {
    const db = makeDb({
      'users/other': { username: 'ann', deletedAt: null },
    });
    const before = snapshot(db.__store);
    const res = await runRecoverUserCredentialDryRun(db as never, { userId: 'missing' });
    expect(res.ok).toBe(false);
    expect(res.resolvable).toBe(false);
    expect(res.status).toBe('USER_NOT_FOUND');
    expect(res.dryRun).toBe(true);
    expect(db.__reads).toEqual([{ op: 'get', path: 'users/missing' }]);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });

  test('missing username fails closed with zero writes', async () => {
    const db = makeDb({
      'users/u1': { username: 'ann', deletedAt: null },
    });
    const before = snapshot(db.__store);
    const res = await runRecoverUserCredentialDryRun(db as never, { username: 'nobody' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('USERNAME_NOT_FOUND');
    expect(res.resolvable).toBe(false);
    expect(db.__reads).toEqual([{ op: 'get', path: 'users' }]);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });

  test('ambiguous username fails closed with zero writes', async () => {
    const db = makeDb({
      'users/a': { username: 'Same', deletedAt: null },
      'users/b': { username: 'same', deletedAt: null },
    });
    const before = snapshot(db.__store);
    const res = await runRecoverUserCredentialDryRun(db as never, { username: 'same' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('USERNAME_AMBIGUOUS');
    expect(res.resolvable).toBe(false);
    expect(db.__reads).toEqual([{ op: 'get', path: 'users' }]);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });

  test('executeRecoverUserCredentialCli still requires --apply and does not mutate on dry-run args', async () => {
    const db = makeDb({
      'users/target': { username: 'admin', role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
    });
    const before = snapshot(db.__store);
    const args = parseRecoverUserCredentialCliArgs([...BINDING, '--userId=target', '--dry-run'], EMPTY_ENV);
    await expect(executeRecoverUserCredentialCli(args, { database: db as never })).rejects.toThrow(/MISSING_APPLY/);
    expect(db.__reads).toEqual([]);
    assertNoUserCredentialReads(db);
    assertZeroMutation(db, before);
  });
});
