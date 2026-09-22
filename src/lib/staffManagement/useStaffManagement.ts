import bcrypt from 'bcryptjs';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { FirebaseError } from 'firebase/app';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { useCallback, useEffect, useRef, useState } from 'react';
import { setUserAccount } from '../auth/setUserAccount';
import {
  isSetRolePermissionsFailureCode,
  SET_ROLE_PERMISSIONS_ERROR_LABELS,
} from '../auth/managerApprovalTypes';
import { app, collections, db, getEmulatorHost, isFirebaseConfigured, USE_EMULATOR } from '../firebase';
import type { StaffActivity, User, UserRole } from '../types';
import { diffUserFields, writeStaffActivity, writeUserAuditLog } from './audit';
import {
  devAddActivity,
  devGenerateUserId,
  devSaveStaffUser,
  devSoftDeleteUser,
  devToggleUserActive,
  getDevRoleMatrix,
  getDevStaffActivities,
  getDevAllStaffActivities,
  getDevStaffUsers,
  initDevStaffStore,
  setDevRoleMatrix,
} from './devMock';
import {
  cloneDefaultMatrix,
  permissionsForRole,
  ROLE_PERMISSIONS_DOC_ID,
  type RolePermissionMatrix,
  type StaffFormData,
} from './types';

type RolePermDoc = {
  rolePermissions?: RolePermissionMatrix;
};

type SetRolePermissionsResult =
  | { ok: true; requiresStaging: false }
  | { ok: true; requiresStaging: true; changeId: string }
  | { ok: false; code: string };

let rolePermissionsEmulatorConnected = false;

/**
 * Shared success shape for both role-matrix mutations. `requiresStaging: true`
 * means the server accepted the write but only persisted an *interim* row —
 * the removal converges later via the staged-deny sweep — so the UI must not
 * render the requested target as already converged.
 */
export type RoleMatrixMutationOutcome = {
  requiresStaging: boolean;
};

const NO_STAGING: RoleMatrixMutationOutcome = { requiresStaging: false };

/**
 * A resolved `RoleMatrixMutationOutcome` means the server accepted a permission
 * mutation. Every local guard / concurrency refusal therefore throws instead of
 * resolving, so a page can never turn a no-op into success feedback.
 */
const ROLE_PERMISSION_BUSY_MESSAGE =
  'กำลังบันทึกสิทธิ์อยู่ กรุณารอให้เสร็จก่อนแล้วลองใหม่';
const ROLE_PERMISSION_ADMIN_LOCKED_MESSAGE = 'ไม่สามารถแก้ไขสิทธิ์ของ Admin ได้';

/**
 * Mirrors the server's `interimMatrixRow` (`functions/src/setRolePermissionsCore.ts`)
 * without importing across the functions/src boundary: the server persists
 * `currentRow ∪ addedPermissions`, so removals stay present until convergence.
 * For a pure removal this returns the prior row unchanged.
 */
function computeInterimRow(priorRow: readonly string[], requestedRow: readonly string[]): string[] {
  const prior = new Set(priorRow);
  const additions = requestedRow.filter((key) => !prior.has(key));
  return [...new Set([...priorRow, ...additions])];
}

/**
 * SEC-001 Packet C-A / F7 — routes a role-permission change through the
 * `setRolePermissions` Cloud Function instead of a direct client Firestore
 * write, so a removal gets the staged-deny fail-closed protection instead of
 * taking effect for live sessions only once they refresh their claims.
 */
async function callSetRolePermissions(
  role: UserRole,
  permissions: string[],
): Promise<RoleMatrixMutationOutcome> {
  if (!app) throw new Error('Firebase is not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR && !rolePermissionsEmulatorConnected) {
    connectFunctionsEmulator(functions, getEmulatorHost(), 5001);
    rolePermissionsEmulatorConnected = true;
  }
  const callable = httpsCallable<{ roleId: UserRole; permissions: string[] }, SetRolePermissionsResult>(
    functions,
    'setRolePermissions',
  );
  try {
    const result = await callable({ roleId: role, permissions });
    const payload = result.data;
    if (!payload.ok) {
      const message = isSetRolePermissionsFailureCode(payload.code)
        ? SET_ROLE_PERMISSIONS_ERROR_LABELS[payload.code]
        : 'ไม่สามารถบันทึกสิทธิ์การใช้งานได้';
      throw new Error(message);
    }
    return { requiresStaging: payload.requiresStaging === true };
  } catch (err) {
    if (err instanceof FirebaseError) {
      throw new Error(err.message || 'ไม่สามารถบันทึกสิทธิ์การใช้งานได้');
    }
    throw err;
  }
}

export type UseStaffManagementOptions = {
  /** HQ admin panel — list all staff across branches */
  hq?: boolean;
};

function resolveActivityBranchId(
  hq: boolean,
  branchId: string | null,
  branchIds: string[],
): string {
  if (hq) {
    const id = branchIds[0];
    if (!id) throw new Error('กรุณาเลือกสาขา');
    return id;
  }
  if (!branchId) throw new Error('ไม่พบสาขา');
  return branchId;
}

export function useStaffManagement(
  branchId: string | null,
  actor: { id: string; name: string } | null,
  options?: UseStaffManagementOptions,
) {
  const hq = options?.hq === true;
  const [users, setUsers] = useState<User[]>([]);
  const [activities, setActivities] = useState<StaffActivity[]>([]);
  const [roleMatrix, setRoleMatrix] = useState<RolePermissionMatrix>(cloneDefaultMatrix());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  /**
   * Authoritative mirror of `roleMatrix`, kept eagerly in sync so a mutation
   * started in the same tick as another reads current rows instead of a stale
   * render closure (the lost-update hazard behind the original toggle defect).
   */
  const roleMatrixRef = useRef<RolePermissionMatrix>(roleMatrix);
  /** Per-role in-flight lock. The ref is the synchronous source of truth; the
   * state copy exists so both pages can disable the affected role's toggles. */
  const pendingRolesRef = useRef<ReadonlySet<UserRole>>(new Set<UserRole>());
  const [pendingRoles, setPendingRoles] = useState<ReadonlySet<UserRole>>(() => new Set<UserRole>());
  /**
   * Reset-exclusive lock. Reset and role toggles are mutually exclusive at the
   * hook boundary, not merely via disabled controls: a synchronous ref is the
   * source of truth so a same-tick caller cannot slip past the check.
   */
  const resetPendingRef = useRef(false);

  const commitWholeMatrix = useCallback((next: RolePermissionMatrix) => {
    roleMatrixRef.current = next;
    setRoleMatrix(next);
  }, []);

  /** Row-scoped commit — never replaces a whole-matrix snapshot, so a rollback
   * on one role can never undo a concurrent success on another. */
  const commitRoleRow = useCallback((role: UserRole, row: string[]) => {
    roleMatrixRef.current = { ...roleMatrixRef.current, [role]: row };
    setRoleMatrix((prev) => ({ ...prev, [role]: row }));
  }, []);

  const markRolePending = useCallback((role: UserRole) => {
    const next = new Set(pendingRolesRef.current);
    next.add(role);
    pendingRolesRef.current = next;
    setPendingRoles(next);
  }, []);

  const clearRolePending = useCallback((role: UserRole) => {
    const next = new Set(pendingRolesRef.current);
    next.delete(role);
    pendingRolesRef.current = next;
    setPendingRoles(next);
  }, []);

  useEffect(() => {
    if (!hq && !branchId) {
      setUsers([]);
      setActivities([]);
      setLoading(false);
      return;
    }

    if (!isFirebaseConfigured || !db) {
      void initDevStaffStore().then(() => {
        if (hq) {
          setUsers(getDevStaffUsers().filter((u) => !u.deletedAt));
          setActivities(getDevAllStaffActivities());
        } else {
          setUsers(getDevStaffUsers().filter((u) => u.branchIds.includes(branchId!) && !u.deletedAt));
          setActivities(getDevStaffActivities(branchId!));
        }
        commitWholeMatrix(getDevRoleMatrix());
        setLoading(false);
      });
      return;
    }

    setLoading(true);
    setError(null);

    const usersQ = hq
      ? query(collection(db, collections.users))
      : query(collection(db, collections.users), where('branchIds', 'array-contains', branchId!));

    const actQ = hq
      ? query(collection(db, collections.staffActivities), orderBy('createdAt', 'desc'))
      : query(
          collection(db, collections.staffActivities),
          where('branchId', '==', branchId!),
          orderBy('createdAt', 'desc'),
        );

    const actFallbackQ = hq
      ? query(collection(db, collections.staffActivities))
      : query(collection(db, collections.staffActivities), where('branchId', '==', branchId!));

    let cancelled = false;
    let unsubActFallback: (() => void) | null = null;

    const unsubUsers = onSnapshot(
      usersQ,
      (snap) => {
        if (cancelled) return;
        const list = snap.docs
          .map((d) => ({ ...(d.data() as User), id: d.id }))
          .filter((u) => !u.deletedAt);
        setUsers(list);
        setLoading(false);
      },
      (err) => {
        if (!cancelled) {
          setError(err);
          setLoading(false);
        }
      },
    );

    const mapActivities = (snap: { docs: { id: string; data: () => unknown }[] }) =>
      snap.docs.map((d) => ({ ...(d.data() as StaffActivity), id: d.id }));

    const sortActivitiesDesc = (list: StaffActivity[]) =>
      [...list].sort((a, b) => {
        const ta =
          a.createdAt && typeof a.createdAt === 'object' && 'toDate' in a.createdAt
            ? (a.createdAt as Timestamp).toDate().getTime()
            : 0;
        const tb =
          b.createdAt && typeof b.createdAt === 'object' && 'toDate' in b.createdAt
            ? (b.createdAt as Timestamp).toDate().getTime()
            : 0;
        return tb - ta;
      });

    const unsubAct = onSnapshot(
      actQ,
      (snap) => {
        if (cancelled) return;
        setActivities(mapActivities(snap));
      },
      (err) => {
        if (cancelled) return;
        console.warn('[useStaffManagement] staffActivities indexed query failed, using fallback:', err);
        unsubActFallback = onSnapshot(actFallbackQ, (snap) => {
          if (cancelled) return;
          setActivities(sortActivitiesDesc(mapActivities(snap)));
        });
      },
    );

    void getDoc(doc(db, collections.settings, ROLE_PERMISSIONS_DOC_ID)).then((snap) => {
      if (cancelled) return;
      const data = snap.data() as RolePermDoc | undefined;
      if (data?.rolePermissions) {
        commitWholeMatrix(data.rolePermissions);
      }
    });

    return () => {
      cancelled = true;
      unsubUsers();
      unsubAct();
      unsubActFallback?.();
    };
  }, [branchId, hq, commitWholeMatrix]);

  const refreshDev = useCallback(() => {
    if (isFirebaseConfigured) return;
    if (hq) {
      setUsers(getDevStaffUsers().filter((u) => !u.deletedAt));
      setActivities(getDevAllStaffActivities());
      commitWholeMatrix(getDevRoleMatrix());
      return;
    }
    if (!branchId) return;
    setUsers(getDevStaffUsers().filter((u) => u.branchIds.includes(branchId) && !u.deletedAt));
    setActivities(getDevStaffActivities(branchId));
    commitWholeMatrix(getDevRoleMatrix());
  }, [branchId, hq, commitWholeMatrix]);

  const saveUser = useCallback(
    async (form: StaffFormData, editId?: string): Promise<void> => {
      if (!actor) throw new Error('ไม่พบผู้ใช้งาน');
      if (!hq && !branchId) throw new Error('ไม่พบสาขา');
      if (hq && form.branchIds.length === 0) throw new Error('กรุณาเลือกสาขา');

      const activityBranchId = resolveActivityBranchId(hq, branchId, form.branchIds);

      const permissions = permissionsForRole(form.role, roleMatrix);
      const now = serverTimestamp() as Timestamp;

      if (!isFirebaseConfigured || !db) {
        await initDevStaffStore();
        const pinHash = form.pin ? await bcrypt.hash(form.pin, 10) : undefined;

        if (editId) {
          const existing = getDevStaffUsers().find((u) => u.id === editId);
          if (!existing) throw new Error('ไม่พบพนักงาน');

          const before = { role: existing.role, branchIds: existing.branchIds, isActive: existing.isActive };
          const updated: User = {
            ...existing,
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            username: form.username.trim().toLowerCase(),
            role: form.role,
            branchIds: form.branchIds,
            permissions,
            updatedAt: { toDate: () => new Date() } as Timestamp,
          };
          await devSaveStaffUser(updated, form.password || undefined, form.pin || undefined);

          if (before.role !== updated.role) {
            devAddActivity({
              branchId: activityBranchId,
              userId: actor.id,
              userName: actor.name,
              action: 'ROLE_CHANGE',
              detail: `เปลี่ยน Role ${existing.firstName} ${existing.lastName}: ${before.role} → ${updated.role}`,
              refId: updated.id,
              ip: null,
              deviceId: null,
            });
          }
        } else {
          if (!form.password) throw new Error('กรุณากรอก password สำหรับพนักงานใหม่');
          const id = devGenerateUserId();
          const user: User = {
            id,
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            username: form.username.trim().toLowerCase(),
            pin: pinHash ?? '',
            role: form.role,
            branchIds: form.branchIds,
            permissions,
            isActive: true,
            lastLoginAt: null,
            createdAt: { toDate: () => new Date() } as Timestamp,
            updatedAt: { toDate: () => new Date() } as Timestamp,
            deletedAt: null,
          };
          await devSaveStaffUser(user, form.password, form.pin);
          devAddActivity({
            branchId: activityBranchId,
            userId: actor.id,
            userName: actor.name,
            action: 'STAFF_CREATE',
            detail: `เพิ่มพนักงาน ${user.firstName} ${user.lastName} (${roleLabel(user.role)})`,
            refId: user.id,
            ip: null,
            deviceId: null,
          });
        }
        refreshDev();
        return;
      }

      if (editId) {
        const ref = doc(db, collections.users, editId);
        const snap = await getDoc(ref);
        if (!snap.exists()) throw new Error('ไม่พบพนักงาน');
        const existing = snap.data() as User;

        await setUserAccount({
          op: 'updateProfile',
          userId: editId,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          role: form.role,
          branchIds: form.branchIds,
          permissions,
        });

        const nextUsername = form.username.trim().toLowerCase();
        if (nextUsername && nextUsername !== String(existing.username ?? '').trim().toLowerCase()) {
          await setUserAccount({
            op: 'rename',
            userId: editId,
            newUsername: nextUsername,
          });
        }
        if (form.pin && /^\d{4}$/.test(form.pin)) {
          await setUserAccount({
            op: 'rotate',
            userId: editId,
            pin: form.pin,
            rotateIdempotencyKey: `staff-rotate:${editId}:${crypto.randomUUID()}`,
          });
        }

        const patch: Partial<User> = {
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          username: nextUsername,
          role: form.role,
          branchIds: form.branchIds,
          permissions,
          updatedAt: now,
        };

        const changed = diffUserFields(
          existing as unknown as Record<string, unknown>,
          { ...existing, ...patch } as unknown as Record<string, unknown>,
          ['role', 'permissions', 'branchIds'],
        );

        if (changed.changed.length > 0) {
          await writeUserAuditLog(
            { firestore: db, changedBy: actor.id, changedByName: actor.name },
            {
              docId: editId,
              action: 'update',
              before: changed.before,
              after: changed.after,
              changedFields: changed.changed,
            },
          );
        }

        if (existing.role !== form.role) {
          await writeStaffActivity(
            { firestore: db, changedBy: actor.id, changedByName: actor.name },
            {
              branchId: activityBranchId,
              userId: actor.id,
              userName: actor.name,
              action: 'ROLE_CHANGE',
              detail: `เปลี่ยน Role ${existing.firstName} ${existing.lastName}: ${existing.role} → ${form.role}`,
              refId: editId,
            },
          );
        }
      } else {
        if (!form.pin || !/^\d{4}$/.test(form.pin)) {
          throw new Error('กรุณากรอก PIN 4 หลักสำหรับพนักงานใหม่');
        }

        const normalizedUsername = form.username.trim().toLowerCase();
        const created = await setUserAccount({
          op: 'create',
          idempotencyKey: `staff-create:${normalizedUsername}:${crypto.randomUUID()}`,
          username: normalizedUsername,
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          role: form.role,
          branchIds: form.branchIds,
          permissions,
          isActive: true,
          pin: form.pin,
        });
        if (!created.userId) throw new Error('ไม่สามารถสร้างพนักงานได้');

        await writeStaffActivity(
          { firestore: db, changedBy: actor.id, changedByName: actor.name },
          {
            branchId: activityBranchId,
            userId: actor.id,
            userName: actor.name,
            action: 'STAFF_CREATE',
            detail: `เพิ่มพนักงาน ${form.firstName.trim()} ${form.lastName.trim()}`,
            refId: created.userId,
          },
        );
      }
    },
    [branchId, actor, roleMatrix, refreshDev, hq],
  );

  const toggleActive = useCallback(
    async (userId: string, isActive: boolean): Promise<void> => {
      if (!actor) return;
      if (!hq && !branchId) return;

      if (!isFirebaseConfigured || !db) {
        const user = devToggleUserActive(userId, isActive);
        if (user) {
          const logBranchId = hq ? (user.branchIds[0] ?? branchId) : branchId;
          if (!logBranchId) return;
          devAddActivity({
            branchId: logBranchId,
            userId: actor.id,
            userName: actor.name,
            action: 'STAFF_TOGGLE',
            detail: `${isActive ? 'เปิดใช้งาน' : 'ปิดใช้งาน'} ${user.firstName} ${user.lastName}`,
            refId: userId,
            ip: null,
            deviceId: null,
          });
        }
        refreshDev();
        return;
      }

      const ref = doc(db, collections.users, userId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return;
      const existing = snap.data() as User;
      const logBranchId = hq ? (existing.branchIds[0] ?? branchId) : branchId;
      if (!logBranchId) return;

      await setUserAccount({ op: 'setActive', userId, isActive });

      await writeUserAuditLog(
        { firestore: db, changedBy: actor.id, changedByName: actor.name },
        {
          docId: userId,
          action: 'update',
          before: { isActive: existing.isActive },
          after: { isActive },
          changedFields: ['isActive'],
        },
      );

      await writeStaffActivity(
        { firestore: db, changedBy: actor.id, changedByName: actor.name },
        {
          branchId: logBranchId,
          userId: actor.id,
          userName: actor.name,
          action: 'STAFF_TOGGLE',
          detail: `${isActive ? 'เปิดใช้งาน' : 'ปิดใช้งาน'} ${existing.firstName} ${existing.lastName}`,
          refId: userId,
        },
      );
    },
    [branchId, actor, refreshDev, hq],
  );

  const softDeleteUser = useCallback(
    async (userId: string): Promise<void> => {
      if (!actor) return;
      if (!hq && !branchId) return;

      if (!isFirebaseConfigured || !db) {
        const user = getDevStaffUsers().find((u) => u.id === userId);
        devSoftDeleteUser(userId);
        if (user) {
          const logBranchId = hq ? (user.branchIds[0] ?? branchId) : branchId;
          if (!logBranchId) return;
          devAddActivity({
            branchId: logBranchId,
            userId: actor.id,
            userName: actor.name,
            action: 'STAFF_DELETE',
            detail: `ลบพนักงาน ${user.firstName} ${user.lastName}`,
            refId: userId,
            ip: null,
            deviceId: null,
          });
        }
        refreshDev();
        return;
      }

      const ref = doc(db, collections.users, userId);
      const snap = await getDoc(ref);
      if (!snap.exists()) return;
      const existing = snap.data() as User;
      const logBranchId = hq ? (existing.branchIds[0] ?? branchId) : branchId;
      if (!logBranchId) return;

      await setUserAccount({ op: 'softDelete', userId });

      await writeUserAuditLog(
        { firestore: db, changedBy: actor.id, changedByName: actor.name },
        {
          docId: userId,
          action: 'delete',
          before: { deletedAt: null, isActive: existing.isActive },
          after: { deletedAt: 'now', isActive: false },
          changedFields: ['deletedAt', 'isActive'],
        },
      );

      await writeStaffActivity(
        { firestore: db, changedBy: actor.id, changedByName: actor.name },
        {
          branchId: logBranchId,
          userId: actor.id,
          userName: actor.name,
          action: 'STAFF_DELETE',
          detail: `ลบพนักงาน ${existing.firstName} ${existing.lastName}`,
          refId: userId,
        },
      );
    },
    [branchId, actor, refreshDev, hq],
  );

  const updateRoleMatrix = useCallback(
    async (role: UserRole, key: string, enabled: boolean): Promise<RoleMatrixMutationOutcome> => {
      if (!actor) throw new Error('ไม่พบผู้ใช้งาน');
      if (!hq && !branchId) throw new Error('ไม่พบสาขา');
      if (role === 'admin') throw new Error(ROLE_PERMISSION_ADMIN_LOCKED_MESSAGE);

      const logBranchId = branchId;
      if (!logBranchId) throw new Error('ไม่พบสาขา');

      // Reset owns the whole matrix while it runs, so a toggle must not start.
      if (resetPendingRef.current) throw new Error(ROLE_PERMISSION_BUSY_MESSAGE);

      // Same-role overlap is refused outright: no second request, no second
      // local mutation. That is what makes row-scoped rollback safe without a
      // request-sequence token.
      if (pendingRolesRef.current.has(role)) throw new Error(ROLE_PERMISSION_BUSY_MESSAGE);

      const priorRow = [...roleMatrixRef.current[role]];
      const requestedRow = enabled
        ? [...new Set([...priorRow, key])]
        : priorRow.filter((k) => k !== key);

      commitRoleRow(role, requestedRow);

      if (!isFirebaseConfigured || !db) {
        setDevRoleMatrix(roleMatrixRef.current);
        devAddActivity({
          branchId: logBranchId,
          userId: actor.id,
          userName: actor.name,
          action: 'PERM_CHANGE',
          detail: `อัปเดตสิทธิ์ ${role}: ${key} → ${enabled ? 'เปิด' : 'ปิด'}`,
          refId: null,
          ip: null,
          deviceId: null,
        });
        refreshDev();
        return NO_STAGING;
      }

      markRolePending(role);
      try {
        let outcome: RoleMatrixMutationOutcome;
        try {
          outcome = await callSetRolePermissions(role, requestedRow);
        } catch (err) {
          // Row-scoped rollback only — a whole-matrix restore would silently
          // revert a concurrent success on a different role.
          commitRoleRow(role, priorRow);
          throw err;
        }

        if (outcome.requiresStaging) {
          // The server persisted only the interim row, so the removal is not
          // converged yet. Render that interim truth instead of the target.
          commitRoleRow(role, computeInterimRow(priorRow, requestedRow));
        }

        await writeStaffActivity(
          { firestore: db, changedBy: actor.id, changedByName: actor.name },
          {
            branchId: logBranchId,
            userId: actor.id,
            userName: actor.name,
            action: 'PERM_CHANGE',
            detail: `อัปเดตสิทธิ์ ${role}: ${key} → ${enabled ? 'เปิด' : 'ปิด'}`,
          },
        );

        return outcome;
      } finally {
        clearRolePending(role);
      }
    },
    [branchId, actor, refreshDev, hq, commitRoleRow, markRolePending, clearRolePending],
  );

  const resetRoleMatrix = useCallback(async (): Promise<RoleMatrixMutationOutcome> => {
    // Context is validated before any local mutation: an unusable actor/branch
    // must never visually reset the matrix.
    if (!actor) throw new Error('ไม่พบผู้ใช้งาน');
    if (!hq && !branchId) throw new Error('ไม่พบสาขา');
    const logBranchId = branchId;
    if (!logBranchId) throw new Error('ไม่พบสาขา');

    // Mutual exclusion, enforced here rather than only by disabled controls:
    // Reset rewrites every non-admin row, so it must not overlap another Reset
    // or any in-flight role toggle whose late response would land afterwards.
    if (resetPendingRef.current) throw new Error(ROLE_PERMISSION_BUSY_MESSAGE);
    if (pendingRolesRef.current.size > 0) throw new Error(ROLE_PERMISSION_BUSY_MESSAGE);

    resetPendingRef.current = true;
    try {
      const target = cloneDefaultMatrix();

      if (!isFirebaseConfigured || !db) {
        commitWholeMatrix(target);
        setDevRoleMatrix(target);
        devAddActivity({
          branchId: logBranchId,
          userId: actor.id,
          userName: actor.name,
          action: 'PERM_CHANGE',
          detail: 'Reset สิทธิ์ Role เป็นค่าเริ่มต้น',
          refId: null,
          ip: null,
          deviceId: null,
        });
        refreshDev();
        return NO_STAGING;
      }

      // No optimism: each row is committed only after the server accepts it, so a
      // mid-loop failure leaves the rendered matrix equal to what actually landed.
      // `admin` is excluded because the interactive toggle path refuses it.
      const roles = (Object.keys(target) as UserRole[]).filter((role) => role !== 'admin');
      let anyRequiresStaging = false;

      for (const role of roles) {
        const priorRow = [...roleMatrixRef.current[role]];
        const requestedRow = [...target[role]];
        const outcome = await callSetRolePermissions(role, requestedRow);
        anyRequiresStaging = anyRequiresStaging || outcome.requiresStaging;
        commitRoleRow(
          role,
          outcome.requiresStaging ? computeInterimRow(priorRow, requestedRow) : requestedRow,
        );
      }

      await writeStaffActivity(
        { firestore: db, changedBy: actor.id, changedByName: actor.name },
        {
          branchId: logBranchId,
          userId: actor.id,
          userName: actor.name,
          action: 'PERM_CHANGE',
          detail: 'Reset สิทธิ์ Role เป็นค่าเริ่มต้น',
        },
      );

      return { requiresStaging: anyRequiresStaging };
    } finally {
      resetPendingRef.current = false;
    }
  }, [branchId, actor, refreshDev, hq, commitWholeMatrix, commitRoleRow]);

  return {
    users,
    activities,
    roleMatrix,
    pendingRoles,
    loading,
    error,
    saveUser,
    toggleActive,
    softDeleteUser,
    updateRoleMatrix,
    resetRoleMatrix,
  };
}

function roleLabel(role: UserRole): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  return 'Staff';
}
