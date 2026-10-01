// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getDoc } from 'firebase/firestore';
import { AuthProvider } from './AuthProvider';
import { useAuth, type AuthContextValue } from '../hooks/useAuth';
import { verifyPinLogin } from './verifyPinLogin';
import { ensureFirebaseAuth } from '../firebaseAuth';
import { DeviceNotReadyError, NATIVE_DEVICE_SECURITY_READINESS_COMMAND } from './nativeDeviceReadiness';

/**
 * TPOS-R7 device-wide native enrollment gate (AuthProvider level).
 * On a Tauri POS that is not READY: zero verifyPinLogin, zero password
 * sign-in, no app session saved, restored sessions withheld — and no Firebase
 * sign-out / UID replacement to enforce it. Web behavior is unchanged.
 */

const h = vi.hoisted(() => {
  const currentUser = {
    uid: 'anon-uid',
    isAnonymous: true,
    getIdToken: vi.fn(async () => 'token'),
    // Stale privileged claims on the persisted anonymous UID must never open the gate.
    getIdTokenResult: vi.fn(async () => ({ claims: { staffId: 'staff-1', role: 'admin', branchIds: ['ALL'] } })),
  };
  return {
    auth: { currentUser } as { currentUser: typeof currentUser | null },
    callables: {} as Record<string, ReturnType<typeof vi.fn>>,
  };
});

vi.mock('../firebase', () => ({
  auth: h.auth,
  app: {},
  db: {},
  isFirebaseConfigured: true,
  collections: { users: 'users' },
  authEmailForUsername: (u: string) => `${u}@example.invalid`,
}));
vi.mock('../firebaseAuth', () => ({ ensureFirebaseAuth: vi.fn(async () => undefined) }));
vi.mock('./verifyPinLogin', () => ({ verifyPinLogin: vi.fn() }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: null) => void) => {
    cb(null);
    return () => undefined;
  },
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock('./devUsers', () => ({ findDevUserByPin: vi.fn(), findDevUserByUsernamePassword: vi.fn() }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  getDoc: vi.fn(),
  serverTimestamp: vi.fn(),
  updateDoc: vi.fn(async () => undefined),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_fns: unknown, name: string) => h.callables[name] ?? vi.fn()),
}));

const mockStorage = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true, configurable: true });

const mockVerify = vi.mocked(verifyPinLogin);
const mockEnsure = vi.mocked(ensureFirebaseAuth);
const mockSignIn = vi.mocked(signInWithEmailAndPassword);
const mockSignOut = vi.mocked(signOut);
const mockGetDoc = vi.mocked(getDoc);
const TAURI_KEY = '__TAURI__';
const SESSION_KEY = 'twinpet_session';
const READINESS = NATIVE_DEVICE_SECURITY_READINESS_COMMAND;
const RAW_NATIVE_ERROR = 'cannot read security device id: os error 2 (C:\\Users\\x\\AppData)';

const STAFF_USER = {
  id: 'staff-1',
  username: 'admin',
  firstName: 'A',
  lastName: 'B',
  role: 'admin',
  branchIds: ['ALL'],
  isActive: true,
  deletedAt: null,
};

type Readiness = 'READY' | 'NOT_ENROLLED' | 'INVALID_OR_INCOMPLETE';

function installTauri(invoke: ReturnType<typeof vi.fn>) {
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
}

function nativeInvoke(
  readiness: Readiness | (() => unknown),
  overrides: Record<string, (args?: unknown) => unknown> = {},
) {
  return vi.fn(async (cmd: string, args?: unknown) => {
    if (overrides[cmd]) return overrides[cmd]!(args);
    switch (cmd) {
      case READINESS:
        return typeof readiness === 'function' ? readiness() : { readiness };
      case 'native_prepare_staff_session_challenge':
        return { generation: 7, sscp1ProofBase64: 'c3NjcDE=' };
      case 'native_persist_staff_session_assertion':
      case 'native_clear_staff_session':
        return undefined;
      default:
        throw new Error(`unexpected native command ${cmd}`);
    }
  });
}

function saveRestoredSession() {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ schemaVersion: 1, issuedAt: 1, user: STAFF_USER, branchId: 'ALL' }),
  );
}

/** Renders the provider; `ctx()` always returns the latest context value. */
async function renderAuth(): Promise<() => AuthContextValue> {
  let latest: AuthContextValue | null = null;
  function Grab() {
    latest = useAuth();
    return null;
  }
  render(
    <AuthProvider>
      <Grab />
    </AuthProvider>,
  );
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  return () => latest!;
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
}

beforeEach(() => {
  localStorage.clear();
  mockVerify.mockReset();
  mockEnsure.mockClear();
  mockSignIn.mockReset();
  mockSignOut.mockReset();
  mockGetDoc.mockReset();
  h.auth.currentUser!.getIdToken.mockClear();
  h.auth.currentUser!.getIdTokenResult.mockClear();
  h.callables.issueOfflineStaffSessionAssertion = vi.fn(async () => ({
    data: { ok: true, ssa1Base64: 'c3NhMQ==', srf1Base64: 'c3JmMQ==' },
  }));
  h.callables.getOacKeysetManifest = vi.fn(async () => ({ data: { ok: true, oks1Base64: 'b2tzMQ==' } }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)[TAURI_KEY];
  delete (globalThis as Record<string, unknown>).isTauri;
  vi.restoreAllMocks();
});

describe('Quick PIN — native device gate runs before any PIN reaches the server', () => {
  it.each([
    ['NOT_ENROLLED', 'DEVICE_NOT_ENROLLED'],
    ['INVALID_OR_INCOMPLETE', 'DEVICE_ENROLLMENT_INVALID'],
  ] as const)('native %s: %s and ZERO verifyPinLogin / Firebase prep', async (readiness, code) => {
    const invoke = nativeInvoke(readiness);
    installTauri(invoke);
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('1234', 'LDP-001', 'admin'));

    expect(err).toBeInstanceOf(DeviceNotReadyError);
    expect((err as DeviceNotReadyError).code).toBe(code);
    expect((err as Error).message).not.toContain('PIN ไม่ถูกต้อง');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(h.auth.currentUser!.getIdToken).not.toHaveBeenCalled();
    expect(h.auth.currentUser!.getIdTokenResult).not.toHaveBeenCalled();
    expect(new Set(invoke.mock.calls.map((c) => c[0]))).toEqual(new Set([READINESS]));
  });

  it('native readiness command rejects: DEVICE_STATUS_UNAVAILABLE, zero verifyPinLogin, raw native string never surfaced', async () => {
    installTauri(vi.fn(async () => Promise.reject(RAW_NATIVE_ERROR)));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('1234', 'LDP-001', 'admin'));

    expect((err as DeviceNotReadyError).code).toBe('DEVICE_STATUS_UNAVAILABLE');
    expect((err as Error).message).not.toContain('security device id');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(ctx().deviceReadiness).toBe('UNAVAILABLE');
  });

  it('native readiness result malformed / unknown value: fails closed as DEVICE_STATUS_UNAVAILABLE', async () => {
    installTauri(nativeInvoke(() => ({ readiness: 'MAYBE', deviceKeyPresent: true })));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('1234', 'LDP-001', 'admin'));

    expect((err as DeviceNotReadyError).code).toBe('DEVICE_STATUS_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('Tauri runtime flag present but command bridge missing: fails closed (never treated as web), zero verifyPinLogin', async () => {
    (globalThis as Record<string, unknown>).isTauri = true;
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('1234', 'LDP-001', 'admin'));

    expect(ctx().deviceReadiness).toBe('UNAVAILABLE');
    expect((err as DeviceNotReadyError).code).toBe('DEVICE_STATUS_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it('native READY: strong readiness precedes verifyPinLogin and the native staff-session sequence is unchanged', async () => {
    mockVerify.mockResolvedValue(STAFF_USER as never);
    const invoke = nativeInvoke('READY');
    installTauri(invoke);
    const ctx = await renderAuth();
    invoke.mockClear();

    const user = await ctx().loginWithPin('1234', 'LDP-001', 'admin');

    expect(user.id).toBe('staff-1');
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledWith('1234', 'LDP-001', { username: 'admin' });
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      READINESS,
      'native_prepare_staff_session_challenge',
      'native_persist_staff_session_assertion',
    ]);
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(mockVerify.mock.invocationCallOrder[0]!);
    expect(invoke.mock.calls[1]![1]).toEqual({ purpose: 'SSA1_LOGIN', branchId: 'LDP-001', intendedStaffId: 'staff-1' });
    expect(invoke.mock.calls[2]![1]).toEqual({
      generation: 7,
      ssa1Base64: 'c3NhMQ==',
      srf1Base64: 'c3JmMQ==',
      oks1Base64: 'b2tzMQ==',
    });
    expect(h.callables.issueOfflineStaffSessionAssertion).toHaveBeenCalledWith({ sscp1Base64: 'c3NjcDE=' });
    expect(h.callables.getOacKeysetManifest).toHaveBeenCalledTimes(1);
  });

  it('web: no device check, verifyPinLogin called, PIN/branch denial propagates unchanged', async () => {
    mockVerify.mockRejectedValue(new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้'));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('1234', 'LDP-001', 'admin'));

    expect(ctx().deviceReadiness).toBe('not_native');
    expect(err).not.toBeInstanceOf(DeviceNotReadyError);
    expect((err as Error).message).toBe('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(mockVerify).toHaveBeenCalledTimes(1);
  });

  it('web: successful PIN login does not touch any native command or offline issuance', async () => {
    mockVerify.mockResolvedValue(STAFF_USER as never);
    const ctx = await renderAuth();

    const user = await ctx().loginWithPin('1234', 'LDP-001', 'admin');

    expect(user.id).toBe('staff-1');
    expect(h.callables.issueOfflineStaffSessionAssertion).not.toHaveBeenCalled();
  });
});

describe('native staff-session failures are device-security errors, never PIN-invalid, never raw', () => {
  async function failingLogin(overrides: Record<string, (args?: unknown) => unknown>) {
    mockVerify.mockResolvedValue(STAFF_USER as never);
    installTauri(nativeInvoke('READY', overrides));
    const ctx = await renderAuth();
    return (await rejectionOf(ctx().loginWithPin('1234', 'LDP-001', 'admin'))) as DeviceNotReadyError;
  }

  function expectSafe(err: DeviceNotReadyError, code: string) {
    expect(err).toBeInstanceOf(DeviceNotReadyError);
    expect(err.code).toBe(code);
    expect(err.message).not.toContain('security device id');
    expect(err.message).not.toContain('AppData');
    expect(err.message).not.toContain('PIN ไม่ถูกต้อง');
  }

  it('challenge command rejects -> DEVICE_SESSION_PREPARATION_FAILED, no issuance', async () => {
    const err = await failingLogin({ native_prepare_staff_session_challenge: () => Promise.reject(RAW_NATIVE_ERROR) });
    expectSafe(err, 'DEVICE_SESSION_PREPARATION_FAILED');
    expect(h.callables.issueOfflineStaffSessionAssertion).not.toHaveBeenCalled();
  });

  it.each([
    ['null', () => null],
    ['missing proof', () => ({ generation: 7 })],
    ['string generation', () => ({ generation: '7', sscp1ProofBase64: 'eA==' })],
    ['empty proof', () => ({ generation: 7, sscp1ProofBase64: '' })],
  ])('malformed challenge (%s) -> DEVICE_SESSION_PREPARATION_FAILED, no issuance', async (_label, result) => {
    const err = await failingLogin({ native_prepare_staff_session_challenge: result });
    expectSafe(err, 'DEVICE_SESSION_PREPARATION_FAILED');
    expect(h.callables.issueOfflineStaffSessionAssertion).not.toHaveBeenCalled();
  });

  it('persist command rejects -> DEVICE_SESSION_PERSIST_FAILED', async () => {
    const err = await failingLogin({ native_persist_staff_session_assertion: () => Promise.reject(RAW_NATIVE_ERROR) });
    expectSafe(err, 'DEVICE_SESSION_PERSIST_FAILED');
  });

  it('issuance callable throws a raw error / refuses -> DEVICE_SESSION_ISSUANCE_FAILED', async () => {
    h.callables.issueOfflineStaffSessionAssertion = vi.fn(async () => Promise.reject(new Error(RAW_NATIVE_ERROR)));
    expectSafe(await failingLogin({}), 'DEVICE_SESSION_ISSUANCE_FAILED');

    cleanup();
    h.callables.issueOfflineStaffSessionAssertion = vi.fn(async () => ({ data: { ok: false, code: 'DEVICE_REVOKED' } }));
    expectSafe(await failingLogin({}), 'DEVICE_SESSION_ISSUANCE_FAILED');
  });
});

describe('Username/Password — native device gate blocks sign-in itself', () => {
  it.each([
    ['NOT_ENROLLED', 'DEVICE_NOT_ENROLLED'],
    ['INVALID_OR_INCOMPLETE', 'DEVICE_ENROLLMENT_INVALID'],
  ] as const)('native %s: ZERO signInWithEmailAndPassword, no app session', async (readiness, code) => {
    installTauri(nativeInvoke(readiness));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithUsername('admin', 'secret', 'LDP-001'));

    expect((err as DeviceNotReadyError).code).toBe(code);
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(ctx().isAuthenticated).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('native readiness unavailable: ZERO signInWithEmailAndPassword', async () => {
    installTauri(vi.fn(async () => Promise.reject(RAW_NATIVE_ERROR)));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithUsername('admin', 'secret', 'LDP-001'));

    expect((err as DeviceNotReadyError).code).toBe('DEVICE_STATUS_UNAVAILABLE');
    expect(mockSignIn).not.toHaveBeenCalled();
  });

  it('native READY: existing password flow (sign-in, profile fetch) and completeLogin unlock', async () => {
    installTauri(nativeInvoke('READY'));
    mockSignIn.mockImplementation(async () => {
      h.auth.currentUser = { ...h.auth.currentUser!, uid: 'staff-1', isAnonymous: false };
      return {} as never;
    });
    mockGetDoc.mockResolvedValue({ exists: () => true, id: 'staff-1', data: () => STAFF_USER } as never);
    const ctx = await renderAuth();

    try {
      const user = await ctx().loginWithUsername('admin', 'secret', 'ALL');
      expect(mockSignIn).toHaveBeenCalledTimes(1);
      expect(user.id).toBe('staff-1');
      await act(() => ctx().completeLogin(user, 'ALL'));
      expect(ctx().isAuthenticated).toBe(true);
    } finally {
      h.auth.currentUser = { ...h.auth.currentUser!, uid: 'anon-uid', isAnonymous: true };
    }
  });

  it('web: password sign-in still attempted (behavior unchanged)', async () => {
    mockSignIn.mockRejectedValue(new Error('auth/wrong-password'));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithUsername('admin', 'wrong', 'LDP-001'));

    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect((err as Error).message).toBe('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  });
});

describe('completeLogin — defense in depth', () => {
  it('native NOT_ENROLLED: refuses to save an app session (no native clear, no localStorage write)', async () => {
    const invoke = nativeInvoke('NOT_ENROLLED');
    installTauri(invoke);
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().completeLogin(STAFF_USER as never, 'ALL'));

    expect((err as DeviceNotReadyError).code).toBe('DEVICE_NOT_ENROLLED');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(ctx().isAuthenticated).toBe(false);
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain('native_clear_staff_session');
  });
});

describe('restored sessions — withheld on a not-READY native device, no sign-out', () => {
  it.each(['NOT_ENROLLED', 'INVALID_OR_INCOMPLETE'] as const)(
    'restored app session + native %s: not authenticated, session/user/branch withheld, storage and Firebase UID kept',
    async (readiness) => {
      saveRestoredSession();
      installTauri(nativeInvoke(readiness));
      const ctx = await renderAuth();

      expect(ctx().deviceReadiness).toBe(readiness);
      expect(ctx().isAuthenticated).toBe(false);
      expect(ctx().session).toBeNull();
      expect(ctx().user).toBeNull();
      expect(ctx().branchId).toBeNull();
      // Not destroyed: the stored session and the Firebase identity survive for recovery.
      expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(h.auth.currentUser?.uid).toBe('anon-uid');
      // Stale privileged token claims are never consulted as readiness proof.
      expect(h.auth.currentUser!.getIdTokenResult).not.toHaveBeenCalled();
    },
  );

  it('restored app session + readiness command failure: blocked', async () => {
    saveRestoredSession();
    installTauri(vi.fn(async () => Promise.reject(RAW_NATIVE_ERROR)));
    const ctx = await renderAuth();

    expect(ctx().deviceReadiness).toBe('UNAVAILABLE');
    expect(ctx().isAuthenticated).toBe(false);
  });

  it('restored app session + native READY: authenticated as before', async () => {
    saveRestoredSession();
    installTauri(nativeInvoke('READY'));
    const ctx = await renderAuth();

    expect(ctx().isAuthenticated).toBe(true);
    expect(ctx().user?.id).toBe('staff-1');
    expect(ctx().branchId).toBe('ALL');
  });

  it('web restored session: unchanged (authenticated, no native call)', async () => {
    saveRestoredSession();
    const ctx = await renderAuth();

    expect(ctx().deviceReadiness).toBe('not_native');
    expect(ctx().isAuthenticated).toBe(true);
  });

  it('after enrollment, a readiness refresh to READY unlocks the otherwise valid restored session', async () => {
    saveRestoredSession();
    let readiness: Readiness = 'NOT_ENROLLED';
    installTauri(nativeInvoke(() => ({ readiness })));
    const ctx = await renderAuth();
    expect(ctx().isAuthenticated).toBe(false);

    readiness = 'READY';
    await act(async () => {
      await ctx().refreshDeviceReadiness();
    });

    expect(ctx().isAuthenticated).toBe(true);
    expect(ctx().user?.id).toBe('staff-1');
  });
});
