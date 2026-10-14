import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({
  app: undefined,
  auth: undefined,
  db: undefined,
  collections: { settings: 'settings' },
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

import { SetUserAccountError } from '../auth/setUserAccount';
import { cloneDefaultMatrix } from '../staffManagement/types';
import {
  __resetAdminSecurityServiceForTests,
  clearManagerApprovalLockout,
  createAdminUser,
  loadAdminSecurityOverview,
  reissueManagerOac,
  rotateAdminUserPin,
  setAdminUserActive,
  updateAdminUser,
  isProtectedAccountTarget,
  isProtectedAdminTarget,
  type AdminSecurityDeps,
} from './adminSecurityService';

const ADMIN = { id: 'admin1', role: 'admin' };
const MGR = {
  userId: 'mgr1',
  role: 'manager' as const,
  isActive: true,
  branchIds: ['LDP-001'],
  securityAdminClassification: null,
  accountAuthClassification: 'QUICK_PIN_ONLY' as const,
};
const SECURITY_ADMIN = {
  userId: 'admin2',
  role: 'admin' as const,
  isActive: true,
  branchIds: ['ALL'],
  securityAdminClassification: 'PASSWORD_ADMIN' as const,
  accountAuthClassification: 'PASSWORD_PRINCIPAL' as const,
};
const UNKNOWN_ADMIN = { ...SECURITY_ADMIN, userId: 'admin3', securityAdminClassification: 'UNKNOWN' as const, accountAuthClassification: 'UNKNOWN' as const };
const POS_ADMIN = {
  ...SECURITY_ADMIN,
  userId: 'posadm1',
  branchIds: ['LDP-001'],
  securityAdminClassification: 'POS_ADMIN' as const,
  accountAuthClassification: 'QUICK_PIN_ONLY' as const,
};
// D-ASC12/D-ASC13: password-backed and unclassified staff / managers.
const PASSWORD_MGR = { ...MGR, userId: 'pwmgr1', accountAuthClassification: 'PASSWORD_PRINCIPAL' as const };
const PASSWORD_STAFF = { ...MGR, userId: 'pwstaff1', role: 'staff' as const, accountAuthClassification: 'PASSWORD_PRINCIPAL' as const };
const UNKNOWN_MGR = { ...MGR, userId: 'unkmgr1', accountAuthClassification: 'UNKNOWN' as const };
const UNKNOWN_STAFF = { ...MGR, userId: 'unkstaff1', role: 'staff' as const, accountAuthClassification: 'UNKNOWN' as const };
const OTHER_MGR_ID = 'mgr2';
const PIN = '4826';

function harness(over: Partial<AdminSecurityDeps> = {}) {
  const callSetUserAccount = vi.fn(async (cmd: { op: string; userId?: string }) => ({
    ok: true,
    status: cmd.op === 'create' ? 'created' : cmd.op === 'rotate' ? 'rotated' : 'updated',
    userId: cmd.userId ?? 'new-user-id',
  }));
  const revokeOac = vi.fn(async () => 'revoked' as const);
  const provision = vi.fn<(input: unknown, deps?: unknown) => Promise<{ kind: 'provisioned' }>>(async () => ({ kind: 'provisioned' }));
  const runLockoutRecovery = vi.fn<(input: unknown, deps?: unknown) => Promise<{ kind: 'recovered' }>>(async () => ({ kind: 'recovered' }));
  const deps: AdminSecurityDeps = {
    isAdminPasswordSession: vi.fn(async () => true),
    callSetUserAccount,
    revokeOac,
    loadRoleMatrix: async () => cloneDefaultMatrix(),
    provision,
    runLockoutRecovery,
    newKey: () => 'fixed-key',
    ...over,
  };
  return { deps, callSetUserAccount, revokeOac, provision, runLockoutRecovery };
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  __resetAdminSecurityServiceForTests();
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
});

afterEach(() => {
  // No PIN may ever reach a console sink.
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(PIN);
    spy.mockRestore();
  }
});

describe('access control', () => {
  it('a password admin session may mutate', async () => {
    const h = harness();
    expect((await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps)).kind).toBe('ok');
    expect(h.callSetUserAccount).toHaveBeenCalledTimes(1);
  });

  it('a Quick PIN admin session (gate false) cannot mutate anything and nothing is called', async () => {
    const h = harness({ isAdminPasswordSession: vi.fn(async () => false) });
    expect(await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps)).toEqual({ kind: 'not_admin' });
    expect(await setAdminUserActive(ADMIN, MGR, false, h.deps)).toEqual({ kind: 'not_admin' });
    expect(await updateAdminUser(ADMIN, MGR, { firstName: 'a', lastName: 'b', role: 'staff', branchIds: ['LDP-001'] }, h.deps)).toEqual({ kind: 'not_admin' });
    expect(
      await createAdminUser(ADMIN, { firstName: 'a', lastName: 'b', username: 'x', role: 'staff', branchIds: ['LDP-001'], pin: PIN }, h.deps),
    ).toEqual({ kind: 'not_admin' });
    expect(await clearManagerApprovalLockout(ADMIN, MGR, h.deps)).toEqual({ kind: 'not_admin' });
    expect(await reissueManagerOac(ADMIN, MGR, 'LDP-001', PIN, h.deps)).toEqual({ kind: 'not_admin' });
    expect(await loadAdminSecurityOverview(ADMIN, { ...h.deps, fetchOverview: vi.fn() })).toEqual({ kind: 'not_admin' });
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
    expect(h.revokeOac).not.toHaveBeenCalled();
    expect(h.provision).not.toHaveBeenCalled();
    expect(h.runLockoutRecovery).not.toHaveBeenCalled();
  });

  it('manager / staff / anonymous operators cannot mutate (gate never even consulted as admin)', async () => {
    for (const operator of [{ id: 'm', role: 'manager' }, { id: 's', role: 'staff' }, null, undefined]) {
      const h = harness();
      expect(await rotateAdminUserPin(operator, MGR, PIN, h.deps)).toEqual({ kind: 'not_admin' });
      expect(h.deps.isAdminPasswordSession).not.toHaveBeenCalled();
      expect(h.callSetUserAccount).not.toHaveBeenCalled();
    }
  });

  it('an admin never mutates their own account here', async () => {
    const h = harness();
    const self = { ...MGR, userId: ADMIN.id };
    expect(await rotateAdminUserPin(ADMIN, self, PIN, h.deps)).toEqual({ kind: 'self_target' });
    expect(await setAdminUserActive(ADMIN, self, false, h.deps)).toEqual({ kind: 'self_target' });
    expect(await updateAdminUser(ADMIN, self, { firstName: 'a', lastName: '', role: 'staff', branchIds: ['LDP-001'] }, h.deps)).toEqual({ kind: 'self_target' });
    expect(await clearManagerApprovalLockout(ADMIN, self, h.deps)).toEqual({ kind: 'self_target' });
    expect(await reissueManagerOac(ADMIN, self, 'LDP-001', PIN, h.deps)).toEqual({ kind: 'self_target' });
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
  });
});

describe('D-ASC8/9 — Security Admin and unclassified admin targets are read-only', () => {
  it('classification decides mutability (fail closed for anything but POS_ADMIN)', () => {
    expect(isProtectedAdminTarget(SECURITY_ADMIN)).toBe(true);
    expect(isProtectedAdminTarget(UNKNOWN_ADMIN)).toBe(true);
    expect(isProtectedAdminTarget({ role: 'admin', securityAdminClassification: null })).toBe(true);
    expect(isProtectedAdminTarget(POS_ADMIN)).toBe(false);
    expect(isProtectedAdminTarget(MGR)).toBe(false);
  });

  for (const [label, target] of [
    ['Security Admin', SECURITY_ADMIN],
    ['UNKNOWN admin', UNKNOWN_ADMIN],
  ] as const) {
    it(`${label}: no mutation, PIN, toggle, lockout clear or OAC reissue is ever called`, async () => {
      const h = harness();
      expect(await rotateAdminUserPin(ADMIN, target, PIN, h.deps)).toEqual({ kind: 'protected_target' });
      expect(await setAdminUserActive(ADMIN, target, false, h.deps)).toEqual({ kind: 'protected_target' });
      expect(await setAdminUserActive(ADMIN, target, true, h.deps)).toEqual({ kind: 'protected_target' });
      expect(
        await updateAdminUser(ADMIN, target, { firstName: 'a', lastName: 'b', role: 'manager', branchIds: ['LDP-001'] }, h.deps),
      ).toEqual({ kind: 'protected_target' });
      expect(await clearManagerApprovalLockout(ADMIN, target, h.deps)).toEqual({ kind: 'protected_target' });
      expect(await reissueManagerOac(ADMIN, target, 'LDP-001', PIN, h.deps)).toEqual({ kind: 'protected_target' });
      expect(h.callSetUserAccount).not.toHaveBeenCalled();
      expect(h.revokeOac).not.toHaveBeenCalled();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.runLockoutRecovery).not.toHaveBeenCalled();
    });
  }

  it('a POS admin stays manageable (rotate + target-only revoke)', async () => {
    const h = harness();
    expect((await rotateAdminUserPin(ADMIN, POS_ADMIN, PIN, h.deps)).kind).toBe('ok');
    expect(h.callSetUserAccount).toHaveBeenCalledTimes(1);
    expect(h.revokeOac.mock.calls).toEqual([['posadm1']]);
  });

  it('a server PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED refusal is definite: shown verbatim, no local OAC revoke', async () => {
    const h = harness({
      callSetUserAccount: vi.fn(async () => {
        throw new SetUserAccountError('บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery', 'functions/failed-precondition');
      }),
    });
    expect(await rotateAdminUserPin(ADMIN, POS_ADMIN, PIN, h.deps)).toEqual({
      kind: 'rejected',
      message: 'บัญชีผู้ดูแลระบบหลักต้องจัดการผ่าน Owner Recovery',
    });
    expect(h.revokeOac).not.toHaveBeenCalled();
  });
});

describe('user management', () => {
  it('creates through the canonical create op (normalized username, role permissions, active, PIN passed through once)', async () => {
    const h = harness();
    const res = await createAdminUser(
      ADMIN,
      { firstName: ' Som ', lastName: 'Chai', username: ' SomChai ', role: 'manager', branchIds: ['LDP-001'], pin: PIN },
      h.deps,
    );
    expect(res).toEqual({ kind: 'ok', userId: 'new-user-id', oacRevoke: 'none' });
    expect(h.callSetUserAccount).toHaveBeenCalledTimes(1);
    expect(h.callSetUserAccount.mock.calls[0]![0]).toMatchObject({
      op: 'create',
      idempotencyKey: 'admin-center-create:somchai:fixed-key',
      username: 'somchai',
      firstName: 'Som',
      role: 'manager',
      branchIds: ['LDP-001'],
      isActive: true,
      pin: PIN,
      permissions: expect.objectContaining({ canVoidOrder: true }),
    });
    expect(h.revokeOac).not.toHaveBeenCalled();
  });

  it('a duplicate username is a definite refusal: message surfaced, nothing revoked, no retry', async () => {
    const h = harness({
      callSetUserAccount: vi.fn(async () => {
        throw new SetUserAccountError('username นี้ถูกใช้แล้ว', 'status:username_reservation_conflict');
      }),
    });
    const res = await createAdminUser(
      ADMIN,
      { firstName: 'A', lastName: 'B', username: 'nara', role: 'staff', branchIds: ['LDP-001'], pin: PIN },
      h.deps,
    );
    expect(res).toEqual({ kind: 'rejected', message: 'username นี้ถูกใช้แล้ว' });
    expect(h.deps.callSetUserAccount).toHaveBeenCalledTimes(1);
    expect(h.revokeOac).not.toHaveBeenCalled();
  });

  it('disable and re-enable each use setActive once and invalidate only that user\'s local OAC', async () => {
    const h = harness();
    expect(await setAdminUserActive(ADMIN, MGR, false, h.deps)).toEqual({ kind: 'ok', userId: 'mgr1', oacRevoke: 'revoked' });
    expect(await setAdminUserActive(ADMIN, MGR, true, h.deps)).toEqual({ kind: 'ok', userId: 'mgr1', oacRevoke: 'revoked' });
    expect(h.callSetUserAccount.mock.calls.map((c) => c[0])).toEqual([
      { op: 'setActive', userId: 'mgr1', isActive: false },
      { op: 'setActive', userId: 'mgr1', isActive: true },
    ]);
    expect(h.revokeOac.mock.calls).toEqual([['mgr1'], ['mgr1']]);
    expect(h.revokeOac).not.toHaveBeenCalledWith(OTHER_MGR_ID);
    expect(h.provision).not.toHaveBeenCalled(); // re-enable never re-provisions
  });

  it('role/branch update uses updateProfile (permissions only on a role change) and invalidates the target OAC', async () => {
    const h = harness();
    await updateAdminUser(ADMIN, MGR, { firstName: 'Na', lastName: 'Ra', role: 'staff', branchIds: ['LDP-001'] }, h.deps);
    await updateAdminUser(ADMIN, MGR, { firstName: 'Na', lastName: 'Ra', role: 'manager', branchIds: ['BKK-002'] }, h.deps);
    const [demote, transfer] = h.callSetUserAccount.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(demote).toMatchObject({ op: 'updateProfile', userId: 'mgr1', role: 'staff', branchIds: ['LDP-001'] });
    expect(demote!.permissions).toEqual(expect.objectContaining({ canVoidOrder: false }));
    expect(transfer).toMatchObject({ op: 'updateProfile', userId: 'mgr1', role: 'manager', branchIds: ['BKK-002'] });
    expect(transfer).not.toHaveProperty('permissions');
    expect(h.revokeOac.mock.calls).toEqual([['mgr1'], ['mgr1']]);
  });

  it('exposes no hard-delete operation', async () => {
    const mod = await import('./adminSecurityService');
    expect(Object.keys(mod).some((k) => /delete|remove/i.test(k))).toBe(false);
  });
});

describe('Quick PIN rotation', () => {
  it('validates the 4-digit shape before any call', async () => {
    const h = harness();
    for (const bad of ['123', '12345', 'abcd', '12a4', ' 1234', '']) {
      expect(await rotateAdminUserPin(ADMIN, MGR, bad, h.deps)).toEqual({ kind: 'invalid', reason: 'pin_format' });
    }
    expect(h.callSetUserAccount).not.toHaveBeenCalled();
  });

  it('rotates canonically exactly once and invalidates ONLY the target manager OAC, never re-provisioning', async () => {
    const h = harness();
    const res = await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps);
    expect(res).toEqual({ kind: 'ok', userId: 'mgr1', oacRevoke: 'revoked' });
    expect(h.callSetUserAccount).toHaveBeenCalledTimes(1);
    expect(h.callSetUserAccount).toHaveBeenCalledWith({
      op: 'rotate',
      userId: 'mgr1',
      pin: PIN,
      rotateIdempotencyKey: 'admin-center-rotate:mgr1:fixed-key',
    });
    expect(h.revokeOac).toHaveBeenCalledTimes(1);
    expect(h.revokeOac).toHaveBeenCalledWith('mgr1');
    expect(h.provision).not.toHaveBeenCalled();
    // The result never carries the PIN.
    expect(JSON.stringify(res)).not.toContain(PIN);
  });

  it('an unknown outcome is never replayed but still invalidates the target OAC (fail closed)', async () => {
    const call = vi.fn(async () => {
      throw new SetUserAccountError('internal', 'functions/internal');
    });
    const h = harness({ callSetUserAccount: call });
    expect(await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps)).toEqual({ kind: 'uncertain', oacRevoke: 'revoked' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(h.revokeOac).toHaveBeenCalledWith('mgr1');
  });

  it('a definite refusal touches no local state', async () => {
    const h = harness({
      callSetUserAccount: vi.fn(async () => {
        throw new SetUserAccountError('ต้องเข้าสู่ระบบด้วยชื่อผู้ใช้และรหัสผ่านของผู้ดูแลระบบเพื่อจัดการความปลอดภัย', 'functions/permission-denied');
      }),
    });
    expect((await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps)).kind).toBe('rejected');
    expect(h.revokeOac).not.toHaveBeenCalled();
  });

  it('a second concurrent mutation is refused without a call', async () => {
    let release!: () => void;
    const call = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: string; userId: string }>((resolve) => {
          release = () => resolve({ ok: true, status: 'rotated', userId: 'mgr1' });
        }),
    );
    const h = harness({ callSetUserAccount: call });
    const first = rotateAdminUserPin(ADMIN, MGR, PIN, h.deps);
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps)).toEqual({ kind: 'busy' });
    release();
    expect((await first).kind).toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('never writes the PIN to web storage', async () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('localStorage', fake);
    vi.stubGlobal('sessionStorage', fake);
    try {
      const h = harness();
      await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps);
      expect([...store.values()].join('|')).not.toContain(PIN);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('approval lockout + OAC reissue reuse', () => {
  it('lockout clear delegates once to the reviewed 0.1.11 recovery episode for the selected manager', async () => {
    const h = harness();
    expect(await clearManagerApprovalLockout(ADMIN, MGR, h.deps)).toEqual({ kind: 'recovered' });
    expect(h.runLockoutRecovery).toHaveBeenCalledTimes(1);
    expect(h.runLockoutRecovery.mock.calls[0]![0]).toEqual({ managerStaffId: 'mgr1', operator: ADMIN });
  });

  it('reissue uses the SELECTED manager id, this terminal branch and that manager\'s PIN, exactly once', async () => {
    const h = harness();
    expect(await reissueManagerOac(ADMIN, MGR, 'LDP-001', PIN, h.deps)).toEqual({ kind: 'provisioned' });
    expect(h.provision).toHaveBeenCalledTimes(1);
    expect(h.provision.mock.calls[0]![0]).toEqual({ managerStaffId: 'mgr1', branchId: 'LDP-001', pin: PIN });
  });

  it('a wrong manager PIN is returned as-is and never retried', async () => {
    const provision = vi.fn(async () => ({ kind: 'pin_rejected' as const }));
    const h = harness({ provision });
    expect(await reissueManagerOac(ADMIN, MGR, 'LDP-001', PIN, h.deps)).toEqual({ kind: 'pin_rejected' });
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('refuses ineligible targets / terminals without a ceremony', async () => {
    const h = harness();
    for (const [target, branch] of [
      [{ ...MGR, role: 'staff' as const }, 'LDP-001'],
      [{ ...MGR, isActive: false }, 'LDP-001'],
      [{ ...MGR, branchIds: ['BKK-002'] }, 'LDP-001'],
      [MGR, 'ALL'],
      [MGR, null],
    ] as Array<[typeof MGR | (Omit<typeof MGR, 'role'> & { role: 'staff' }), string | null]>) {
      expect(await reissueManagerOac(ADMIN, target, branch, PIN, h.deps)).toEqual({ kind: 'not_eligible_target' });
    }
    expect(await reissueManagerOac(ADMIN, MGR, 'LDP-001', '12', h.deps)).toEqual({ kind: 'invalid', reason: 'pin_format' });
    expect(h.provision).not.toHaveBeenCalled();
  });
});

describe('overview', () => {
  it('parses safe projections only', async () => {
    const h = harness({
      fetchOverview: vi.fn(async () => ({
        ok: true,
        users: [
          { userId: 'mgr1', firstName: 'Na', lastName: 'Ra', username: 'nara', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 3, quickPinState: 'set', pinHash: 'x' },
          { userId: 'bad', role: 'root' },
        ],
        events: [{ type: 'QUICK_PIN_ROTATED', actorStaffId: 'admin1', targetStaffId: 'mgr1', createdAtMs: 5 }],
      })),
    });
    const res = await loadAdminSecurityOverview(ADMIN, h.deps);
    expect(res.kind).toBe('ok');
    if (res.kind !== 'ok') return;
    expect(res.overview.users).toHaveLength(1);
    expect(res.overview.users[0]).not.toHaveProperty('pinHash');
    expect(res.overview.users[0]!.securityAdminClassification).toBeNull();
    expect(res.overview.events[0]).toMatchObject({ type: 'QUICK_PIN_ROTATED', targetStaffId: 'mgr1' });
  });

  it('admin classification parses fail-closed: missing / unexpected value → UNKNOWN', async () => {
    const base = { firstName: 'A', lastName: 'B', username: 'a', role: 'admin', branchIds: ['ALL'], isActive: true, authVersion: 0, quickPinState: 'set' };
    const h = harness({
      fetchOverview: vi.fn(async () => ({
        ok: true,
        users: [
          { ...base, userId: 'p', securityAdminClassification: 'PASSWORD_ADMIN' },
          { ...base, userId: 'q', securityAdminClassification: 'POS_ADMIN' },
          { ...base, userId: 'r' },
          { ...base, userId: 's', securityAdminClassification: 'SUPER' },
          { ...base, userId: 't', role: 'manager', securityAdminClassification: 'POS_ADMIN' },
        ],
        events: [],
      })),
    });
    const res = await loadAdminSecurityOverview(ADMIN, h.deps);
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(Object.fromEntries(res.overview.users.map((u) => [u.userId, u.securityAdminClassification]))).toEqual({
      p: 'PASSWORD_ADMIN',
      q: 'POS_ADMIN',
      r: 'UNKNOWN',
      s: 'UNKNOWN',
      t: null,
    });
  });

  it('server-side password-session refusal maps to not_admin; transport failure to failed', async () => {
    expect(
      await loadAdminSecurityOverview(ADMIN, harness({ fetchOverview: async () => ({ ok: false, code: 'admin_password_session_required' }) }).deps),
    ).toEqual({ kind: 'not_admin' });
    expect(
      await loadAdminSecurityOverview(ADMIN, harness({ fetchOverview: async () => { throw new Error('net'); } }).deps),
    ).toEqual({ kind: 'failed' });
  });
});

describe('D-ASC12/D-ASC13 — password-backed and unclassified staff / manager targets are read-only', () => {
  it('only a server-proven Quick-PIN-only account is mutable (any role)', () => {
    expect(isProtectedAccountTarget(MGR)).toBe(false);
    expect(isProtectedAccountTarget({ ...MGR, role: 'staff' })).toBe(false);
    expect(isProtectedAccountTarget(POS_ADMIN)).toBe(false);
    for (const target of [PASSWORD_MGR, PASSWORD_STAFF, UNKNOWN_MGR, UNKNOWN_STAFF, SECURITY_ADMIN, UNKNOWN_ADMIN]) {
      expect(isProtectedAccountTarget(target)).toBe(true);
    }
    // An admin row must also be POS_ADMIN, whatever the account classification says.
    expect(isProtectedAccountTarget({ ...POS_ADMIN, securityAdminClassification: 'UNKNOWN' })).toBe(true);
  });

  for (const [label, target] of [
    ['password-backed manager', PASSWORD_MGR],
    ['password-backed staff', PASSWORD_STAFF],
    ['UNKNOWN manager', UNKNOWN_MGR],
    ['UNKNOWN staff', UNKNOWN_STAFF],
  ] as const) {
    it(`${label}: no edit, PIN, toggle, lockout clear or OAC reissue is ever called, and no local OAC is revoked`, async () => {
      const h = harness();
      expect(await rotateAdminUserPin(ADMIN, target, PIN, h.deps)).toEqual({ kind: 'protected_target' });
      expect(await setAdminUserActive(ADMIN, target, false, h.deps)).toEqual({ kind: 'protected_target' });
      expect(await setAdminUserActive(ADMIN, target, true, h.deps)).toEqual({ kind: 'protected_target' });
      expect(
        await updateAdminUser(ADMIN, target, { firstName: 'a', lastName: 'b', role: target.role, branchIds: ['LDP-001'] }, h.deps),
      ).toEqual({ kind: 'protected_target' });
      expect(await clearManagerApprovalLockout(ADMIN, target, h.deps)).toEqual({ kind: 'protected_target' });
      expect(await reissueManagerOac(ADMIN, target, 'LDP-001', PIN, h.deps)).toEqual({ kind: 'protected_target' });
      expect(h.callSetUserAccount).not.toHaveBeenCalled();
      expect(h.revokeOac).not.toHaveBeenCalled();
      expect(h.provision).not.toHaveBeenCalled();
      expect(h.runLockoutRecovery).not.toHaveBeenCalled();
    });
  }

  it('a server PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED refusal is definite: shown verbatim, no local OAC revoke', async () => {
    const message = 'บัญชีนี้มีการเข้าสู่ระบบด้วย username/password จึงต้องจัดการผ่าน Owner Recovery';
    const h = harness({
      callSetUserAccount: vi.fn(async () => {
        throw new SetUserAccountError(message, 'functions/failed-precondition');
      }),
    });
    expect(await setAdminUserActive(ADMIN, MGR, false, h.deps)).toEqual({ kind: 'rejected', message });
    expect(h.revokeOac).not.toHaveBeenCalled();
  });

  it('a server ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE refusal is definite too: no local OAC revoke', async () => {
    const message = 'ไม่สามารถยืนยันประเภทการเข้าสู่ระบบของบัญชีนี้ได้ จึงยังไม่บันทึกการเปลี่ยนแปลง กรุณาลองใหม่ภายหลัง';
    const h = harness({
      callSetUserAccount: vi.fn(async () => {
        throw new SetUserAccountError(message, 'functions/failed-precondition');
      }),
    });
    expect(await rotateAdminUserPin(ADMIN, MGR, PIN, h.deps)).toEqual({ kind: 'rejected', message });
    expect(h.revokeOac).not.toHaveBeenCalled();
  });

  it('account classification parses fail-closed: missing / unexpected value → UNKNOWN', async () => {
    const base = { firstName: 'A', lastName: 'B', username: 'a', role: 'manager', branchIds: ['LDP-001'], isActive: true, authVersion: 0, quickPinState: 'set' };
    const h = harness({
      fetchOverview: vi.fn(async () => ({
        ok: true,
        users: [
          { ...base, userId: 'q', accountAuthClassification: 'QUICK_PIN_ONLY' },
          { ...base, userId: 'p', role: 'staff', accountAuthClassification: 'PASSWORD_PRINCIPAL' },
          { ...base, userId: 'm' },
          { ...base, userId: 'x', accountAuthClassification: 'quick_pin_only' },
        ],
        events: [],
      })),
    });
    const res = await loadAdminSecurityOverview(ADMIN, h.deps);
    if (res.kind !== 'ok') throw new Error('expected ok');
    expect(Object.fromEntries(res.overview.users.map((u) => [u.userId, u.accountAuthClassification]))).toEqual({
      q: 'QUICK_PIN_ONLY',
      p: 'PASSWORD_PRINCIPAL',
      m: 'UNKNOWN',
      x: 'UNKNOWN',
    });
  });
});
