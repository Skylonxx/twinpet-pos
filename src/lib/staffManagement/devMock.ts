import bcrypt from 'bcryptjs';
import { Timestamp } from 'firebase/firestore';
import type { StaffActivity, User } from '../types';
import { getDevUsers } from '../auth/devUsers';
import { cloneDefaultMatrix, type RolePermissionMatrix } from './types';

const now = Timestamp.now();

let devUsers: User[] | null = null;
let devPasswordHashes = new Map<string, string>();
let devPinHashes = new Map<string, string>();
let devActivities: StaffActivity[] = [];
let devRoleMatrix: RolePermissionMatrix = cloneDefaultMatrix();
let nextActivityId = 100;

function ts(date: Date): StaffActivity['createdAt'] {
  return { toDate: () => date } as StaffActivity['createdAt'];
}

function seedActivities(users: User[]): StaffActivity[] {
  const somchai = users.find((u) => u.username === 'somchai');
  const suda = users.find((u) => u.username === 'suda');
  const wichai = users.find((u) => u.username === 'wichai');
  const today = new Date();

  return [
    {
      id: 'act-1',
      branchId: 'LDP-001',
      userId: somchai?.id ?? '',
      userName: somchai ? `${somchai.firstName} ${somchai.lastName}` : 'Unknown',
      action: 'LOGIN',
      detail: 'เข้าสู่ระบบจาก Terminal POS-01',
      refId: null,
      ip: '192.168.1.10',
      deviceId: 'POS-01',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 12)),
    },
    {
      id: 'act-2',
      branchId: 'LDP-001',
      userId: suda?.id ?? '',
      userName: suda ? `${suda.firstName} ${suda.lastName}` : 'Unknown',
      action: 'LOGIN',
      detail: 'เข้าสู่ระบบจาก Terminal POS-02',
      refId: null,
      ip: '192.168.1.11',
      deviceId: 'POS-02',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8, 45)),
    },
    {
      id: 'act-3',
      branchId: 'LDP-001',
      userId: suda?.id ?? '',
      userName: suda ? `${suda.firstName} ${suda.lastName}` : 'Unknown',
      action: 'SALE',
      detail: 'บันทึกการขาย บิล #TW-0582 ฿1,240',
      refId: 'TW-0582',
      ip: '192.168.1.11',
      deviceId: 'POS-02',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8, 55)),
    },
    {
      id: 'act-4',
      branchId: 'LDP-001',
      userId: suda?.id ?? '',
      userName: suda ? `${suda.firstName} ${suda.lastName}` : 'Unknown',
      action: 'DISCOUNT',
      detail: 'ให้ส่วนลด 5% บิล #TW-0582',
      refId: 'TW-0582',
      ip: '192.168.1.11',
      deviceId: 'POS-02',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 8, 57)),
    },
    {
      id: 'act-5',
      branchId: 'LDP-001',
      userId: somchai?.id ?? '',
      userName: somchai ? `${somchai.firstName} ${somchai.lastName}` : 'Unknown',
      action: 'SALE',
      detail: 'บันทึกการขาย บิล #TW-0583 ฿860',
      refId: 'TW-0583',
      ip: '192.168.1.10',
      deviceId: 'POS-01',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 30)),
    },
    {
      id: 'act-6',
      branchId: 'LDP-001',
      userId: somchai?.id ?? '',
      userName: somchai ? `${somchai.firstName} ${somchai.lastName}` : 'Unknown',
      action: 'EDIT',
      detail: 'แก้ไขสินค้า "Royal Canin Adult 3kg" ราคา: ฿450→฿480',
      refId: null,
      ip: '192.168.1.10',
      deviceId: 'POS-01',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 5)),
    },
    {
      id: 'act-7',
      branchId: 'LDP-001',
      userId: somchai?.id ?? '',
      userName: somchai ? `${somchai.firstName} ${somchai.lastName}` : 'Unknown',
      action: 'VOID',
      detail: 'Void รายการ "Whiskas Tuna 85g" บิล #TW-0584',
      refId: 'TW-0584',
      ip: '192.168.1.10',
      deviceId: 'POS-01',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 45)),
    },
    {
      id: 'act-8',
      branchId: 'LDP-001',
      userId: suda?.id ?? '',
      userName: suda ? `${suda.firstName} ${suda.lastName}` : 'Unknown',
      action: 'EDIT',
      detail: 'รับสินค้าเข้า GRN-0088 รวม 12 รายการ',
      refId: 'GRN-0088',
      ip: '192.168.1.11',
      deviceId: 'POS-02',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 11, 20)),
    },
    {
      id: 'act-9',
      branchId: 'LDP-001',
      userId: wichai?.id ?? '',
      userName: wichai ? `${wichai.firstName} ${wichai.lastName}` : 'Unknown',
      action: 'LOGOUT',
      detail: 'ออกจากระบบ Terminal POS-01',
      refId: null,
      ip: '192.168.1.10',
      deviceId: 'POS-01',
      createdAt: ts(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 18, 30)),
    },
  ];
}

export async function initDevStaffStore(): Promise<void> {
  if (devUsers) return;
  devUsers = (await getDevUsers()).map((u) => ({ ...u }));
  devActivities = seedActivities(devUsers);
}

export function getDevStaffUsers(): User[] {
  return devUsers ?? [];
}

export function getDevStaffActivities(branchId: string): StaffActivity[] {
  return devActivities
    .filter((a) => a.branchId === branchId)
    .sort((a, b) => b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime());
}

export function getDevAllStaffActivities(): StaffActivity[] {
  return [...devActivities].sort(
    (a, b) => b.createdAt.toDate().getTime() - a.createdAt.toDate().getTime(),
  );
}

export function getDevRoleMatrix(): RolePermissionMatrix {
  return {
    admin: [...devRoleMatrix.admin],
    manager: [...devRoleMatrix.manager],
    staff: [...devRoleMatrix.staff],
  };
}

export function setDevRoleMatrix(matrix: RolePermissionMatrix): void {
  devRoleMatrix = matrix;
}

export async function devSaveStaffUser(
  user: User,
  password?: string,
  pin?: string,
): Promise<User> {
  await initDevStaffStore();
  const idx = devUsers!.findIndex((u) => u.id === user.id);
  if (idx >= 0) {
    devUsers![idx] = user;
  } else {
    devUsers!.push(user);
  }
  if (password) {
    devPasswordHashes.set(user.id, await bcrypt.hash(password, 10));
  }
  if (pin) {
    devPinHashes.set(user.id, await bcrypt.hash(pin, 10));
    user.pin = devPinHashes.get(user.id)!;
  }
  return user;
}

export function devSoftDeleteUser(userId: string): void {
  if (!devUsers) return;
  const user = devUsers.find((u) => u.id === userId);
  if (user) {
    user.deletedAt = now;
    user.isActive = false;
    user.updatedAt = now;
  }
}

export function devAddActivity(activity: Omit<StaffActivity, 'id' | 'createdAt'>): StaffActivity {
  const row: StaffActivity = {
    ...activity,
    id: `act-${nextActivityId++}`,
    createdAt: now,
  };
  devActivities.unshift(row);
  return row;
}

export function devToggleUserActive(userId: string, isActive: boolean): User | null {
  const user = devUsers?.find((u) => u.id === userId);
  if (!user) return null;
  user.isActive = isActive;
  user.updatedAt = now;
  return user;
}

export function devGenerateUserId(): string {
  return `dev-user-${Date.now()}`;
}
