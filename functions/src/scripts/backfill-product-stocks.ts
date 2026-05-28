/**
 * Backfill `branchId` on products/{id}/productStocks/{branchId} docs.
 * Required for collectionGroup('productStocks').where('branchId', '==', …) queries.
 *
 * Run:
 *   cd functions
 *   npm run backfill-product-stocks
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps, App, ServiceAccount } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

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

  throw new Error('ไม่พบ serviceAccount.json — ดูคำแนะนำใน seed-branch.ts');
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
  const db = getFirestore(initAdminApp());
  const productsSnap = await db.collection('products').get();

  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for (const productDoc of productsSnap.docs) {
    const stocksSnap = await productDoc.ref.collection('productStocks').get();
    for (const stockDoc of stocksSnap.docs) {
      scanned += 1;
      const data = stockDoc.data();
      const branchId = typeof data.branchId === 'string' ? data.branchId : stockDoc.id;

      if (data.branchId === branchId) {
        skipped += 1;
        continue;
      }

      await stockDoc.ref.set(
        {
          branchId,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      updated += 1;
      console.log(`  ✓ ${productDoc.id}/productStocks/${stockDoc.id} → branchId=${branchId}`);
    }
  }

  console.log('');
  console.log('✓ backfill-product-stocks เสร็จสิ้น');
  console.log(`  scanned : ${scanned}`);
  console.log(`  updated : ${updated}`);
  console.log(`  skipped : ${skipped}`);
}

main().catch((err) => {
  console.error('');
  console.error('✗ backfill-product-stocks ล้มเหลว:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
