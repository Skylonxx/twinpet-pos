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
import { useCallback, useEffect, useState } from 'react';
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
 * SEC-001 Packet C-A / F7 — routes a role-permission change through the
 * `setRolePermissions` Cloud Function instead of a direct client Firestore
 * write, so a removal gets the staged-deny fail-closed protection instead of
 * taking effect for live sessions only once they refresh their claims.
 */
async function callSetRolePermissions(role: UserRole, permissions: string[]): Promise<void> {
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
        setRoleMatrix(getDevRoleMatrix());
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
        setRoleMatrix(data.rolePermissions);
      }
    });

    return () => {
      cancelled = true;
      unsubUsers();
      unsubAct();
      unsubActFallback?.();
    };
  }, [branchId, hq]);

  const refreshDev = useCallback(() => {
    if (isFirebaseConfigured) return;
    if (hq) {
      setUsers(getDevStaffUsers().filter((u) => !u.deletedAt));
      setActivities(getDevAllStaffActivities());
      setRoleMatrix(getDevRoleMatrix());
      return;
    }
    if (!branchId) return;
    setUsers(getDevStaffUsers().filter((u) => u.branchIds.includes(branchId) && !u.deletedAt));
    setActivities(getDevStaffActivities(branchId));
    setRoleMatrix(getDevRoleMatrix());
  }, [branchId, hq]);

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
    async (role: UserRole, key: string, enabled: boolean): Promise<void> => {
      if (!actor) return;
      if (!hq && !branchId) return;
      if (role === 'admin') return;

      const logBranchId = branchId;
      if (!logBranchId) return;

      const next: RolePermissionMatrix = {
        ...roleMatrix,
        [role]: enabled
          ? [...new Set([...roleMatrix[role], key])]
          : roleMatrix[role].filter((k) => k !== key),
      };

      setRoleMatrix(next);

      if (!isFirebaseConfigured || !db) {
        setDevRoleMatrix(next);
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
        return;
      }

      await callSetRolePermissions(role, next[role]);

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
    },
    [branchId, actor, roleMatrix, refreshDev, hq],
  );

  const resetRoleMatrix = useCallback(async (): Promise<void> => {
    const next = cloneDefaultMatrix();
    setRoleMatrix(next);

    if (!actor) return;
    if (!hq && !branchId) return;
    const logBranchId = branchId;
    if (!logBranchId) return;

    if (!isFirebaseConfigured || !db) {
      setDevRoleMatrix(next);
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
      return;
    }

    const roles = Object.keys(next) as UserRole[];
    for (const role of roles) {
      await callSetRolePermissions(role, next[role]);
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
  }, [branchId, actor, refreshDev, hq]);

  return {
    users,
    activities,
    roleMatrix,
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
