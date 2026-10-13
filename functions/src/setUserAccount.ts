import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { assertFreshPrivilegedAuthority } from './authorityFence';
import {
  ADMIN_PASSWORD_SESSION_REQUIRED,
  ADMIN_PASSWORD_SESSION_REQUIRED_MESSAGE,
  isPrimaryPasswordPrincipal,
} from './adminPasswordPrincipal';
import {
  performSetUserAccount,
  type SetUserAccountOp,
  type SetUserAccountResult,
} from './setUserAccountCore';

function asCommand(raw: unknown): SetUserAccountOp | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  const op = data.op;
  if (
    op !== 'create' &&
    op !== 'rotate' &&
    op !== 'updateProfile' &&
    op !== 'setActive' &&
    op !== 'softDelete' &&
    op !== 'rename'
  ) {
    return null;
  }
  return data as unknown as SetUserAccountOp;
}

export async function performSetUserAccountCallable(
  database: typeof db,
  raw: unknown,
  auth: { uid?: string; token?: Record<string, unknown> } | null,
): Promise<SetUserAccountResult> {
  if (!auth) throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');
  // Admin & Security Center V1: account/credential administration requires
  // the primary username+password admin principal. A Quick PIN (anonymous)
  // session never qualifies, including an admin's. Additive to the fence
  // below and to the core's live users/{staffId} admin check.
  if (!isPrimaryPasswordPrincipal(auth)) {
    throw new HttpsError('permission-denied', ADMIN_PASSWORD_SESSION_REQUIRED_MESSAGE, {
      code: ADMIN_PASSWORD_SESSION_REQUIRED,
    });
  }
  const freshness = await assertFreshPrivilegedAuthority(database, auth);
  const command = asCommand(raw);
  if (!command) throw new HttpsError('invalid-argument', 'คำสั่งไม่ถูกต้อง');
  const result = await performSetUserAccount(
    database,
    { kind: 'staff', staffId: freshness.staffId, authVersion: freshness.authVersion },
    command,
  );
  if (!result.ok && result.status === 'unauthorized') {
    throw new HttpsError('permission-denied', result.message ?? 'ไม่มีสิทธิ์ดำเนินการ');
  }
  return result;
}

export const setUserAccount = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    return performSetUserAccountCallable(db, request.data, request.auth ?? null);
  },
);
