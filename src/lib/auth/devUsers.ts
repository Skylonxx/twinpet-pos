import bcrypt from 'bcryptjs';
import { Timestamp } from 'firebase/firestore';
import type { User } from '../types';

const now = Timestamp.now();

/** Dev-only mock staff (see docs/twinpet_cursor_guide.md) */
const DEV_USERS_SEED = [
  {
    id: 'dev-global-admin',
    firstName: 'Global',
    lastName: 'Admin',
    username: 'globaladmin',
    password: 'global9999',
    pin: '9999',
    role: 'admin' as const,
    branchIds: ['ALL'],           // Global Admin — access to every branch
  },
  {
    id: 'dev-somchai',
    firstName: 'สมชาย',
    lastName: 'ใจดี',
    username: 'somchai',
    password: 'admin1234',
    pin: '1234',
    role: 'admin' as const,
    branchIds: ['LDP-001', 'BKK-002'],
  },
  {
    id: 'dev-suda',
    firstName: 'สุดา',
    lastName: 'รักงาน',
    username: 'suda',
    password: 'manager01',
    pin: '2345',
    role: 'manager' as const,
    branchIds: ['LDP-001'],
  },
  {
    id: 'dev-wichai',
    firstName: 'วิชัย',
    lastName: 'ขยัน',
    username: 'wichai',
    password: 'staff001',
    pin: '3456',
    role: 'staff' as const,
    branchIds: ['LDP-001'],
  },
  {
    id: 'dev-nongnuch',
    firstName: 'นงนุช',
    lastName: 'ยิ้มแย้ม',
    username: 'nongnuch',
    password: 'staff002',
    pin: '4567',
    role: 'staff' as const,
    branchIds: ['BKK-002'],
  },
];

let cachedUsers: User[] | null = null;
let cachedPinHashes: Map<string, string> | null = null;
let cachedPasswordHashes: Map<string, string> | null = null;

async function ensureDevCaches(): Promise<void> {
  if (cachedUsers) return;

  cachedUsers = DEV_USERS_SEED.map((seed) => ({
    id: seed.id,
    firstName: seed.firstName,
    lastName: seed.lastName,
    username: seed.username,
    pin: '', // filled below
    role: seed.role,
    branchIds: seed.branchIds,
    permissions: {
      canVoidOrder: seed.role !== 'staff',
      canEditPrice: seed.role !== 'staff',
      canViewReport: true,
      canManageStock: seed.role !== 'staff',
      canManageStaff: seed.role === 'admin',
    },
    isActive: true,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  }));

  cachedPinHashes = new Map();
  cachedPasswordHashes = new Map();

  await Promise.all(
    DEV_USERS_SEED.map(async (seed) => {
      const pinHash = await bcrypt.hash(seed.pin, 10);
      const passwordHash = await bcrypt.hash(seed.password, 10);
      cachedPinHashes!.set(seed.id, pinHash);
      cachedPasswordHashes!.set(seed.id, passwordHash);
    }),
  );

  cachedUsers = cachedUsers.map((user) => ({
    ...user,
    pin: cachedPinHashes!.get(user.id) ?? '',
  }));
}

export async function getDevUsers(): Promise<User[]> {
  await ensureDevCaches();
  return cachedUsers!;
}

export async function findDevUserByPin(
  pin: string,
  branchId: string,
): Promise<User | null> {
  await ensureDevCaches();
  const users = cachedUsers!.filter(
    // 'ALL' sentinel grants access to any branch
    (u) => u.isActive && (u.branchIds.includes('ALL') || u.branchIds.includes(branchId)) && !u.deletedAt,
  );

  for (const user of users) {
    const hash = cachedPinHashes!.get(user.id);
    if (hash && (await bcrypt.compare(pin, hash))) {
      return user;
    }
  }
  return null;
}

export async function findDevUserByUsernamePassword(
  username: string,
  password: string,
  branchId: string,
): Promise<User | null> {
  await ensureDevCaches();
  const user = cachedUsers!.find(
    (u) =>
      u.username === username &&
      u.isActive &&
      // 'ALL' sentinel grants access to any branch
      (u.branchIds.includes('ALL') || u.branchIds.includes(branchId)) &&
      !u.deletedAt,
  );
  if (!user) return null;

  const hash = cachedPasswordHashes!.get(user.id);
  if (!hash || !(await bcrypt.compare(password, hash))) return null;
  return user;
}
