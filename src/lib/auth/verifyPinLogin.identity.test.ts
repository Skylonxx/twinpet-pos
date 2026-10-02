// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FirebaseError } from 'firebase/app';
import { verifyPinLogin } from './verifyPinLogin';
import { PinIdentityError } from './pinIdentityError';

/**
 * TPOS-R7: the PIN callable wrapper itself refuses to send a PIN under a
 * non-anonymous Firebase identity (web and native), and maps the server's
 * provider-guard rejection to a fixed PinIdentityError — never "PIN incorrect".
 */

const h = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string; isAnonymous: boolean; getIdToken: () => Promise<string> } },
  callable: null as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('../firebase', () => ({
  auth: h.auth,
  app: {},
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));
vi.mock('../firebaseAuth', () => ({ ensureFirebaseAuth: vi.fn(async () => undefined) }));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: vi.fn(() => h.callable),
  httpsCallableFromURL: vi.fn(() => h.callable),
}));

const STAFF = { id: 'staff-b', username: 'cashier', isActive: true, deletedAt: null };

beforeEach(() => {
  h.callable = vi.fn(async () => ({ data: { success: true, user: STAFF } }));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('verifyPinLogin wrapper — identity guard', () => {
  it('password (non-anonymous) current user: PIN_IDENTITY_UNAVAILABLE and the callable is NEVER invoked', async () => {
    h.auth.currentUser = { uid: 'admin-a', isAnonymous: false, getIdToken: vi.fn(async () => 't') };

    const err = await verifyPinLogin('4321', 'LDP-001', { username: 'cashier' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PinIdentityError);
    expect((err as PinIdentityError).code).toBe('PIN_IDENTITY_UNAVAILABLE');
    expect(h.callable).not.toHaveBeenCalled();
  });

  it('anonymous current user: callable invoked, user returned', async () => {
    h.auth.currentUser = { uid: 'anon-1', isAnonymous: true, getIdToken: vi.fn(async () => 't') };

    const user = await verifyPinLogin('4321', 'LDP-001', { username: 'cashier' });

    expect(user.id).toBe('staff-b');
    expect(h.callable).toHaveBeenCalledTimes(1);
  });

  it('server provider-guard rejection (failed-precondition) → PIN_IDENTITY_REJECTED, raw server string not surfaced', async () => {
    h.auth.currentUser = { uid: 'anon-1', isAnonymous: true, getIdToken: vi.fn(async () => 't') };
    h.callable = vi.fn(async () => {
      throw new FirebaseError('functions/failed-precondition', 'PIN_SESSION_IDENTITY_REJECTED');
    });

    const err = await verifyPinLogin('4321', 'LDP-001', { username: 'cashier' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PinIdentityError);
    expect((err as PinIdentityError).code).toBe('PIN_IDENTITY_REJECTED');
    expect((err as Error).message).not.toContain('PIN_SESSION_IDENTITY_REJECTED');
    expect((err as Error).message).not.toContain('PIN ไม่ถูกต้อง');
  });

  it('wrong PIN (permission-denied) is still the existing PIN-incorrect message', async () => {
    h.auth.currentUser = { uid: 'anon-1', isAnonymous: true, getIdToken: vi.fn(async () => 't') };
    h.callable = vi.fn(async () => {
      throw new FirebaseError('functions/permission-denied', 'x');
    });

    const err = await verifyPinLogin('0000', 'LDP-001', { username: 'cashier' }).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(PinIdentityError);
    expect((err as Error).message).toBe('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  });
});

describe('verifyPinLogin wrapper — token refresh failures', () => {
  const RAW = 'FirebaseError: auth/network-request-failed (raw)';

  it('pre-call refresh rejects → PIN_IDENTITY_UNAVAILABLE, callable NEVER invoked, raw text not surfaced', async () => {
    h.auth.currentUser = {
      uid: 'anon-1',
      isAnonymous: true,
      getIdToken: vi.fn(async () => {
        throw new FirebaseError('auth/network-request-failed', RAW);
      }),
    };

    const err = await verifyPinLogin('4321', 'LDP-001', { username: 'cashier' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PinIdentityError);
    expect((err as PinIdentityError).code).toBe('PIN_IDENTITY_UNAVAILABLE');
    expect((err as Error).message).not.toContain('auth/');
    expect(h.callable).not.toHaveBeenCalled();
  });

  it('post-call refresh rejects → PIN_IDENTITY_UNAVAILABLE (not the generic FirebaseError fallthrough)', async () => {
    let calls = 0;
    h.auth.currentUser = {
      uid: 'anon-1',
      isAnonymous: true,
      getIdToken: vi.fn(async () => {
        calls += 1;
        if (calls > 1) throw new FirebaseError('auth/user-token-expired', RAW);
        return 't';
      }),
    };

    const err = await verifyPinLogin('4321', 'LDP-001', { username: 'cashier' }).catch((e: unknown) => e);

    expect(h.callable).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(PinIdentityError);
    expect((err as PinIdentityError).code).toBe('PIN_IDENTITY_UNAVAILABLE');
    expect((err as Error).message).not.toContain(RAW);
    expect((err as Error).message).not.toContain('PIN ไม่ถูกต้อง');
  });
});
