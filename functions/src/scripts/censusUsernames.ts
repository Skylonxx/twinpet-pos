/**
 * Full unfiltered users census. Absent/null deletedAt is LIVE.
 * Writes entries/{userId} batches first, header last (publish signal).
 *
 * Operator CLI (no work on import):
 *   npm run census-usernames -- --project=<id> --database=<id> --credentials=<path> --censusOperationId=<id> [--requestedEpoch=0] --apply
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { canonicalJSON, COLLECTIONS, normalizeUsername } from '../credentialStore';

export const CENSUS_NAMESPACE_DOC = 'usernameCensus';
export const CENSUS_HEADERS_SUB = 'headers';
export const CENSUS_ENTRIES_SUB = 'entries';

export type CensusEntry = {
  userId: string;
  rawUsername: string;
  normalizedUsername: string;
};

export type CensusHeader = {
  censusOperationId: string;
  createdAt: unknown;
  totalUserCount: number;
  liveUserCount: number;
  deletedUserCount: number;
  snapshotDigest: string;
  requestedEpoch: number;
  status: 'published';
};

export function isLiveDeletedAt(deletedAt: unknown): boolean {
  return deletedAt == null;
}

export function classifyUsers(
  docs: Array<{ id: string; data: () => Record<string, unknown> }>,
): { live: CensusEntry[]; deletedCount: number; totalUserCount: number } {
  const live: CensusEntry[] = [];
  let deletedCount = 0;
  for (const doc of docs) {
    const data = doc.data() ?? {};
    if (isLiveDeletedAt(data.deletedAt)) {
      const rawUsername = typeof data.username === 'string' ? data.username : '';
      live.push({
        userId: doc.id,
        rawUsername,
        normalizedUsername: normalizeUsername(rawUsername),
      });
    } else {
      deletedCount += 1;
    }
  }
  live.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return { live, deletedCount, totalUserCount: docs.length };
}

export function snapshotDigestOf(entries: CensusEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return createHash('sha256').update(canonicalJSON(sorted)).digest('hex');
}

export function censusHeaderRef(database: Firestore, censusOperationId: string) {
  return database
    .collection(COLLECTIONS.migrationControl)
    .doc(CENSUS_NAMESPACE_DOC)
    .collection(CENSUS_HEADERS_SUB)
    .doc(censusOperationId);
}

export function censusEntriesCol(database: Firestore, censusOperationId: string) {
  return censusHeaderRef(database, censusOperationId).collection(CENSUS_ENTRIES_SUB);
}

export async function loadAllUsersUnfiltered(
  database: Firestore,
): Promise<Array<{ id: string; data: () => Record<string, unknown> }>> {
  const snap = await database.collection(COLLECTIONS.users).get();
  return snap.docs.map((d) => ({
    id: d.id,
    data: () => (d.data() ?? {}) as Record<string, unknown>,
  }));
}

export async function loadPublishedCensus(
  database: Firestore,
  censusOperationId: string,
): Promise<{ header: CensusHeader; entries: CensusEntry[] }> {
  const headerSnap = await censusHeaderRef(database, censusOperationId).get();
  if (!headerSnap.exists) {
    throw new Error(`CENSUS_HEADER_ABSENT:${censusOperationId}`);
  }
  const header = headerSnap.data() as CensusHeader;
  const entriesSnap = await censusEntriesCol(database, censusOperationId).get();
  const entries = entriesSnap.docs.map((d) => d.data() as CensusEntry);
  if (entries.length !== header.liveUserCount) {
    throw new Error(`CENSUS_COUNT_MISMATCH:entries=${entries.length},header=${header.liveUserCount}`);
  }
  const digest = snapshotDigestOf(entries);
  if (digest !== header.snapshotDigest) {
    throw new Error(`CENSUS_DIGEST_MISMATCH`);
  }
  return { header, entries };
}

export async function runCensusUsernames(
  database: Firestore,
  censusOperationId: string,
  requestedEpoch = 0,
): Promise<CensusHeader> {
  const docs = await loadAllUsersUnfiltered(database);
  const classified = classifyUsers(docs);
  const snapshotDigest = snapshotDigestOf(classified.live);
  const headerRef = censusHeaderRef(database, censusOperationId);
  const entriesCol = censusEntriesCol(database, censusOperationId);

  for (let i = 0; i < classified.live.length; i += 500) {
    const chunk = classified.live.slice(i, i + 500);
    const batch = database.batch();
    for (const entry of chunk) {
      batch.set(entriesCol.doc(entry.userId), entry);
    }
    await batch.commit();
  }

  const header: CensusHeader = {
    censusOperationId,
    createdAt: FieldValue.serverTimestamp(),
    totalUserCount: classified.totalUserCount,
    liveUserCount: classified.live.length,
    deletedUserCount: classified.deletedCount,
    snapshotDigest,
    requestedEpoch,
    status: 'published',
  };
  await headerRef.set(header);
  return header;
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

function parseEpochFlag(argv: string[], defaultValue: number): number {
  const raw = cliFlag(argv, 'requestedEpoch');
  if (raw === undefined) return defaultValue;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error('INVALID_REQUESTED_EPOCH');
  return n;
}

export type CensusUsernamesCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
  censusOperationId: string;
  requestedEpoch: number;
};

export function parseCensusUsernamesCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): CensusUsernamesCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const censusOperationId = (cliFlag(argv, 'censusOperationId') ?? '').trim();
  if (!censusOperationId) throw new Error('MISSING_CENSUS_OPERATION_ID: pass --censusOperationId=<id>');
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply: argv.includes('--apply'),
    censusOperationId,
    requestedEpoch: parseEpochFlag(argv, 0),
  };
}

export async function executeCensusUsernamesCli(
  args: CensusUsernamesCliArgs,
  deps: { database: Firestore },
): Promise<CensusHeader> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runCensusUsernames(deps.database, args.censusOperationId, args.requestedEpoch);
}

export function isCensusUsernamesCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /censusUsernames\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: CensusUsernamesCliArgs): Promise<Firestore> {
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
  const args = parseCensusUsernamesCliArgs(process.argv.slice(2), process.env);
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  const database = await openOperatorFirestore(args);
  const header = await executeCensusUsernamesCli(args, { database });
  console.log(JSON.stringify({
    ok: true,
    censusOperationId: header.censusOperationId,
    liveUserCount: header.liveUserCount,
    totalUserCount: header.totalUserCount,
    deletedUserCount: header.deletedUserCount,
    snapshotDigest: header.snapshotDigest,
    requestedEpoch: header.requestedEpoch,
    status: header.status,
  }));
}

if (isCensusUsernamesCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
