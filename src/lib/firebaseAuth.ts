import { signInAnonymously } from 'firebase/auth';
import { auth, isFirebaseConfigured } from './firebase';

/**
 * Ensures a Firebase Auth session exists for Firestore rules (`request.auth != null`).
 * PIN login uses anonymous auth; username login uses email/password instead.
 */
export async function ensureFirebaseAuth(): Promise<void> {
  if (!isFirebaseConfigured || !auth) return;
  if (auth.currentUser) return;
  await signInAnonymously(auth);
}
