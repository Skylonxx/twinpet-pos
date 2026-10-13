/**
 * Admin & Security Center V1 — read-only safe overview for the in-POS admin
 * surface (`Settings → Admin & ความปลอดภัย`).
 *
 * Caller: the primary username+password admin principal only
 * (`isPrimaryPasswordPrincipal`) with fresh authority and a live active admin
 * `users/{staffId}`. A Quick PIN session never qualifies.
 *
 * Returns ONLY display-safe projections:
 *   - users (not soft-deleted): names, username, role, branch access, active
 *     flag, live authVersion (to detect a stale local OAC binding), and a
 *     coarse Quick PIN state `set` | `required` derived server-side from
 *     `userCredentials` — never the PIN, hash, cost, salt or version;
 *   - the most recent `securityAuditEvents` (server-authored only).
 * Performs no writes.
 */
import { onCall } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { isPrimaryPasswordPrincipal } from './adminPasswordPrincipal';
import { COLLECTIONS, isAuthoritativeRotated, isUsableForLogin, readUserCredential } from './credentialStore';
import { SECURITY_AUDIT_EVENTS_COLLECTION, SECURITY_AUDIT_EVENT_TYPES, type SecurityAuditEventType } from './securityAudit';

export const ADMIN_SECURITY_OVERVIEW_EVENT_LIMIT = 50;

export type AdminSecurityOverviewUser = {
  userId: string;
  firstName: string;
  lastName: string;
  username: string;
  role: 'admin' | 'manager' | 'staff';
  branchIds: string[];
  isActive: boolean;
  authVersion: number;
  quickPinState: 'set' | 'required';
};

export type AdminSecurityOverviewEvent = {
  type: SecurityAuditEventType;
  actorStaffId: string;
  targetStaffId: string;
  changedFields: string[];
  roleBefore: string | null;
  roleAfter: string | null;
  branchIdsBefore: string[] | null;
  branchIdsAfter: string[] | null;
  deviceBranchId: string | null;
  createdAtMs: number | null;
};

export type AdminSecurityOverviewResponse =
  | { ok: true; users: AdminSecurityOverviewUser[]; events: AdminSecurityOverviewEvent[] }
  | { ok: false; code: 'admin_password_session_required' | 'not_authorized' };

const ROLES = new Set(['admin', 'manager', 'staff']);
const EVENT_TYPES = new Set<string>(SECURITY_AUDIT_EVENT_TYPES);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strArrayOrNull(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...(v as string[])] : null;
}

function timestampMs(v: unknown): number | null {
  if (v && typeof v === 'object' && typeof (v as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (v as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function projectUser(id: string, data: DocumentData, quickPinState: 'set' | 'required'): AdminSecurityOverviewUser | null {
  if (data.deletedAt != null) return null;
  if (!ROLES.has(data.role)) return null;
  return {
    userId: id,
    firstName: str(data.firstName),
    lastName: str(data.lastName),
    username: str(data.username),
    role: data.role,
    branchIds: strArrayOrNull(data.branchIds) ?? [],
    isActive: data.isActive === true,
    authVersion: typeof data.authVersion === 'number' && Number.isFinite(data.authVersion) ? data.authVersion : 0,
    quickPinState,
  };
}

function projectEvent(data: DocumentData): AdminSecurityOverviewEvent | null {
  if (!EVENT_TYPES.has(data.type)) return null;
  return {
    type: data.type as SecurityAuditEventType,
    actorStaffId: str(data.actorStaffId),
    targetStaffId: str(data.targetStaffId),
    changedFields: strArrayOrNull(data.changedFields) ?? [],
    roleBefore: typeof data.roleBefore === 'string' ? data.roleBefore : null,
    roleAfter: typeof data.roleAfter === 'string' ? data.roleAfter : null,
    branchIdsBefore: strArrayOrNull(data.branchIdsBefore),
    branchIdsAfter: strArrayOrNull(data.branchIdsAfter),
    deviceBranchId: typeof data.deviceBranchId === 'string' ? data.deviceBranchId : null,
    createdAtMs: timestampMs(data.createdAt),
  };
}

export async function performGetAdminSecurityOverview(
  database: Firestore,
  auth: AuthLike,
): Promise<AdminSecurityOverviewResponse> {
  if (!isPrimaryPasswordPrincipal(auth)) return { ok: false, code: 'admin_password_session_required' };
  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return { ok: false, code: 'not_authorized' };
  const actorSnap = await database.collection(COLLECTIONS.users).doc(freshness.staffId).get();
  if (!actorSnap.exists || (actorSnap.data() ?? {}).role !== 'admin') return { ok: false, code: 'not_authorized' };

  const usersSnap = await database.collection(COLLECTIONS.users).get();
  const liveDocs = usersSnap.docs.filter((doc) => ((doc.data() ?? {}) as DocumentData).deletedAt == null);
  const projectedUsers = await Promise.all(
    liveDocs.map(async (doc) => {
      const cred = await readUserCredential(database, doc.id);
      const quickPinState = isUsableForLogin(cred) && isAuthoritativeRotated(cred) ? 'set' : 'required';
      return projectUser(doc.id, (doc.data() ?? {}) as DocumentData, quickPinState);
    }),
  );
  const users = projectedUsers.filter((u): u is AdminSecurityOverviewUser => u !== null);

  const eventsSnap = await database
    .collection(SECURITY_AUDIT_EVENTS_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(ADMIN_SECURITY_OVERVIEW_EVENT_LIMIT)
    .get();
  const events: AdminSecurityOverviewEvent[] = [];
  for (const doc of eventsSnap.docs) {
    const projected = projectEvent((doc.data() ?? {}) as DocumentData);
    if (projected) events.push(projected);
  }

  return { ok: true, users, events };
}

export const getAdminSecurityOverview = onCall({ region: FUNCTIONS_REGION }, async (request) => {
  return performGetAdminSecurityOverview(db, request.auth as AuthLike);
});
