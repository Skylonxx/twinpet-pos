/**
 * Shared privileged-authority freshness fence.
 * Live users/{staffId} read + asymmetric authVersion compare (doc default 0, token default -1).
 * Disabled / deleted fail closed independently of the version math.
 */
import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from './credentialStore';

export type AuthLike = { uid?: string; token?: Record<string, unknown> } | null | undefined;

export type FreshnessReason =
  | 'unauthenticated'
  | 'missing_staff'
  | 'missing_user'
  | 'disabled'
  | 'deleted'
  | 'stale';

export type FreshnessResult =
  | { ok: true; staffId: string; authVersion: number }
  | { ok: false; reason: FreshnessReason };

export function tokenStaffId(auth: AuthLike): string | null {
  const staffId = auth?.token?.staffId;
  if (typeof staffId === 'string' && staffId.trim()) return staffId.trim();
  return null;
}

export function tokenAuthVersion(auth: AuthLike): number {
  const raw = auth?.token?.authVersion;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : -1;
}

export async function evaluateFreshPrivilegedAuthority(
  database: Firestore,
  auth: AuthLike,
): Promise<FreshnessResult> {
  if (!auth) return { ok: false, reason: 'unauthenticated' };
  const staffId = tokenStaffId(auth);
  if (!staffId) return { ok: false, reason: 'missing_staff' };

  const snap = await database.collection(COLLECTIONS.users).doc(staffId).get();
  if (!snap.exists) return { ok: false, reason: 'missing_user' };
  const user = (snap.data() ?? {}) as DocumentData;
  if (user.isActive !== true) return { ok: false, reason: 'disabled' };
  if (user.deletedAt != null) return { ok: false, reason: 'deleted' };

  const liveVersion = typeof user.authVersion === 'number' && Number.isFinite(user.authVersion)
    ? user.authVersion
    : 0;
  const claimed = tokenAuthVersion(auth);
  if (liveVersion !== claimed) return { ok: false, reason: 'stale' };
  return { ok: true, staffId, authVersion: liveVersion };
}

export async function assertFreshPrivilegedAuthority(
  database: Firestore,
  auth: AuthLike,
): Promise<{ staffId: string; authVersion: number }> {
  const result = await evaluateFreshPrivilegedAuthority(database, auth);
  if (result.ok) return { staffId: result.staffId, authVersion: result.authVersion };
  if (result.reason === 'unauthenticated' || result.reason === 'missing_staff') {
    throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบก่อน');
  }
  throw new HttpsError('permission-denied', 'ไม่มีสิทธิ์ดำเนินการ');
}
