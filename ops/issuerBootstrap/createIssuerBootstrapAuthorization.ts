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
 *   npx ts-node issuerBootstrap/createIssuerBootstrapAuthorization.ts --issuerId=<id> --database=pos-db
 *
 * `--database=<id>` is REQUIRED and must equal firebase.json `firestore.database`
 * (the named database `registerIssuer` reads). There is no implicit `(default)`
 * fallback: a missing/mismatched target fails before any Firestore access.
 *
 * Requires a Firebase service account JSON (GOOGLE_APPLICATION_CREDENTIALS or
 * ops/serviceAccount.json) or FIRESTORE_EMULATOR_HOST for local testing.
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

// ── Target database selection (SEC-001 R6-D2) ──────────────────────────────
// Kept per-script (no shared module), mirroring rotateOacSigningKey.ts.

export const DATABASE_ARG_PREFIX = '--database=';
export const DEFAULT_FIRESTORE_DATABASE_ID = '(default)';
/** Firestore named-database id grammar: 4-63 chars, lowercase/digits/hyphen, starts with a letter, ends alnum. */
export const FIRESTORE_DATABASE_ID_RE = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
/** 32 hex digits once hyphens are removed: a UUID in canonical, compact or re-grouped form. */
const UUID_HEX_RE = /^[0-9a-f]{32}$/i;
const FIREBASE_JSON_SEARCH_DEPTH = 5;

/** Firestore forbids database ids that are, or resemble, a UUID. */
export function isUuidLikeDatabaseId(id: string): boolean {
  return UUID_HEX_RE.test(id.replace(/-/g, ''));
}

/**
 * The single per-script predicate for an acceptable target: a well-formed named
 * database id that is neither `(default)` nor UUID-like. Guards the canonical
 * firebase.json value, the CLI value and openTargetFirestore alike.
 */
export function isValidNamedDatabaseId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id !== DEFAULT_FIRESTORE_DATABASE_ID &&
    FIRESTORE_DATABASE_ID_RE.test(id) &&
    !isUuidLikeDatabaseId(id)
  );
}

function isPopulatedDatabaseValue(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim().length === 0);
}

/** Nearest ancestor firebase.json (works from source `ops/<dir>/` and compiled `ops/lib/<dir>/`). */
export function locateFirebaseJson(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i <= FIREBASE_JSON_SEARCH_DEPTH; i++) {
    const candidate = join(dir, 'firebase.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`firebase.json not found within ${FIREBASE_JSON_SEARCH_DEPTH} levels above ${startDir}`);
}

/**
 * Canonical named database from firebase.json `firestore.database` (object or
 * multi-database array form). Fails closed when absent, ambiguous (more than one
 * populated array entry — never picks the first) or not a valid named id.
 */
export function readCanonicalDatabaseId(firebaseJsonPath: string): string {
  if (!existsSync(firebaseJsonPath)) throw new Error(`firebase.json not found at ${firebaseJsonPath}`);
  const fb = JSON.parse(readFileSync(firebaseJsonPath, 'utf8')) as { firestore?: unknown };
  const fs = fb.firestore;
  let database: unknown;
  if (Array.isArray(fs)) {
    const populated = fs
      .map((e: unknown) => (e !== null && typeof e === 'object' ? (e as { database?: unknown }).database : undefined))
      .filter(isPopulatedDatabaseValue);
    if (populated.length > 1) {
      throw new Error(`firebase.json: firestore declares ${populated.length} databases — ambiguous target, refusing to choose`);
    }
    database = populated[0];
  } else if (fs !== null && typeof fs === 'object') {
    database = (fs as { database?: unknown }).database;
  }
  if (!isPopulatedDatabaseValue(database)) {
    throw new Error('firebase.json: firestore.database is missing — cannot determine the target database');
  }
  if (!isValidNamedDatabaseId(database)) {
    throw new Error(`firebase.json: firestore.database "${String(database)}" is not a valid named database id`);
  }
  return database;
}

/**
 * Resolves the REQUIRED `--database=<id>` argument. Throws (before any
 * Firestore/app work) on a missing, duplicated, empty, `(default)`, malformed,
 * UUID-like, or non-canonical value. Never falls back to `(default)`.
 */
export function resolveTargetDatabaseId(argv: readonly string[], canonicalDatabaseId: string | undefined): string {
  const args = argv.filter((a) => a === '--database' || a.startsWith(DATABASE_ARG_PREFIX));
  if (args.length === 0) {
    throw new Error(`usage: ${DATABASE_ARG_PREFIX}<firestore-database-id> is required (no implicit ${DEFAULT_FIRESTORE_DATABASE_ID} fallback)`);
  }
  if (args.length > 1) throw new Error(`${DATABASE_ARG_PREFIX} must be given exactly once`);
  if (!args[0]!.startsWith(DATABASE_ARG_PREFIX)) throw new Error(`use ${DATABASE_ARG_PREFIX}<id> (with "=")`);
  const value = args[0]!.slice(DATABASE_ARG_PREFIX.length);
  if (value.length === 0) throw new Error(`${DATABASE_ARG_PREFIX} value is empty`);
  if (value === DEFAULT_FIRESTORE_DATABASE_ID) {
    throw new Error(`${DEFAULT_FIRESTORE_DATABASE_ID} is not an allowed target; the Functions read the named database`);
  }
  if (!isValidNamedDatabaseId(value)) throw new Error(`malformed database id: "${value}"`);
  if (typeof canonicalDatabaseId !== 'string' || canonicalDatabaseId.trim().length === 0) {
    throw new Error('canonical database id is unavailable — refusing to guess a target');
  }
  if (!isValidNamedDatabaseId(canonicalDatabaseId)) {
    throw new Error(`canonical database id "${canonicalDatabaseId}" is not a valid named database id`);
  }
  if (value !== canonicalDatabaseId) {
    throw new Error(`--database="${value}" does not match firebase.json firestore.database="${canonicalDatabaseId}"`);
  }
  return value;
}

/** The ONLY way this script obtains a Firestore handle: always an explicit named database. */
export function openTargetFirestore(app: App, databaseId: string): Firestore {
  if (!isValidNamedDatabaseId(databaseId)) {
    throw new Error(`refusing to open Firestore without a valid named database (got "${databaseId}")`);
  }
  return getFirestore(app, databaseId);
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
  const databaseId = resolveTargetDatabaseId(process.argv, readCanonicalDatabaseId(locateFirebaseJson(__dirname)));
  const createdByOps = process.env.USER ?? process.env.USERNAME ?? 'ops';

  const app = initAdminApp();
  const db = openTargetFirestore(app, databaseId);
  console.log(
    `  target      : project=${app.options.projectId ?? '(unknown)'} database=${databaseId}` +
      (process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ''),
  );
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
