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

/**
 * Thrown by `setUserAccount`. `message` is the existing user-facing text
 * (unchanged for current callers). `code` lets a caller tell a DEFINITE
 * server refusal apart from an unknown outcome without parsing text:
 *   - `status:<status>`      — the callable answered `{ ok: false, status }`;
 *   - `functions/<code>`     — a Functions/transport error code;
 *   - `unknown`              — anything else.
 */
export class SetUserAccountError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SetUserAccountError';
    this.code = code;
  }
}

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
  let payload: SetUserAccountClientResult | null | undefined;
  try {
    const result = await getCallable()(command);
    payload = result.data;
  } catch (err) {
    if (err instanceof FirebaseError) {
      throw new SetUserAccountError(err.message || 'ไม่สามารถบันทึกบัญชีผู้ใช้ได้', err.code || 'unknown');
    }
    throw new SetUserAccountError(
      err instanceof Error && err.message ? err.message : 'ไม่สามารถบันทึกบัญชีผู้ใช้ได้',
      'unknown',
    );
  }
  if (!payload) throw new SetUserAccountError('ไม่สามารถบันทึกบัญชีผู้ใช้ได้', 'unknown');
  if (!payload.ok) {
    throw new SetUserAccountError(
      payload.message || 'ไม่สามารถบันทึกบัญชีผู้ใช้ได้',
      `status:${payload.status || 'unknown'}`,
    );
  }
  return payload;
}
