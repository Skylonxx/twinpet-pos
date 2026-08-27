import { describe, expect, test, vi } from 'vitest';
import bcrypt from 'bcryptjs';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
}));

import {
  createIntentIdFromKey,
  createPayloadHash,
  createUserIdFromKey,
  performSetUserAccount,
  rotateIntentIdFromKey,
} from './setUserAccountCore';

type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    }
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return 'ts';
    return v;
  };
  function docRef(path: string) {
    return { path, id: path.slice(path.lastIndexOf('/') + 1) };
  }
  return {
    collection: (c: string) => ({ doc: (id: string) => docRef(`${c}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let hasWritten = false;
      const tx = {
        get: async (r: { path: string }) => {
          if (hasWritten) {
            throw new Error(
              'FakeTransaction: read after write inside one transaction is not allowed (matches real Firestore)',
            );
          }
          const data = store.get(r.path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          hasWritten = true;
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          hasWritten = true;
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        delete: (r: { path: string }) => {
          hasWritten = true;
          store.delete(r.path);
        },
      };
      return fn(tx);
    },
    __store: store,
  };
}

const marker = {
  'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 },
};
const adminActor = { kind: 'staff' as const, staffId: 'admin1', authVersion: 0 };
const adminUser = {
  'users/admin1': { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
};

describe('setUserAccountCore C1 create / rotate', () => {
  test('deterministic userId and intentId are domain-separated', () => {
    const a = createUserIdFromKey('k1');
    const b = createIntentIdFromKey('k1');
    expect(a).toHaveLength(40);
    expect(b).toHaveLength(40);
    expect(a).not.toBe(b);
    expect(rotateIntentIdFromKey('k1')).not.toBe(b);
  });

  test('payloadHash ignores PIN', () => {
    const input = {
      username: 'somchai',
      firstName: 'A',
      lastName: 'B',
      role: 'staff',
      branchIds: ['LDP-001'],
      permissions: {},
      isActive: true,
    };
    expect(createPayloadHash(input)).toBe(createPayloadHash(input));
  });

  test('create then same-key different PIN replays original without mutating hash', async () => {
    const db = makeDb({ ...marker, ...adminUser });
    const cmd = {
      op: 'create' as const,
      idempotencyKey: 'create-1',
      username: 'nong',
      firstName: 'Nong',
      lastName: 'Nuch',
      role: 'staff' as const,
      branchIds: ['LDP-001'],
      permissions: {},
      isActive: true,
      pin: '1234',
    };
    const first = await performSetUserAccount(db as never, adminActor, cmd);
    expect(first.ok).toBe(true);
    expect(first.status).toBe('created');
    const userId = first.userId!;
    const hash1 = (db.__store.get(`userCredentials/${userId}`) as { pinHash: string }).pinHash;
    expect(await bcrypt.compare('1234', hash1)).toBe(true);

    const replay = await performSetUserAccount(db as never, adminActor, { ...cmd, pin: '9999' });
    expect(replay.status).toBe('duplicate_confirmed');
    const hash2 = (db.__store.get(`userCredentials/${userId}`) as { pinHash: string }).pinHash;
    expect(hash2).toBe(hash1);
    expect(await bcrypt.compare('9999', hash2)).toBe(false);
  });

  test('rotate uses a separate namespace and bumps authVersion', async () => {
    const db = makeDb({ ...marker, ...adminUser });
    const created = await performSetUserAccount(db as never, adminActor, {
      op: 'create',
      idempotencyKey: 'create-2',
      username: 'wichai',
      firstName: 'W',
      lastName: 'C',
      role: 'staff',
      branchIds: ['LDP-001'],
      permissions: {},
      isActive: true,
      pin: '1111',
    });
    const rotated = await performSetUserAccount(db as never, adminActor, {
      op: 'rotate',
      rotateIdempotencyKey: 'rot-1',
      userId: created.userId!,
      pin: '2222',
      reasonCode: 'p1_peer',
    });
    expect(rotated.status).toBe('rotated');
    expect(rotated.authVersion).toBe(1);
    const replay = await performSetUserAccount(db as never, adminActor, {
      op: 'rotate',
      rotateIdempotencyKey: 'rot-1',
      userId: created.userId!,
      pin: '3333',
      reasonCode: 'p1_peer',
    });
    expect(replay.status).toBe('duplicate_confirmed');
  });

  test('P1 trusted-peer admin can rotate; non-admin cannot', async () => {
    const db = makeDb({
      ...marker,
      'users/admin1': { role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
      'users/staff1': { role: 'staff', isActive: true, deletedAt: null, authVersion: 0, username: 's' },
    });
    const denied = await performSetUserAccount(
      db as never,
      { kind: 'staff', staffId: 'staff1', authVersion: 0 },
      { op: 'rotate', rotateIdempotencyKey: 'x', userId: 'staff1', pin: '4444' },
    );
    expect(denied.status).toBe('unauthorized');
  });

  test('P2 operator_cli rotate is authorized without a staff token', async () => {
    const db = makeDb({
      ...marker,
      'users/target': { role: 'admin', isActive: true, deletedAt: null, authVersion: 0, username: 'admin' },
    });
    const res = await performSetUserAccount(
      db as never,
      { kind: 'operator_cli' },
      { op: 'rotate', rotateIdempotencyKey: 'p2', userId: 'target', pin: '5555', reasonCode: 'p2_operator_recovery' },
    );
    expect(res.ok).toBe(true);
    expect(res.status).toBe('rotated');
  });
});

const targetCred = {
  pinHash: 'keep-me',
  algo: 'bcrypt',
  cost: 10,
  credentialVersion: 3,
  credentialState: 'rotated_authoritative',
  disabled: false,
  updatedBy: 'admin1',
};

function seedSoftDeleteTarget(overrides: Record<string, Doc> = {}) {
  return {
    ...marker,
    ...adminUser,
    'users/target1': {
      role: 'staff',
      isActive: true,
      deletedAt: null,
      authVersion: 2,
      username: 'nongnuch',
      firstName: 'Nong',
      lastName: 'Nuch',
    },
    'usernames/nongnuch': { userId: 'target1' },
    'userCredentials/target1': { ...targetCred },
    ...overrides,
  };
}

describe('setUserAccountCore softDelete', () => {
  test('transaction mock rejects reads after writes', async () => {
    const db = makeDb({ ...marker, ...adminUser });
    await expect(
      db.runTransaction(async (rawTx) => {
        const tx = rawTx as {
          get: (r: { path: string }) => Promise<unknown>;
          update: (r: { path: string }, data: Doc) => void;
        };
        await tx.get(db.collection('users').doc('admin1'));
        tx.update(db.collection('users').doc('admin1'), { touched: true });
        await tx.get(db.collection('usernames').doc('nongnuch'));
      }),
    ).rejects.toThrow(/read after write/);
  });

  test('softDelete succeeds with all reads before writes and frozen terminal semantics', async () => {
    const db = makeDb(seedSoftDeleteTarget());
    const credBefore = { ...(db.__store.get('userCredentials/target1') as Doc) };
    const res = await performSetUserAccount(db as never, adminActor, {
      op: 'softDelete',
      userId: 'target1',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('updated');
    expect(res.userId).toBe('target1');
    expect(res.authVersion).toBe(3);

    const user = db.__store.get('users/target1') as Doc;
    expect(user.deletedAt).toBe('ts');
    expect(user.isActive).toBe(false);
    expect(user.authVersion).toBe(3);
    expect(user.username).toBe('nongnuch');
    expect(user.firstName).toBe('Nong');
    expect(user.lastName).toBe('Nuch');
    expect(user.role).toBe('staff');
    expect(db.__store.has('usernames/nongnuch')).toBe(false);
    expect(db.__store.get('userCredentials/target1')).toEqual(credBefore);
  });

  test('softDelete leaves a foreign username reservation in place', async () => {
    const db = makeDb(
      seedSoftDeleteTarget({
        'usernames/nongnuch': { userId: 'someone-else' },
      }),
    );
    const res = await performSetUserAccount(db as never, adminActor, {
      op: 'softDelete',
      userId: 'target1',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('updated');
    expect(db.__store.get('usernames/nongnuch')).toEqual({ userId: 'someone-else' });
    const user = db.__store.get('users/target1') as Doc;
    expect(user.isActive).toBe(false);
    expect(user.deletedAt).toBe('ts');
    expect(db.__store.get('userCredentials/target1')).toEqual(targetCred);
  });

  test('softDelete with empty username still terminalizes and skips reservation IO', async () => {
    const db = makeDb(
      seedSoftDeleteTarget({
        'users/target1': {
          role: 'staff',
          isActive: true,
          deletedAt: null,
          authVersion: 0,
          username: '',
          firstName: 'Nong',
          lastName: 'Nuch',
        },
      }),
    );
    db.__store.delete('usernames/nongnuch');
    const res = await performSetUserAccount(db as never, adminActor, {
      op: 'softDelete',
      userId: 'target1',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('updated');
    expect(res.authVersion).toBe(1);
    expect(db.__store.get('users/target1')?.isActive).toBe(false);
    expect(db.__store.get('users/target1')?.deletedAt).toBe('ts');
    expect([...db.__store.keys()].filter((k) => k.startsWith('usernames/'))).toEqual([]);
  });

  test('softDelete missing userId and missing target fail closed without mutation', async () => {
    const db = makeDb(seedSoftDeleteTarget());
    const snapshot = () =>
      Object.fromEntries([...db.__store.entries()].map(([k, v]) => [k, { ...v }]));
    const before = snapshot();

    const missingId = await performSetUserAccount(db as never, adminActor, {
      op: 'softDelete',
      userId: '   ',
    });
    expect(missingId.ok).toBe(false);
    expect(missingId.status).toBe('invalid_argument');
    expect(snapshot()).toEqual(before);

    const missing = await performSetUserAccount(db as never, adminActor, {
      op: 'softDelete',
      userId: 'no-such-user',
    });
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe('not_found');
    expect(snapshot()).toEqual(before);
  });

  test('softDelete unauthorized actor fails closed without mutating the target', async () => {
    const db = makeDb({
      ...seedSoftDeleteTarget(),
      'users/staff1': { role: 'staff', isActive: true, deletedAt: null, authVersion: 0, username: 's' },
    });
    const beforeTarget = { ...(db.__store.get('users/target1') as Doc) };
    const beforeUname = { ...(db.__store.get('usernames/nongnuch') as Doc) };
    const beforeCred = { ...(db.__store.get('userCredentials/target1') as Doc) };

    const denied = await performSetUserAccount(
      db as never,
      { kind: 'staff', staffId: 'staff1', authVersion: 0 },
      { op: 'softDelete', userId: 'target1' },
    );
    expect(denied.ok).toBe(false);
    expect(denied.status).toBe('unauthorized');
    expect(db.__store.get('users/target1')).toEqual(beforeTarget);
    expect(db.__store.get('usernames/nongnuch')).toEqual(beforeUname);
    expect(db.__store.get('userCredentials/target1')).toEqual(beforeCred);
  });

  test('updateProfile still succeeds under the read-before-write mock', async () => {
    const db = makeDb(
      seedSoftDeleteTarget({
        'users/target1': {
          role: 'staff',
          isActive: true,
          deletedAt: null,
          authVersion: 0,
          username: 'nongnuch',
          firstName: 'Nong',
          lastName: 'Nuch',
        },
      }),
    );
    const credBefore = { ...(db.__store.get('userCredentials/target1') as Doc) };
    const res = await performSetUserAccount(db as never, adminActor, {
      op: 'updateProfile',
      userId: 'target1',
      firstName: 'Nongnuch',
    });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('updated');
    expect(db.__store.get('users/target1')?.firstName).toBe('Nongnuch');
    expect(db.__store.get('users/target1')?.isActive).toBe(true);
    expect(db.__store.get('users/target1')?.deletedAt).toBeNull();
    expect(db.__store.has('usernames/nongnuch')).toBe(true);
    expect(db.__store.get('userCredentials/target1')).toEqual(credBefore);
  });
});
