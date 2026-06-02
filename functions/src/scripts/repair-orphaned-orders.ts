/**
 * Repair orphaned `settled` async orders — sales that flipped to
 * reconcileStatus 'settled' but whose canonical `orders/{id}` doc is missing.
 *
 * Backfills the read-model docs (orders/orderItems/payments) from the settled
 * asyncOrder. Does NOT re-run FIFO / stock / credit / shift (those already
 * committed when the order settled). See functions/src/sweeper.ts for the why.
 *
 * Targets the configured named database (firebase.json → firestore.database),
 * NOT the (default) one.
 *
 * Run (dry-run — reports only, writes nothing):
 *   cd functions
 *   npm run repair-orphaned-orders
 *
 * Apply the repairs for real:
 *   npm run repair-orphaned-orders -- --apply
 *
 * Requires a serviceAccount.json (see seed-branch.ts) or
 * GOOGLE_APPLICATION_CREDENTIALS / --credentials=<path>.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps, App, ServiceAccount } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { sweepStuckOrders } from '../sweeper';
import { FIRESTORE_DATABASE_ID } from '../deployConfig';

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
  const apply = process.argv.includes('--apply');
  // 2nd arg pins this handle to the configured named database.
  const db = getFirestore(initAdminApp(), FIRESTORE_DATABASE_ID);

  if (!apply) {
    console.log('');
    console.log('DRY-RUN. No documents will be written. Re-run with --apply to repair.');
    console.log('');
  }

  const report = await sweepStuckOrders(db, { apply });

  if (report.unrepairable.length > 0) {
    console.log('');
    console.log('Unrepairable orders (need manual review):');
    for (const u of report.unrepairable) console.log(`  - ${u.id}: ${u.reason}`);
  }
}

main().catch((err) => {
  console.error('');
  console.error('✗ repair-orphaned-orders ล้มเหลว:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
