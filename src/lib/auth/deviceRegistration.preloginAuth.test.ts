import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadCompletionIntent,
  recoverDeviceRegistrationCompletion,
  registerDevice,
  saveCompletionIntent,
  PENDING_COMPLETION_INTENT_SCHEMA,
  type PendingCompletionIntentV1,
} from './deviceRegistration';
import { ensureFirebaseAuth } from '../firebaseAuth';

/**
 * TPOS-R7 pre-login enrollment: the non-injected (production) callable path of
 * registerDevice must establish the normal Firebase Auth session itself,
 * because on the login screen no staff session exists yet. Registration needs
 * only a Firebase UID — never staff claims.
 */

const h = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string } },
  begin: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('../firebase', () => ({ auth: h.auth, app: {}, isFirebaseConfigured: true }));
vi.mock('../firebaseAuth', () => ({ ensureFirebaseAuth: vi.fn() }));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn((_fns: unknown, name: string) =>
    name === 'beginDeviceRegistration' ? h.begin : name === 'completeDeviceRegistration' ? h.complete : vi.fn(),
  ),
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

const mockEnsure = vi.mocked(ensureFirebaseAuth);
const AUTH_ID = '0123456789abcdef0123456789abcdef';
const nativeInvoke = vi.fn();

const INTENT: PendingCompletionIntentV1 = {
  schema: PENDING_COMPLETION_INTENT_SCHEMA,
  version: 1,
  registrationSessionId: '11'.repeat(16),
  drp1Base64: Buffer.alloc(185, 7).toString('base64'),
  enrollmentGenerationId: '22'.repeat(16),
  stagedPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
};

beforeEach(() => {
  localStorage.clear();
  h.auth.currentUser = null;
  h.begin.mockReset();
  h.complete.mockReset();
  nativeInvoke.mockReset();
  mockEnsure.mockReset();
  mockEnsure.mockImplementation(async () => {
    h.auth.currentUser = { uid: 'anon-prelogin-uid' };
  });
});

describe('registerDevice — pre-login Firebase auth prerequisite (TPOS-R7)', () => {
  it('with no Firebase user yet, ensures the anonymous session BEFORE beginDeviceRegistration', async () => {
    h.begin.mockResolvedValue({ data: { ok: false, code: 'not_authorized' } });

    const result = await registerDevice(AUTH_ID, { customInvoke: nativeInvoke });

    expect(mockEnsure).toHaveBeenCalledTimes(1);
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(mockEnsure.mock.invocationCallOrder[0]).toBeLessThan(h.begin.mock.invocationCallOrder[0]!);
    // begin carries no payload: the server binds the session to request.auth.uid only.
    expect(h.begin).toHaveBeenCalledWith();
    expect(result).toEqual({ ok: false, code: 'not_authorized' });
    expect(nativeInvoke).not.toHaveBeenCalled();
  });

  it('reuses an existing Firebase user (e.g. the Settings path) and requires no staff claims', async () => {
    // A bare UID with no getIdTokenResult/claims at all is sufficient.
    h.auth.currentUser = { uid: 'existing-uid' };
    mockEnsure.mockImplementation(async () => undefined);
    h.begin.mockResolvedValue({ data: { ok: false, code: 'begin_registration_failed' } });

    await registerDevice(AUTH_ID, { customInvoke: nativeInvoke });

    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.auth.currentUser).toEqual({ uid: 'existing-uid' });
  });

  it('if the Firebase session cannot be established, returns not_authenticated and never calls the server', async () => {
    mockEnsure.mockRejectedValue(new Error('auth/operation-not-allowed'));

    const result = await registerDevice(AUTH_ID, { customInvoke: nativeInvoke });

    expect(result).toEqual({ ok: false, code: 'not_authenticated' });
    expect(h.begin).not.toHaveBeenCalled();
    expect(nativeInvoke).not.toHaveBeenCalled();
  });
});

describe('recoverDeviceRegistrationCompletion — recovery semantics preserved pre-login (TPOS-R7)', () => {
  it('does NOT mint a new Firebase identity: no user => not_authenticated, no replay, intent kept', async () => {
    saveCompletionIntent(INTENT);

    const result = await recoverDeviceRegistrationCompletion({ customInvoke: nativeInvoke });

    expect(result).toEqual({ ok: false, code: 'not_authenticated' });
    expect(mockEnsure).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(loadCompletionIntent()).toEqual(INTENT);
  });

  it('with the original persisted Firebase user, replays the exact saved request once — no begin, no new proof', async () => {
    h.auth.currentUser = { uid: 'original-uid' };
    saveCompletionIntent(INTENT);
    h.complete.mockResolvedValue({ data: { ok: false, code: 'session_expired' } });

    await recoverDeviceRegistrationCompletion({ customInvoke: nativeInvoke });

    expect(mockEnsure).not.toHaveBeenCalled();
    expect(h.begin).not.toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete).toHaveBeenCalledWith({
      registrationSessionId: INTENT.registrationSessionId,
      drp1Base64: INTENT.drp1Base64,
      enrollmentGenerationId: INTENT.enrollmentGenerationId,
    });
    expect(nativeInvoke).not.toHaveBeenCalledWith('native_generate_device_registration_proof', expect.anything());
    // A rejected recovery never deletes the durable evidence.
    expect(loadCompletionIntent()).toEqual(INTENT);
  });
});
