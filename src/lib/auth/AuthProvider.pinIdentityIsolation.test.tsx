// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { signInAnonymously, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getDoc } from 'firebase/firestore';
import { AuthProvider } from './AuthProvider';
import { __resetNativeStaffSessionCoordinatorForTests } from './staffSessionNativeCoordinator';
import { useAuth, type AuthContextValue } from '../hooks/useAuth';
import { verifyPinLogin } from './verifyPinLogin';
import { DeviceNotReadyError, NATIVE_DEVICE_SECURITY_READINESS_COMMAND } from './nativeDeviceReadiness';
import { PinIdentityError } from './pinIdentityError';
import { AUTH_OPERATION_SUPERSEDED_MESSAGE, AuthOperationSupersededError } from './authOperationError';
import {
  PENDING_COMPLETION_INTENT_STORAGE_KEY,
  PENDING_FINALIZATION_STORAGE_KEY,
} from './deviceRegistration';

/**
 * TPOS-R7 Quick PIN identity isolation (client). Uses the REAL
 * `ensureAnonymousFirebaseAuthForPin` against a stateful fake Firebase Auth:
 * Quick PIN must reach `verifyPinLogin` only under a proven anonymous UID and
 * never under a password account, whose claims are global.
 */

type FakeUser = {
  uid: string;
  isAnonymous: boolean;
  getIdToken: ReturnType<typeof vi.fn>;
  getIdTokenResult: ReturnType<typeof vi.fn>;
};

const h = vi.hoisted(() => {
  const state = {
    auth: { currentUser: null as unknown },
    anonCounter: 0,
    lastVerifiedStaffId: null as string | null,
    events: [] as string[],
    verifyCallers: [] as Array<{ uid: string; isAnonymous: boolean } | null>,
    callables: {} as Record<string, unknown>,
  };
  return state;
});

function makeUser(uid: string, isAnonymous: boolean): FakeUser {
  return {
    uid,
    isAnonymous,
    getIdToken: vi.fn(async () => 'token'),
    getIdTokenResult: vi.fn(async () => ({ claims: { staffId: h.lastVerifiedStaffId } })),
  };
}

vi.mock('../firebase', () => ({
  auth: h.auth,
  app: {},
  db: {},
  isFirebaseConfigured: true,
  collections: { users: 'users' },
  authEmailForUsername: (u: string) => `${u}@example.invalid`,
}));
vi.mock('./verifyPinLogin', () => ({ verifyPinLogin: vi.fn() }));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (u: unknown) => void) => {
    cb(h.auth.currentUser);
    return () => undefined;
  },
  signInWithEmailAndPassword: vi.fn(),
  signOut: vi.fn(),
  signInAnonymously: vi.fn(),
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
const mockSignOut = vi.mocked(signOut);
const mockSignInAnon = vi.mocked(signInAnonymously);
const mockSignInPassword = vi.mocked(signInWithEmailAndPassword);
const mockGetDoc = vi.mocked(getDoc);
const TAURI_KEY = '__TAURI__';
const SESSION_KEY = 'twinpet_session';
const READINESS = NATIVE_DEVICE_SECURITY_READINESS_COMMAND;
const RAW_FIREBASE_ERROR = 'FirebaseError: auth/network-request-failed (raw)';

const ADMIN_A = 'admin-a';
const STAFF_B = {
  id: 'staff-b', username: 'cashier', firstName: 'B', lastName: 'S', role: 'staff',
  branchIds: ['LDP-001'], isActive: true, deletedAt: null,
};
const ADMIN_A_USER = {
  id: ADMIN_A, username: 'admin', firstName: 'A', lastName: 'A', role: 'admin',
  branchIds: ['ALL'], isActive: true, deletedAt: null,
};

function current(): FakeUser | null {
  return h.auth.currentUser as FakeUser | null;
}

function setCurrent(user: FakeUser | null) {
  h.auth.currentUser = user;
}

function installTauri(invoke: ReturnType<typeof vi.fn>) {
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke } };
}

function nativeInvoke(readiness: 'READY' | 'NOT_ENROLLED' | 'INVALID_OR_INCOMPLETE') {
  return vi.fn(async (cmd: string) => {
    h.events.push(`native:${cmd}`);
    switch (cmd) {
      case READINESS:
        return { readiness };
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

function expectSafePinIdentityError(err: unknown, code: string) {
  expect(err).toBeInstanceOf(PinIdentityError);
  expect((err as PinIdentityError).code).toBe(code);
  expect((err as Error).message).not.toContain('PIN ไม่ถูกต้อง');
  expect((err as Error).message).not.toContain('FirebaseError');
  expect((err as Error).message).not.toContain('auth/');
}

beforeEach(() => {
  __resetNativeStaffSessionCoordinatorForTests();
  localStorage.clear();
  setCurrent(null);
  h.anonCounter = 0;
  h.lastVerifiedStaffId = null;
  h.events = [];
  h.verifyCallers = [];
  mockSignOut.mockReset().mockImplementation(async () => {
    h.events.push('signOut');
    setCurrent(null);
  });
  mockSignInAnon.mockReset().mockImplementation(async () => {
    h.events.push('signInAnonymously');
    h.anonCounter += 1;
    setCurrent(makeUser(`anon-${h.anonCounter}`, true));
    return {} as never;
  });
  mockSignInPassword.mockReset();
  mockGetDoc.mockReset().mockResolvedValue({ exists: () => false } as never);
  mockVerify.mockReset().mockImplementation(async (_pin: string, _branch: string, opts?: { username?: string }) => {
    const u = current();
    h.events.push('verifyPinLogin');
    h.verifyCallers.push(u ? { uid: u.uid, isAnonymous: u.isAnonymous } : null);
    const staff = opts?.username === 'admin' ? ADMIN_A_USER : STAFF_B;
    h.lastVerifiedStaffId = staff.id;
    return staff as never;
  });
  h.callables.issueOfflineStaffSessionAssertion = vi.fn(async () => {
    h.events.push('issueOfflineStaffSessionAssertion');
    return { data: { ok: true, ssa1Base64: 'c3NhMQ==', srf1Base64: 'c3JmMQ==' } };
  });
  h.callables.getOacKeysetManifest = vi.fn(async () => ({ data: { ok: true, oks1Base64: 'b2tzMQ==' } }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)[TAURI_KEY];
  vi.restoreAllMocks();
});

describe('Quick PIN establishes / reuses an anonymous Firebase identity', () => {
  it('no current user → anonymous sign-in → PIN callable under that anonymous UID', async () => {
    const ctx = await renderAuth();

    const user = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(user.id).toBe('staff-b');
    expect(mockSignInAnon).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
  });

  it('existing anonymous user → same UID reused (no sign-out, no new anonymous sign-in)', async () => {
    setCurrent(makeUser('anon-existing', true));
    const ctx = await renderAuth();

    await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(h.verifyCallers).toEqual([{ uid: 'anon-existing', isAnonymous: true }]);
  });
});

describe('password Firebase user A + Quick PIN for staff B', () => {
  it('A is signed out and a NEW anonymous UID is the only PIN callable identity', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    const user = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(user.id).toBe('staff-b');
    expect(h.events.indexOf('signOut')).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf('signOut')).toBeLessThan(h.events.indexOf('signInAnonymously'));
    expect(h.events.indexOf('signInAnonymously')).toBeLessThan(h.events.indexOf('verifyPinLogin'));
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
    expect(h.verifyCallers.some((c) => c?.uid === ADMIN_A)).toBe(false);
    expect(current()?.uid).toBe('anon-1');
  });

  it("A's stored app session is ended with the account it belonged to", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ schemaVersion: 1, issuedAt: 1, user: ADMIN_A_USER, branchId: 'ALL' }),
    );
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();
    expect(ctx().user?.id).toBe(ADMIN_A);

    await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    await waitFor(() => expect(ctx().session).toBeNull());
  });

  it("same staff: password admin A using admin A's own PIN still transitions to anonymous", async () => {
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    const user = await ctx().loginWithPin('9876', 'LDP-001', 'admin');

    expect(user.id).toBe(ADMIN_A);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
  });

  it('a restored (reload) password session is handled at the PIN submit boundary, not on render', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    // Rendering / showing the PIN UI has no auth side effect.
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(current()?.uid).toBe(ADMIN_A);

    await ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
  });
});

describe('UID-bound enrollment recovery blocks the identity transition', () => {
  it.each([
    ['finalization pending', PENDING_FINALIZATION_STORAGE_KEY, '{"enrollmentGenerationId":"g"}'],
    ['completion intent pending', PENDING_COMPLETION_INTENT_STORAGE_KEY, '{"schema":"twinpet.pendingCompletionIntent"}'],
    ['malformed recovery bytes', PENDING_COMPLETION_INTENT_STORAGE_KEY, 'not-json'],
  ])('%s + password user: TRANSITION_BLOCKED, UID kept, zero PIN callable', async (_label, key, value) => {
    localStorage.setItem(key, value);
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_TRANSITION_BLOCKED');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(current()?.uid).toBe(ADMIN_A);
    expect(localStorage.getItem(key)).toBe(value);
  });

  it('both recovery keys present (conflict) + password user: blocked, nothing deleted', async () => {
    localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, '{"enrollmentGenerationId":"a"}');
    localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, '{"enrollmentGenerationId":"b"}');
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_TRANSITION_BLOCKED');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).not.toBeNull();
  });

  it('unreadable storage + password user: fails closed as TRANSITION_BLOCKED', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));
    getItem.mockRestore();

    expectSafePinIdentityError(err, 'PIN_IDENTITY_TRANSITION_BLOCKED');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('pending recovery + existing anonymous user: no UID change needed, anonymous UID reused', async () => {
    localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, '{"enrollmentGenerationId":"g"}');
    setCurrent(makeUser('anon-bound', true));
    const ctx = await renderAuth();

    await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(h.verifyCallers).toEqual([{ uid: 'anon-bound', isAnonymous: true }]);
    expect(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)).not.toBeNull();
  });
});

describe('transition failures make ZERO PIN callable, with a fixed safe error', () => {
  it('sign-out of the password account fails', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    mockSignOut.mockRejectedValue(new Error(RAW_FIREBASE_ERROR));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('sign-out resolves but the password user is still current', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    mockSignOut.mockImplementation(async () => undefined);
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
  });

  it('anonymous sign-in fails', async () => {
    mockSignInAnon.mockRejectedValue(new Error(RAW_FIREBASE_ERROR));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('anonymous sign-in yields a non-anonymous user (not proven anonymous)', async () => {
    mockSignInAnon.mockImplementation(async () => {
      setCurrent(makeUser('weird', false));
      return {} as never;
    });
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('identity replaced while verifyPinLogin was in flight → safe failure, never accepted', async () => {
    mockVerify.mockImplementation(async () => {
      h.lastVerifiedStaffId = 'staff-b';
      setCurrent(makeUser(ADMIN_A, false));
      return STAFF_B as never;
    });
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
  });

  it('server rejection classification propagates as PIN_IDENTITY_REJECTED, not PIN-incorrect', async () => {
    mockVerify.mockRejectedValue(new PinIdentityError('PIN_IDENTITY_REJECTED'));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_REJECTED');
  });
});

describe('native device gate ordering is preserved', () => {
  it.each(['NOT_ENROLLED', 'INVALID_OR_INCOMPLETE'] as const)(
    'native %s + password user: device error, ZERO PIN callable, NO sign-out / UID change',
    async (readiness) => {
      installTauri(nativeInvoke(readiness));
      setCurrent(makeUser(ADMIN_A, false));
      const ctx = await renderAuth();

      const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

      expect(err).toBeInstanceOf(DeviceNotReadyError);
      expect(mockVerify).not.toHaveBeenCalled();
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockSignInAnon).not.toHaveBeenCalled();
      expect(current()?.uid).toBe(ADMIN_A);
    },
  );

  it('native READY + password user: readiness → recovery/clear → sign-out → anonymous → token → verify → challenge → issue → persist', async () => {
    const invoke = nativeInvoke('READY');
    installTauri(invoke);
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();
    h.events = [];

    const user = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(user.id).toBe('staff-b');
    expect(h.events).toEqual([
      `native:${READINESS}`,
      'native:native_clear_staff_session',
      'signOut',
      'signInAnonymously',
      'verifyPinLogin',
      'native:native_prepare_staff_session_challenge',
      'issueOfflineStaffSessionAssertion',
      'native:native_persist_staff_session_assertion',
    ]);
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
    const anon = current()!;
    expect(anon.getIdToken.mock.invocationCallOrder[0]).toBeLessThan(mockVerify.mock.invocationCallOrder[0]!);
  });

  it('native READY + existing anonymous user: sequence unchanged (no clear / sign-out)', async () => {
    installTauri(nativeInvoke('READY'));
    setCurrent(makeUser('anon-existing', true));
    const ctx = await renderAuth();
    h.events = [];

    await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expect(h.events).toEqual([
      `native:${READINESS}`,
      'verifyPinLogin',
      'native:native_prepare_staff_session_challenge',
      'issueOfflineStaffSessionAssertion',
      'native:native_persist_staff_session_assertion',
    ]);
  });
});

describe('password login is unchanged', () => {
  it('loginWithUsername uses email/password only — no anonymous sign-in, no sign-out, no PIN callable', async () => {
    setCurrent(makeUser('anon-existing', true));
    mockSignInPassword.mockImplementation(async () => {
      setCurrent(makeUser(ADMIN_A, false));
      return {} as never;
    });
    mockGetDoc.mockResolvedValue({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER } as never);
    const ctx = await renderAuth();

    const user = await ctx().loginWithUsername('admin', 'secret', 'ALL');

    expect(user.id).toBe(ADMIN_A);
    expect(mockSignInPassword).toHaveBeenCalledTimes(1);
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});

describe('PIN-path token refresh failures are fixed identity errors (never raw, never PIN-incorrect)', () => {
  it('pre-call getIdToken(true) rejects → PIN_IDENTITY_UNAVAILABLE, ZERO PIN callable', async () => {
    const anon = makeUser('anon-existing', true);
    anon.getIdToken.mockRejectedValue(new Error(RAW_FIREBASE_ERROR));
    setCurrent(anon);
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('post-call getIdTokenResult(true) rejects → PIN_IDENTITY_UNAVAILABLE, no native issuance', async () => {
    const anon = makeUser('anon-existing', true);
    anon.getIdTokenResult.mockRejectedValue(new Error(RAW_FIREBASE_ERROR));
    setCurrent(anon);
    installTauri(nativeInvoke('READY'));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
    expect(mockVerify).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain('native:native_prepare_staff_session_challenge');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('wrapper-level refresh failure surfaces unchanged as the fixed identity error', async () => {
    mockVerify.mockRejectedValue(new PinIdentityError('PIN_IDENTITY_UNAVAILABLE'));
    setCurrent(makeUser('anon-existing', true));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));

    expectSafePinIdentityError(err, 'PIN_IDENTITY_UNAVAILABLE');
  });
});

describe('stale password-session restore cannot outlive a Quick PIN identity transition', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  function renderNoWait(): () => AuthContextValue {
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
    return () => latest!;
  }

  it('restore fetch for password user A is delayed; PIN moves to anonymous; late fetch must NOT save A', async () => {
    const pending = deferred<unknown>();
    mockGetDoc.mockReturnValue(pending.promise as never);
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = renderNoWait();
    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));

    await ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    expect(current()?.uid).toBe('anon-1');

    pending.resolve({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER });
    await waitFor(() => expect(ctx().isLoading).toBe(false));

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(ctx().session).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1); // only the PIN transition — the fence never signs out
  });

  it('control: delayed restore with NO transition still restores password session A unchanged', async () => {
    const pending = deferred<unknown>();
    mockGetDoc.mockReturnValue(pending.promise as never);
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = renderNoWait();
    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));

    pending.resolve({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER });
    await waitFor(() => expect(ctx().isLoading).toBe(false));

    expect(ctx().user?.id).toBe(ADMIN_A);
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!).user.id).toBe(ADMIN_A);
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});

describe('interactive password / Quick PIN operations cannot cross-complete (Codex 002 blocker 2)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  const docA = { exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER };

  function passwordSignsInA() {
    mockSignInPassword.mockImplementation(async () => {
      h.events.push('signInWithEmailAndPassword');
      setCurrent(makeUser(ADMIN_A, false));
      return {} as never;
    });
  }

  function savedUserId(): string | null {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { user: { id: string } }).user.id : null;
  }

  function expectSuperseded(err: unknown) {
    expect(err).toBeInstanceOf(AuthOperationSupersededError);
    expect((err as Error).message).toBe(AUTH_OPERATION_SUPERSEDED_MESSAGE);
    expect((err as Error).message).not.toContain('PIN ไม่ถูกต้อง');
    expect((err as Error).message).not.toContain('รหัสผ่านไม่ถูกต้อง');
    expect((err as Error).message).not.toContain(ADMIN_A);
    expect((err as Error).message).not.toContain('anon-');
  }

  it('Codex interleaving: password A held at fetchUserById, PIN moves Firebase to U and completes B, late A never saves a session', async () => {
    passwordSignsInA();
    const fetchA = deferred<unknown>();
    mockGetDoc.mockReturnValue(fetchA.promise as never);
    const ctx = await renderAuth();

    const pw = ctx().loginWithUsername('admin', 'secret', 'ALL');
    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));
    expect(current()?.uid).toBe(ADMIN_A);

    const userB = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    expect(current()?.uid).toBe('anon-1');
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
    await act(() => ctx().completeLogin(userB, 'LDP-001'));
    expect(savedUserId()).toBe('staff-b');

    fetchA.resolve(docA);
    const err = await rejectionOf(pw);

    expectSuperseded(err);
    // A's app session is never saved; nothing became A while Firebase is U.
    expect(savedUserId()).toBe('staff-b');
    expect(ctx().user?.id).toBe('staff-b');
    expect(ctx().branchId).toBe('LDP-001');
    expect(current()?.uid).toBe('anon-1');
    // Even a direct completion attempt for A is refused.
    expectSuperseded(await rejectionOf(ctx().completeLogin(ADMIN_A_USER as never, 'ALL')));
    expect(savedUserId()).toBe('staff-b');
  });

  it('password A resolved but not yet completed; PIN supersedes it → completeLogin(A) refused, B completes', async () => {
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const ctx = await renderAuth();

    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    const userB = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');

    expectSuperseded(await rejectionOf(ctx().completeLogin(userA, 'ALL')));
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();

    await act(() => ctx().completeLogin(userB, 'LDP-001'));
    expect(savedUserId()).toBe('staff-b');
    expect(current()?.uid).toBe('anon-1');
  });

  it('reverse overlap: PIN held at verifyPinLogin, password A starts and completes, late PIN result is superseded', async () => {
    setCurrent(makeUser('anon-existing', true));
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const verifyB = deferred<unknown>();
    mockVerify.mockImplementation(async () => {
      h.lastVerifiedStaffId = 'staff-b';
      return verifyB.promise as never;
    });
    const ctx = await renderAuth();

    const pin = ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    await waitFor(() => expect(mockVerify).toHaveBeenCalledTimes(1));

    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    await act(() => ctx().completeLogin(userA, 'ALL'));
    expect(savedUserId()).toBe(ADMIN_A);

    verifyB.resolve(STAFF_B);
    expectSuperseded(await rejectionOf(pin));

    expect(savedUserId()).toBe(ADMIN_A);
    expect(ctx().user?.id).toBe(ADMIN_A);
    expect(current()?.uid).toBe(ADMIN_A);
    expectSuperseded(await rejectionOf(ctx().completeLogin(STAFF_B as never, 'LDP-001')));
    expect(savedUserId()).toBe(ADMIN_A);
  });

  it('reverse overlap before identity transition: superseded PIN never signs the newer password account out', async () => {
    const readiness = deferred<unknown>();
    let held = false;
    installTauri(vi.fn(async (cmd: string) => {
      h.events.push(`native:${cmd}`);
      if (cmd === READINESS) {
        if (held) { held = false; await readiness.promise; }
        return { readiness: 'READY' };
      }
      return undefined;
    }));
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const ctx = await renderAuth();

    held = true; // hold only the PIN attempt's readiness read
    const pin = ctx().loginWithPin('4321', 'LDP-001', 'cashier'); // held at readiness
    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    await act(() => ctx().completeLogin(userA, 'ALL'));

    readiness.resolve(undefined);
    expectSuperseded(await rejectionOf(pin));

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(current()?.uid).toBe(ADMIN_A);
    expect(savedUserId()).toBe(ADMIN_A);
  });

  it('native: PIN superseded while persisting its staff session → that native session is cleared, no app session', async () => {
    setCurrent(makeUser('anon-existing', true));
    const persist = deferred<unknown>();
    installTauri(vi.fn(async (cmd: string) => {
      h.events.push(`native:${cmd}`);
      switch (cmd) {
        case READINESS:
          return { readiness: 'READY' };
        case 'native_prepare_staff_session_challenge':
          return { generation: 7, sscp1ProofBase64: 'c3NjcDE=' };
        case 'native_persist_staff_session_assertion':
          return persist.promise;
        default:
          return undefined;
      }
    }));
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const ctx = await renderAuth();

    const pin = ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    await waitFor(() => expect(h.events).toContain('native:native_persist_staff_session_assertion'));
    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    h.events = [];

    persist.resolve(undefined);
    expectSuperseded(await rejectionOf(pin));
    expect(h.events).toContain('native:native_clear_staff_session');

    await act(() => ctx().completeLogin(userA, 'ALL'));
    expect(savedUserId()).toBe(ADMIN_A);
  });

  it('Firebase UID changed after the result (no newer login) → completeLogin refused, nothing saved', async () => {
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const ctx = await renderAuth();

    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    setCurrent(makeUser('someone-else', true));

    expectSuperseded(await rejectionOf(ctx().completeLogin(userA, 'ALL')));
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('logout while a password login is in flight → late result superseded, no session re-created', async () => {
    passwordSignsInA();
    const fetchA = deferred<unknown>();
    mockGetDoc.mockReturnValue(fetchA.promise as never);
    const ctx = await renderAuth();

    const pw = ctx().loginWithUsername('admin', 'secret', 'ALL');
    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));
    await act(() => ctx().logout());
    fetchA.resolve(docA);

    expectSuperseded(await rejectionOf(pw));
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('completeLogin needs a matching, unconsumed login result (wrong user / replay refused)', async () => {
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const ctx = await renderAuth();

    expectSuperseded(await rejectionOf(ctx().completeLogin(ADMIN_A_USER as never, 'ALL')));

    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    expectSuperseded(await rejectionOf(ctx().completeLogin(STAFF_B as never, 'LDP-001')));
    await act(() => ctx().completeLogin(userA, 'ALL'));
    expect(savedUserId()).toBe(ADMIN_A);
    expectSuperseded(await rejectionOf(ctx().completeLogin(userA, 'ALL')));
  });

  it('control: no overlap — password login completes normally', async () => {
    passwordSignsInA();
    mockGetDoc.mockResolvedValue(docA as never);
    const ctx = await renderAuth();

    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    await act(() => ctx().completeLogin(userA, 'ALL'));

    expect(savedUserId()).toBe(ADMIN_A);
    expect(ctx().user?.id).toBe(ADMIN_A);
    expect(mockSignInAnon).not.toHaveBeenCalled();
  });

  it('control: no overlap — Quick PIN login completes normally', async () => {
    const ctx = await renderAuth();

    const userB = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    await act(() => ctx().completeLogin(userB, 'LDP-001'));

    expect(savedUserId()).toBe('staff-b');
    expect(ctx().user?.id).toBe('staff-b');
    expect(current()?.uid).toBe('anon-1');
  });
});

describe('stale PIN waiting in the pre-sign-out native clear cannot touch a newer login (Codex 003 blocker)', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  const PW_B = 'pw-b';
  const PW_B_USER = {
    id: PW_B, username: 'bob', firstName: 'B', lastName: 'P', role: 'admin',
    branchIds: ['ALL'], isActive: true, deletedAt: null,
  };

  function savedUserId(): string | null {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as { user: { id: string } }).user.id : null;
  }

  function expectSuperseded(err: unknown) {
    expect(err).toBeInstanceOf(AuthOperationSupersededError);
    expect((err as Error).message).toBe(AUTH_OPERATION_SUPERSEDED_MESSAGE);
  }

  /** READY native device whose FIRST native_clear_staff_session is held. */
  function nativeWithHeldFirstClear() {
    const firstClear = deferred<unknown>();
    let clears = 0;
    installTauri(vi.fn(async (cmd: string) => {
      h.events.push(`native:${cmd}`);
      switch (cmd) {
        case READINESS:
          return { readiness: 'READY' };
        case 'native_clear_staff_session':
          clears += 1;
          if (clears === 1) await firstClear.promise;
          return undefined;
        case 'native_prepare_staff_session_challenge':
          return { generation: 7, sscp1ProofBase64: 'c3NjcDE=' };
        default:
          return undefined;
      }
    }));
    return firstClear;
  }

  it('Test A: newer password login for a DIFFERENT uid wins during the native clear → stale PIN stops, B untouched', async () => {
    const firstClear = nativeWithHeldFirstClear();
    const ctx = await renderAuth();
    setCurrent(makeUser(ADMIN_A, false)); // password user A is the departing identity

    // Observed at creation: this stale attempt settles while the newer
    // completion is still queued behind its held clear.
    const pinOutcome = rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));
    await waitFor(() => expect(h.events).toContain('native:native_clear_staff_session'));

    // Newer password op for B signs in and completes while the PIN op waits.
    mockSignInPassword.mockImplementation(async () => {
      setCurrent(makeUser(PW_B, false));
      return {} as never;
    });
    mockGetDoc.mockResolvedValue({ exists: () => true, id: PW_B, data: () => PW_B_USER } as never);
    const userB = await ctx().loginWithUsername('bob', 'secret', 'ALL');
    // SSA1-LIFECYCLE-ORDER: B's completion clear joins the one native ordering
    // domain, so it is queued strictly AFTER the stale PIN's held clear and
    // B's session is saved only once that older clear has landed.
    const completeB = ctx().completeLogin(userB, 'ALL');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(savedUserId()).toBeNull();

    await act(async () => {
      firstClear.resolve(undefined);
      await completeB;
    });
    expect(savedUserId()).toBe(PW_B);
    expectSuperseded(await pinOutcome);

    expect(current()?.uid).toBe(PW_B);
    expect(current()?.isAnonymous).toBe(false);
    expect(savedUserId()).toBe(PW_B);
    expect(ctx().user?.id).toBe(PW_B);
    expect(ctx().session?.user.id).toBe(PW_B);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expectSuperseded(await rejectionOf(ctx().completeLogin(STAFF_B as never, 'LDP-001')));
    expect(savedUserId()).toBe(PW_B);
  });

  it('Test B: newer password login re-signs-in the SAME uid → generation alone stops the stale PIN', async () => {
    const firstClear = nativeWithHeldFirstClear();
    const ctx = await renderAuth();
    setCurrent(makeUser(ADMIN_A, false));

    const pinOutcome = rejectionOf(ctx().loginWithPin('4321', 'LDP-001', 'cashier'));
    await waitFor(() => expect(h.events).toContain('native:native_clear_staff_session'));

    mockSignInPassword.mockImplementation(async () => {
      setCurrent(makeUser(ADMIN_A, false)); // same UID, newer operation
      return {} as never;
    });
    mockGetDoc.mockResolvedValue({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER } as never);
    const userA = await ctx().loginWithUsername('admin', 'secret', 'ALL');
    // SSA1-LIFECYCLE-ORDER: the newer completion clear is queued after the
    // stale PIN's held clear (one native ordering domain).
    const completeA = ctx().completeLogin(userA, 'ALL');
    await act(async () => {
      firstClear.resolve(undefined);
      await completeA;
    });
    const newerA = current();
    expectSuperseded(await pinOutcome);

    expect(current()).toBe(newerA);
    expect(current()?.uid).toBe(ADMIN_A);
    expect(savedUserId()).toBe(ADMIN_A);
    expect(ctx().user?.id).toBe(ADMIN_A);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('Test C (control): unsuperseded password → PIN transition on native clears, signs out, goes anonymous, verifies, completes', async () => {
    installTauri(nativeInvoke('READY'));
    const ctx = await renderAuth();
    setCurrent(makeUser(ADMIN_A, false));
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      schemaVersion: 1, issuedAt: Date.now(), user: ADMIN_A_USER, branchId: 'ALL',
    }));
    let sessionAtSignOut: string | null = 'unset';
    mockSignOut.mockImplementation(async () => {
      h.events.push('signOut');
      sessionAtSignOut = localStorage.getItem(SESSION_KEY);
      setCurrent(null);
    });

    const userB = await ctx().loginWithPin('4321', 'LDP-001', 'cashier');
    await act(() => ctx().completeLogin(userB, 'LDP-001'));

    const order = ['native:native_clear_staff_session', 'signOut', 'signInAnonymously', 'verifyPinLogin'];
    const idx = order.map((e) => h.events.indexOf(e));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(sessionAtSignOut).toBeNull(); // old local app session cleared before sign-out
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(h.verifyCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
    expect(current()?.uid).toBe('anon-1');
    expect(savedUserId()).toBe('staff-b');
  });
});
