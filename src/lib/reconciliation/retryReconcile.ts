import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { app, USE_EMULATOR } from '../firebase';

/**
 * Thin client wrapper for the admin-only `retryReconcile` Cloud Function (the
 * ONLY way the UI mutates a stuck async order — it never writes Firestore
 * directly). Mirrors the region/emulator wiring of verifyPinLogin.ts.
 */
let emulatorConnected = false;

export async function callRetryReconcile(orderId: string): Promise<void> {
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR && !emulatorConnected) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    emulatorConnected = true;
  }
  const callable = httpsCallable<{ orderId: string }, { success: boolean }>(functions, 'retryReconcile');
  await callable({ orderId });
}
