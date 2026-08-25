/**
 * Asymmetric maintenanceMode writer: may only request false→true, or no-op at true.
 * Hard-rejects any request to set maintenanceMode false before any write.
 *
 * Operator CLI (no work on import). Enable only — no reverse off-ramp:
 *   npm run set-username-migration-maintenance-mode -- --project=<id> --database=<id> --credentials=<path> --enable --apply
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';

export type EnterMaintenanceResult = {
  ok: boolean;
  maintenanceMode: boolean;
  noop: boolean;
  error?: string;
};

export async function runSetUsernameMigrationMaintenanceMode(
  database: Firestore,
  requested: boolean,
): Promise<EnterMaintenanceResult> {
  if (requested === false) {
    throw new Error('MAINTENANCE_FALSE_REJECTED');
  }
  const ref = database.collection(COLLECTIONS.migrationControl).doc('usernameReservations');
  const snap = await ref.get();
  const current = (snap.data() ?? {}) as { maintenanceMode?: boolean; complete?: boolean; epoch?: number };
  if (current.maintenanceMode === true) {
    return { ok: true, maintenanceMode: true, noop: true };
  }
  await ref.set(
    {
      ...current,
      maintenanceMode: true,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  return { ok: true, maintenanceMode: true, noop: false };
}

// ── Operator CLI (import-safe; runs only when this file is process entry) ──
// Enable-only: never maps to requested=false. Reverse off-ramp is not in this CLI.

function cliFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return undefined;
}

export type SetUsernameMigrationMaintenanceModeCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
};

export function parseSetUsernameMigrationMaintenanceModeCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): SetUsernameMigrationMaintenanceModeCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const requestedRaw = (cliFlag(argv, 'requested') ?? cliFlag(argv, 'maintenanceMode') ?? '').trim().toLowerCase();
  if (
    argv.includes('--disable') ||
    requestedRaw === 'false' ||
    requestedRaw === '0' ||
    requestedRaw === 'off'
  ) {
    throw new Error('MAINTENANCE_FALSE_REJECTED');
  }
  const enable = argv.includes('--enable') || requestedRaw === 'true' || requestedRaw === '1' || requestedRaw === 'on';
  if (!enable) {
    throw new Error('MISSING_ENABLE: pass --enable (disable/false is rejected)');
  }
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply: argv.includes('--apply'),
  };
}

export async function executeSetUsernameMigrationMaintenanceModeCli(
  args: SetUsernameMigrationMaintenanceModeCliArgs,
  deps: { database: Firestore },
): Promise<EnterMaintenanceResult> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runSetUsernameMigrationMaintenanceMode(deps.database, true);
}

export function isSetUsernameMigrationMaintenanceModeCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /setUsernameMigrationMaintenanceMode\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: SetUsernameMigrationMaintenanceModeCliArgs): Promise<Firestore> {
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
  const args = parseSetUsernameMigrationMaintenanceModeCliArgs(process.argv.slice(2), process.env);
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  const database = await openOperatorFirestore(args);
  const result = await executeSetUsernameMigrationMaintenanceModeCli(args, { database });
  console.log(JSON.stringify({
    ok: result.ok,
    maintenanceMode: result.maintenanceMode,
    noop: result.noop,
    error: result.error,
  }));
  if (!result.ok) process.exit(1);
}

if (isSetUsernameMigrationMaintenanceModeCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
