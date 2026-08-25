/**
 * Repair username reservations from a durable census.
 * 8-step load: header → entries → count → digest → manifest binding → re-scan → fwd/bwd drift → halt.
 * Applied-entry targets occupy uniqueness for later undone entries.
 *
 * Operator CLI (no work on import):
 *   npm run repair-username-reservations -- --project=<id> --database=<id> --credentials=<path> --censusOperationId=<id> --snapshotDigest=<hex> [--appliedUserIds=id1,id2] --apply
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';
import {
  classifyUsers,
  loadAllUsersUnfiltered,
  loadPublishedCensus,
  type CensusEntry,
} from './censusUsernames';

export type RepairManifest = {
  censusOperationId: string;
  snapshotDigest: string;
  appliedUserIds?: string[];
};

export type RepairResult = {
  ok: boolean;
  writes: number;
  applied: string[];
  error?: string;
  driftedUserIds?: string[];
};

function liveMap(entries: CensusEntry[]): Map<string, CensusEntry> {
  return new Map(entries.map((e) => [e.userId, e]));
}

export function detectDrift(
  censusEntries: CensusEntry[],
  currentLive: CensusEntry[],
): string[] {
  const a = liveMap(censusEntries);
  const b = liveMap(currentLive);
  const drifted = new Set<string>();
  for (const [id, entry] of a) {
    const now = b.get(id);
    if (!now) {
      drifted.add(id);
      continue;
    }
    if (now.normalizedUsername !== entry.normalizedUsername) drifted.add(id);
  }
  for (const [id] of b) {
    if (!a.has(id)) drifted.add(id);
  }
  return [...drifted].sort();
}

export function planReservationWrites(
  entries: CensusEntry[],
  alreadyApplied: Set<string>,
): { ok: true; writes: Array<{ username: string; userId: string }> } | { ok: false; error: string } {
  const occupied = new Map<string, string>();
  const writes: Array<{ username: string; userId: string }> = [];
  const ordered = [...entries].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  for (const entry of ordered) {
    if (!entry.normalizedUsername) {
      return { ok: false, error: `EMPTY_USERNAME:${entry.userId}` };
    }
    const owner = occupied.get(entry.normalizedUsername);
    if (owner && owner !== entry.userId) {
      return { ok: false, error: `NORMALIZATION_COLLISION:${entry.normalizedUsername}:${owner}:${entry.userId}` };
    }
    occupied.set(entry.normalizedUsername, entry.userId);
    if (!alreadyApplied.has(entry.userId)) {
      writes.push({ username: entry.normalizedUsername, userId: entry.userId });
    }
  }
  return { ok: true, writes };
}

export async function runRepairUsernameReservations(
  database: Firestore,
  manifest: RepairManifest,
): Promise<RepairResult> {
  let published;
  try {
    published = await loadPublishedCensus(database, manifest.censusOperationId);
  } catch (err) {
    return { ok: false, writes: 0, applied: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (manifest.snapshotDigest !== published.header.snapshotDigest) {
    return { ok: false, writes: 0, applied: [], error: 'MANIFEST_BINDING_MISMATCH' };
  }

  const currentDocs = await loadAllUsersUnfiltered(database);
  const current = classifyUsers(currentDocs).live;
  const drifted = detectDrift(published.entries, current);
  if (drifted.length > 0) {
    return { ok: false, writes: 0, applied: [], error: 'DRIFT_HALT', driftedUserIds: drifted };
  }

  const alreadyApplied = new Set(manifest.appliedUserIds ?? []);
  const plan = planReservationWrites(published.entries, alreadyApplied);
  if (!plan.ok) return { ok: false, writes: 0, applied: [], error: plan.error };

  let writes = 0;
  const applied = [...alreadyApplied];
  for (const item of plan.writes) {
    await database.collection(COLLECTIONS.usernames).doc(item.username).set({
      userId: item.userId,
      reservedAt: new Date().toISOString(),
    });
    writes += 1;
    applied.push(item.userId);
  }
  return { ok: true, writes, applied };
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

export type RepairUsernameReservationsCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
  censusOperationId: string;
  snapshotDigest: string;
  appliedUserIds?: string[];
};

export function parseRepairUsernameReservationsCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): RepairUsernameReservationsCliArgs {
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
    appliedUserIds: parseAppliedUserIds(argv),
  };
}

export async function executeRepairUsernameReservationsCli(
  args: RepairUsernameReservationsCliArgs,
  deps: { database: Firestore },
): Promise<RepairResult> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runRepairUsernameReservations(deps.database, {
    censusOperationId: args.censusOperationId,
    snapshotDigest: args.snapshotDigest,
    appliedUserIds: args.appliedUserIds,
  });
}

export function isRepairUsernameReservationsCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /repairUsernameReservations\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: RepairUsernameReservationsCliArgs): Promise<Firestore> {
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
  const args = parseRepairUsernameReservationsCliArgs(process.argv.slice(2), process.env);
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  const database = await openOperatorFirestore(args);
  const result = await executeRepairUsernameReservationsCli(args, { database });
  console.log(JSON.stringify({
    ok: result.ok,
    writes: result.writes,
    appliedCount: result.applied.length,
    error: result.error,
    driftedUserIds: result.driftedUserIds,
  }));
  if (!result.ok) process.exit(1);
}

if (isRepairUsernameReservationsCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
