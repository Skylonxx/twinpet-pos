/**
 * Completeness verification + the only two writers of maintenanceMode:false.
 * Initial complete:false→true (+ epoch:1 + maintenanceMode:false).
 * Re-migration success: epoch→requestedEpoch + maintenanceMode:false, complete stays true.
 * Failure leaves maintenanceMode:true and epoch unchanged.
 *
 * Operator CLI (no work on import):
 *   npm run verify-username-reservation-completeness -- --project=<id> --database=<id> --credentials=<path> --requestedEpoch=<n> --apply
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, normalizeUsername } from '../credentialStore';
import { classifyUsers, loadAllUsersUnfiltered } from './censusUsernames';

export type VerifyResult = {
  ok: boolean;
  complete: boolean;
  maintenanceMode: boolean;
  epoch: number;
  error?: string;
};

export async function verifyZeroMissNoOrphan(
  database: Firestore,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const docs = await loadAllUsersUnfiltered(database);
  const live = classifyUsers(docs).live;
  const reservations = await database.collection(COLLECTIONS.usernames).get();
  const byUsername = new Map<string, string>();
  for (const doc of reservations.docs) {
    const userId = String((doc.data() as { userId?: string }).userId ?? '');
    byUsername.set(doc.id, userId);
  }
  for (const entry of live) {
    const owner = byUsername.get(entry.normalizedUsername);
    if (owner !== entry.userId) {
      return { ok: false, error: `MISS_OR_OWNER_MISMATCH:${entry.userId}` };
    }
  }
  for (const [username, userId] of byUsername) {
    const liveEntry = live.find((e) => e.userId === userId);
    if (!liveEntry || liveEntry.normalizedUsername !== username) {
      return { ok: false, error: `ORPHAN_RESERVATION:${username}` };
    }
  }
  return { ok: true };
}

export async function runVerifyUsernameReservationCompleteness(
  database: Firestore,
  requestedEpoch: number,
): Promise<VerifyResult> {
  const ref = database.collection(COLLECTIONS.migrationControl).doc('usernameReservations');
  const snap = await ref.get();
  const current = (snap.data() ?? {}) as {
    complete?: boolean;
    maintenanceMode?: boolean;
    epoch?: number;
  };
  const complete = current.complete === true;
  const maintenanceMode = current.maintenanceMode === true;
  const epoch = typeof current.epoch === 'number' ? current.epoch : 0;

  const check = await verifyZeroMissNoOrphan(database);
  if (!check.ok) {
    return {
      ok: false,
      complete,
      maintenanceMode: maintenanceMode || true,
      epoch,
      error: check.error,
    };
  }

  if (!complete) {
    await ref.set({
      complete: true,
      epoch: 1,
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, complete: true, maintenanceMode: false, epoch: 1 };
  }

  if (maintenanceMode && requestedEpoch === epoch + 1) {
    await ref.set({
      complete: true,
      epoch: requestedEpoch,
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, complete: true, maintenanceMode: false, epoch: requestedEpoch };
  }

  return { ok: true, complete, maintenanceMode, epoch };
}

export function normalizedEquals(a: string, b: string): boolean {
  return normalizeUsername(a) === normalizeUsername(b);
}

// ── Operator CLI (import-safe; runs only when this file is process entry) ──

function cliFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return undefined;
}

function parseRequiredEpoch(argv: string[]): number {
  const raw = cliFlag(argv, 'requestedEpoch');
  if (raw === undefined) throw new Error('MISSING_REQUESTED_EPOCH: pass --requestedEpoch=<int>');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error('INVALID_REQUESTED_EPOCH');
  return n;
}

export type VerifyUsernameReservationCompletenessCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
  requestedEpoch: number;
};

export function parseVerifyUsernameReservationCompletenessCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): VerifyUsernameReservationCompletenessCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply: argv.includes('--apply'),
    requestedEpoch: parseRequiredEpoch(argv),
  };
}

export async function executeVerifyUsernameReservationCompletenessCli(
  args: VerifyUsernameReservationCompletenessCliArgs,
  deps: { database: Firestore },
): Promise<VerifyResult> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runVerifyUsernameReservationCompleteness(deps.database, args.requestedEpoch);
}

export function isVerifyUsernameReservationCompletenessCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /verifyUsernameReservationCompleteness\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: VerifyUsernameReservationCompletenessCliArgs): Promise<Firestore> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  if (!existsSync(args.credentialsPath)) {
    throw new Error(`CREDENTIALS_FILE_MISSING:${args.credentialsPath}`);
  }
  const raw = JSON.parse(readFileSync(args.credentialsPath, 'utf8')) as {
    project_id?: string;
    projectId?: string;
    client_email?: string;
    clientEmail?: string;
    private_key?: string;
    privateKey?: string;
  };
  const saProject = raw.projectId ?? raw.project_id ?? '';
  if (saProject && saProject !== args.projectId) {
    throw new Error(`PROJECT_MISMATCH: --project=${args.projectId} != service account ${saProject}`);
  }
  const existing = getApps()[0];
  if (existing) {
    const existingProject = existing.options.projectId;
    if (existingProject && existingProject !== args.projectId) {
      throw new Error(`PROJECT_MISMATCH: already initialized as ${existingProject}`);
    }
    return getFirestore(existing, args.databaseId);
  }
  const app = initializeApp({
    credential: cert({
      projectId: args.projectId,
      clientEmail: raw.clientEmail ?? raw.client_email ?? '',
      privateKey: raw.privateKey ?? raw.private_key ?? '',
    }),
    projectId: args.projectId,
  });
  return getFirestore(app, args.databaseId);
}

async function main(): Promise<void> {
  const args = parseVerifyUsernameReservationCompletenessCliArgs(process.argv.slice(2), process.env);
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  const database = await openOperatorFirestore(args);
  const result = await executeVerifyUsernameReservationCompletenessCli(args, { database });
  console.log(JSON.stringify({
    ok: result.ok,
    complete: result.complete,
    maintenanceMode: result.maintenanceMode,
    epoch: result.epoch,
    error: result.error,
  }));
  if (!result.ok) process.exit(1);
}

if (isVerifyUsernameReservationCompletenessCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
