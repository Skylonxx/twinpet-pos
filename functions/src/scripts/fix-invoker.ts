/**
 * Grant public invoke on verifyPinLogin (Gen2 = Cloud Run + Cloud Functions IAM).
 * Fixes CORS / "internal" errors from localhost when preflight OPTIONS is blocked.
 *
 * Run: cd functions && npm run fix-invoker
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GoogleAuth } from 'google-auth-library';
import { FUNCTIONS_REGION } from '../deployConfig';

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID ?? 'twinpet-pos';
const REGION = FUNCTIONS_REGION;
const FUNCTION_ID = 'verifyPinLogin';
const RUN_SERVICE_ID = 'verifypinlogin';

function loadCredentials() {
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
      return JSON.parse(readFileSync(filePath, 'utf8'));
    }
  }

  throw new Error('ไม่พบ serviceAccount.json — วางไว้ที่ functions/serviceAccount.json');
}

type IamPolicy = { bindings?: { role: string; members: string[] }[]; etag?: string };

async function addPublicInvoker(
  client: Awaited<ReturnType<GoogleAuth['getClient']>>,
  label: string,
  getUrl: string,
  setUrl: string,
  invokerRole: string,
): Promise<boolean> {
  const getRes = await client.request<IamPolicy>({
    url: getUrl,
    method: 'POST',
    data: {},
  });

  const bindings = getRes.data.bindings ?? [];
  const publicMember = 'allUsers';
  const existing = bindings.find((b) => b.role === invokerRole);

  if (existing?.members.includes(publicMember)) {
    console.log(`✓ ${label}: allUsers already has ${invokerRole}`);
    return false;
  }

  if (existing) {
    existing.members.push(publicMember);
  } else {
    bindings.push({ role: invokerRole, members: [publicMember] });
  }

  await client.request({
    url: setUrl,
    method: 'POST',
    data: {
      policy: {
        bindings,
        etag: getRes.data.etag,
      },
    },
  });

  console.log(`✓ ${label}: added allUsers → ${invokerRole}`);
  return true;
}

async function main(): Promise<void> {
  const credentials = loadCredentials();
  const projectId = credentials.project_id ?? PROJECT_ID;

  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();

  let changed = false;

  try {
    changed =
      (await addPublicInvoker(
        client,
        'Cloud Function',
        `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${REGION}/functions/${FUNCTION_ID}:getIamPolicy`,
        `https://cloudfunctions.googleapis.com/v2/projects/${projectId}/locations/${REGION}/functions/${FUNCTION_ID}:setIamPolicy`,
        'roles/cloudfunctions.invoker',
      )) || changed;
  } catch (err) {
    console.warn('[fix-invoker] Cloud Function IAM skipped:', (err as Error).message);
  }

  try {
    changed =
      (await addPublicInvoker(
        client,
        'Cloud Run',
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${REGION}/services/${RUN_SERVICE_ID}:getIamPolicy`,
        `https://run.googleapis.com/v2/projects/${projectId}/locations/${REGION}/services/${RUN_SERVICE_ID}:setIamPolicy`,
        'roles/run.invoker',
      )) || changed;
  } catch (err) {
    console.warn('[fix-invoker] Cloud Run IAM skipped:', (err as Error).message);
  }

  if (!changed) {
    console.log('IAM ครบแล้ว — ถ้ายัง CORS อยู่ ลอง redeploy: firebase deploy --only functions:verifyPinLogin');
  }

  console.log('');
  console.log('ลองรีเฟรชหน้า Login (Ctrl+Shift+R) แล้วกรอก PIN 1234');
}

main().catch((err) => {
  console.error('');
  console.error('✗ fix-invoker ล้มเหลว:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
