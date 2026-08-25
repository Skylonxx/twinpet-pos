/**
 * Seed the first Admin user into Firestore `users` collection.
 *
 * PIN is stored as bcrypt hash (rounds=10) — same as verifyPinLogin + Staff CRUD.
 *
 * Run from project root:
 *   cd functions
 *   npm run seed-admin
 *
 * Requires a Firebase service account JSON (see README in response / scripts section).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps, App, ServiceAccount } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp, Firestore } from 'firebase-admin/firestore';
import bcrypt from 'bcryptjs';
import { FIRESTORE_DATABASE_ID } from '../deployConfig';
import { COLLECTIONS } from '../credentialStore';

// ─── Edit these defaults or override via environment variables ───────────────

const CONFIG = {
  firstName: process.env.SEED_FIRST_NAME ?? 'Admin',
  lastName: process.env.SEED_LAST_NAME ?? 'TwinPet',
  username: (process.env.SEED_USERNAME ?? 'admin').trim().toLowerCase(),
  /** Plain PIN — will be bcrypt-hashed before save (must be 4 digits for verifyPinLogin) */
  pin: process.env.SEED_PIN ?? '1234',
  /** Password for username/password login (Firebase Auth email) — never logged */
  password: process.env.SEED_PASSWORD ?? 'Admin@1234',
  /** Set to skip branch lookup and use this id directly */
  branchId: process.env.SEED_BRANCH_ID?.trim() || null,
  /** When true and no active branch exists, create a default branch (LDP-001) */
  createBranchIfMissing: process.env.SEED_CREATE_BRANCH === '1',
  /** When true, force-sync role/permissions/branch on existing admin */
  syncExisting: process.env.SEED_ADMIN_SYNC === '1',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadServiceAccount(): ServiceAccount {
  const explicitPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    process.argv.find((a) => a.startsWith('--credentials='))?.split('=')[1];

  const candidates = [
    explicitPath,
    resolve(process.cwd(), 'serviceAccount.json'),
    resolve(process.cwd(), '..', 'serviceAccount.json'),
  ].filter(Boolean) as string[];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      console.log(`Using service account: ${filePath}`);
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        project_id?: string;
        projectId?: string;
        client_email?: string;
        clientEmail?: string;
        private_key?: string;
        privateKey?: string;
      };
      return {
        projectId: raw.projectId ?? raw.project_id ?? '',
        clientEmail: raw.clientEmail ?? raw.client_email ?? '',
        privateKey: raw.privateKey ?? raw.private_key ?? '',
      };
    }
  }

  throw new Error(
    [
      'ไม่พบไฟล์ Service Account',
      '',
      'ดาวน์โหลดจาก Firebase Console → Project settings → Service accounts → Generate new private key',
      'แล้ววางไฟล์เป็น functions/serviceAccount.json',
      'หรือตั้ง env: GOOGLE_APPLICATION_CREDENTIALS=path/to/key.json',
      'หรือส่ง argument: --credentials=path/to/key.json',
    ].join('\n'),
  );
}

function initAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;

  // Emulator mode: the Admin SDK auto-routes to the local emulators when their
  // *_EMULATOR_HOST envs are set — no service account / real credentials needed.
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    const projectId =
      process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'twinpet-pos';
    console.log(`[seed-admin] 🔌 emulator mode → project="${projectId}" (no service account needed)`);
    return initializeApp({ projectId });
  }

  const serviceAccount = loadServiceAccount();
  return initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.projectId,
  });
}

function authEmailForUsername(username: string, projectId: string): string {
  return `${username.trim().toLowerCase()}@${projectId}.twinpet`;
}

const ADMIN_PERMISSIONS = {
  canVoidOrder: true,
  canEditPrice: true,
  canViewReport: true,
  canManageStock: true,
  canManageStaff: true,
} as const;

// Default role → granular permission-key matrix. Mirrors the client
// DEFAULT_ROLE_PERMS (src/lib/staffManagement/types.ts) and the functions
// fallback (functions/src/index.ts). verifyPinLogin reads this doc to stamp the
// token's `permissions` array; the admin Staff panel edits it live.
const DEFAULT_ROLE_PERMISSIONS_MATRIX = {
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
} as const;

/**
 * Ensure settings/_rolePermissions exists so the Emulator mirrors production and
 * verifyPinLogin can resolve granular permission keys. Creates it only when
 * absent — never clobbers a matrix already edited via the admin panel.
 */
async function seedRolePermissions(db: Firestore): Promise<void> {
  const ref = db.collection('settings').doc('_rolePermissions');
  const snap = await ref.get();
  if (snap.exists && snap.data()?.rolePermissions) {
    console.log('settings/_rolePermissions มีอยู่แล้ว — ข้ามการสร้าง');
    return;
  }
  await ref.set(
    {
      rolePermissions: { ...DEFAULT_ROLE_PERMISSIONS_MATRIX },
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  console.log('✓ สร้าง settings/_rolePermissions (role → permission matrix)');
}

async function resolveBranchId(db: Firestore): Promise<string> {
  if (CONFIG.branchId) {
    const snap = await db.collection('branches').doc(CONFIG.branchId).get();
    if (!snap.exists) {
      throw new Error(`ไม่พบสาขา id="${CONFIG.branchId}" ในคอลเลกชัน branches`);
    }
    const data = snap.data() as { isActive?: boolean };
    if (data.isActive === false) {
      throw new Error(`สาขา id="${CONFIG.branchId}" ถูกปิดใช้งาน (isActive: false)`);
    }
    console.log(`ใช้สาขาที่ระบุ: ${CONFIG.branchId}`);
    return CONFIG.branchId;
  }

  const snap = await db
    .collection('branches')
    .where('isActive', '==', true)
    .limit(10)
    .get();

  if (snap.empty) {
    if (CONFIG.createBranchIfMissing) {
      const branchId = 'LDP-001';
      const now = FieldValue.serverTimestamp();
      await db.collection('branches').doc(branchId).set({
        name: 'สาขาหลัก',
        address: '',
        phone: '',
        email: '',
        taxId: '',
        logoUrl: null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
      console.log(`สร้างสาขาเริ่มต้น: ${branchId} (สาขาหลัก)`);
      return branchId;
    }

    throw new Error(
      [
        'ไม่พบสาขาที่ isActive=true ในคอลเลกชัน branches',
        'หน้า Login จะแสดง "ไม่พบสาขาที่ใช้งานได้" จนกว่าจะมีสาขา',
        '',
        'แก้ไข: สร้างสาขาใน Firestore ก่อน หรือรันด้วย SEED_CREATE_BRANCH=1',
        'หรือระบุ SEED_BRANCH_ID=your-branch-id',
      ].join('\n'),
    );
  }

  const branches = snap.docs
    .map((d) => ({ id: d.id, name: (d.data() as { name?: string }).name ?? d.id }))
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));

  const first = branches[0]!;
  console.log(`ดึงสาขาแรกอัตโนมัติ: ${first.id} (${first.name})`);
  if (branches.length > 1) {
    console.log(`  (มีสาขาอื่น ${branches.length - 1} แห่ง — เปลี่ยนได้ด้วย SEED_BRANCH_ID)`);
  }
  return first.id;
}

export function assertSeedAdminResetPinDisabled(): void {
  if (process.env.SEED_ADMIN_RESET_PIN === '1') {
    throw new Error(
      'SEED_ADMIN_RESET_PIN is decommissioned. Use recoverUserCredential for existing-user PIN recovery.',
    );
  }
}

async function main(): Promise<void> {
  assertSeedAdminResetPinDisabled();
  if (!/^\d{4}$/.test(CONFIG.pin)) {
    throw new Error('SEED_PIN ต้องเป็นตัวเลข 4 หลัก (verifyPinLogin บังคับรูปแบบนี้)');
  }

  const app = initAdminApp();
  const projectId = app.options.projectId!;
  const db = getFirestore(app, FIRESTORE_DATABASE_ID);
  const auth = getAuth(app);

  const branchId = await resolveBranchId(db);
  await seedRolePermissions(db);
  const email = authEmailForUsername(CONFIG.username, projectId);

  const existing = await db
    .collection('users')
    .where('username', '==', CONFIG.username)
    .limit(1)
    .get();

  if (!existing.empty) {
    const docSnap = existing.docs[0]!;
    const data = docSnap.data() as {
      branchIds?: string[];
      isActive?: boolean;
      deletedAt?: unknown;
      role?: string;
    };
    const currentBranchIds = data.branchIds ?? [];
    const needsBranchSync = !currentBranchIds.includes(branchId);
    const needsActiveSync = data.isActive !== true || data.deletedAt != null;

    console.log(`มีผู้ใช้ username="${CONFIG.username}" อยู่แล้ว (doc id: ${docSnap.id}) — ข้ามการสร้าง`);
    console.log(`  branchIds ปัจจุบัน : ${JSON.stringify(currentBranchIds)}`);
    console.log(`  isActive          : ${String(data.isActive ?? '(ไม่ระบุ)')}`);
    console.log(`  role              : ${data.role ?? '(ไม่ระบุ)'}`);

    if (needsBranchSync || needsActiveSync || CONFIG.syncExisting) {
      const updates: Record<string, unknown> = {
        updatedAt: Timestamp.now(),
      };

      if (needsBranchSync || CONFIG.syncExisting) {
        updates.branchIds = CONFIG.syncExisting
          ? [branchId]
          : [...new Set([...currentBranchIds, branchId])];
      }

      if (needsActiveSync || CONFIG.syncExisting) {
        updates.isActive = true;
        updates.deletedAt = null;
        updates.role = 'admin';
        updates.permissions = { ...ADMIN_PERMISSIONS };
      }

      await docSnap.ref.update(updates);
      console.log('');
      console.log('✓ อัปเดตผู้ใช้ admin ที่มีอยู่แล้ว');
      if (updates.branchIds) {
        console.log(`  branchIds → ${JSON.stringify(updates.branchIds)}`);
      }
    } else {
      console.log('');
      console.log('ข้อมูล admin ครบแล้ว — ใช้ credential เดิม');
      console.log('ถ้าต้องหมุน PIN ของผู้ใช้ที่มีอยู่แล้ว ให้ใช้ recoverUserCredential');
    }

    console.log('');
    console.log('ทดสอบ: เปิดแอป → เลือกสาขา → กรอก username + PIN แล้วล็อกอิน');
    process.exit(0);
  }

  let uid: string;
  try {
    const userRecord = await auth.createUser({
      email,
      password: CONFIG.password,
      displayName: `${CONFIG.firstName} ${CONFIG.lastName}`,
    });
    uid = userRecord.uid;
    console.log(`สร้าง Firebase Auth user: ${uid}`);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'auth/email-already-exists') {
      const existingAuth = await auth.getUserByEmail(email);
      uid = existingAuth.uid;
      console.log(`Firebase Auth มี email นี้อยู่แล้ว — ใช้ uid: ${uid}`);
    } else {
      throw err;
    }
  }

  const pinHash = await bcrypt.hash(CONFIG.pin, 10);
  const now = Timestamp.now();

  const userDoc = {
    id: uid,
    firstName: CONFIG.firstName,
    lastName: CONFIG.lastName,
    username: CONFIG.username,
    role: 'admin' as const,
    branchIds: [branchId],
    permissions: { ...ADMIN_PERMISSIONS },
    isActive: true,
    authVersion: 0,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };

  await db.collection(COLLECTIONS.users).doc(uid).set(userDoc);
  await db.collection(COLLECTIONS.userCredentials).doc(uid).set({
    pinHash,
    algo: 'bcrypt',
    cost: 10,
    credentialVersion: 0,
    credentialState: 'rotated_authoritative',
    disabled: false,
    updatedAt: now,
    updatedBy: 'seed-admin',
  });
  await db.collection(COLLECTIONS.usernames).doc(CONFIG.username).set({
    userId: uid,
    reservedAt: now,
  });

  console.log('');
  console.log('✓ สร้าง Admin สำเร็จ');
  console.log('──────────────────────────────────────');
  console.log(`  Firestore doc : users/${uid}`);
  console.log(`  ชื่อ          : ${CONFIG.firstName} ${CONFIG.lastName}`);
  console.log(`  Username      : ${CONFIG.username}`);
  console.log(`  Auth email    : ${email}`);
  console.log(`  สาขา          : ${branchId}`);
  console.log(`  role          : admin`);
  console.log(`  isActive      : true`);
  console.log(`  deletedAt     : null`);
  console.log('──────────────────────────────────────');
  console.log('');
  console.log('ทดสอบ: เปิดแอป → เลือกสาขา → กรอก username + PIN แล้วล็อกอิน');
}

function isExecutedAsCli(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
  return /seed-admin\.(ts|js)$/.test(entry);
}

if (isExecutedAsCli()) {
  main().catch((err) => {
    console.error('');
    console.error('✗ seed-admin ล้มเหลว:');
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
