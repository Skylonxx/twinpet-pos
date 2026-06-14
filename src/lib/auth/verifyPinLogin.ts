import { FirebaseError } from 'firebase/app';
import {
  getFunctions,
  httpsCallable,
  httpsCallableFromURL,
  connectFunctionsEmulator,
} from 'firebase/functions';
import { auth, app, isFirebaseConfigured, USE_EMULATOR, getEmulatorHost } from '../firebase';
import { ensureFirebaseAuth } from '../firebaseAuth';
import type { User } from '../types';

export type VerifyPinLoginRequest = {
  pin: string;
  branchId: string;
  username?: string;
  userId?: string;
};

export type VerifyPinLoginResponse = {
  success: boolean;
  user: Omit<User, 'pin'> & { id: string };
};

let emulatorConnected = false;

function getVerifyPinLoginCallable() {
  if (!app) {
    throw new Error('Firebase is not configured');
  }

  // Region sourced from firebase.json via the generated env (see gen-deploy-config.mjs).
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);

  if (USE_EMULATOR && !emulatorConnected) {
    // LAN-aware host (Phase 7C-E1): same resolution as the other emulator SDKs so
    // PIN login works from a POS terminal hitting the dev machine's LAN IP.
    connectFunctionsEmulator(functions, getEmulatorHost(), 5001);
    emulatorConnected = true;
  }

  // In dev (NOT on the emulator), route via Vite proxy (same origin) to bypass
  // Cloud Run CORS/IAM preflight issues.
  if (import.meta.env.DEV && !USE_EMULATOR) {
    const proxyUrl = `${window.location.origin}/__/firebase/functions/verifyPinLogin`;
    return httpsCallableFromURL<VerifyPinLoginRequest, VerifyPinLoginResponse>(
      functions,
      proxyUrl,
    );
  }

  return httpsCallable<VerifyPinLoginRequest, VerifyPinLoginResponse>(
    functions,
    'verifyPinLogin',
  );
}

/** Call Cloud Function to verify PIN and stamp custom claims on the current Auth user. */
export async function verifyPinLogin(
  pin: string,
  branchId: string,
  options?: Pick<VerifyPinLoginRequest, 'username' | 'userId'>,
): Promise<User> {
  if (!isFirebaseConfigured) {
    throw new Error('Firebase is not configured');
  }

  await ensureFirebaseAuth();
  if (!auth?.currentUser) {
    throw new Error(
      'Firebase Auth ไม่พร้อม — เปิด Anonymous Authentication ใน Firebase Console',
    );
  }
  await auth.currentUser.getIdToken(true);

  const callable = getVerifyPinLoginCallable();

  try {
    console.log('[verifyPinLogin] calling Cloud Function', { branchId, pinLength: pin.length });
    const result = await callable({
      pin,
      branchId,
      username: options?.username,
      userId: options?.userId,
    });

    const payload = result.data;
    if (!payload?.success || !payload.user) {
      throw new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
    }

    return { ...payload.user, pin: '' };
  } catch (err) {
    if (err instanceof FirebaseError) {
      console.error('[verifyPinLogin] FirebaseError', err.code, err.message);
      if (err.code === 'functions/internal') {
        throw new Error(
          'เซิร์ฟเวอร์ PIN ไม่ตอบสนอง — รีสตาร์ท dev server (npm run dev) หรือเปิด Anonymous Auth',
        );
      }
      if (err.code === 'functions/unauthenticated') {
        throw new Error('ต้องเข้าสู่ระบบ Firebase ก่อน — เปิด Anonymous Authentication');
      }
      if (err.code === 'functions/permission-denied') {
        throw new Error('PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
      }
      const message = err.message || 'ไม่สามารถยืนยัน PIN ได้';
      throw new Error(message);
    }
    throw err;
  }
}
