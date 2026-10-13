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
  type AdminSecurityDeps,
} from './adminSecurityService';

const ADMIN = { id: 'admin1', role: 'admin' };
const MGR = { userId: 'mgr1', role: 'manager' as const, isActive: true, branchIds: ['LDP-001'] };
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
    ] as Array<[{ userId: string; role: 'manager' | 'staff'; isActive: boolean; branchIds: string[] }, string | null]>) {
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
    expect(res.overview.events[0]).toMatchObject({ type: 'QUICK_PIN_ROTATED', targetStaffId: 'mgr1' });
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
