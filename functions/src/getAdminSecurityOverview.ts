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
 *     `userCredentials` — never the PIN, hash, cost, salt or version — a
 *     coarse `accountAuthClassification` for EVERY user (QUICK_PIN_ONLY /
 *     PASSWORD_PRINCIPAL / UNKNOWN, D-ASC13) and, for `role=admin` only, the
 *     same answer as `securityAdminClassification` (PASSWORD_ADMIN /
 *     POS_ADMIN / UNKNOWN, see adminTargetClassification) — never an email,
 *     provider payload, token or claim;
 *   - the most recent `securityAuditEvents` (server-authored only).
 * Performs no writes.
 */
import { onCall } from 'firebase-functions/v2/https';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';
import { evaluateFreshPrivilegedAuthority, type AuthLike } from './authorityFence';
import { isPrimaryPasswordPrincipal } from './adminPasswordPrincipal';
import {
  classifyAccountTargets,
  defaultAdminAuthLookup,
  toSecurityAdminClassification,
  type AccountAuthClassification,
  type AdminAuthLookup,
  type SecurityAdminClassification,
} from './adminTargetClassification';
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
  /** Every role. Only QUICK_PIN_ONLY is mutable; anything else renders read-only. */
  accountAuthClassification: AccountAuthClassification;
  /** `null` for non-admin roles. UNKNOWN must be rendered fail-closed (read-only). */
  securityAdminClassification: SecurityAdminClassification | null;
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

function projectUser(
  id: string,
  data: DocumentData,
  quickPinState: 'set' | 'required',
  accountClasses: Map<string, AccountAuthClassification>,
): AdminSecurityOverviewUser | null {
  if (data.deletedAt != null) return null;
  if (!ROLES.has(data.role)) return null;
  const accountAuthClassification = accountClasses.get(id) ?? 'UNKNOWN';
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
    accountAuthClassification,
    securityAdminClassification: data.role === 'admin' ? toSecurityAdminClassification(accountAuthClassification) : null,
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
  lookupAuth: AdminAuthLookup = defaultAdminAuthLookup,
): Promise<AdminSecurityOverviewResponse> {
  if (!isPrimaryPasswordPrincipal(auth)) return { ok: false, code: 'admin_password_session_required' };
  const freshness = await evaluateFreshPrivilegedAuthority(database, auth);
  if (!freshness.ok) return { ok: false, code: 'not_authorized' };
  const actorSnap = await database.collection(COLLECTIONS.users).doc(freshness.staffId).get();
  if (!actorSnap.exists || (actorSnap.data() ?? {}).role !== 'admin') return { ok: false, code: 'not_authorized' };

  const usersSnap = await database.collection(COLLECTIONS.users).get();
  const liveDocs = usersSnap.docs.filter((doc) => ((doc.data() ?? {}) as DocumentData).deletedAt == null);
  // D-ASC13: every live uid is classified in Firebase Auth (batched ≤100 per
  // call), so password-backed staff / managers render read-only too.
  const accountClasses = await classifyAccountTargets(
    liveDocs.map((doc) => doc.id),
    lookupAuth,
  );
  const projectedUsers = await Promise.all(
    liveDocs.map(async (doc) => {
      const cred = await readUserCredential(database, doc.id);
      const quickPinState = isUsableForLogin(cred) && isAuthoritativeRotated(cred) ? 'set' : 'required';
      return projectUser(doc.id, (doc.data() ?? {}) as DocumentData, quickPinState, accountClasses);
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
