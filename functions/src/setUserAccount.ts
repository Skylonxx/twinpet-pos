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
  ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
  ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE_MESSAGE,
  classifyAdminTarget,
  defaultAdminAuthLookup,
  PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED,
  PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE,
  PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE,
  type AdminAuthLookup,
} from './adminTargetClassification';
import { COLLECTIONS } from './credentialStore';
import {
  performSetUserAccount,
  type AdminTargetGuard,
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

function classificationUnavailable(): HttpsError {
  return new HttpsError('failed-precondition', ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE_MESSAGE, {
    code: ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
  });
}

/**
 * D-ASC8 / D-ASC11: a staff caller never mutates a password-backed admin,
 * and never turns a password-backed (or unclassifiable) account INTO an
 * admin — either way the account's static claims would be stranded by the
 * authVersion bump. Reads the live target and classifies it via Firebase
 * Auth when its live role is `admin` OR the command would result in
 * `role=admin`. PASSWORD_ADMIN → definite refusal; UNKNOWN → fail closed.
 * Both refuse before `performSetUserAccount`, so nothing is written. The
 * returned guard makes the core re-check, inside its transaction, both the
 * live role and the role it is about to assign.
 *
 * `create` is not classified: its userId is a fresh 40-hex SHA-256 derived
 * from the idempotency key (`createUserIdFromKey`) and the core refuses an
 * existing users doc, so a create never targets an existing Auth principal.
 */
async function adminTargetGuardFor(
  database: typeof db,
  actorStaffId: string,
  command: SetUserAccountOp,
  lookup: AdminAuthLookup,
): Promise<AdminTargetGuard> {
  if (command.op === 'create') return { clearedPosAdminTargetId: null };
  const userId = String((command as { userId?: unknown }).userId ?? '').trim();
  if (!userId) return { clearedPosAdminTargetId: null };
  let exists = false;
  let role: unknown;
  try {
    const snap = await database.collection(COLLECTIONS.users).doc(userId).get();
    exists = snap.exists;
    role = exists ? (snap.data() ?? {}).role : undefined;
  } catch {
    throw classificationUnavailable();
  }
  const promotesToAdmin = command.op === 'updateProfile' && command.role === 'admin' && role !== 'admin';
  // A missing target is left to the core (`not_found`); should it appear
  // before the transaction, the core's guard refuses it as uncleared.
  if (!exists || (role !== 'admin' && !promotesToAdmin)) return { clearedPosAdminTargetId: null };
  // Never answer a classification to a non-admin caller (no oracle); the
  // core re-checks the actor inside its transaction regardless.
  const actorSnap = await database.collection(COLLECTIONS.users).doc(actorStaffId).get();
  if (!actorSnap.exists || (actorSnap.data() ?? {}).role !== 'admin') {
    throw new HttpsError('permission-denied', 'เฉพาะผู้ดูแลระบบ');
  }
  const classification = await classifyAdminTarget(userId, lookup);
  if (classification === 'PASSWORD_ADMIN') {
    throw new HttpsError(
      'failed-precondition',
      promotesToAdmin ? PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE : PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE,
      { code: PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED },
    );
  }
  if (classification !== 'POS_ADMIN') throw classificationUnavailable();
  return { clearedPosAdminTargetId: userId };
}

export async function performSetUserAccountCallable(
  database: typeof db,
  raw: unknown,
  auth: { uid?: string; token?: Record<string, unknown> } | null,
  lookupAuth: AdminAuthLookup = defaultAdminAuthLookup,
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
  const adminTargetGuard = await adminTargetGuardFor(database, freshness.staffId, command, lookupAuth);
  const result = await performSetUserAccount(
    database,
    { kind: 'staff', staffId: freshness.staffId, authVersion: freshness.authVersion, adminTargetGuard },
    command,
  );
  // The live target became an admin after classification, or an admin role
  // would be assigned to an uncleared target: fail closed.
  if (!result.ok && result.status === 'protected_admin_target') throw classificationUnavailable();
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
