import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signInAnonymously, signOut } from 'firebase/auth';
import { ensureAnonymousFirebaseAuthForPin } from './firebaseAuth';
import { PinIdentityError } from './auth/pinIdentityError';

/**
 * TPOS-R7 (Codex 003): `ensureAnonymousFirebaseAuthForPin` must never sign out
 * a Firebase user other than the non-anonymous user it began leaving, and a
 * throwing final pre-sign-out fence means zero sign-out / anonymous sign-in.
 */

type FakeUser = { uid: string; isAnonymous: boolean };

const h = vi.hoisted(() => ({ auth: { currentUser: null as unknown }, anon: 0 }));

vi.mock('./firebase', () => ({ auth: h.auth, isFirebaseConfigured: true }));
vi.mock('firebase/auth', () => ({ signInAnonymously: vi.fn(), signOut: vi.fn() }));

const mockSignOut = vi.mocked(signOut);
const mockSignInAnon = vi.mocked(signInAnonymously);

function setCurrent(u: FakeUser | null) {
  h.auth.currentUser = u;
}
function current() {
  return h.auth.currentUser as FakeUser | null;
}

beforeEach(() => {
  setCurrent(null);
  h.anon = 0;
  mockSignOut.mockReset().mockImplementation(async () => {
    setCurrent(null);
  });
  mockSignInAnon.mockReset().mockImplementation(async () => {
    h.anon += 1;
    setCurrent({ uid: `anon-${h.anon}`, isAnonymous: true });
    return {} as never;
  });
});

describe('ensureAnonymousFirebaseAuthForPin — departing-identity fence', () => {
  it('current user changes to ANOTHER uid while beforeLeaving is awaited → no signOut, no anonymous sign-in', async () => {
    const a = { uid: 'pw-a', isAnonymous: false };
    setCurrent(a);
    const err = await ensureAnonymousFirebaseAuthForPin({
      beforeLeavingNonAnonymous: async (departing) => {
        expect(departing).toBe(a);
        setCurrent({ uid: 'pw-b', isAnonymous: false });
      },
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(PinIdentityError);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(current()?.uid).toBe('pw-b');
  });

  it.each([
    ['signed out', null],
    ['replaced by an anonymous user', { uid: 'anon-x', isAnonymous: true }],
  ])('current user %s while beforeLeaving is awaited → no signOut, no anonymous sign-in', async (_l, replacement) => {
    setCurrent({ uid: 'pw-a', isAnonymous: false });
    const err = await ensureAnonymousFirebaseAuthForPin({
      beforeLeavingNonAnonymous: async () => {
        setCurrent(replacement);
      },
    }).then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(PinIdentityError);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
  });

  it('final synchronous fence throws → zero signOut, zero anonymous sign-in, its error propagates unchanged', async () => {
    const a = { uid: 'pw-a', isAnonymous: false };
    setCurrent(a);
    const fenceErr = new Error('superseded');
    const fence = vi.fn(() => {
      throw fenceErr;
    });
    const err = await ensureAnonymousFirebaseAuthForPin({
      beforeLeavingNonAnonymous: async () => undefined,
      assertCanSignOutNonAnonymous: fence,
    }).then(() => null, (e: unknown) => e);

    expect(err).toBe(fenceErr);
    expect(fence).toHaveBeenCalledWith(a);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
    expect(current()).toBe(a);
  });

  it('fence runs after beforeLeaving and immediately before signOut', async () => {
    setCurrent({ uid: 'pw-a', isAnonymous: false });
    const order: string[] = [];
    mockSignOut.mockImplementation(async () => {
      order.push('signOut');
      setCurrent(null);
    });
    await ensureAnonymousFirebaseAuthForPin({
      beforeLeavingNonAnonymous: async () => {
        order.push('beforeLeaving');
      },
      assertCanSignOutNonAnonymous: () => {
        order.push('fence');
      },
    });
    expect(order).toEqual(['beforeLeaving', 'fence', 'signOut']);
  });

  it('control: normal non-anonymous → anonymous transition (new UID)', async () => {
    setCurrent({ uid: 'pw-a', isAnonymous: false });
    const fence = vi.fn();
    const before = vi.fn(async () => undefined);
    const user = await ensureAnonymousFirebaseAuthForPin({
      beforeLeavingNonAnonymous: before,
      assertCanSignOutNonAnonymous: fence,
    });

    expect(before).toHaveBeenCalledTimes(1);
    expect(fence).toHaveBeenCalledTimes(1);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSignInAnon).toHaveBeenCalledTimes(1);
    expect(user.uid).toBe('anon-1');
    expect(user.isAnonymous).toBe(true);
  });

  it('control: an existing anonymous user is reused; no departure callbacks, no signOut', async () => {
    const anon = { uid: 'anon-existing', isAnonymous: true };
    setCurrent(anon);
    const before = vi.fn();
    const fence = vi.fn();
    const user = await ensureAnonymousFirebaseAuthForPin({
      beforeLeavingNonAnonymous: before,
      assertCanSignOutNonAnonymous: fence,
    });

    expect(user).toBe(anon);
    expect(before).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockSignInAnon).not.toHaveBeenCalled();
  });

  it('control: no current user → one anonymous sign-in, no departure callbacks', async () => {
    const before = vi.fn();
    const user = await ensureAnonymousFirebaseAuthForPin({ beforeLeavingNonAnonymous: before });

    expect(user.uid).toBe('anon-1');
    expect(before).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });
});
