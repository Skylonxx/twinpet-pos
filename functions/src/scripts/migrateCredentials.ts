/**
 * Canonical credential backfill + forced-rotation state machine.
 * Never executes against live data from this module's default export; tests inject a db.
 * Legacy users.pin is cleared only after every in-scope account is rotated or waived.
 *
 * Operator CLI (no work on import):
 *   npm run migrate-credentials -- --project=<id> --database=<id> --credentials=<path> --phase=backfill|cut_over_readers|clear_legacy_pin --apply
 *   npm run migrate-credentials -- --project=<id> --database=<id> --credentials=<path> --phase=waive --userId=<id> --apply
 */
import bcrypt from 'bcryptjs';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  isUsableForLogin,
  type CredentialState,
  type UserCredentialDoc,
} from '../credentialStore';
import { classifyUsers, loadAllUsersUnfiltered } from './censusUsernames';

export type MigrateCredentialsPhase =
  | 'backfill'
  | 'cut_over_readers'
  | 'clear_legacy_pin';

export type MigrateCredentialsResult = {
  ok: boolean;
  phase: MigrateCredentialsPhase;
  scanned: number;
  mutated: number;
  skipped: number;
  error?: string;
  pendingRotation?: number;
};

function inScopePin(data: Record<string, unknown>): boolean {
  return typeof data.pin === 'string' && data.pin.length > 0;
}

export async function runMigrateCredentials(
  database: Firestore,
  phase: MigrateCredentialsPhase,
): Promise<MigrateCredentialsResult> {
  const docs = await loadAllUsersUnfiltered(database);
  const live = classifyUsers(docs).live;
  const liveIds = new Set(live.map((e) => e.userId));
  let mutated = 0;
  let skipped = 0;
  let pendingRotation = 0;

  if (phase === 'backfill') {
    for (const doc of docs) {
      if (!liveIds.has(doc.id)) {
        skipped += 1;
        continue;
      }
      const data = doc.data();
      if (!inScopePin(data)) {
        skipped += 1;
        continue;
      }
      const credRef = database.collection(COLLECTIONS.userCredentials).doc(doc.id);
      const credSnap = await credRef.get();
      if (!credSnap.exists) {
        await credRef.set({
          pinHash: data.pin,
          algo: 'bcrypt',
          cost: 10,
          credentialVersion: 0,
          credentialState: 'backfilled_not_trusted' satisfies CredentialState,
          disabled: false,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'migrateCredentials',
        });
        mutated += 1;
      } else {
        skipped += 1;
      }
      const userRef = database.collection(COLLECTIONS.users).doc(doc.id);
      const userSnap = await userRef.get();
      const user = (userSnap.data() ?? {}) as { authVersion?: unknown };
      if (user.authVersion === undefined) {
        await userRef.set({ authVersion: 0 }, { merge: true });
        mutated += 1;
      }
    }
    return { ok: true, phase, scanned: docs.length, mutated, skipped };
  }

  if (phase === 'cut_over_readers') {
    const creds = await database.collection(COLLECTIONS.userCredentials).get();
    for (const cred of creds.docs) {
      const data = cred.data() as UserCredentialDoc;
      if (data.credentialState === 'backfilled_not_trusted') {
        await cred.ref.set(
          {
            credentialState: 'readers_cut_over_rotation_required' satisfies CredentialState,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        mutated += 1;
      } else {
        skipped += 1;
      }
      if (data.credentialState !== 'rotated_authoritative' && data.disabled !== true) {
        pendingRotation += 1;
      }
    }
    return { ok: true, phase, scanned: creds.size, mutated, skipped, pendingRotation };
  }

  const creds = await database.collection(COLLECTIONS.userCredentials).get();
  for (const cred of creds.docs) {
    const data = cred.data() as UserCredentialDoc;
    const done = data.credentialState === 'rotated_authoritative' || data.disabled === true;
    if (!done) pendingRotation += 1;
  }
  if (pendingRotation > 0) {
    return {
      ok: false,
      phase,
      scanned: creds.size,
      mutated: 0,
      skipped: 0,
      pendingRotation,
      error: 'LEGACY_PIN_CLEAR_BLOCKED_PENDING_ROTATION',
    };
  }
  for (const doc of docs) {
    if (!liveIds.has(doc.id)) continue;
    const data = doc.data();
    if (!inScopePin(data)) {
      skipped += 1;
      continue;
    }
    await database.collection(COLLECTIONS.users).doc(doc.id).set({ pin: '' }, { merge: true });
    mutated += 1;
  }
  return { ok: true, phase, scanned: docs.length, mutated, skipped, pendingRotation: 0 };
}

export async function waiveCredential(
  database: Firestore,
  userId: string,
): Promise<void> {
  const credRef = database.collection(COLLECTIONS.userCredentials).doc(userId);
  const credSnap = await credRef.get();
  const cred = (credSnap.data() ?? {}) as UserCredentialDoc;
  await credRef.set(
    {
      disabled: true,
      credentialVersion: (typeof cred.credentialVersion === 'number' ? cred.credentialVersion : 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'migrateCredentials:waiver',
    },
    { merge: true },
  );
  await database.collection(COLLECTIONS.users).doc(userId).set(
    { authVersion: FieldValue.increment(1) },
    { merge: true },
  );
}

export function credentialUsableForLogin(cred: UserCredentialDoc | null): boolean {
  return isUsableForLogin(cred);
}

export async function pinHashLooksLikeBcrypt(hash: string): Promise<boolean> {
  try {
    await bcrypt.getRounds(hash);
    return hash.startsWith('$2');
  } catch {
    return hash.startsWith('$2');
  }
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

export type MigrateCredentialsCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
} & (
  | { phase: MigrateCredentialsPhase }
  | { phase: 'waive'; userId: string }
);

export function parseMigrateCredentialsCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): MigrateCredentialsCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const phase = (cliFlag(argv, 'phase') ?? cliFlag(argv, 'action') ?? '').trim();
  if (!phase) {
    throw new Error('MISSING_PHASE: pass --phase=backfill|cut_over_readers|clear_legacy_pin|waive');
  }
  const base = {
    projectId,
    databaseId,
    credentialsPath,
    apply: argv.includes('--apply'),
  };
  if (phase === 'waive') {
    const userId = (cliFlag(argv, 'userId') ?? '').trim();
    if (!userId) throw new Error('MISSING_USER_ID: waive requires --userId=<id>');
    return { ...base, phase: 'waive', userId };
  }
  if (phase === 'backfill' || phase === 'cut_over_readers' || phase === 'clear_legacy_pin') {
    return { ...base, phase };
  }
  throw new Error(`INVALID_PHASE: ${phase}`);
}

export async function executeMigrateCredentialsCli(
  args: MigrateCredentialsCliArgs,
  deps: { database: Firestore },
): Promise<MigrateCredentialsResult | { ok: true; phase: 'waive'; userId: string }> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  if (args.phase === 'waive') {
    await waiveCredential(deps.database, args.userId);
    return { ok: true, phase: 'waive', userId: args.userId };
  }
  return runMigrateCredentials(deps.database, args.phase);
}

export function isMigrateCredentialsCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /migrateCredentials\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: MigrateCredentialsCliArgs): Promise<Firestore> {
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
  const args = parseMigrateCredentialsCliArgs(process.argv.slice(2), process.env);
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  const database = await openOperatorFirestore(args);
  const result = await executeMigrateCredentialsCli(args, { database });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

if (isMigrateCredentialsCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
