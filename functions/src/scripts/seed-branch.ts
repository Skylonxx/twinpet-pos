/**
 * Seed the first branch into Firestore `branches` collection.
 *
 * Run:
 *   cd functions
 *   npm run seed-branch
 *
 * Requires serviceAccount.json in functions/ (same as seed-admin).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps, App, ServiceAccount } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { FIRESTORE_DATABASE_ID } from '../deployConfig';

const CONFIG = {
  branchId: (process.env.SEED_BRANCH_ID ?? 'LDP-001').trim(),
  name: process.env.SEED_BRANCH_NAME ?? 'สาขาหลัก',
  /** Set to "1" to overwrite an existing branch document */
  force: process.env.SEED_BRANCH_FORCE === '1',
};

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
    ].join('\n'),
  );
}

function initAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;

  const serviceAccount = loadServiceAccount();
  return initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.projectId,
  });
}

async function main(): Promise<void> {
  const app = initAdminApp();
  const db = getFirestore(app, FIRESTORE_DATABASE_ID);
  const ref = db.collection('branches').doc(CONFIG.branchId);
  const existing = await ref.get();

  if (existing.exists && !CONFIG.force) {
    const data = existing.data() as { name?: string; isActive?: boolean };
    console.log(`มีสาขา "${CONFIG.branchId}" อยู่แล้ว — ข้ามการสร้าง`);
    console.log(`  name: ${data.name ?? '(ไม่ระบุ)'}`);
    console.log(`  isActive: ${String(data.isActive ?? '(ไม่ระบุ)')}`);
    console.log('');
    console.log('ถ้าต้องการเขียนทับ ให้รันด้วย SEED_BRANCH_FORCE=1');
    process.exit(0);
  }

  const now = FieldValue.serverTimestamp();

  const branchDoc = {
    name: CONFIG.name,
    address: '',
    phone: '',
    email: '',
    taxId: '',
    logoUrl: null,
    isActive: true,
    deletedAt: null,
    createdAt: existing.exists ? existing.data()?.createdAt ?? now : now,
    updatedAt: now,
  };

  await ref.set(branchDoc);

  console.log('');
  console.log('✓ สร้างสาขาสำเร็จ');
  console.log('──────────────────────────────────────');
  console.log(`  Firestore doc : branches/${CONFIG.branchId}`);
  console.log(`  name          : ${CONFIG.name}`);
  console.log(`  isActive      : true`);
  console.log(`  deletedAt     : null`);
  console.log('──────────────────────────────────────');
  console.log('');
  console.log('ขั้นตอนถัดไป: รีเฟรชหน้า Login → เลือกสาขา "สาขาหลัก" → กรอก PIN');
}

main().catch((err) => {
  console.error('');
  console.error('✗ seed-branch ล้มเหลว:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
