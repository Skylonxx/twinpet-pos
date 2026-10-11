/**
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002 — D-V6 secondary,
 * isolated manager principal. Firebase SDK modules are mocked; no live
 * Firebase. Proves the primary principal is never touched, the secondary is
 * the selected manager only, and it is always torn down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const primaryUser = { uid: 'operator-anon-uid', isAnonymous: true };
  const primaryAuth = { currentUser: primaryUser, name: 'primary-auth' };
  const primaryApp = { name: '[DEFAULT]', options: { apiKey: 'k', projectId: 'p', appId: 'a' } };
  return {
    primaryUser,
    primaryAuth,
    primaryApp,
    secondaryUser: null as null | { uid: string; isAnonymous: boolean; getIdTokenResult: ReturnType<typeof vi.fn> },
    claims: {} as Record<string, unknown>,
    callableHandlers: {} as Record<string, (data: unknown) => unknown>,
    log: [] as string[],
  };
});

vi.mock('../firebase', () => ({
  app: h.primaryApp,
  auth: h.primaryAuth,
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));

vi.mock('firebase/app', () => {
  class FirebaseError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    FirebaseError,
    initializeApp: vi.fn((options: unknown, name: string) => {
      h.log.push(`initializeApp:${name}`);
      return { name, options };
    }),
    deleteApp: vi.fn(async (app: { name: string }) => {
      h.log.push(`deleteApp:${app.name}`);
    }),
  };
});

vi.mock('firebase/auth', () => ({
  inMemoryPersistence: { type: 'NONE' },
  initializeAuth: vi.fn((app: { name: string }, deps: { persistence: unknown }) => {
    h.log.push(`initializeAuth:${app.name}:${(deps.persistence as { type: string }).type}`);
    return { app, currentUser: null as unknown, name: `auth:${app.name}` };
  }),
  signInAnonymously: vi.fn(async (auth: { currentUser: unknown }) => {
    h.secondaryUser = {
      uid: 'secondary-anon-uid',
      isAnonymous: true,
      getIdTokenResult: vi.fn(async () => ({ claims: h.claims })),
    };
    auth.currentUser = h.secondaryUser;
    h.log.push('signInAnonymously');
  }),
  deleteUser: vi.fn(async (user: { uid: string }) => {
    h.log.push(`deleteUser:${user.uid}`);
  }),
  signOut: vi.fn(async (auth: { name: string }) => {
    h.log.push(`signOut:${auth.name}`);
  }),
  connectAuthEmulator: vi.fn(),
}));

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn((app: { name: string }) => ({ app })),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: vi.fn((fns: { app: { name: string } }, name: string) => async (data: unknown) => {
    h.log.push(`call:${fns.app.name}:${name}`);
    const handler = h.callableHandlers[name];
    if (!handler) throw new Error(`unexpected callable ${name}`);
    return { data: await handler(data) };
  }),
}));

import { withManagerApprovalPrincipal } from './managerApprovalPrincipal';

const MANAGER = 'mgr-1';
const BRANCH = 'LDP-001';
const PARAMS = { managerStaffId: MANAGER, pin: '1234', branchId: BRANCH };

beforeEach(() => {
  h.log = [];
  h.secondaryUser = null;
  h.claims = { staffId: MANAGER, role: 'manager', branchIds: [BRANCH] };
  h.callableHandlers = {
    verifyPinLogin: () => ({ success: true, user: { id: MANAGER } }),
    beginPrivilegedOacIssuanceSession: () => ({ ok: true }),
  };
});

function secondaryAppName(): string {
  const entry = h.log.find((l) => l.startsWith('initializeApp:'));
  return entry!.slice('initializeApp:'.length);
}

describe('withManagerApprovalPrincipal (real-factory wiring, SDK mocked)', () => {
  it('uses a uniquely named secondary app with in-memory auth; the primary principal is untouched', async () => {
    const res = await withManagerApprovalPrincipal(PARAMS, async (p) => p.call('beginPrivilegedOacIssuanceSession', {}));
    expect(res).toEqual({ ok: true, value: { ok: true } });
    const name = secondaryAppName();
    expect(name).not.toBe('[DEFAULT]');
    expect(name).toMatch(/^twinpet-manager-approval-/);
    expect(h.log).toContain(`initializeAuth:${name}:NONE`);
    // Every callable went through the SECONDARY app's Functions instance.
    expect(h.log.filter((l) => l.startsWith('call:'))).toEqual([
      `call:${name}:verifyPinLogin`,
      `call:${name}:beginPrivilegedOacIssuanceSession`,
    ]);
    // Primary principal unchanged: same object, same UID, never signed out.
    expect(h.primaryAuth.currentUser).toBe(h.primaryUser);
    expect(h.primaryUser.uid).toBe('operator-anon-uid');
    expect(h.log).not.toContain('signOut:primary-auth');
    expect(h.secondaryUser!.getIdTokenResult).toHaveBeenCalledWith(true);
  });

  it('verifyPinLogin is called for the SELECTED manager by userId + target branch', async () => {
    const seen: unknown[] = [];
    h.callableHandlers.verifyPinLogin = (data) => {
      seen.push(data);
      return { success: true, user: { id: MANAGER } };
    };
    await withManagerApprovalPrincipal(PARAMS, async () => 'x');
    expect(seen).toEqual([{ pin: '1234', branchId: BRANCH, userId: MANAGER }]);
  });

  it('cleans up (deleteUser, signOut, deleteApp) after success', async () => {
    await withManagerApprovalPrincipal(PARAMS, async () => 'done');
    const name = secondaryAppName();
    expect(h.log.slice(-3)).toEqual(['deleteUser:secondary-anon-uid', `signOut:auth:${name}`, `deleteApp:${name}`]);
  });

  it('cleans up after a body failure and propagates it', async () => {
    await expect(
      withManagerApprovalPrincipal(PARAMS, async () => {
        throw new Error('ceremony boom');
      }),
    ).rejects.toThrow('ceremony boom');
    const name = secondaryAppName();
    expect(h.log).toContain(`deleteApp:${name}`);
    expect(h.log).toContain(`signOut:auth:${name}`);
  });

  it('cleans up after a refused PIN (pin_rejected) and never runs body', async () => {
    h.callableHandlers.verifyPinLogin = () => {
      throw Object.assign(new Error('x'), { code: 'functions/permission-denied' });
    };
    const body = vi.fn();
    const res = await withManagerApprovalPrincipal(PARAMS, body);
    expect(res).toEqual({ ok: false, code: 'pin_rejected' });
    expect(body).not.toHaveBeenCalled();
    expect(h.log).toContain(`deleteApp:${secondaryAppName()}`);
  });

  it.each([
    ['claims for another staff', { staffId: 'mgr-OTHER', role: 'manager', branchIds: [BRANCH] }],
    ['non-approver role', { staffId: MANAGER, role: 'staff', branchIds: [BRANCH] }],
    ['no access to the target branch', { staffId: MANAGER, role: 'manager', branchIds: ['LDP-999'] }],
    ['missing claims', {}],
  ])('identity mismatch (%s) fails closed, body never runs, cleaned up', async (_label, claims) => {
    h.claims = claims;
    const body = vi.fn();
    const res = await withManagerApprovalPrincipal(PARAMS, body);
    expect(res).toEqual({ ok: false, code: 'identity_mismatch' });
    expect(body).not.toHaveBeenCalled();
    expect(h.log).toContain(`deleteApp:${secondaryAppName()}`);
  });

  it('verifyPinLogin returning a different user id fails closed', async () => {
    h.callableHandlers.verifyPinLogin = () => ({ success: true, user: { id: 'someone-else' } });
    const body = vi.fn();
    const res = await withManagerApprovalPrincipal(PARAMS, body);
    expect(res).toEqual({ ok: false, code: 'identity_mismatch' });
    expect(body).not.toHaveBeenCalled();
  });

  it('a Global Admin approver (branchIds ALL) is accepted for a concrete branch', async () => {
    h.claims = { staffId: MANAGER, role: 'admin', branchIds: ['ALL'] };
    const res = await withManagerApprovalPrincipal(PARAMS, async () => 'ok');
    expect(res).toEqual({ ok: true, value: 'ok' });
  });

  it('refuses the ALL branch sentinel without creating any app', async () => {
    const res = await withManagerApprovalPrincipal({ ...PARAMS, branchId: 'ALL' }, async () => 'x');
    expect(res).toEqual({ ok: false, code: 'identity_mismatch' });
    expect(h.log).toEqual([]);
  });

  it('two ceremonies never share a secondary app name', async () => {
    await withManagerApprovalPrincipal(PARAMS, async () => 1);
    await withManagerApprovalPrincipal(PARAMS, async () => 2);
    const names = h.log.filter((l) => l.startsWith('initializeApp:'));
    expect(new Set(names).size).toBe(2);
  });
});
