/**
 * Ops-only, out-of-band issuer bootstrap ceremony (SEC-001 Packet C-A).
 *
 * Per the frozen issuer trust decision (`OPTION_I1_PER_INSTALL_ASYMMETRIC_ISSUER_KEYPAIR_OPS_BOOTSTRAP`,
 * `docs/agent-workflow/CURRENT_PACKET.md`): a random, short-lived, single-use
 * bootstrap token bound to an intended `issuerId` is created here by Ops
 * (real GCP/Firebase project IAM, not available to the POS/Admin runtime).
 * The Admin Issuance Console imports the raw token once and proves possession
 * of its locally-generated Ed25519 private key; the server's `registerIssuer`
 * callable consumes the bootstrap token and registers only the resulting
 * public key. The raw token is never persisted — only its SHA-256 hash is
 * stored, matching `functions/src/credentialStore.ts`'s "no raw secret at
 * rest" convention.
 *
 * Run from project root:
 *   cd ops
 *   npx ts-node issuerBootstrap/createIssuerBootstrapAuthorization.ts --issuerId=<id>
 *
 * Requires a Firebase service account JSON (GOOGLE_APPLICATION_CREDENTIALS or
 * ops/serviceAccount.json) or FIRESTORE_EMULATOR_HOST for local testing.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeApp, cert, getApps, type App, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

export const ISSUER_BOOTSTRAP_TOKENS_COLLECTION = 'privilegedIssuerBootstrapTokens';
export const BOOTSTRAP_TOKEN_BYTES = 32;
export const BOOTSTRAP_TOKEN_DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes — single ceremony window
export const ISSUER_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export type BootstrapTokenStatus = 'PENDING' | 'CONSUMED' | 'EXPIRED';

export interface IssuerBootstrapTokenDoc {
  tokenId: string;
  issuerId: string;
  tokenHash: string;
  status: BootstrapTokenStatus;
  createdAtServerMs: number;
  expiresAtServerMs: number;
  createdByOps: string;
  consumedAtServerMs: number | null;
}

export interface BootstrapAuthorization {
  tokenId: string;
  /** Raw token, base64url — printed to the operator exactly once, never persisted. */
  rawToken: string;
  doc: IssuerBootstrapTokenDoc;
}

export function sha256HexOfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isValidIssuerId(issuerId: string): boolean {
  return ISSUER_ID_RE.test(issuerId);
}

/**
 * Pure core: build the bootstrap authorization from injected randomness/clock
 * so it is testable without Firestore. `randomTokenBytes` must be exactly
 * `BOOTSTRAP_TOKEN_BYTES` bytes; `randomTokenIdBytes` seeds the (separate,
 * non-secret) tokenId so the doc id never derives from the secret token.
 */
export function buildBootstrapAuthorization(
  issuerId: string,
  nowMs: number,
  createdByOps: string,
  randomTokenBytes: Buffer,
  randomTokenIdBytes: Buffer,
  ttlMs: number = BOOTSTRAP_TOKEN_DEFAULT_TTL_MS,
): BootstrapAuthorization {
  if (!isValidIssuerId(issuerId)) {
    throw new Error(`invalid issuerId: "${issuerId}" (expected ${ISSUER_ID_RE})`);
  }
  if (randomTokenBytes.length !== BOOTSTRAP_TOKEN_BYTES) {
    throw new RangeError(`randomTokenBytes must be ${BOOTSTRAP_TOKEN_BYTES} bytes`);
  }
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError('ttlMs must be a positive integer');
  }
  if (!createdByOps.trim()) {
    throw new Error('createdByOps is required (operator identity for the audit trail)');
  }

  const tokenId = randomTokenIdBytes.toString('hex');
  const rawToken = randomTokenBytes.toString('base64url');
  const doc: IssuerBootstrapTokenDoc = {
    tokenId,
    issuerId,
    tokenHash: sha256HexOfBytes(randomTokenBytes),
    status: 'PENDING',
    createdAtServerMs: nowMs,
    expiresAtServerMs: nowMs + ttlMs,
    createdByOps,
    consumedAtServerMs: null,
  };
  return { tokenId, rawToken, doc };
}

async function persistBootstrapAuthorization(db: Firestore, doc: IssuerBootstrapTokenDoc): Promise<void> {
  await db.collection(ISSUER_BOOTSTRAP_TOKENS_COLLECTION).doc(doc.tokenId).set({
    ...doc,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function loadServiceAccount(): ServiceAccount {
  const explicitPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ??
    process.argv.find((a) => a.startsWith('--credentials='))?.split('=')[1];
  const candidates = [explicitPath, resolve(process.cwd(), 'serviceAccount.json')].filter(Boolean) as string[];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as {
        project_id?: string;
        client_email?: string;
        private_key?: string;
      };
      return {
        projectId: raw.project_id ?? '',
        clientEmail: raw.client_email ?? '',
        privateKey: raw.private_key ?? '',
      };
    }
  }
  throw new Error(
    'No service account found. Set GOOGLE_APPLICATION_CREDENTIALS, pass --credentials=path, or place ops/serviceAccount.json.',
  );
}

function initAdminApp(): App {
  if (getApps().length > 0) return getApps()[0]!;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const projectId = process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT ?? 'twinpet-pos';
    return initializeApp({ projectId });
  }
  const serviceAccount = loadServiceAccount();
  return initializeApp({ credential: cert(serviceAccount), projectId: serviceAccount.projectId });
}

async function main(): Promise<void> {
  const issuerId = process.argv.find((a) => a.startsWith('--issuerId='))?.split('=')[1];
  if (!issuerId) throw new Error('usage: --issuerId=<issuer-id>');
  const createdByOps = process.env.USER ?? process.env.USERNAME ?? 'ops';

  const app = initAdminApp();
  const db = getFirestore(app);
  const authorization = buildBootstrapAuthorization(
    issuerId,
    Date.now(),
    createdByOps,
    randomBytes(BOOTSTRAP_TOKEN_BYTES),
    randomBytes(16),
  );
  await persistBootstrapAuthorization(db, authorization.doc);

  console.log('');
  console.log('✓ Issuer bootstrap authorization created');
  console.log('──────────────────────────────────────');
  console.log(`  issuerId    : ${authorization.doc.issuerId}`);
  console.log(`  tokenId     : ${authorization.tokenId}`);
  console.log(`  expiresAt   : ${new Date(authorization.doc.expiresAtServerMs).toISOString()}`);
  console.log('──────────────────────────────────────');
  console.log('  RAW TOKEN (shown once, never persisted — copy it now):');
  console.log(`  ${authorization.rawToken}`);
  console.log('──────────────────────────────────────');
}

function isExecutedAsCli(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
  return /createIssuerBootstrapAuthorization\.(ts|js)$/.test(entry);
}

if (isExecutedAsCli()) {
  main().catch((err) => {
    console.error('✗ createIssuerBootstrapAuthorization failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
