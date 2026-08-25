import { FirebaseError } from 'firebase/app';
import {
  getFunctions,
  httpsCallable,
  httpsCallableFromURL,
  connectFunctionsEmulator,
} from 'firebase/functions';
import { app, isFirebaseConfigured, USE_EMULATOR, getEmulatorHost } from '../firebase';

export type SetUserAccountClientCommand = {
  op: 'create' | 'rotate' | 'updateProfile' | 'setActive' | 'softDelete' | 'rename';
  [key: string]: unknown;
};

export type SetUserAccountClientResult = {
  ok: boolean;
  status: string;
  userId?: string;
  authVersion?: number;
  credentialVersion?: number;
  message?: string;
};

let emulatorConnected = false;

function getCallable() {
  if (!app) throw new Error('Firebase is not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR && !emulatorConnected) {
    connectFunctionsEmulator(functions, getEmulatorHost(), 5001);
    emulatorConnected = true;
  }
  if (import.meta.env.DEV && !USE_EMULATOR) {
    const proxyUrl = `${window.location.origin}/__/firebase/functions/setUserAccount`;
    return httpsCallableFromURL<SetUserAccountClientCommand, SetUserAccountClientResult>(
      functions,
      proxyUrl,
    );
  }
  return httpsCallable<SetUserAccountClientCommand, SetUserAccountClientResult>(
    functions,
    'setUserAccount',
  );
}

export async function setUserAccount(
  command: SetUserAccountClientCommand,
): Promise<SetUserAccountClientResult> {
  if (!isFirebaseConfigured) {
    throw new Error('Firebase is not configured');
  }
  try {
    const result = await getCallable()(command);
    const payload = result.data;
    if (!payload) throw new Error('ไม่สามารถบันทึกบัญชีผู้ใช้ได้');
    if (!payload.ok) {
      throw new Error(payload.message || 'ไม่สามารถบันทึกบัญชีผู้ใช้ได้');
    }
    return payload;
  } catch (err) {
    if (err instanceof FirebaseError) {
      throw new Error(err.message || 'ไม่สามารถบันทึกบัญชีผู้ใช้ได้');
    }
    throw err;
  }
}
