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
  ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE,
  ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE_MESSAGE,
  ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
  ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE_MESSAGE,
  classifyAccountTarget,
  defaultAdminAuthLookup,
  PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED,
  PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE,
  PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE,
  PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED,
  PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED_MESSAGE,
  type AdminAuthLookup,
} from './adminTargetClassification';
import { COLLECTIONS } from './credentialStore';
import {
  performSetUserAccount,
  type AccountTargetGuard,
  type SetUserAccountOp,
  type SetUserAccountResult,
} from './setUserAccountCore';
import { DESKTOP_CALLABLE_CORS } from './callableCors';

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

function adminClassificationUnavailable(): HttpsError {
  return new HttpsError('failed-precondition', ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE_MESSAGE, {
    code: ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE,
  });
}

function accountClassificationUnavailable(): HttpsError {
  return new HttpsError('failed-precondition', ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE_MESSAGE, {
    code: ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE,
  });
}

/**
 * D-ASC8 / D-ASC11 / D-ASC12: until Owner Recovery can restamp claims, a
 * staff caller may mutate an existing account only when Firebase Auth
 * conclusively reports NO Auth user for that uid (Quick-PIN-only). Every
 * existing-target op (`rotate`, `updateProfile`, `setActive`, `softDelete`,
 * `rename`) bumps the target's `authVersion`, which would strand a password
 * principal's static claims whatever its role. So for every such op this
 * reads the live target and classifies its exact uid:
 *   - PASSWORD_PRINCIPAL → definite Owner Recovery refusal
 *     (`PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED` when the target is, or would
 *     become, an admin; `PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED`
 *     otherwise);
 *   - UNKNOWN → fail closed (`ADMIN_TARGET_CLASSIFICATION_UNAVAILABLE` /
 *     `ACCOUNT_AUTH_CLASSIFICATION_UNAVAILABLE`).
 * Both refuse before `performSetUserAccount`, so nothing is written. Only
 * QUICK_PIN_ONLY returns a guard clearing that exact uid, which the core
 * re-checks inside its transaction for every existing-target handler.
 *
 * `create` is not classified: its userId is a fresh 40-hex SHA-256 derived
 * from the idempotency key (`createUserIdFromKey`) and the core refuses an
 * existing users doc, so a create never targets an existing Auth principal.
 */
async function accountTargetGuardFor(
  database: typeof db,
  actorStaffId: string,
  command: SetUserAccountOp,
  lookup: AdminAuthLookup,
): Promise<AccountTargetGuard> {
  if (command.op === 'create') return { clearedQuickPinOnlyTargetId: null };
  const userId = String((command as { userId?: unknown }).userId ?? '').trim();
  if (!userId) return { clearedQuickPinOnlyTargetId: null };
  let exists: boolean;
  let role: unknown;
  try {
    const snap = await database.collection(COLLECTIONS.users).doc(userId).get();
    exists = snap.exists;
    role = exists ? (snap.data() ?? {}).role : undefined;
  } catch {
    throw accountClassificationUnavailable();
  }
  // A missing target is left to the core (`not_found`); should it appear
  // before the transaction, the core's guard refuses it as uncleared.
  if (!exists) return { clearedQuickPinOnlyTargetId: null };
  // Never answer a classification to a non-admin caller (no oracle); the
  // core re-checks the actor inside its transaction regardless.
  const actorSnap = await database.collection(COLLECTIONS.users).doc(actorStaffId).get();
  if (!actorSnap.exists || (actorSnap.data() ?? {}).role !== 'admin') {
    throw new HttpsError('permission-denied', 'เฉพาะผู้ดูแลระบบ');
  }
  const promotesToAdmin = command.op === 'updateProfile' && command.role === 'admin' && role !== 'admin';
  const adminTarget = role === 'admin' || promotesToAdmin;
  const classification = await classifyAccountTarget(userId, lookup);
  if (classification === 'PASSWORD_PRINCIPAL') {
    if (!adminTarget) {
      throw new HttpsError('failed-precondition', PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED_MESSAGE, {
        code: PASSWORD_PRINCIPAL_OWNER_RECOVERY_REQUIRED,
      });
    }
    throw new HttpsError(
      'failed-precondition',
      promotesToAdmin ? PASSWORD_PRINCIPAL_ADMIN_PROMOTION_MESSAGE : PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED_MESSAGE,
      { code: PASSWORD_ADMIN_OWNER_RECOVERY_REQUIRED },
    );
  }
  if (classification !== 'QUICK_PIN_ONLY') {
    throw adminTarget ? adminClassificationUnavailable() : accountClassificationUnavailable();
  }
  return { clearedQuickPinOnlyTargetId: userId };
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
  const targetGuard = await accountTargetGuardFor(database, freshness.staffId, command, lookupAuth);
  const result = await performSetUserAccount(
    database,
    { kind: 'staff', staffId: freshness.staffId, authVersion: freshness.authVersion, targetGuard },
    command,
  );
  // The core refused an uncleared existing target (e.g. it appeared after the
  // pre-read): fail closed with the matching classification code.
  if (!result.ok && result.status === 'protected_admin_target') throw adminClassificationUnavailable();
  if (!result.ok && result.status === 'protected_account_target') throw accountClassificationUnavailable();
  if (!result.ok && result.status === 'unauthorized') {
    throw new HttpsError('permission-denied', result.message ?? 'ไม่มีสิทธิ์ดำเนินการ');
  }
  return result;
}

export const setUserAccount = onCall(
  {
    region: FUNCTIONS_REGION,
    cors: DESKTOP_CALLABLE_CORS,
  },
  async (request) => {
    return performSetUserAccountCallable(db, request.data, request.auth ?? null);
  },
);
