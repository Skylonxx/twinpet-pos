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
import { createUserIdFromKey, performSetUserAccount } from '../setUserAccountCore';
import {
  ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
  PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED,
  PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE,
  PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE,
  classifyAdminTargets,
  type AdminAuthLookup,
} from '../adminTargetClassification';
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

/**
 * Fake Firebase Auth `getUsers`: uids in `password` exist with the password
 * provider (and an email that must never leak); uids in `other` exist with a
 * non-password provider; everything else is not found. `fail` throws.
 */
function fakeAuth(opts: { password?: string[]; other?: string[]; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const lookup: AdminAuthLookup = async (uids) => {
    calls.push([...uids]);
    if (opts.fail) throw new Error('auth/internal-error');
    const users: Array<{ uid: string; email: string; providerData: Array<{ providerId: string; email?: string }> }> = [];
    const notFound: Array<{ uid: string }> = [];
    for (const uid of uids) {
      if (opts.password?.includes(uid)) {
        users.push({ uid, email: `${uid}@secret.example`, providerData: [{ providerId: 'password', email: `${uid}@secret.example` }] });
      } else if (opts.other?.includes(uid)) {
        users.push({ uid, email: `${uid}@secret.example`, providerData: [{ providerId: 'google.com' }] });
      } else {
        notFound.push({ uid });
      }
    }
    return { users, notFound };
  };
  return Object.assign(lookup, { calls });
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
    const res = await performGetAdminSecurityOverview(db as never, passwordAdmin, fakeAuth({ password: ['admin1'] }));
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
      securityAdminClassification: null,
    });
    expect(byId.admin1.securityAdminClassification).toBe('PASSWORD_ADMIN');
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

describe('D-ASC8 — password-backed admin targets are protected from staff mutation', () => {
  function adminSeed(): Record<string, Doc> {
    return {
      ...seed(),
      'users/admin2': { role: 'admin', isActive: true, deletedAt: null, authVersion: 4, firstName: 'Sec', lastName: 'Two', username: 'admin2', branchIds: ['ALL'] },
      'users/posadm1': { role: 'admin', isActive: true, deletedAt: null, authVersion: 1, firstName: 'Pos', lastName: 'Adm', username: 'posadm', branchIds: ['LDP-001'] },
      'userCredentials/admin2': { pinHash: '$2a$10$admin2hashadmin2hashadmin2', credentialVersion: 1, credentialState: 'rotated_authoritative', disabled: false },
      'userCredentials/posadm1': { pinHash: '$2a$10$posadmhashposadmhashposadm', credentialVersion: 1, credentialState: 'rotated_authoritative', disabled: false },
    };
  }
  const auth = () => fakeAuth({ password: ['admin1', 'admin2'] });

  async function expectProtected(promise: Promise<unknown>, code: string) {
    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'failed-precondition', details: { code } });
    return caught as { message: string };
  }

  const protectedOps: Array<[string, Record<string, unknown>]> = [
    ['rotate', { op: 'rotate', userId: 'admin2', pin: '4321', rotateIdempotencyKey: 'rot-a2' }],
    ['updateProfile', { op: 'updateProfile', userId: 'admin2', firstName: 'X', lastName: 'Y', role: 'admin', branchIds: ['ALL'] }],
    ['updateProfile (demote)', { op: 'updateProfile', userId: 'admin2', role: 'manager', branchIds: ['LDP-001'] }],
    ['setActive(false)', { op: 'setActive', userId: 'admin2', isActive: false }],
    ['setActive(true)', { op: 'setActive', userId: 'admin2', isActive: true }],
    ['rename', { op: 'rename', userId: 'admin2', newUsername: 'renamed' }],
    ['softDelete', { op: 'softDelete', userId: 'admin2' }],
  ];

  for (const [label, cmd] of protectedOps) {
    test(`${label} on another password admin is refused before any write (no authVersion bump, no audit)`, async () => {
      const { db, store, writes } = makeDb(adminSeed());
      const err = await expectProtected(
        performSetUserAccountCallable(db as never, cmd, passwordAdmin, auth()),
        PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED,
      );
      expect(err.message).toBe(PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE);
      expect(err.message).toBe('บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery');
      expect(writes).toEqual([]);
      expect(store.get('users/admin2')).toMatchObject({ authVersion: 4, isActive: true, username: 'admin2', role: 'admin' });
      expect(auditEvents(store)).toHaveLength(0);
      expect(JSON.stringify(err)).not.toContain('secret.example');
    });
  }

  test('a password admin cannot mutate their OWN account through the callable', async () => {
    for (const cmd of [
      { op: 'rotate', userId: 'admin1', pin: '4321', rotateIdempotencyKey: 'rot-self' },
      { op: 'setActive', userId: 'admin1', isActive: true },
      { op: 'updateProfile', userId: 'admin1', branchIds: ['ALL'] },
    ]) {
      const { db, store, writes } = makeDb(adminSeed());
      await expectProtected(performSetUserAccountCallable(db as never, cmd, passwordAdmin, auth()), PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED);
      expect(writes).toEqual([]);
      expect(store.get('users/admin1')).toMatchObject({ authVersion: 2 });
    }
  });

  test('an Auth lookup failure fails closed with a separate code and no mutation', async () => {
    const { db, store, writes } = makeDb(adminSeed());
    await expectProtected(
      performSetUserAccountCallable(db as never, { op: 'setActive', userId: 'posadm1', isActive: false }, passwordAdmin, fakeAuth({ fail: true })),
      ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
    );
    expect(writes).toEqual([]);
    expect(store.get('users/posadm1')).toMatchObject({ authVersion: 1, isActive: true });
    expect(auditEvents(store)).toHaveLength(0);
  });

  test('an Auth user without the password provider is UNKNOWN and fails closed', async () => {
    const { db, writes } = makeDb(adminSeed());
    await expectProtected(
      performSetUserAccountCallable(
        db as never,
        { op: 'rotate', userId: 'posadm1', pin: '1234', rotateIdempotencyKey: 'rot-x' },
        passwordAdmin,
        fakeAuth({ password: ['admin1'], other: ['posadm1'] }),
      ),
      ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
    );
    expect(writes).toEqual([]);
  });

  test('role=admin without a password principal is a POS admin and remains manageable', async () => {
    const { db, store } = makeDb(adminSeed());
    const lookup = auth();
    const rotated = await performSetUserAccountCallable(
      db as never,
      { op: 'rotate', userId: 'posadm1', pin: '2468', rotateIdempotencyKey: 'rot-pos' },
      passwordAdmin,
      lookup,
    );
    expect(rotated).toMatchObject({ ok: true, status: 'rotated', authVersion: 2 });
    const disabled = await performSetUserAccountCallable(
      db as never,
      { op: 'setActive', userId: 'posadm1', isActive: false },
      passwordAdmin,
      lookup,
    );
    expect(disabled).toMatchObject({ ok: true, status: 'updated' });
    expect(store.get('users/posadm1')).toMatchObject({ isActive: false, authVersion: 3 });
    expect(auditEvents(store).map((e) => e.type)).toEqual(['QUICK_PIN_ROTATED', 'USER_DISABLED']);
    expect(lookup.calls).toEqual([['posadm1'], ['posadm1']]);
  });

  test('staff / manager targets not being promoted to admin never trigger an Auth lookup and stay manageable', async () => {
    const { db } = makeDb(adminSeed());
    const lookup = auth();
    for (const cmd of [
      { op: 'rotate', userId: 'mgr1', pin: '1357', rotateIdempotencyKey: 'rot-m' },
      { op: 'setActive', userId: 'staff1', isActive: false },
      { op: 'updateProfile', userId: 'mgr1', role: 'manager', branchIds: ['LDP-001'] },
      { op: 'updateProfile', userId: 'staff1', role: 'manager', branchIds: ['LDP-001'] },
    ]) {
      expect((await performSetUserAccountCallable(db as never, cmd, passwordAdmin, lookup)).ok).toBe(true);
    }
    expect(lookup.calls).toEqual([]);
  });

  test('a non-admin caller learns nothing about an admin target (no classification oracle)', async () => {
    const { db, writes } = makeDb(adminSeed());
    const lookup = auth();
    await expectRejected(
      performSetUserAccountCallable(db as never, { op: 'setActive', userId: 'admin2', isActive: false }, passwordManager, lookup),
      'permission-denied',
    );
    expect(lookup.calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('core guard: a live admin target not pre-cleared is refused inside the transaction (role-change race)', async () => {
    const { db, store, writes } = makeDb(adminSeed());
    const res = await performSetUserAccount(
      db as never,
      { kind: 'staff', staffId: 'admin1', authVersion: 2, adminTargetGuard: { clearedPosAdminTargetId: null } },
      { op: 'setActive', userId: 'posadm1', isActive: false },
    );
    expect(res).toMatchObject({ ok: false, status: 'protected_admin_target' });
    expect(writes).toEqual([]);
    expect(store.get('users/posadm1')).toMatchObject({ authVersion: 1 });
    const cleared = await performSetUserAccount(
      db as never,
      { kind: 'staff', staffId: 'admin1', authVersion: 2, adminTargetGuard: { clearedPosAdminTargetId: 'posadm1' } },
      { op: 'setActive', userId: 'admin2', isActive: false },
    );
    expect(cleared).toMatchObject({ ok: false, status: 'protected_admin_target' });
    expect(writes).toEqual([]);
  });

  test('operator_cli recovery route is unchanged and may still rotate a password admin', async () => {
    const { db, store } = makeDb(adminSeed());
    const res = await performSetUserAccount(db as never, { kind: 'operator_cli' }, {
      op: 'rotate',
      userId: 'admin2',
      pin: '8642',
      rotateIdempotencyKey: 'cli-rot',
      reasonCode: 'operator_recovery',
    });
    expect(res).toMatchObject({ ok: true, status: 'rotated' });
    expect(store.get('users/admin2')).toMatchObject({ authVersion: 5 });
    expect(auditEvents(store)[0]).toMatchObject({ type: 'QUICK_PIN_ROTATED', actorStaffId: 'OPERATOR_CLI', targetStaffId: 'admin2' });
  });
});

describe('D-ASC11 — any transition INTO role=admin requires Auth classification', () => {
  // mgr1 / staff1 are password-backed (an Auth user with the password
  // provider), mgr2 has no Auth user at all, other1 has a non-password Auth user.
  function promoSeed(): Record<string, Doc> {
    return {
      ...seed(),
      'users/mgr2': { role: 'manager', isActive: true, deletedAt: null, authVersion: 3, firstName: 'Pos', lastName: 'Mgr', username: 'posmgr', branchIds: ['LDP-001'], permissions: { pos: true } },
      'users/other1': { role: 'staff', isActive: true, deletedAt: null, authVersion: 0, firstName: 'Oth', lastName: 'Er', username: 'other', branchIds: ['LDP-001'] },
      'users/posadm1': { role: 'admin', isActive: true, deletedAt: null, authVersion: 1, firstName: 'Pos', lastName: 'Adm', username: 'posadm', branchIds: ['LDP-001'] },
      'users/admin2': { role: 'admin', isActive: true, deletedAt: null, authVersion: 4, firstName: 'Sec', lastName: 'Two', username: 'admin2', branchIds: ['ALL'] },
      'userCredentials/mgr2': { pinHash: '$2a$10$mgr2hashmgr2hashmgr2hashmgr2', credentialVersion: 2, credentialState: 'rotated_authoritative', disabled: false },
    };
  }
  const auth = () => fakeAuth({ password: ['admin1', 'admin2', 'mgr1', 'staff1'], other: ['other1'] });
  const promote = (userId: string, branchIds = ['LDP-001']) => ({
    op: 'updateProfile',
    userId,
    firstName: 'New',
    lastName: 'Admin',
    role: 'admin',
    branchIds,
    permissions: { admin: true },
  });

  async function refusal(promise: Promise<unknown>) {
    let caught: unknown = null;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    return caught as { code: string; message: string; details?: { code?: string } };
  }

  function expectUntouched(store: Map<string, Doc>, before: Record<string, Doc>, ids: string[]) {
    for (const id of ids) {
      expect(store.get(`users/${id}`)).toEqual(before[`users/${id}`]);
      expect(store.get(`userCredentials/${id}`)).toEqual(before[`userCredentials/${id}`]);
    }
    expect(auditEvents(store)).toHaveLength(0);
  }

  for (const [label, target] of [
    ['password-backed staff', 'staff1'],
    ['password-backed manager', 'mgr1'],
  ] as const) {
    test(`${label} → role=admin is refused before mutation (no role/branch/permission/authVersion/credential/audit change)`, async () => {
      const before = promoSeed();
      const { db, store, writes } = makeDb(before);
      const lookup = auth();
      const err = await refusal(performSetUserAccountCallable(db as never, promote(target, ['ALL']), passwordAdmin, lookup));
      expect(err).toMatchObject({ code: 'failed-precondition', details: { code: PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED } });
      expect(err.message).toBe(PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE);
      expect(err.message).toBe('บัญชีที่มีการเข้าสู่ระบบด้วยรหัสผ่านไม่สามารถเปลี่ยนเป็น POS Admin ผ่านหน้านี้ได้ กรุณาใช้ Owner Recovery');
      expect(writes).toEqual([]);
      expectUntouched(store, before, [target]);
      expect(lookup.calls).toEqual([[target]]);
      expect(JSON.stringify(err)).not.toContain('secret.example');
    });
  }

  test('a non-password Auth user being promoted is UNKNOWN and fails closed with no mutation', async () => {
    const before = promoSeed();
    const { db, store, writes } = makeDb(before);
    const err = await refusal(performSetUserAccountCallable(db as never, promote('other1'), passwordAdmin, auth()));
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE } });
    expect(writes).toEqual([]);
    expectUntouched(store, before, ['other1']);
  });

  for (const [label, lookup] of [
    ['throws (transient)', fakeAuth({ fail: true })],
    ['is malformed', (async () => ({ users: 'x' })) as unknown as AdminAuthLookup],
    ['is silent about the uid', (async () => ({ users: [], notFound: [] })) as AdminAuthLookup],
    ['is contradictory', (async () => ({ users: [{ uid: 'mgr2', providerData: [] }], notFound: [{ uid: 'mgr2' }] })) as AdminAuthLookup],
  ] as const) {
    test(`an Auth lookup that ${label} never lets a promotion through`, async () => {
      const before = promoSeed();
      const { db, store, writes } = makeDb(before);
      const err = await refusal(performSetUserAccountCallable(db as never, promote('mgr2'), passwordAdmin, lookup));
      expect(err).toMatchObject({ code: 'failed-precondition', details: { code: ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE } });
      expect(writes).toEqual([]);
      expectUntouched(store, before, ['mgr2']);
    });
  }

  test('a manager with no Auth user is POS_ADMIN and may be promoted: authVersion +1 exactly, one correct audit event', async () => {
    const { db, store } = makeDb(promoSeed());
    const lookup = auth();
    const res = await performSetUserAccountCallable(db as never, promote('mgr2'), passwordAdmin, lookup);
    expect(res).toMatchObject({ ok: true, status: 'updated', userId: 'mgr2', authVersion: 4 });
    expect(store.get('users/mgr2')).toMatchObject({ role: 'admin', authVersion: 4, branchIds: ['LDP-001'], permissions: { admin: true } });
    // Credential untouched: a promotion never creates or changes a password / PIN.
    expect(store.get('userCredentials/mgr2')).toMatchObject({ credentialVersion: 2 });
    expect(lookup.calls).toEqual([['mgr2']]);
    const events = auditEvents(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'USER_PROFILE_UPDATED',
      actorStaffId: 'admin1',
      targetStaffId: 'mgr2',
      roleBefore: 'manager',
      roleAfter: 'admin',
    });
    expect(events[0]!.changedFields).toEqual(expect.arrayContaining(['role', 'permissions']));
  });

  test('an existing POS_ADMIN edit stays allowed; an existing PASSWORD_ADMIN edit stays refused', async () => {
    const { db, store } = makeDb(promoSeed());
    const lookup = auth();
    const ok = await performSetUserAccountCallable(
      db as never,
      { op: 'updateProfile', userId: 'posadm1', firstName: 'Renamed', role: 'admin', branchIds: ['LDP-001'] },
      passwordAdmin,
      lookup,
    );
    expect(ok).toMatchObject({ ok: true, status: 'updated', authVersion: 2 });
    const err = await refusal(
      performSetUserAccountCallable(
        db as never,
        { op: 'updateProfile', userId: 'admin2', firstName: 'X', role: 'admin', branchIds: ['ALL'] },
        passwordAdmin,
        lookup,
      ),
    );
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED } });
    expect(err.message).toBe(PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE);
    expect(store.get('users/admin2')).toMatchObject({ authVersion: 4, firstName: 'Sec' });
  });

  test('core guard: a resulting role=admin without the exact uid pre-cleared is refused inside the transaction', async () => {
    const before = promoSeed();
    const { db, store, writes } = makeDb(before);
    for (const cleared of [null, 'posadm1', 'mgr1']) {
      const res = await performSetUserAccount(
        db as never,
        { kind: 'staff', staffId: 'admin1', authVersion: 2, adminTargetGuard: { clearedPosAdminTargetId: cleared } },
        promote('mgr2') as never,
      );
      expect(res).toMatchObject({ ok: false, status: 'protected_admin_target' });
    }
    expect(writes).toEqual([]);
    expectUntouched(store, before, ['mgr2']);
    // The exact pre-cleared uid may be promoted.
    const ok = await performSetUserAccount(
      db as never,
      { kind: 'staff', staffId: 'admin1', authVersion: 2, adminTargetGuard: { clearedPosAdminTargetId: 'mgr2' } },
      promote('mgr2') as never,
    );
    expect(ok).toMatchObject({ ok: true, status: 'updated', authVersion: 4 });
  });

  test('race: the target becomes an admin between the pre-read and the transaction → fail closed, no write', async () => {
    const before = promoSeed();
    const { db, store, writes } = makeDb(before);
    const lookup = auth();
    const realCollection = db.collection;
    db.collection = (c: string) => {
      const col = realCollection(c);
      return {
        ...col,
        doc: (id: string) => {
          const ref = col.doc(id);
          if (c !== 'users' || id !== 'mgr2') return ref;
          return {
            ...ref,
            get: async () => {
              const snap = await ref.get();
              // Someone else promotes mgr2 right after the callable's pre-read.
              store.set('users/mgr2', { ...store.get('users/mgr2'), role: 'admin' });
              return snap;
            },
          };
        },
      };
    };
    const err = await refusal(
      performSetUserAccountCallable(db as never, { op: 'setActive', userId: 'mgr2', isActive: false }, passwordAdmin, lookup),
    );
    expect(err).toMatchObject({ code: 'failed-precondition', details: { code: ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE } });
    expect(writes).toEqual([]);
    expect(store.get('users/mgr2')).toMatchObject({ authVersion: 3, isActive: true });
    expect(auditEvents(store)).toHaveLength(0);
    expect(lookup.calls).toEqual([]);
  });

  test('a non-admin caller attempting a promotion gets permission-denied and no classification oracle', async () => {
    const { db, writes } = makeDb(promoSeed());
    const lookup = auth();
    for (const target of ['staff1', 'mgr2', 'other1']) {
      await expectRejected(performSetUserAccountCallable(db as never, promote(target), passwordManager, lookup), 'permission-denied');
    }
    expect(lookup.calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('promoting a missing user does no Auth lookup and returns not_found', async () => {
    const { db, writes } = makeDb(promoSeed());
    const lookup = auth();
    const res = await performSetUserAccountCallable(db as never, promote('nobody'), passwordAdmin, lookup);
    expect(res).toMatchObject({ ok: false, status: 'not_found' });
    expect(lookup.calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  test('create role=admin makes a fresh 40-hex POS admin id from the idempotency key, with no Auth lookup or Auth user', async () => {
    const { db, store } = makeDb(promoSeed());
    const lookup = auth();
    const res = await performSetUserAccountCallable(
      db as never,
      {
        op: 'create',
        idempotencyKey: 'admin-center-create:newpos:k1',
        username: 'newpos',
        firstName: 'New',
        lastName: 'Pos',
        role: 'admin',
        branchIds: ['LDP-001'],
        permissions: {},
        isActive: true,
        pin: '5678',
      },
      passwordAdmin,
      lookup,
    );
    expect(res).toMatchObject({ ok: true, status: 'created' });
    expect(res.userId).toBe(createUserIdFromKey('admin-center-create:newpos:k1'));
    expect(res.userId).toMatch(/^[0-9a-f]{40}$/);
    expect(store.get(`users/${res.userId}`)).toMatchObject({ role: 'admin', authVersion: 0 });
    expect(lookup.calls).toEqual([]);
  });

  test('operator_cli recovery behavior is unchanged (no guard, no Auth lookup)', async () => {
    const { db, store } = makeDb(promoSeed());
    const res = await performSetUserAccount(db as never, { kind: 'operator_cli' }, promote('mgr1') as never);
    expect(res).toMatchObject({ ok: true, status: 'updated', authVersion: 2 });
    expect(store.get('users/mgr1')).toMatchObject({ role: 'admin' });
    expect(auditEvents(store)[0]).toMatchObject({ type: 'USER_PROFILE_UPDATED', actorStaffId: 'OPERATOR_CLI', roleAfter: 'admin' });
  });
});

describe('D-ASC9 — admin classification', () => {
  test('classifyAdminTargets: password → PASSWORD_ADMIN, not found → POS_ADMIN, other/failed/malformed → UNKNOWN', async () => {
    const map = await classifyAdminTargets(['a', 'b', 'c'], fakeAuth({ password: ['a'], other: ['c'] }));
    expect(Object.fromEntries(map)).toEqual({ a: 'PASSWORD_ADMIN', b: 'POS_ADMIN', c: 'UNKNOWN' });
    const failed = await classifyAdminTargets(['a', 'b'], fakeAuth({ fail: true }));
    expect(Object.fromEntries(failed)).toEqual({ a: 'UNKNOWN', b: 'UNKNOWN' });
    const malformed = await classifyAdminTargets(['a'], (async () => ({ users: 'x' })) as never);
    expect(Object.fromEntries(malformed)).toEqual({ a: 'UNKNOWN' });
    const silent = await classifyAdminTargets(['a'], async () => ({ users: [], notFound: [] }));
    expect(Object.fromEntries(silent)).toEqual({ a: 'UNKNOWN' });
    const contradictory = await classifyAdminTargets(['a'], async () => ({
      users: [{ uid: 'a', providerData: [{ providerId: 'password' }] }],
      notFound: [{ uid: 'a' }],
    }));
    expect(Object.fromEntries(contradictory)).toEqual({ a: 'UNKNOWN' });
  });

  test('overview classifies only live admins, never leaks email/provider, and fails closed to UNKNOWN', async () => {
    const seedWithPos = {
      ...seed(),
      'users/posadm1': { role: 'admin', isActive: true, deletedAt: null, authVersion: 0, firstName: 'P', lastName: 'A', username: 'posadm', branchIds: ['LDP-001'] },
    };
    const { db, writes } = makeDb(seedWithPos);
    const lookup = fakeAuth({ password: ['admin1'] });
    const res = await performGetAdminSecurityOverview(db as never, passwordAdmin, lookup);
    expect(writes).toEqual([]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cls = Object.fromEntries(res.users.map((u) => [u.userId, u.securityAdminClassification]));
    expect(cls).toEqual({ admin1: 'PASSWORD_ADMIN', posadm1: 'POS_ADMIN', mgr1: null, staff1: null });
    expect(lookup.calls.flat().sort()).toEqual(['admin1', 'posadm1']);
    expect(JSON.stringify(res)).not.toMatch(/secret\.example|providerData|providerId|email/);

    const { db: db2 } = makeDb(seedWithPos);
    const failed = await performGetAdminSecurityOverview(db2 as never, passwordAdmin, fakeAuth({ fail: true }));
    if (!failed.ok) throw new Error('expected ok');
    expect(Object.fromEntries(failed.users.map((u) => [u.userId, u.securityAdminClassification]))).toEqual({
      admin1: 'UNKNOWN',
      posadm1: 'UNKNOWN',
      mgr1: null,
      staff1: null,
    });
  });
});
