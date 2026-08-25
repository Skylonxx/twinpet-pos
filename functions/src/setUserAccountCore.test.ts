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
      const tx = {
        get: async (r: { path: string }) => {
          const data = store.get(r.path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        delete: (r: { path: string }) => {
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
