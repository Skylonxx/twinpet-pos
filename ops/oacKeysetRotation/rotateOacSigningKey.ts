/**
 * Ops-only OAC Ed25519 signing-key rotation (SEC-001 Packet C-A).
 *
 * Generates a new Ed25519 keypair for signing `OfflineAuthorizationCapabilityV1`
 * envelopes (and the OKS1 keyset manifest), persists the new key as the
 * fleet's active signer, and leaves prior non-retired keys in place so
 * already-issued OACs (and cached OKS1 manifests naming them) remain
 * verifiable until they age out / are explicitly retired. Consumed by
 * `functions/src/signingKeyLoader.ts` (loads the active private key to sign)
 * and `functions/src/oacKeysetManifest.ts` (lists all non-retired public
 * keys for `getOacKeysetManifest`).
 *
 * Run from project root:
 *   cd ops
 *   npx ts-node oacKeysetRotation/rotateOacSigningKey.ts --database=pos-db
 *
 * `--database=<id>` is REQUIRED and must equal firebase.json `firestore.database`
 * (the named database the Functions read). There is no implicit `(default)`
 * fallback: a missing/mismatched target fails before any Firestore access.
 *
 * Requires a Firebase service account JSON (GOOGLE_APPLICATION_CREDENTIALS or
 * ops/serviceAccount.json) or FIRESTORE_EMULATOR_HOST for local testing.
 */

import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { initializeApp, cert, getApps, type App, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore';

export const OAC_SIGNING_KEYS_COLLECTION = 'privilegedOacSigningKeys';
export const OAC_KEYSET_META_COLLECTION = 'privilegedOacKeysetMeta';
export const OAC_KEYSET_META_DOC_ID = 'current';

export const VERIFY_ONLY_WINDOW_MS = 96 * 60 * 60 * 1000; // 345_600_000 ms

export type OacSigningKeyStatus = 'ACTIVE' | 'VERIFY_ONLY' | 'RETIRED';

export interface OacSigningKeyDoc {
  signingKeyId: string;
  algo: 'ed25519';
  publicKeyBase64Url: string;
  privateKeyBase64Url: string;
  status: OacSigningKeyStatus;
  createdAtServerMs: number;
  createdByOps: string;
  verifyUntilServerMs?: number;
}

export interface OacKeysetMetaDoc {
  activeSigningKeyId: string;
  rotatedAtServerMs: number;
  rotatedByOps: string;
}

export interface RotatedKeysetUpdate {
  keyDoc: OacSigningKeyDoc;
  metaDoc: OacKeysetMetaDoc;
}

export type KeyNormalizationUpdate =
  | {
      signingKeyId: string;
      status: 'VERIFY_ONLY';
      verifyUntilServerMs: number;
    }
  | {
      signingKeyId: string;
      status: 'RETIRED';
    };

/** Raw 32-byte Ed25519 public key from a JWK `x` field. */
export function rawFromJwkCoordinate(base64Url: string): Buffer {
  return Buffer.from(base64Url, 'base64url');
}

export function signingKeyIdFromPublicKey(publicKeyRaw: Buffer): string {
  return createHash('sha256').update(publicKeyRaw).digest('hex').slice(0, 16);
}

/**
 * Pure core: build the Firestore writes for a rotation given an already
 * (Ed25519) key material and clock, so it is testable without Firestore or
 * real key generation.
 */
export function buildRotatedKeysetUpdate(
  publicKeyBase64Url: string,
  privateKeyBase64Url: string,
  nowMs: number,
  rotatedByOps: string,
): RotatedKeysetUpdate {
  if (!rotatedByOps.trim()) throw new Error('rotatedByOps is required (operator identity for the audit trail)');
  const publicKeyRaw = rawFromJwkCoordinate(publicKeyBase64Url);
  if (publicKeyRaw.length !== 32) throw new RangeError('publicKeyBase64Url must decode to 32 raw bytes');
  const privateKeyRaw = rawFromJwkCoordinate(privateKeyBase64Url);
  if (privateKeyRaw.length !== 32) throw new RangeError('privateKeyBase64Url must decode to 32 raw bytes');

  const signingKeyId = signingKeyIdFromPublicKey(publicKeyRaw);
  const keyDoc: OacSigningKeyDoc = {
    signingKeyId,
    algo: 'ed25519',
    publicKeyBase64Url,
    privateKeyBase64Url,
    status: 'ACTIVE',
    createdAtServerMs: nowMs,
    createdByOps: rotatedByOps,
  };
  const metaDoc: OacKeysetMetaDoc = {
    activeSigningKeyId: signingKeyId,
    rotatedAtServerMs: nowMs,
    rotatedByOps,
  };
  return { keyDoc, metaDoc };
}

/** Generates a fresh Ed25519 keypair, raw-encoded as JWK base64url coordinates. */
export function generateOacSigningKeypair(): { publicKeyBase64Url: string; privateKeyBase64Url: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { publicKeyBase64Url: pubJwk.x, privateKeyBase64Url: privJwk.d };
}

export function normalizePriorActiveKeys(
  existingKeys: Array<{ signingKeyId: string; status: OacSigningKeyStatus; verifyUntilServerMs?: number }>,
  newSigningKeyId: string,
  nowMs: number,
): KeyNormalizationUpdate[] {
  const updates: KeyNormalizationUpdate[] = [];
  for (const k of existingKeys) {
    if (k.signingKeyId === newSigningKeyId) continue;
    if (k.status === 'ACTIVE') {
      updates.push({
        signingKeyId: k.signingKeyId,
        status: 'VERIFY_ONLY',
        verifyUntilServerMs: nowMs + VERIFY_ONLY_WINDOW_MS,
      });
    } else if (k.status === 'VERIFY_ONLY') {
      if (typeof k.verifyUntilServerMs === 'number' && k.verifyUntilServerMs <= nowMs) {
        updates.push({
          signingKeyId: k.signingKeyId,
          status: 'RETIRED',
        });
      }
    }
  }
  return updates;
}

export async function persistRotatedKeyset(
  db: Firestore,
  update: RotatedKeysetUpdate,
  nowMs: number = Date.now(),
): Promise<KeyNormalizationUpdate[]> {
  return await db.runTransaction(async (transaction) => {
    const metaRef = db.collection(OAC_KEYSET_META_COLLECTION).doc(OAC_KEYSET_META_DOC_ID);
    const keysCollection = db.collection(OAC_SIGNING_KEYS_COLLECTION);

    const [metaSnap, keysSnap] = await Promise.all([
      transaction.get(metaRef),
      transaction.get(keysCollection),
    ]);

    const currentMeta = metaSnap.exists ? (metaSnap.data() as Record<string, unknown>) : null;
    const currentGeneration =
      typeof currentMeta?.generation === 'number' && Number.isSafeInteger(currentMeta.generation)
        ? currentMeta.generation
        : 0;
    const nextGeneration = currentGeneration + 1;

    const existingKeys = keysSnap.docs.map((d) => {
      const data = d.data();
      const rawStatus = typeof data.status === 'string' ? data.status : '';
      const status: OacSigningKeyStatus =
        rawStatus === 'ACTIVE' || rawStatus === 'VERIFY_ONLY' || rawStatus === 'RETIRED'
          ? (rawStatus as OacSigningKeyStatus)
          : 'RETIRED';
      return {
        signingKeyId: d.id,
        status,
        verifyUntilServerMs:
          typeof data.verifyUntilServerMs === 'number' && Number.isSafeInteger(data.verifyUntilServerMs)
            ? data.verifyUntilServerMs
            : undefined,
      };
    });

    const normalizations = normalizePriorActiveKeys(existingKeys, update.keyDoc.signingKeyId, nowMs);

    for (const n of normalizations) {
      const keyRef = db.collection(OAC_SIGNING_KEYS_COLLECTION).doc(n.signingKeyId);
      if (n.status === 'RETIRED') {
        transaction.update(keyRef, {
          status: 'RETIRED',
          retiredAtServerMs: nowMs,
        });
      } else {
        transaction.update(keyRef, {
          status: n.status,
          verifyUntilServerMs: n.verifyUntilServerMs,
        });
      }
    }

    const newKeyRef = db.collection(OAC_SIGNING_KEYS_COLLECTION).doc(update.keyDoc.signingKeyId);
    transaction.set(newKeyRef, {
      ...update.keyDoc,
      generation: nextGeneration,
      createdAt: FieldValue.serverTimestamp(),
    });

    transaction.set(metaRef, {
      ...update.metaDoc,
      generation: nextGeneration,
      rotatedAt: FieldValue.serverTimestamp(),
    });

    return normalizations;
  });
}

// ── Target database selection (SEC-001 R6-D2) ──────────────────────────────
// Kept per-script (no shared module), mirroring createIssuerBootstrapAuthorization.ts.

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
  const databaseId = resolveTargetDatabaseId(process.argv, readCanonicalDatabaseId(locateFirebaseJson(__dirname)));
  const rotatedByOps = process.env.USER ?? process.env.USERNAME ?? 'ops';
  const app = initAdminApp();
  const db = openTargetFirestore(app, databaseId);
  console.log(
    `  target      : project=${app.options.projectId ?? '(unknown)'} database=${databaseId}` +
      (process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ''),
  );

  const { publicKeyBase64Url, privateKeyBase64Url } = generateOacSigningKeypair();
  const update = buildRotatedKeysetUpdate(publicKeyBase64Url, privateKeyBase64Url, Date.now(), rotatedByOps);
  await persistRotatedKeyset(db, update);

  console.log('');
  console.log('✓ OAC signing key rotated');
  console.log('──────────────────────────────────────');
  console.log(`  new signingKeyId : ${update.keyDoc.signingKeyId}`);
  console.log(`  publicKey (b64url): ${update.keyDoc.publicKeyBase64Url}`);
  console.log('  Prior non-retired keys remain valid for verification.');
  console.log('──────────────────────────────────────');
}

function isExecutedAsCli(): boolean {
  const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
  return /rotateOacSigningKey\.(ts|js)$/.test(entry);
}

if (isExecutedAsCli()) {
  main().catch((err) => {
    console.error('✗ rotateOacSigningKey failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
