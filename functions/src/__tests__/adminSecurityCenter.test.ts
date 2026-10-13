/**
 * Admin & Security Center V1 — server authority + audit tests.
 *
 *  - setUserAccount callable: only the primary username+password admin
 *    principal may mutate; a Quick PIN (anonymous) admin, a manager, staff
 *    and an unauthenticated caller cannot.
 *  - every server-accepted account mutation writes exactly one server-only
 *    `securityAuditEvents` entry in the same transaction; refusals and
 *    idempotent replays write none; no PIN / hash ever reaches an event.
 *  - issuePrivilegedLockoutClear writes its audit event before the LCT1 is
 *    returned and fails closed if it cannot.
 *  - getAdminSecurityOverview: password-admin only, read-only, safe fields.
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
}));
vi.mock('../db', () => ({ db: {} }));

import { isPrimaryPasswordPrincipal, ADMIN_PASSWORD_SESSION_REQUIRED } from '../adminPasswordPrincipal';
import { performSetUserAccountCallable } from '../setUserAccount';
import { performGetAdminSecurityOverview } from '../getAdminSecurityOverview';
import { performIssuePrivilegedLockoutClear } from '../issuePrivilegedLockoutClear';

type Doc = Record<string, unknown>;

/** Path-keyed fake supporting plain gets, collection scans, ordered queries and transactions. */
function makeDb(seed: Record<string, Doc> = {}, opts: { failAuditSet?: boolean } = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const writes: string[] = [];
  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    }
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'ts') return { toMillis: () => 1_000 };
    return v;
  };
  const apply = (path: string, data: Doc, merge: boolean) => {
    if (opts.failAuditSet && path.startsWith('securityAuditEvents/')) throw new Error('audit_unavailable');
    writes.push(path);
    const existing = merge ? (store.get(path) ?? {}) : {};
    const next: Doc = { ...existing };
    for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
    store.set(path, next);
  };
  const snapOf = (path: string) => {
    const data = store.get(path);
    return { exists: data !== undefined, id: path.slice(path.lastIndexOf('/') + 1), data: () => data };
  };
  const docsIn = (c: string) =>
    [...store.keys()]
      .filter((k) => k.startsWith(`${c}/`) && k.split('/').length === 2)
      .map((k) => snapOf(k));
  function docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      get: async () => snapOf(path),
      set: async (data: Doc) => apply(path, data, false),
    };
  }
  const db = {
    collection: (c: string) => ({
      doc: (id: string) => docRef(`${c}/${id}`),
      get: async () => ({ docs: docsIn(c) }),
      orderBy: () => ({
        limit: (n: number) => ({ get: async () => ({ docs: docsIn(c).slice(0, n) }) }),
      }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (r: { path: string }) => snapOf(r.path),
        set: (r: { path: string }, data: Doc, o?: { merge?: boolean }) => apply(r.path, data, !!o?.merge),
        update: (r: { path: string }, data: Doc) => apply(r.path, data, true),
        delete: (r: { path: string }) => {
          writes.push(r.path);
          store.delete(r.path);
        },
      }),
  };
  return { db, store, writes };
}

const marker = { 'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 } };

function seed(): Record<string, Doc> {
  return {
    ...marker,
    'users/admin1': { role: 'admin', isActive: true, deletedAt: null, authVersion: 2, firstName: 'Ad', lastName: 'Min', username: 'admin', branchIds: ['ALL'] },
    'users/mgr1': { role: 'manager', isActive: true, deletedAt: null, authVersion: 1, firstName: 'Na', lastName: 'Ra', username: 'nara', branchIds: ['LDP-001'] },
    'users/staff1': { role: 'staff', isActive: true, deletedAt: null, authVersion: 0, firstName: 'St', lastName: 'Aff', username: 'staff', branchIds: ['LDP-001'] },
    'users/gone1': { role: 'staff', isActive: false, deletedAt: 'ts', authVersion: 0, firstName: 'Old', lastName: 'One', username: '', branchIds: [] },
    'userCredentials/admin1': { pinHash: '$2a$10$adminhashadminhashadminhash', credentialVersion: 3, credentialState: 'rotated_authoritative', disabled: false },
    'userCredentials/mgr1': { pinHash: '$2a$10$mgrhashmgrhashmgrhashmgrhash', credentialVersion: 1, credentialState: 'rotated_authoritative', disabled: false },
    'userCredentials/staff1': { pinHash: '$2a$10$legacylegacylegacylegacy', credentialVersion: 0, credentialState: 'backfilled_not_trusted', disabled: false },
  };
}

const passwordAdmin = {
  uid: 'admin1',
  token: { staffId: 'admin1', role: 'admin', authVersion: 2, firebase: { sign_in_provider: 'password', identities: { email: ['a@x'] } } },
};
const quickPinAdmin = {
  uid: 'anon-uid-1',
  token: { staffId: 'admin1', role: 'admin', authVersion: 2, firebase: { sign_in_provider: 'anonymous', identities: {} } },
};
const passwordManager = {
  uid: 'mgr1',
  token: { staffId: 'mgr1', role: 'manager', authVersion: 1, firebase: { sign_in_provider: 'password', identities: {} } },
};
const quickPinStaff = {
  uid: 'anon-uid-2',
  token: { staffId: 'staff1', role: 'staff', authVersion: 0, firebase: { sign_in_provider: 'anonymous', identities: {} } },
};

function auditEvents(store: Map<string, Doc>): Doc[] {
  return [...store.entries()].filter(([k]) => k.startsWith('securityAuditEvents/')).map(([, v]) => v);
}

async function expectRejected(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('isPrimaryPasswordPrincipal', () => {
  test('only a password session whose uid is its own staff id qualifies', () => {
    expect(isPrimaryPasswordPrincipal(passwordAdmin)).toBe(true);
    expect(isPrimaryPasswordPrincipal(quickPinAdmin)).toBe(false);
    expect(isPrimaryPasswordPrincipal(null)).toBe(false);
    expect(isPrimaryPasswordPrincipal({ uid: 'admin1', token: { staffId: 'admin1' } })).toBe(false);
    expect(
      isPrimaryPasswordPrincipal({ uid: 'admin1', token: { staffId: 'other', firebase: { sign_in_provider: 'password' } } }),
    ).toBe(false);
    for (const provider of ['custom', 'anonymous', 'google.com', 1, undefined]) {
      expect(
        isPrimaryPasswordPrincipal({ uid: 'admin1', token: { staffId: 'admin1', firebase: { sign_in_provider: provider } } }),
      ).toBe(false);
    }
  });
});

describe('setUserAccount callable — Admin Center access control', () => {
  const rotateCmd = { op: 'rotate', userId: 'mgr1', pin: '4321', rotateIdempotencyKey: 'rot-1' };

  test('password admin can mutate (rotate) and exactly one audit event is written', async () => {
    const { db, store } = makeDb(seed());
    const res = await performSetUserAccountCallable(db as never, rotateCmd, passwordAdmin);
    expect(res).toMatchObject({ ok: true, status: 'rotated', userId: 'mgr1', credentialVersion: 2, authVersion: 2 });
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'QUICK_PIN_ROTATED', actorStaffId: 'admin1', targetStaffId: 'mgr1' });
    expect(JSON.stringify(events[0])).not.toContain('4321');
    expect(JSON.stringify(events[0])).not.toContain('pinHash');
  });

  test('a Quick PIN admin session cannot mutate and nothing is written', async () => {
    const { db, writes } = makeDb(seed());
    await expectRejected(performSetUserAccountCallable(db as never, rotateCmd, quickPinAdmin), 'permission-denied');
    expect(writes).toEqual([]);
    try {
      await performSetUserAccountCallable(db as never, rotateCmd, quickPinAdmin);
    } catch (err) {
      expect((err as { details?: { code?: string } }).details?.code).toBe(ADMIN_PASSWORD_SESSION_REQUIRED);
    }
  });

  test('a manager (even with a password session) cannot mutate', async () => {
    const { db, writes } = makeDb(seed());
    await expectRejected(performSetUserAccountCallable(db as never, rotateCmd, passwordManager), 'permission-denied');
    expect(writes).toEqual([]);
  });

  test('a Quick PIN staff session cannot mutate', async () => {
    const { db, writes } = makeDb(seed());
    await expectRejected(performSetUserAccountCallable(db as never, rotateCmd, quickPinStaff), 'permission-denied');
    expect(writes).toEqual([]);
  });

  test('an unauthenticated caller cannot mutate', async () => {
    const { db, writes } = makeDb(seed());
    await expectRejected(performSetUserAccountCallable(db as never, rotateCmd, null), 'unauthenticated');
    expect(writes).toEqual([]);
  });

  test('a stale password admin token (authVersion behind live) is refused', async () => {
    const { db, writes } = makeDb(seed());
    const stale = { ...passwordAdmin, token: { ...passwordAdmin.token, authVersion: 1 } };
    await expectRejected(performSetUserAccountCallable(db as never, rotateCmd, stale), 'permission-denied');
    expect(writes).toEqual([]);
  });
});

describe('setUserAccount — server-authored audit events', () => {
  test('create writes USER_CREATED with role/branches and never the PIN', async () => {
    const { db, store } = makeDb(seed());
    const res = await performSetUserAccountCallable(
      db as never,
      {
        op: 'create',
        idempotencyKey: 'create-k1',
        username: 'Somchai',
        firstName: 'Som',
        lastName: 'Chai',
        role: 'manager',
        branchIds: ['LDP-001'],
        permissions: {},
        isActive: true,
        pin: '9876',
      },
      passwordAdmin,
    );
    expect(res.ok).toBe(true);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'USER_CREATED',
      actorStaffId: 'admin1',
      targetStaffId: res.userId,
      roleAfter: 'manager',
      branchIdsAfter: ['LDP-001'],
    });
    expect(JSON.stringify(events[0])).not.toContain('9876');

    // Idempotent replay: no second event.
    const replay = await performSetUserAccountCallable(
      db as never,
      {
        op: 'create',
        idempotencyKey: 'create-k1',
        username: 'Somchai',
        firstName: 'Som',
        lastName: 'Chai',
        role: 'manager',
        branchIds: ['LDP-001'],
        permissions: {},
        isActive: true,
        pin: '9876',
      },
      passwordAdmin,
    );
    expect(replay.status).toBe('duplicate_confirmed');
    expect(auditEvents(store)).toHaveLength(1);
  });

  test('duplicate username is rejected without an audit event', async () => {
    const { db, store } = makeDb({ ...seed(), 'usernames/nara': { userId: 'mgr1' } });
    const res = await performSetUserAccountCallable(
      db as never,
      {
        op: 'create',
        idempotencyKey: 'create-dup',
        username: 'NARA',
        firstName: 'X',
        lastName: 'Y',
        role: 'staff',
        branchIds: ['LDP-001'],
        permissions: {},
        isActive: true,
        pin: '1111',
      },
      passwordAdmin,
    );
    expect(res).toMatchObject({ ok: false, status: 'username_reservation_conflict' });
    expect(auditEvents(store)).toHaveLength(0);
  });

  test('disable / re-enable write USER_DISABLED / USER_ENABLED and bump authVersion', async () => {
    const { db, store } = makeDb(seed());
    await performSetUserAccountCallable(db as never, { op: 'setActive', userId: 'mgr1', isActive: false }, passwordAdmin);
    expect(store.get('users/mgr1')).toMatchObject({ isActive: false, authVersion: 2 });
    await performSetUserAccountCallable(db as never, { op: 'setActive', userId: 'mgr1', isActive: true }, passwordAdmin);
    expect(store.get('users/mgr1')).toMatchObject({ isActive: true, authVersion: 3, deletedAt: null });
    expect(auditEvents(store).map((e) => e.type)).toEqual(['USER_DISABLED', 'USER_ENABLED']);
  });

  test('role/branch update writes USER_PROFILE_UPDATED with changed field names and before/after', async () => {
    const { db, store } = makeDb(seed());
    await performSetUserAccountCallable(
      db as never,
      { op: 'updateProfile', userId: 'mgr1', firstName: 'Na', lastName: 'Ra', role: 'staff', branchIds: ['BKK-002'] },
      passwordAdmin,
    );
    const [event] = auditEvents(store);
    expect(event).toMatchObject({
      type: 'USER_PROFILE_UPDATED',
      targetStaffId: 'mgr1',
      changedFields: ['branchIds', 'role'],
      roleBefore: 'manager',
      roleAfter: 'staff',
      branchIdsBefore: ['LDP-001'],
      branchIdsAfter: ['BKK-002'],
    });
  });
});

describe('getAdminSecurityOverview', () => {
  test('password admin receives safe user projections and events with zero writes', async () => {
    const { db, store, writes } = makeDb({
      ...seed(),
      'securityAuditEvents/e1': {
        schemaVersion: 1,
        type: 'QUICK_PIN_ROTATED',
        actorStaffId: 'admin1',
        targetStaffId: 'mgr1',
        createdAt: { toMillis: () => 5_000 },
      },
      'securityAuditEvents/e2': { type: 'SOMETHING_UNKNOWN', actorStaffId: 'x', targetStaffId: 'y' },
    });
    void store;
    const res = await performGetAdminSecurityOverview(db as never, passwordAdmin);
    expect(writes).toEqual([]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byId = Object.fromEntries(res.users.map((u) => [u.userId, u]));
    expect(Object.keys(byId).sort()).toEqual(['admin1', 'mgr1', 'staff1']); // soft-deleted excluded
    expect(byId.mgr1).toEqual({
      userId: 'mgr1',
      firstName: 'Na',
      lastName: 'Ra',
      username: 'nara',
      role: 'manager',
      branchIds: ['LDP-001'],
      isActive: true,
      authVersion: 1,
      quickPinState: 'set',
    });
    expect(byId.staff1.quickPinState).toBe('required'); // non-authoritative credential
    const serialized = JSON.stringify(res);
    expect(serialized).not.toMatch(/pinHash|\$2a\$|credentialVersion|credentialState|salt|verifier/);
    expect(res.events).toEqual([
      expect.objectContaining({ type: 'QUICK_PIN_ROTATED', targetStaffId: 'mgr1', createdAtMs: 5_000 }),
    ]);
  });

  test('Quick PIN admin, manager and unauthenticated callers get nothing', async () => {
    const { db, writes } = makeDb(seed());
    expect(await performGetAdminSecurityOverview(db as never, quickPinAdmin)).toEqual({
      ok: false,
      code: 'admin_password_session_required',
    });
    expect(await performGetAdminSecurityOverview(db as never, passwordManager)).toEqual({
      ok: false,
      code: 'not_authorized',
    });
    expect(await performGetAdminSecurityOverview(db as never, null)).toEqual({
      ok: false,
      code: 'admin_password_session_required',
    });
    expect(writes).toEqual([]);
  });
});

describe('issuePrivilegedLockoutClear — audit', () => {
  const DEVICE_HEX = 'a'.repeat(32);
  const LOCKOUT_ID_HEX = 'b'.repeat(64);
  function rawKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return {
      x: (publicKey.export({ format: 'jwk' }) as { x: string }).x,
      d: (privateKey.export({ format: 'jwk' }) as { d: string }).d,
    };
  }
  function lctSeed() {
    const k = rawKeypair();
    return {
      'users/admin1': { role: 'admin', isActive: true, deletedAt: null },
      'users/mgr1': { role: 'manager', isActive: true, deletedAt: null },
      [`privilegedDeviceRegistrations/${DEVICE_HEX}`]: {
        securityDeviceIdHex: DEVICE_HEX,
        branchId: 'LDP-001',
        registeredAtServerMs: 1,
        status: 'ACTIVE',
        isActive: true,
      },
      'privilegedOacKeysetMeta/current': { activeSigningKeyId: 'key-1' },
      'privilegedOacSigningKeys/key-1': {
        signingKeyId: 'key-1',
        publicKeyBase64Url: k.x,
        privateKeyBase64Url: k.d,
        status: 'ACTIVE',
      },
    };
  }
  const req = { securityDeviceIdHex: DEVICE_HEX, managerStaffId: 'mgr1', lockoutIdHex: LOCKOUT_ID_HEX };
  const adminAuth = { uid: 'admin1', token: { role: 'admin' } };

  test('a successful issuance writes one event with no device id, lockout id or token', async () => {
    const { db, store } = makeDb(lctSeed());
    const res = await performIssuePrivilegedLockoutClear(db as never, adminAuth, req, 1_700_000_000_000);
    expect(res.ok).toBe(true);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'APPROVAL_LOCKOUT_CLEAR_ISSUED',
      actorStaffId: 'admin1',
      targetStaffId: 'mgr1',
      deviceBranchId: 'LDP-001',
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(DEVICE_HEX);
    expect(serialized).not.toContain(LOCKOUT_ID_HEX);
    if (res.ok) expect(serialized).not.toContain(res.lct1Base64);
  });

  test('a refused issuance writes no event', async () => {
    const { db, store } = makeDb(lctSeed());
    const res = await performIssuePrivilegedLockoutClear(db as never, { uid: 'mgr1', token: { role: 'manager' } }, req);
    expect(res).toEqual({ ok: false, code: 'not_authorized' });
    expect(auditEvents(store)).toHaveLength(0);
  });

  test('if the audit event cannot be written, no LCT1 is returned', async () => {
    const { db } = makeDb(lctSeed(), { failAuditSet: true });
    await expect(performIssuePrivilegedLockoutClear(db as never, adminAuth, req, 1_700_000_000_000)).rejects.toThrow(
      'audit_unavailable',
    );
  });
});
