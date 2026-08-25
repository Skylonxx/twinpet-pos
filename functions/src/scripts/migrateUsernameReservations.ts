/**
 * Username reservation backfill. Same A-OR-B self-gate as repair.
 * Zero writes when census binding or drift fails.
 *
 * Operator CLI (no work on import):
 *   npm run migrate-username-reservations -- --project=<id> --database=<id> --credentials=<path> --censusOperationId=<id> --snapshotDigest=<hex> --requestedEpoch=<n> [--appliedUserIds=id1,id2] --apply
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';
import { runRepairUsernameReservations, type RepairManifest, type RepairResult } from './repairUsernameReservations';

export async function reservationsSelfGateAllows(
  database: Firestore,
  requestedEpoch: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const snap = await database.collection(COLLECTIONS.migrationControl).doc('usernameReservations').get();
  const data = (snap.data() ?? {}) as {
    complete?: boolean;
    maintenanceMode?: boolean;
    epoch?: number;
  };
  const complete = data.complete === true;
  const maintenanceMode = data.maintenanceMode === true;
  const epoch = typeof data.epoch === 'number' ? data.epoch : 0;
  if (!complete) return { allowed: true };
  if (complete && maintenanceMode && requestedEpoch === epoch + 1) return { allowed: true };
  return { allowed: false, reason: 'SELF_GATE_DENIED' };
}

export async function runMigrateUsernameReservations(
  database: Firestore,
  manifest: RepairManifest,
  requestedEpoch: number,
): Promise<RepairResult> {
  const gate = await reservationsSelfGateAllows(database, requestedEpoch);
  if (!gate.allowed) {
    return { ok: false, writes: 0, applied: [], error: gate.reason };
  }
  return runRepairUsernameReservations(database, manifest);
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

function parseAppliedUserIds(argv: string[]): string[] | undefined {
  const raw = cliFlag(argv, 'appliedUserIds');
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseRequiredEpoch(argv: string[]): number {
  const raw = cliFlag(argv, 'requestedEpoch');
  if (raw === undefined) throw new Error('MISSING_REQUESTED_EPOCH: pass --requestedEpoch=<int>');
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error('INVALID_REQUESTED_EPOCH');
  return n;
}

export type MigrateUsernameReservationsCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
  censusOperationId: string;
  snapshotDigest: string;
  requestedEpoch: number;
  appliedUserIds?: string[];
};

export function parseMigrateUsernameReservationsCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): MigrateUsernameReservationsCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const censusOperationId = (cliFlag(argv, 'censusOperationId') ?? '').trim();
  const snapshotDigest = (cliFlag(argv, 'snapshotDigest') ?? '').trim();
  if (!censusOperationId) throw new Error('MISSING_CENSUS_OPERATION_ID: pass --censusOperationId=<id>');
  if (!snapshotDigest) throw new Error('MISSING_SNAPSHOT_DIGEST: pass --snapshotDigest=<hex>');
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply: argv.includes('--apply'),
    censusOperationId,
    snapshotDigest,
    requestedEpoch: parseRequiredEpoch(argv),
    appliedUserIds: parseAppliedUserIds(argv),
  };
}

export async function executeMigrateUsernameReservationsCli(
  args: MigrateUsernameReservationsCliArgs,
  deps: { database: Firestore },
): Promise<RepairResult> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runMigrateUsernameReservations(
    deps.database,
    {
      censusOperationId: args.censusOperationId,
      snapshotDigest: args.snapshotDigest,
      appliedUserIds: args.appliedUserIds,
    },
    args.requestedEpoch,
  );
}

export function isMigrateUsernameReservationsCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /migrateUsernameReservations\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: MigrateUsernameReservationsCliArgs): Promise<Firestore> {
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
  const args = parseMigrateUsernameReservationsCliArgs(process.argv.slice(2), process.env);
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  const database = await openOperatorFirestore(args);
  const result = await executeMigrateUsernameReservationsCli(args, { database });
  console.log(JSON.stringify({
    ok: result.ok,
    writes: result.writes,
    appliedCount: result.applied.length,
    error: result.error,
    driftedUserIds: result.driftedUserIds,
  }));
  if (!result.ok) process.exit(1);
}

if (isMigrateUsernameReservationsCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
