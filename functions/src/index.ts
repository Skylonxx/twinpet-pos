import { getAuth } from 'firebase-admin/auth';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { db } from './db';
import { FUNCTIONS_REGION } from './deployConfig';

setGlobalOptions({ region: FUNCTIONS_REGION });

// Offline-first async checkout reconciler (Firestore onWrite trigger) — targets
// the database/region configured in firebase.json.
export { reconcileOrder } from './reconcileOrder';

// Admin-only manual repair: re-arm a failed (`exception`) reconciliation. Safety
// net only — see docs/reports/phase-2-track-b-proposal.md. (Exported after
// setGlobalOptions so the callable inherits the configured region.)
export { retryReconcile } from './retryReconcile';

// Phase 7B-2: ORIGIN-controlled, server-authoritative resolution of branch-transfer
// discrepancies. The destination branch can only REPORT (metadata); this callable
// is the sole path that corrects inventory, gated to the origin branch by verified
// claims and run under Admin SDK so it never needs destination write access.
export { resolveTransferDiscrepancy } from './resolveTransferDiscrepancy';

type UserRole = 'admin' | 'manager' | 'staff';

// Fallback mirror of the client DEFAULT_ROLE_PERMS (src/lib/staffManagement/types.ts).
// Used only when settings/_rolePermissions is missing/unreadable so a login never
// strips a user down to zero granular permissions. Keep in sync if the permission
// vocabulary grows (functions cannot import from src/).
const DEFAULT_ROLE_PERMS: Record<UserRole, string[]> = {
  admin: [
    'pos_sale', 'pos_discount', 'pos_void', 'quotation', 'product_view',
    'product_edit', 'stock_receive', 'cost_view', 'report_sales', 'report_stock',
    'report_profit', 'employee_manage', 'settings',
  ],
  manager: [
    'pos_sale', 'pos_discount', 'pos_void', 'quotation', 'product_view',
    'product_edit', 'stock_receive', 'cost_view', 'report_sales', 'report_stock',
  ],
  staff: ['pos_sale', 'product_view'],
};

/**
 * Resolve the granular permission-key array for a role from the live
 * settings/_rolePermissions matrix doc (the source of truth the admin panel
 * edits). Falls back to DEFAULT_ROLE_PERMS when the doc is missing/unreadable or
 * the role row is empty, so login is never left without permissions.
 */
async function resolvePermissionKeys(role: UserRole): Promise<string[]> {
  try {
    const snap = await db.collection('settings').doc('_rolePermissions').get();
    const matrix = snap.data()?.rolePermissions as Record<string, string[]> | undefined;
    const keys = matrix?.[role];
    if (Array.isArray(keys) && keys.length > 0) return keys;
  } catch (err) {
    console.warn('[verifyPinLogin] _rolePermissions unreadable, using defaults', err);
  }
  return DEFAULT_ROLE_PERMS[role];
}

type UserDoc = {
  id?: string;
  firstName: string;
  lastName: string;
  username: string;
  pin: string;
  role: UserRole;
  branchIds: string[];
  permissions: {
    canVoidOrder: boolean;
    canEditPrice: boolean;
    canViewReport: boolean;
    canManageStock: boolean;
    canManageStaff: boolean;
  };
  isActive: boolean;
  lastLoginAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
};

type VerifyPinLoginRequest = {
  pin?: string;
  branchId?: string;
  username?: string;
  userId?: string;
};

type SanitizedUser = Omit<UserDoc, 'pin'> & { id: string };

function serializeUser(user: UserDoc, id: string): SanitizedUser {
  const { pin: _pin, ...rest } = user;
  const serialized = { ...rest, id: user.id ?? id } as Record<string, unknown>;

  for (const key of ['createdAt', 'updatedAt', 'lastLoginAt', 'deletedAt'] as const) {
    const value = serialized[key];
    if (value && typeof value === 'object' && 'toDate' in value) {
      serialized[key] = (value as Timestamp).toDate().toISOString();
    }
  }

  return serialized as SanitizedUser;
}

function assertActiveBranchUser(user: UserDoc, branchId: string): void {
  if (!user.isActive || user.deletedAt != null) {
    throw new HttpsError('permission-denied', 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  }
  // Global Admins (branchIds: ['ALL']) are allowed to log in at any physical branch.
  const hasAccess = user.branchIds?.includes('ALL') || user.branchIds?.includes(branchId);
  if (!hasAccess) {
    throw new HttpsError('permission-denied', 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
  }
}

async function pinMatches(storedHash: string | undefined, pin: string): Promise<boolean> {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(pin, storedHash);
  } catch {
    return false;
  }
}

/**
 * Merge docs from two parallel Firestore queries, deduplicating by document ID.
 * This is needed because Firestore's array-contains cannot OR two values in one
 * query, so we fetch branch-specific users and Global Admin ('ALL') users separately.
 */
function mergeDocs(
  a: FirebaseFirestore.QuerySnapshot,
  b: FirebaseFirestore.QuerySnapshot,
): FirebaseFirestore.QueryDocumentSnapshot[] {
  const seen = new Set<string>();
  const result: FirebaseFirestore.QueryDocumentSnapshot[] = [];
  for (const doc of [...a.docs, ...b.docs]) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    result.push(doc);
  }
  return result;
}

async function findUserByPinInBranch(
  pin: string,
  branchId: string,
  username?: string,
  userId?: string,
): Promise<{ user: UserDoc; id: string } | null> {
  // ── Fast path: direct lookup by UID ────────────────────────────────────────
  if (userId) {
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) return null;
    const user = snap.data() as UserDoc;
    if (!(await pinMatches(user.pin, pin))) return null;
    assertActiveBranchUser(user, branchId);   // handles 'ALL' bypass
    return { user, id: snap.id };
  }

  // ── Lookup by username ──────────────────────────────────────────────────────
  // Run two queries in parallel: users assigned to the requested branch, and
  // Global Admins (branchIds array contains 'ALL'). Deduplicate by doc ID.
  if (username) {
    const normalized = username.trim().toLowerCase();
    const [branchSnap, globalSnap] = await Promise.all([
      db.collection('users')
        .where('username', '==', normalized)
        .where('branchIds', 'array-contains', branchId)
        .where('isActive', '==', true)
        .limit(5)
        .get(),
      db.collection('users')
        .where('username', '==', normalized)
        .where('branchIds', 'array-contains', 'ALL')
        .where('isActive', '==', true)
        .limit(5)
        .get(),
    ]);

    for (const docSnap of mergeDocs(branchSnap, globalSnap)) {
      const user = docSnap.data() as UserDoc;
      if (user.deletedAt != null) continue;
      if (await pinMatches(user.pin, pin)) {
        return { user, id: docSnap.id };
      }
    }
    return null;
  }

  // ── General PIN scan ────────────────────────────────────────────────────────
  // Same two-query strategy: branch-specific users + Global Admins.
  const [branchSnap, globalSnap] = await Promise.all([
    db.collection('users')
      .where('branchIds', 'array-contains', branchId)
      .where('isActive', '==', true)
      .get(),
    db.collection('users')
      .where('branchIds', 'array-contains', 'ALL')
      .where('isActive', '==', true)
      .get(),
  ]);

  for (const docSnap of mergeDocs(branchSnap, globalSnap)) {
    const user = docSnap.data() as UserDoc;
    if (user.deletedAt != null || !user.pin) continue;
    if (await pinMatches(user.pin, pin)) {
      return { user, id: docSnap.id };
    }
  }

  return null;
}

export const verifyPinLogin = onCall(
  {
    invoker: 'public',
    cors: [/^https?:\/\/localhost:\d+$/, /^https:\/\/.*\.firebaseapp\.com$/, /^https:\/\/.*\.web\.app$/],
  },
  async (request) => {
    try {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'ต้องเข้าสู่ระบบ Firebase ก่อนยืนยัน PIN');
      }

      const data = (request.data ?? {}) as VerifyPinLoginRequest;
      const pin = String(data.pin ?? '').trim();
      const branchId = String(data.branchId ?? '').trim();
      const username = data.username ? String(data.username).trim().toLowerCase() : undefined;
      const userId = data.userId ? String(data.userId).trim() : undefined;

      if (!/^\d{4}$/.test(pin)) {
        throw new HttpsError('invalid-argument', 'PIN ต้องเป็นตัวเลข 4 หลัก');
      }
      if (!branchId) {
        throw new HttpsError('invalid-argument', 'กรุณาระบุสาขา');
      }

      const match = await findUserByPinInBranch(pin, branchId, username, userId);
      if (!match) {
        throw new HttpsError('permission-denied', 'PIN ไม่ถูกต้องหรือไม่มีสิทธิ์สาขานี้');
      }

      const staffId = match.id;
      const user = match.user;

      const permissions = await resolvePermissionKeys(user.role);

      await getAuth().setCustomUserClaims(request.auth.uid, {
        staffId,
        role: user.role,
        branchIds: user.branchIds,
        permissions,
      });

      await db.collection('users').doc(staffId).update({
        lastLoginAt: FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        user: serializeUser(user, staffId),
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error('[verifyPinLogin] unhandled error', err);
      throw new HttpsError('internal', 'ระบบ PIN ขัดข้อง กรุณาลองใหม่');
    }
  },
);

// NOTE: the TEMPORARY one-shot `migrateDataToPosDb` ((default) → pos-db copier,
// `invoker: 'public'`) was REMOVED in Phase 3 Gate 1 — a public DB-copy endpoint
// must never ship to production. The (default) → pos-db migration is complete.
// Production function exports are limited to: verifyPinLogin, reconcileOrder,
// retryReconcile (see the deploy allowlist/checklist in functions/package.json
// + docs/reports/latest-report.md). Do NOT add dev/mock/test/migration
// functions to this entrypoint.
