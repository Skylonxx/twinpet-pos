import { signInAnonymously, signOut, type User as FirebaseUser } from 'firebase/auth';
import { auth, isFirebaseConfigured } from './firebase';
import { PinIdentityError } from './auth/pinIdentityError';

// Single in-flight anonymous sign-in shared by every caller, so a concurrent
// restore (onAuthStateChanged) and a Quick PIN transition can never mint two
// anonymous UIDs and race each other for `auth.currentUser`.
let anonymousSignIn: Promise<void> | null = null;

function signInAnonymouslyOnce(): Promise<void> {
  if (!auth) return Promise.reject(new Error('Firebase Auth is not configured'));
  const firebaseAuth = auth;
  anonymousSignIn ??= (async () => {
    try {
      if (!firebaseAuth.currentUser) await signInAnonymously(firebaseAuth);
    } finally {
      anonymousSignIn = null;
    }
  })();
  return anonymousSignIn;
}

/**
 * Ensures a Firebase Auth session exists for Firestore rules (`request.auth != null`).
 * PIN login uses anonymous auth; username login uses email/password instead.
 */
export async function ensureFirebaseAuth(): Promise<void> {
  if (!isFirebaseConfigured || !auth) return;
  if (auth.currentUser) return;
  await signInAnonymouslyOnce();
}

export type AnonymousPinIdentityOptions = {
  /**
   * Runs ONLY when the current Firebase user is non-anonymous, before that
   * account is signed out; receives the departing user captured before any
   * await. Throw to keep the current UID (e.g. a pending UID-bound enrollment
   * recovery); the error propagates unchanged.
   */
  beforeLeavingNonAnonymous: (departing: FirebaseUser) => void | Promise<void>;
  /**
   * Optional SYNCHRONOUS final authorization, called after all awaited
   * departure work and immediately before `signOut` with no await in between.
   * Throw to abort: zero sign-out, zero anonymous sign-in; the error
   * propagates unchanged.
   */
  assertCanSignOutNonAnonymous?: (departing: FirebaseUser) => void;
};

/**
 * TPOS-R7 Quick PIN identity isolation. Resolves to a Firebase user that is
 * proven anonymous, so `verifyPinLogin` can never stamp PIN-resolved staff
 * claims onto a password / federated account:
 *  - no current user        → sign in anonymously;
 *  - anonymous current user → reused (same UID);
 *  - non-anonymous user     → `beforeLeavingNonAnonymous`, sign out, then a new
 *                             anonymous session (never the same UID).
 * Any failure is a fixed `PinIdentityError`, never a raw Firebase string.
 */
export async function ensureAnonymousFirebaseAuthForPin(
  options: AnonymousPinIdentityOptions,
): Promise<FirebaseUser> {
  if (!isFirebaseConfigured || !auth) throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');

  const previous = auth.currentUser;
  if (previous && !previous.isAnonymous) {
    const departingUid = previous.uid;
    await options.beforeLeavingNonAnonymous(previous);
    // Never sign out a different (or no longer non-anonymous) user than the
    // one this transition began leaving.
    const stillDeparting = auth.currentUser;
    if (!stillDeparting || stillDeparting.isAnonymous || stillDeparting.uid !== departingUid) {
      throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
    }
    options.assertCanSignOutNonAnonymous?.(previous);
    try {
      await signOut(auth);
    } catch {
      throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
    }
    if (auth.currentUser) throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
  }

  if (!auth.currentUser) {
    try {
      await signInAnonymouslyOnce();
    } catch {
      throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
    }
  }

  const next = auth.currentUser as FirebaseUser | null;
  if (!next || next.isAnonymous !== true) throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
  if (previous && !previous.isAnonymous && next.uid === previous.uid) {
    throw new PinIdentityError('PIN_IDENTITY_UNAVAILABLE');
  }
  return next;
}
