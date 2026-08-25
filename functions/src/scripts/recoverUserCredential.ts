/**
 * P2 operator recovery: resolve target by --userId or full-scan --username,
 * then call setUserAccountCore rotate in-process. Never auth.createUser.
 * Never logs the PIN.
 *
 * Operator CLI (no work on import):
 *   npm run recover-user-credential -- --project=<id> --database=<id> --credentials=<path> --userId=<id>|--username=<name> --dry-run
 *   npm run recover-user-credential -- --project=<id> --database=<id> --credentials=<path> --userId=<id>|--username=<name> --rotateIdempotencyKey=<key> --pin=<pin> --apply
 *   --dry-run and --apply are mutually exclusive.
 *   PIN may instead come from RECOVER_USER_PIN (never logged). Dry-run does not require PIN.
 */
import { performSetUserAccount, type SetUserAccountResult } from '../setUserAccountCore';
import { loadAllUsersUnfiltered } from './censusUsernames';
import { COLLECTIONS, normalizeUsername } from '../credentialStore';
import type { Firestore } from 'firebase-admin/firestore';

export type RecoverTarget =
  | { userId: string }
  | { username: string };

export async function resolveRecoveryUserId(
  database: Firestore,
  target: RecoverTarget,
): Promise<{ ok: true; userId: string } | { ok: false; error: string; candidateUserIds?: string[] }> {
  if ('userId' in target && target.userId.trim()) {
    return { ok: true, userId: target.userId.trim() };
  }
  if (!('username' in target)) return { ok: false, error: 'MISSING_TARGET' };
  const wanted = normalizeUsername(target.username);
  const docs = await loadAllUsersUnfiltered(database);
  const matches: string[] = [];
  for (const doc of docs) {
    const data = doc.data();
    if (data.deletedAt != null) continue;
    if (normalizeUsername(String(data.username ?? '')) === wanted) matches.push(doc.id);
  }
  if (matches.length === 1) return { ok: true, userId: matches[0]! };
  if (matches.length === 0) return { ok: false, error: 'USERNAME_NOT_FOUND' };
  return { ok: false, error: 'USERNAME_AMBIGUOUS', candidateUserIds: matches };
}

export async function runRecoverUserCredential(
  database: Firestore,
  target: RecoverTarget,
  pin: string,
  rotateIdempotencyKey: string,
): Promise<SetUserAccountResult> {
  const resolved = await resolveRecoveryUserId(database, target);
  if (!resolved.ok) {
    return { ok: false, status: 'not_found', message: resolved.error };
  }
  return performSetUserAccount(
    database,
    { kind: 'operator_cli' },
    {
      op: 'rotate',
      rotateIdempotencyKey,
      userId: resolved.userId,
      pin,
      reasonCode: 'p2_operator_recovery',
    },
  );
}

export type RecoverTargetKind = 'userId' | 'username';

export type RecoverUserCredentialDryRunResult = {
  ok: boolean;
  dryRun: true;
  userId?: string;
  targetKind: RecoverTargetKind;
  resolvable: boolean;
  status: string;
};

function recoverTargetKind(target: RecoverTarget): RecoverTargetKind {
  return 'userId' in target ? 'userId' : 'username';
}

export async function runRecoverUserCredentialDryRun(
  database: Firestore,
  target: RecoverTarget,
): Promise<RecoverUserCredentialDryRunResult> {
  const targetKind = recoverTargetKind(target);
  const resolved = await resolveRecoveryUserId(database, target);
  if (!resolved.ok) {
    return {
      ok: false,
      dryRun: true,
      targetKind,
      resolvable: false,
      status: resolved.error,
    };
  }
  const userSnap = await database.collection(COLLECTIONS.users).doc(resolved.userId).get();
  if (!userSnap.exists) {
    return {
      ok: false,
      dryRun: true,
      userId: resolved.userId,
      targetKind,
      resolvable: false,
      status: 'USER_NOT_FOUND',
    };
  }
  return {
    ok: true,
    dryRun: true,
    userId: resolved.userId,
    targetKind,
    resolvable: true,
    status: 'RESOLVED',
  };
}

// ── Operator CLI (import-safe; runs only when this file is process entry) ──
// Never auth.createUser. Never logs the PIN.

function cliFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return undefined;
}

export type RecoverUserCredentialCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
  dryRun: boolean;
  target: RecoverTarget;
  pin: string;
  rotateIdempotencyKey: string;
};

export function parseRecoverUserCredentialCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): RecoverUserCredentialCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const userId = (cliFlag(argv, 'userId') ?? '').trim();
  const username = (cliFlag(argv, 'username') ?? '').trim();
  if (userId && username) throw new Error('INVALID_TARGET: pass only --userId or --username');
  if (!userId && !username) throw new Error('MISSING_TARGET: pass --userId=<id> or --username=<name>');
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');
  if (apply && dryRun) throw new Error('INVALID_MODE: pass only --dry-run or --apply');
  if (dryRun) {
    return {
      projectId,
      databaseId,
      credentialsPath,
      apply: false,
      dryRun: true,
      target: userId ? { userId } : { username },
      pin: '',
      rotateIdempotencyKey: '',
    };
  }
  const pin = (cliFlag(argv, 'pin') ?? env.RECOVER_USER_PIN ?? '').trim();
  if (!pin) throw new Error('MISSING_PIN: pass --pin=<pin> or RECOVER_USER_PIN');
  const rotateIdempotencyKey = (cliFlag(argv, 'rotateIdempotencyKey') ?? '').trim();
  if (!rotateIdempotencyKey) throw new Error('MISSING_ROTATE_IDEMPOTENCY_KEY: pass --rotateIdempotencyKey=<key>');
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply,
    dryRun: false,
    target: userId ? { userId } : { username },
    pin,
    rotateIdempotencyKey,
  };
}

export async function executeRecoverUserCredentialCli(
  args: RecoverUserCredentialCliArgs,
  deps: { database: Firestore },
): Promise<SetUserAccountResult> {
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runRecoverUserCredential(deps.database, args.target, args.pin, args.rotateIdempotencyKey);
}

export function formatRecoverUserCredentialCliResult(result: SetUserAccountResult): string {
  return JSON.stringify({
    ok: result.ok,
    status: result.status,
    userId: result.userId,
    authVersion: result.authVersion,
    credentialVersion: result.credentialVersion,
    message: result.message,
  });
}

export function formatRecoverUserCredentialDryRunResult(result: RecoverUserCredentialDryRunResult): string {
  return JSON.stringify({
    ok: result.ok,
    dryRun: true,
    userId: result.userId,
    targetKind: result.targetKind,
    resolvable: result.resolvable,
    status: result.status,
  });
}

export function isRecoverUserCredentialCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /recoverUserCredential\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorFirestore(args: RecoverUserCredentialCliArgs): Promise<Firestore> {
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

function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

async function main(): Promise<void> {
  const args = parseRecoverUserCredentialCliArgs(process.argv.slice(2), process.env);
  try {
    if (args.dryRun) {
      const database = await openOperatorFirestore(args);
      const result = await runRecoverUserCredentialDryRun(database, args.target);
      console.log(redactSecret(formatRecoverUserCredentialDryRunResult(result), args.pin));
      if (!result.ok) process.exit(1);
      return;
    }
    if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
    const database = await openOperatorFirestore(args);
    const result = await executeRecoverUserCredentialCli(args, { database });
    console.log(redactSecret(formatRecoverUserCredentialCliResult(result), args.pin));
    if (!result.ok) process.exit(1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(redactSecret(message, args.pin));
    process.exit(1);
  }
}

if (isRecoverUserCredentialCliEntry()) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
