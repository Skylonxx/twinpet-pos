/**
 * MaintenanceMode writer.
 * Enable path (unchanged): may only request false→true, or no-op at true.
 * Hard-rejects runSetUsernameMigrationMaintenanceMode(..., false) before any write.
 * Disable path: explicit CLI --disable only; true→false while preserving complete and epoch.
 *
 * Operator CLI (no work on import):
 *   npm run set-username-migration-maintenance-mode -- --project=<id> --database=<id> --credentials=<path> --enable --apply
 *   npm run set-username-migration-maintenance-mode -- --project=<id> --database=<id> --credentials=<path> --disable --apply
 *   --enable and --disable are mutually exclusive. Neither mode fails closed.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';

export type EnterMaintenanceResult = {
  ok: boolean;
  maintenanceMode: boolean;
  noop: boolean;
  error?: string;
};

export type DisableMaintenanceResult = {
  ok: boolean;
  maintenanceMode: boolean;
  noop: boolean;
  complete: boolean;
  epoch: number;
  error?: string;
};

function isValidEpoch(epoch: unknown): epoch is number {
  return typeof epoch === 'number' && Number.isInteger(epoch) && epoch >= 0;
}

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

export async function runDisableUsernameMigrationMaintenanceMode(
  database: Firestore,
): Promise<DisableMaintenanceResult> {
  const ref = database.collection(COLLECTIONS.migrationControl).doc('usernameReservations');
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error('CONTROL_DOC_MISSING');
  }
  const current = (snap.data() ?? {}) as {
    maintenanceMode?: boolean;
    complete?: boolean;
    epoch?: number;
  };
  if (current.complete !== true) {
    throw new Error('COMPLETE_NOT_TRUE');
  }
  if (!isValidEpoch(current.epoch)) {
    throw new Error('EPOCH_INVALID');
  }
  if (current.maintenanceMode === false) {
    return {
      ok: true,
      maintenanceMode: false,
      noop: true,
      complete: true,
      epoch: current.epoch,
    };
  }
  if (current.maintenanceMode !== true) {
    throw new Error('MAINTENANCE_NOT_TRUE');
  }
  await ref.set(
    {
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  return {
    ok: true,
    maintenanceMode: false,
    noop: false,
    complete: true,
    epoch: current.epoch,
  };
}

// ── Operator CLI (import-safe; runs only when this file is process entry) ──
// --enable maps to requested=true only. --disable is the explicit true→false off-ramp.
// --requested=false / --maintenanceMode=false remain rejected (not a disable alias).

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
  mode: 'enable' | 'disable';
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
  if (requestedRaw === 'false' || requestedRaw === '0' || requestedRaw === 'off') {
    throw new Error('MAINTENANCE_FALSE_REJECTED');
  }
  const disable = argv.includes('--disable');
  const enable = argv.includes('--enable') || requestedRaw === 'true' || requestedRaw === '1' || requestedRaw === 'on';
  if (enable && disable) {
    throw new Error('INVALID_MODE: pass only --enable or --disable');
  }
  if (disable) {
    return {
      projectId,
      databaseId,
      credentialsPath,
      apply: argv.includes('--apply'),
      mode: 'disable',
    };
  }
  if (!enable) {
    throw new Error('MISSING_ENABLE: pass --enable (or --disable)');
  }
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply: argv.includes('--apply'),
    mode: 'enable',
  };
}

export async function executeSetUsernameMigrationMaintenanceModeCli(
  args: SetUsernameMigrationMaintenanceModeCliArgs,
  deps: { database: Firestore },
): Promise<EnterMaintenanceResult | DisableMaintenanceResult> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  if (args.mode === 'disable') {
    return runDisableUsernameMigrationMaintenanceMode(deps.database);
  }
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
    ...('complete' in result ? { complete: result.complete, epoch: result.epoch } : {}),
  }));
  if (!result.ok) process.exit(1);
}

if (isSetUsernameMigrationMaintenanceModeCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
