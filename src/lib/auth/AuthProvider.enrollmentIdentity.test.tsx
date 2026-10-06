// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { signInAnonymously, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getDoc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { AuthProvider } from './AuthProvider';
import { useAuth, type AuthContextValue } from '../hooks/useAuth';
import { verifyPinLogin } from './verifyPinLogin';
import { NATIVE_DEVICE_SECURITY_READINESS_COMMAND } from './nativeDeviceReadiness';
import { EnrollmentIdentityError } from './enrollmentIdentityError';
import {
  PENDING_COMPLETION_INTENT_STORAGE_KEY,
  PENDING_FINALIZATION_STORAGE_KEY,
  registerDevice,
} from './deviceRegistration';

/**
 * TPOS-R7 first-enrollment identity: before `beginDeviceRegistration` binds
 * `requesterUid`, the AuthProvider must end any stale app staff session and
 * move Firebase to a dedicated anonymous identity. Uses the REAL AuthProvider,
 * the REAL shared anonymous-transition helper and the REAL `registerDevice`
 * production begin path against a stateful fake Firebase Auth.
 */

type FakeUser = { uid: string; isAnonymous: boolean; getIdToken: ReturnType<typeof vi.fn> };

const h = vi.hoisted(() => ({
  auth: { currentUser: null as unknown },
  anonCounter: 0,
  readiness: 'NOT_ENROLLED' as string,
  events: [] as string[],
  beginCallers: [] as Array<{ uid: string; isAnonymous: boolean } | null>,
  callableNames: [] as string[],
  clearStaffSession: null as null | (() => Promise<unknown>),
}));

function makeUser(uid: string, isAnonymous: boolean): FakeUser {
  return { uid, isAnonymous, getIdToken: vi.fn(async () => 'token') };
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
  httpsCallable: vi.fn((_fns: unknown, name: string) => {
    h.callableNames.push(name);
    if (name !== 'beginDeviceRegistration') return vi.fn();
    return vi.fn(async () => {
      const u = h.auth.currentUser as FakeUser | null;
      h.events.push('beginDeviceRegistration');
      h.beginCallers.push(u ? { uid: u.uid, isAnonymous: u.isAnonymous } : null);
      // Stop the flow right after begin: this suite is about who begins.
      return { data: { ok: false, code: 'test_stop_after_begin' } };
    });
  }),
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

const mockSignOut = vi.mocked(signOut);
const mockSignInAnon = vi.mocked(signInAnonymously);
const mockSignInPassword = vi.mocked(signInWithEmailAndPassword);
const mockGetDoc = vi.mocked(getDoc);
const mockUpdateDoc = vi.mocked(updateDoc);
const mockHttpsCallable = vi.mocked(httpsCallable);
const mockVerify = vi.mocked(verifyPinLogin);
const TAURI_KEY = '__TAURI__';
const SESSION_KEY = 'twinpet_session';
const AUTH_ID = '0123456789abcdef0123456789abcdef';
const RAW_FIREBASE_ERROR = 'FirebaseError: auth/network-request-failed (raw)';

const ADMIN_A = 'admin-a';
const ADMIN_A_USER = {
  id: ADMIN_A, username: 'admin', firstName: 'A', lastName: 'A', role: 'admin',
  branchIds: ['ALL'], isActive: true, deletedAt: null,
};
const STALE_ADMIN_SESSION = JSON.stringify({ schemaVersion: 1, issuedAt: 1, user: ADMIN_A_USER, branchId: 'ALL' });

const nativeInvoke = vi.fn(async (cmd: string) => {
  h.events.push(`native:${cmd}`);
  switch (cmd) {
    case NATIVE_DEVICE_SECURITY_READINESS_COMMAND:
      return { readiness: h.readiness };
    case 'native_clear_staff_session':
      return h.clearStaffSession ? h.clearStaffSession() : undefined;
    default:
      throw new Error(`unexpected native command ${cmd}`);
  }
});

function current(): FakeUser | null {
  return h.auth.currentUser as FakeUser | null;
}
function setCurrent(user: FakeUser | null) {
  h.auth.currentUser = user;
}

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

async function renderAuth(): Promise<() => AuthContextValue> {
  const ctx = renderNoWait();
  await waitFor(() => expect(ctx().isLoading).toBe(false));
  return ctx;
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected rejection');
    },
    (e: unknown) => e,
  );
}

function expectSafeEnrollmentIdentityError(err: unknown, code: string) {
  expect(err).toBeInstanceOf(EnrollmentIdentityError);
  expect((err as EnrollmentIdentityError).code).toBe(code);
  const msg = (err as Error).message;
  expect(msg).not.toContain('FirebaseError');
  expect(msg).not.toContain('auth/');
  expect(msg).not.toContain(ADMIN_A);
  expect(msg).not.toContain('anon-');
  expect(msg).not.toMatch(/ไฟล์ลงทะเบียนไม่ถูกต้อง/);
}

/** The production confirm chain: prepare identity → registerDevice(exact grant). */
async function confirmEnrollment(ctx: () => AuthContextValue) {
  const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
  return registerDevice(AUTH_ID, { enrollmentGrant });
}

/** The device becomes READY (as after a finalized enrollment): no stale session may surface. */
async function becomeReady(ctx: () => AuthContextValue) {
  h.readiness = 'READY';
  await act(async () => {
    await ctx().refreshDeviceReadiness();
  });
  expect(ctx().deviceReadiness).toBe('READY');
}

const serverSideMutationCallables = () =>
  h.callableNames.filter((n) => n !== 'beginDeviceRegistration');

beforeEach(() => {
  localStorage.clear();
  setCurrent(null);
  h.anonCounter = 0;
  h.readiness = 'NOT_ENROLLED';
  h.events = [];
  h.beginCallers = [];
  h.callableNames = [];
  h.clearStaffSession = null;
  nativeInvoke.mockClear();
  (globalThis as Record<string, unknown>)[TAURI_KEY] = { core: { invoke: nativeInvoke } };
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
  mockVerify.mockReset();
  mockUpdateDoc.mockClear();
  mockHttpsCallable.mockClear();
  // A persisted password account's restore finds its active admin profile.
  mockGetDoc.mockReset().mockResolvedValue({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER } as never);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>)[TAURI_KEY];
  vi.restoreAllMocks();
});

describe('A. persisted password-admin identity + stale app session, NOT_ENROLLED, recovery none', () => {
  it('session cleared → admin signed out locally → anonymous UID → begin sees ONLY the anonymous UID', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
    const ctx = await renderAuth();
    // The gate withholds the stale admin session while NOT_ENROLLED.
    expect(ctx().session).toBeNull();
    expect(JSON.parse(localStorage.getItem(SESSION_KEY)!).user.id).toBe(ADMIN_A);

    const result = await confirmEnrollment(ctx);

    expect(result).toEqual({ ok: false, code: 'test_stop_after_begin' });
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignInAnon).toHaveBeenCalledTimes(1);
    expect(h.beginCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
    expect(h.beginCallers.some((c) => c?.uid === ADMIN_A)).toBe(false);
    // Order: native staff session cleared → signOut → anonymous → begin.
    const at = (e: string) => h.events.indexOf(e);
    expect(at('native:native_clear_staff_session')).toBeGreaterThanOrEqual(0);
    expect(at('native:native_clear_staff_session')).toBeLessThan(at('signOut'));
    expect(at('signOut')).toBeLessThan(at('signInAnonymously'));
    expect(at('signInAnonymously')).toBeLessThan(at('beginDeviceRegistration'));
    // Zero server-side admin/claim mutation: no other callable, no Firestore write, no PIN call.
    expect(serverSideMutationCallables()).toEqual([]);
    expect(mockUpdateDoc).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSignInPassword).not.toHaveBeenCalled();

    await becomeReady(ctx);
    expect(ctx().session).toBeNull();
    expect(ctx().user).toBeNull();
    expect(ctx().isAuthenticated).toBe(false);
  });
});

describe('B/C. anonymous or no Firebase user', () => {
  it('B. already anonymous → same UID reused, no signOut, no new anonymous sign-in', async () => {
    setCurrent(makeUser('anon-existing', true));
    const ctx = await renderAuth();

    await confirmEnrollment(ctx);

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(current()?.uid).toBe('anon-existing');
    expect(h.beginCallers).toEqual([{ uid: 'anon-existing', isAnonymous: true }]);
  });

  it('B2. already anonymous + stale app session → session still cleared, UID unchanged', async () => {
    setCurrent(makeUser('anon-existing', true));
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
    const ctx = await renderAuth();

    await confirmEnrollment(ctx);

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(h.beginCallers).toEqual([{ uid: 'anon-existing', isAnonymous: true }]);
    await becomeReady(ctx);
    expect(ctx().session).toBeNull();
  });

  it('C. no Firebase user → anonymous user created exactly once, enrollment proceeds', async () => {
    const ctx = await renderAuth();

    await confirmEnrollment(ctx);

    expect(mockSignInAnon).toHaveBeenCalledTimes(1);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(h.beginCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
  });
});

describe('D. recovery evidence is authoritative: nothing changes', () => {
  it.each([
    ['finalization pending', PENDING_FINALIZATION_STORAGE_KEY, '{"enrollmentGenerationId":"g"}'],
    ['completion intent pending', PENDING_COMPLETION_INTENT_STORAGE_KEY, '{"schema":"twinpet.pendingCompletionIntent"}'],
    ['malformed recovery bytes', PENDING_COMPLETION_INTENT_STORAGE_KEY, 'not-json'],
  ])('%s + password user → TRANSITION_BLOCKED; zero signOut / anon sign-in / begin; no deletion', async (_l, key, value) => {
    localStorage.setItem(key, value);
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(h.events).not.toContain('native:native_clear_staff_session');
    expect(current()?.uid).toBe(ADMIN_A);
    expect(localStorage.getItem(key)).toBe(value);
    expect(localStorage.getItem(SESSION_KEY)).not.toBeNull();
  });

  it('conflict (both keys) → blocked, nothing deleted, zero begin', async () => {
    localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, '{"enrollmentGenerationId":"a"}');
    localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, '{"enrollmentGenerationId":"b"}');
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)).not.toBeNull();
    expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).not.toBeNull();
  });

  it('unreadable storage → blocked, zero signOut / anon sign-in', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = await renderAuth();
    const getItem = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());
    getItem.mockRestore();

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(current()?.uid).toBe(ADMIN_A);
  });

  it('pending evidence + anonymous / no user → also blocked (no fresh begin may overwrite it)', async () => {
    localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, 'not-json');
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_TRANSITION_BLOCKED');
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).toBe('not-json');
  });
});

describe('E. delayed admin restore callback', () => {
  it('held restore fetch released after the anonymous transition never saves the admin session', async () => {
    const pending = deferred<unknown>();
    mockGetDoc.mockReturnValue(pending.promise as never);
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = renderNoWait();
    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));

    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
    expect(current()).toMatchObject({ uid: 'anon-1', isAnonymous: true });

    pending.resolve({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER });
    await waitFor(() => expect(ctx().isLoading).toBe(false));

    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(current()).toMatchObject({ uid: 'anon-1', isAnonymous: true });

    await registerDevice(AUTH_ID, { enrollmentGrant });
    expect(h.beginCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);

    await becomeReady(ctx);
    expect(ctx().session).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
  });

  it('E2. restore released while signOut is in flight (admin UID still current) is fenced by generation', async () => {
    const pendingFetch = deferred<unknown>();
    mockGetDoc.mockReturnValue(pendingFetch.promise as never);
    const heldSignOut = deferred<void>();
    mockSignOut.mockImplementation(async () => {
      h.events.push('signOut');
      await heldSignOut.promise;
      setCurrent(null);
    });
    setCurrent(makeUser(ADMIN_A, false));
    const ctx = renderNoWait();
    await waitFor(() => expect(mockGetDoc).toHaveBeenCalledTimes(1));

    const prep = ctx().prepareEnrollmentIdentity();
    await waitFor(() => expect(h.events).toContain('signOut'));
    expect(current()?.uid).toBe(ADMIN_A);
    // The stale restore resolves while Firebase is still on the admin UID.
    pendingFetch.resolve({ exists: () => true, id: ADMIN_A, data: () => ADMIN_A_USER });
    await waitFor(() => expect(ctx().isLoading).toBe(false));
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    heldSignOut.resolve();

    const enrollmentGrant = await prep;
    expect(current()?.uid).toBe('anon-1');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    await registerDevice(AUTH_ID, { enrollmentGrant });
    expect(h.beginCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
  });
});

describe('F. transition failure → no begin, no session re-exposure, fixed safe error', () => {
  it('signOut fails', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
    mockSignOut.mockRejectedValue(new Error(RAW_FIREBASE_ERROR));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_UNAVAILABLE');
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    await becomeReady(ctx);
    expect(ctx().session).toBeNull();
  });

  it('signOut resolves but the password user is still current', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    mockSignOut.mockImplementation(async () => undefined);
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_UNAVAILABLE');
    expect(mockSignInAnon).not.toHaveBeenCalled();
    // A direct registerDevice call cannot fall back to the still-current admin UID.
    expect(await registerDevice(AUTH_ID, { enrollmentGrant: { requesterUid: ADMIN_A } as never })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_prepared',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
  });

  it('anonymous sign-in fails after the admin sign-out', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
    mockSignInAnon.mockRejectedValue(new Error(RAW_FIREBASE_ERROR));
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_UNAVAILABLE');
    expect(current()).toBeNull();
    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    await becomeReady(ctx);
    expect(ctx().session).toBeNull();
  });

  it('anonymous sign-in yields a non-anonymous user → not proven anonymous', async () => {
    mockSignInAnon.mockImplementation(async () => {
      setCurrent(makeUser('weird', false));
      return {} as never;
    });
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_UNAVAILABLE');
    expect(h.events).not.toContain('beginDeviceRegistration');
  });

  it('native staff-session clear fails → nothing signed out', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    h.clearStaffSession = async () => {
      throw new Error('native raw failure');
    };
    const ctx = await renderAuth();

    const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

    expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_UNAVAILABLE');
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(current()?.uid).toBe(ADMIN_A);
  });
});

describe('device state and concurrency fences', () => {
  it.each(['READY', 'INVALID_OR_INCOMPLETE', 'UNAVAILABLE'])(
    'readiness %s → NOT_ALLOWED; zero session clear / signOut / anon sign-in',
    async (readiness) => {
      setCurrent(makeUser(ADMIN_A, false));
      localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
      h.readiness = readiness;
      const ctx = await renderAuth();

      const err = await rejectionOf(ctx().prepareEnrollmentIdentity());

      expectSafeEnrollmentIdentityError(err, 'ENROLLMENT_IDENTITY_NOT_ALLOWED');
      expect(mockSignOut).not.toHaveBeenCalled();
      expect(mockSignInAnon).not.toHaveBeenCalled();
      expect(h.events).not.toContain('native:native_clear_staff_session');
      expect(current()?.uid).toBe(ADMIN_A);
    },
  );

  it('a newer interactive auth operation during preparation → fail closed, admin NOT signed out', async () => {
    setCurrent(makeUser(ADMIN_A, false));
    const clear = deferred<unknown>();
    h.clearStaffSession = () => clear.promise;
    const ctx = await renderAuth();

    const prep = rejectionOf(ctx().prepareEnrollmentIdentity());
    await waitFor(() => expect(h.events).toContain('native:native_clear_staff_session'));
    // A newer login supersedes the preparation (gated afterwards by NOT_ENROLLED).
    const newer = ctx().loginWithUsername('admin', 'pw', 'ALL').catch(() => undefined);
    clear.resolve(undefined);

    expectSafeEnrollmentIdentityError(await prep, 'ENROLLMENT_IDENTITY_UNAVAILABLE');
    await newer;
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(h.events).not.toContain('beginDeviceRegistration');
  });
});

describe('G. registerDevice boundary: only a live grant from a completed preparation begins', () => {
  it('Codex blocker: existing anonymous UID + stale admin session, NO preparation → zero begin', async () => {
    setCurrent(makeUser('anon-existing', true));
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);
    const ctx = await renderAuth();

    for (const forged of [undefined, 'anon-existing', { requesterUid: 'anon-existing' }, Object.freeze({})]) {
      expect(await registerDevice(AUTH_ID, { enrollmentGrant: forged as never })).toEqual({
        ok: false,
        code: 'enrollment_identity_not_prepared',
      });
    }

    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(h.callableNames).toEqual([]);
    expect(localStorage.getItem(SESSION_KEY)).toBe(STALE_ADMIN_SESSION);
    expect(ctx().session).toBeNull();
  });

  it('Codex blocker: existing anonymous UID + recovery evidence, NO preparation → zero begin, evidence kept', async () => {
    setCurrent(makeUser('anon-existing', true));
    localStorage.setItem(PENDING_COMPLETION_INTENT_STORAGE_KEY, 'not-json');
    await renderAuth();

    expect(await registerDevice(AUTH_ID, { enrollmentGrant: { requesterUid: 'anon-existing' } as never })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_prepared',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(localStorage.getItem(PENDING_COMPLETION_INTENT_STORAGE_KEY)).toBe('not-json');
  });

  it('grant replay → second use refused, exactly one begin', async () => {
    const ctx = await renderAuth();
    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();

    await registerDevice(AUTH_ID, { enrollmentGrant });
    expect(await registerDevice(AUTH_ID, { enrollmentGrant })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_prepared',
    });
    expect(h.beginCallers).toEqual([{ uid: 'anon-1', isAnonymous: true }]);
  });

  it('a second preparation revokes the first grant', async () => {
    setCurrent(makeUser('anon-existing', true));
    const ctx = await renderAuth();
    const first = await ctx().prepareEnrollmentIdentity();
    const second = await ctx().prepareEnrollmentIdentity();

    expect(await registerDevice(AUTH_ID, { enrollmentGrant: first })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_prepared',
    });
    await registerDevice(AUTH_ID, { enrollmentGrant: second });
    expect(h.beginCallers).toEqual([{ uid: 'anon-existing', isAnonymous: true }]);
  });

  it('newer password login after the grant was minted → stale grant refused, zero begin', async () => {
    const ctx = await renderAuth();
    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
    // Gated by NOT_ENROLLED, but it is still a newer auth operation.
    await ctx().loginWithUsername('admin', 'pw', 'ALL').catch(() => undefined);

    expect(await registerDevice(AUTH_ID, { enrollmentGrant })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_prepared',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
  });

  it('logout after the grant was minted → stale grant refused, zero begin', async () => {
    const ctx = await renderAuth();
    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
    await act(async () => {
      await ctx().logout();
    });

    expect(await registerDevice(AUTH_ID, { enrollmentGrant })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_prepared',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
  });

  it('Firebase user changes to a password account after mint → refused, zero begin', async () => {
    const ctx = await renderAuth();
    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
    setCurrent(makeUser(ADMIN_A, false));

    expect(await registerDevice(AUTH_ID, { enrollmentGrant })).toEqual({
      ok: false,
      code: 'enrollment_identity_not_anonymous',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
  });

  it('a restore writes twinpet_session after mint → refused, zero begin', async () => {
    const ctx = await renderAuth();
    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
    localStorage.setItem(SESSION_KEY, STALE_ADMIN_SESSION);

    expect(await registerDevice(AUTH_ID, { enrollmentGrant })).toEqual({
      ok: false,
      code: 'enrollment_session_present',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
  });

  it('recovery evidence appears after mint → refused, zero begin, evidence unchanged', async () => {
    const ctx = await renderAuth();
    const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
    localStorage.setItem(PENDING_FINALIZATION_STORAGE_KEY, '{"enrollmentGenerationId":"g"}');

    expect(await registerDevice(AUTH_ID, { enrollmentGrant })).toEqual({
      ok: false,
      code: 'enrollment_recovery_pending',
    });
    expect(h.events).not.toContain('beginDeviceRegistration');
    expect(localStorage.getItem(PENDING_FINALIZATION_STORAGE_KEY)).toBe('{"enrollmentGenerationId":"g"}');
  });

  it.each(['READY', 'INVALID_OR_INCOMPLETE', 'UNAVAILABLE'])(
    'native readiness becomes %s after mint → refused (fresh native read), zero begin',
    async (readiness) => {
      const ctx = await renderAuth();
      const enrollmentGrant = await ctx().prepareEnrollmentIdentity();
      h.readiness = readiness;
      const readsBefore = nativeInvoke.mock.calls.filter(([c]) => c === NATIVE_DEVICE_SECURITY_READINESS_COMMAND).length;

      let result: unknown;
      await act(async () => {
        result = await registerDevice(AUTH_ID, { enrollmentGrant });
      });

      expect(result).toEqual({ ok: false, code: 'enrollment_not_allowed' });
      expect(
        nativeInvoke.mock.calls.filter(([c]) => c === NATIVE_DEVICE_SECURITY_READINESS_COMMAND).length,
      ).toBe(readsBefore + 1);
      expect(h.events).not.toContain('beginDeviceRegistration');
    },
  );
});
