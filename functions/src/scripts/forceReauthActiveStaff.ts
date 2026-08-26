/**
 * Stage-8 operator CLI: revoke refresh tokens for every Firebase Auth UID that
 * currently represents an active, non-deleted staff identity.
 *
 * Identity model:
 *   - Active staff come from Firestore users (isActive === true, deletedAt == null).
 *   - Auth UIDs are discovered by fully paginated auth.listUsers — never assumed
 *     equal to users/{staffId}.
 *   - An Auth UID is relevant when either:
 *       A. customClaims.staffId === activeStaffId (anonymous PIN sessions)
 *       B. auth uid === activeStaffId (canonical Auth account)
 *   - Duplicate UIDs are collapsed with a Set. Planning finishes before the first
 *     revoke. Page-enumeration failure yields zero revokes.
 *
 * Mutation authority: Auth.revokeRefreshTokens(uid) only.
 *
 * Direct run after functions build (no package.json script in this packet):
 *   node lib/scripts/forceReauthActiveStaff.js --project=<id> --database=<id> --credentials=<path> --dry-run
 *   node lib/scripts/forceReauthActiveStaff.js --project=<id> --database=<id> --credentials=<path> --apply
 *   --dry-run and --apply are mutually exclusive. Neither mode fails closed.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { isLiveDeletedAt, loadAllUsersUnfiltered } from './censusUsernames';

export const AUTH_LIST_USERS_PAGE_SIZE = 1000;

export type ForceReauthListedUser = {
  uid: string;
  customClaims?: Record<string, unknown> | null;
};

export type ForceReauthListUsersPage = {
  users: ForceReauthListedUser[];
  pageToken?: string;
};

export type ForceReauthAuth = {
  listUsers(maxResults?: number, pageToken?: string): Promise<ForceReauthListUsersPage>;
  revokeRefreshTokens(uid: string): Promise<void>;
};

export type ForceReauthTarget = {
  userId: string;
  username: string;
  authUids: string[];
};

export type ForceReauthPerStaffMappedUidCount = {
  userId: string;
  mappedUidCount: number;
};

export type ForceReauthInvalidTarget = {
  userId: string;
  username: string;
  reason: string;
};

export type ForceReauthFailedRevoke = {
  userId: string;
  username: string;
  authUid: string;
  error: string;
};

export type ForceReauthPlan = {
  ok: boolean;
  targets: ForceReauthTarget[];
  revokeUids: string[];
  invalidTargets: ForceReauthInvalidTarget[];
  activeStaffCount: number;
  authUsersScanned: number;
  authPagesScanned: number;
  mappedAuthUidCount: number;
  perStaffMappedUidCount: ForceReauthPerStaffMappedUidCount[];
  nonTargetClaimCount: number;
  error?: string;
};

export type ForceReauthResult = {
  ok: boolean;
  dryRun: boolean;
  complete: boolean;
  targetCount: number;
  revokedCount: number;
  failedCount: number;
  activeStaffCount: number;
  authUsersScanned: number;
  authPagesScanned: number;
  mappedAuthUidCount: number;
  perStaffMappedUidCount: ForceReauthPerStaffMappedUidCount[];
  nonTargetClaimCount: number;
  targets: Array<{ userId: string; username: string }>;
  failed?: ForceReauthFailedRevoke[];
  invalidTargets?: ForceReauthInvalidTarget[];
  error?: string;
};

function usernameOf(data: Record<string, unknown>): string {
  return typeof data.username === 'string' ? data.username : '';
}

function isActiveStaff(data: Record<string, unknown>): boolean {
  return data.isActive === true && isLiveDeletedAt(data.deletedAt);
}

function userIdentityInconsistent(userId: string, data: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(data, 'id')) return false;
  const embedded = data.id;
  if (embedded == null) return false;
  if (typeof embedded !== 'string' || !embedded.trim()) return true;
  return embedded.trim() !== userId;
}

function lookupErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function claimStaffIdOf(user: ForceReauthListedUser): string | undefined {
  const claims = user.customClaims;
  if (!claims || typeof claims !== 'object') return undefined;
  const raw = claims.staffId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function emptyPlan(partial: Partial<ForceReauthPlan> & { error: string }): ForceReauthPlan {
  return {
    ok: false,
    targets: [],
    revokeUids: [],
    invalidTargets: partial.invalidTargets ?? [],
    activeStaffCount: partial.activeStaffCount ?? 0,
    authUsersScanned: partial.authUsersScanned ?? 0,
    authPagesScanned: partial.authPagesScanned ?? 0,
    mappedAuthUidCount: 0,
    perStaffMappedUidCount: partial.perStaffMappedUidCount ?? [],
    nonTargetClaimCount: partial.nonTargetClaimCount ?? 0,
    error: partial.error,
  };
}

async function listAllAuthUsers(auth: ForceReauthAuth): Promise<{
  ok: boolean;
  users: ForceReauthListedUser[];
  pages: number;
  error?: string;
}> {
  const users: ForceReauthListedUser[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  const seenTokens = new Set<string>();

  do {
    if (pageToken) {
      if (seenTokens.has(pageToken)) {
        return { ok: false, users: [], pages, error: 'AUTH_ENUMERATION_TOKEN_LOOP' };
      }
      seenTokens.add(pageToken);
    }
    try {
      const page = await auth.listUsers(AUTH_LIST_USERS_PAGE_SIZE, pageToken);
      const batch = page?.users;
      if (!Array.isArray(batch)) {
        return { ok: false, users: [], pages, error: 'AUTH_ENUMERATION_MALFORMED_PAGE' };
      }
      pages += 1;
      users.push(...batch);
      const next = typeof page.pageToken === 'string' ? page.pageToken.trim() : '';
      pageToken = next || undefined;
    } catch (err) {
      return {
        ok: false,
        users: [],
        pages,
        error: `AUTH_ENUMERATION_FAILED:${lookupErrorMessage(err)}`,
      };
    }
  } while (pageToken);

  return { ok: true, users, pages };
}

function mapAuthUsersToActiveStaff(
  activeStaff: Array<{ userId: string; username: string }>,
  authUsers: ForceReauthListedUser[],
): { ok: true; targets: ForceReauthTarget[]; revokeUids: string[]; nonTargetClaimCount: number }
  | { ok: false; error: string; nonTargetClaimCount: number } {
  const activeIds = new Set(activeStaff.map((s) => s.userId));
  const uidsByStaff = new Map<string, Set<string>>();
  for (const staff of activeStaff) {
    uidsByStaff.set(staff.userId, new Set());
  }

  let nonTargetClaimCount = 0;

  for (const user of authUsers) {
    if (!user || typeof user.uid !== 'string' || !user.uid.trim()) {
      return { ok: false, error: 'AUTH_RECORD_MALFORMED', nonTargetClaimCount };
    }
    const uid = user.uid;
    const mapped = new Set<string>();
    if (activeIds.has(uid)) {
      mapped.add(uid);
    }
    const claimStaffId = claimStaffIdOf(user);
    if (claimStaffId) {
      if (activeIds.has(claimStaffId)) {
        mapped.add(claimStaffId);
      } else {
        nonTargetClaimCount += 1;
      }
    }
    if (mapped.size > 1) {
      return { ok: false, error: 'AUTH_UID_AMBIGUOUS', nonTargetClaimCount };
    }
    if (mapped.size === 1) {
      const staffId = [...mapped][0]!;
      uidsByStaff.get(staffId)!.add(uid);
    }
  }

  const targets: ForceReauthTarget[] = [];
  const revokeUids: string[] = [];
  const seen = new Set<string>();
  for (const staff of activeStaff) {
    const authUids = [...(uidsByStaff.get(staff.userId) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    targets.push({ userId: staff.userId, username: staff.username, authUids });
    for (const authUid of authUids) {
      if (seen.has(authUid)) {
        return { ok: false, error: 'AUTH_UID_AMBIGUOUS', nonTargetClaimCount };
      }
      seen.add(authUid);
      revokeUids.push(authUid);
    }
  }

  return { ok: true, targets, revokeUids, nonTargetClaimCount };
}

export async function planForceReauthActiveStaff(
  database: Firestore,
  auth: ForceReauthAuth,
): Promise<ForceReauthPlan> {
  const docs = await loadAllUsersUnfiltered(database);
  const candidates = docs.filter((doc) => isActiveStaff(doc.data()));
  candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const invalidTargets: ForceReauthInvalidTarget[] = [];
  const activeStaff: Array<{ userId: string; username: string }> = [];

  for (const doc of candidates) {
    const data = doc.data();
    const username = usernameOf(data);
    if (userIdentityInconsistent(doc.id, data)) {
      invalidTargets.push({
        userId: doc.id,
        username,
        reason: 'USER_ID_INCONSISTENT',
      });
      continue;
    }
    activeStaff.push({ userId: doc.id, username });
  }

  const perStaffZero = activeStaff.map((s) => ({ userId: s.userId, mappedUidCount: 0 }));

  if (invalidTargets.length > 0) {
    return emptyPlan({
      invalidTargets,
      activeStaffCount: candidates.length,
      perStaffMappedUidCount: perStaffZero,
      error: invalidTargets[0]?.reason ?? 'TARGET_SET_INVALID',
    });
  }

  if (activeStaff.length === 0) {
    return emptyPlan({
      activeStaffCount: 0,
      perStaffMappedUidCount: [],
      error: 'TARGET_SET_EMPTY',
    });
  }

  const listed = await listAllAuthUsers(auth);
  if (!listed.ok) {
    return emptyPlan({
      activeStaffCount: activeStaff.length,
      authUsersScanned: 0,
      authPagesScanned: listed.pages,
      perStaffMappedUidCount: perStaffZero,
      error: listed.error ?? 'AUTH_ENUMERATION_FAILED',
    });
  }

  const mapped = mapAuthUsersToActiveStaff(activeStaff, listed.users);
  if (!mapped.ok) {
    return emptyPlan({
      activeStaffCount: activeStaff.length,
      authUsersScanned: listed.users.length,
      authPagesScanned: listed.pages,
      nonTargetClaimCount: mapped.nonTargetClaimCount,
      perStaffMappedUidCount: perStaffZero,
      error: mapped.error,
    });
  }

  const perStaffMappedUidCount = mapped.targets.map((t) => ({
    userId: t.userId,
    mappedUidCount: t.authUids.length,
  }));

  return {
    ok: true,
    targets: mapped.targets,
    revokeUids: mapped.revokeUids,
    invalidTargets: [],
    activeStaffCount: activeStaff.length,
    authUsersScanned: listed.users.length,
    authPagesScanned: listed.pages,
    mappedAuthUidCount: mapped.revokeUids.length,
    perStaffMappedUidCount,
    nonTargetClaimCount: mapped.nonTargetClaimCount,
  };
}

function publicTargets(targets: ForceReauthTarget[]): Array<{ userId: string; username: string }> {
  return targets.map((t) => ({ userId: t.userId, username: t.username }));
}

function resultFromPlan(
  plan: ForceReauthPlan,
  rest: Pick<ForceReauthResult, 'ok' | 'dryRun' | 'complete' | 'revokedCount' | 'failedCount'> & {
    failed?: ForceReauthFailedRevoke[];
    error?: string;
  },
): ForceReauthResult {
  return {
    ok: rest.ok,
    dryRun: rest.dryRun,
    complete: rest.complete,
    targetCount: plan.mappedAuthUidCount,
    revokedCount: rest.revokedCount,
    failedCount: rest.failedCount,
    activeStaffCount: plan.activeStaffCount,
    authUsersScanned: plan.authUsersScanned,
    authPagesScanned: plan.authPagesScanned,
    mappedAuthUidCount: plan.mappedAuthUidCount,
    perStaffMappedUidCount: plan.perStaffMappedUidCount,
    nonTargetClaimCount: plan.nonTargetClaimCount,
    targets: publicTargets(plan.targets),
    ...(rest.failed && rest.failed.length > 0 ? { failed: rest.failed } : {}),
    ...(plan.invalidTargets.length > 0 ? { invalidTargets: plan.invalidTargets } : {}),
    ...(rest.error || plan.error ? { error: rest.error ?? plan.error } : {}),
  };
}

function staffForUid(targets: ForceReauthTarget[], authUid: string): { userId: string; username: string } {
  for (const target of targets) {
    if (target.authUids.includes(authUid)) {
      return { userId: target.userId, username: target.username };
    }
  }
  return { userId: '', username: '' };
}

export async function runForceReauthActiveStaff(
  database: Firestore,
  auth: ForceReauthAuth,
  options: { dryRun: boolean },
): Promise<ForceReauthResult> {
  const plan = await planForceReauthActiveStaff(database, auth);
  const dryRun = options.dryRun === true;

  if (!plan.ok) {
    return resultFromPlan(plan, {
      ok: false,
      dryRun,
      complete: false,
      revokedCount: 0,
      failedCount: 0,
      error: plan.error,
    });
  }

  if (dryRun) {
    return resultFromPlan(plan, {
      ok: true,
      dryRun: true,
      complete: false,
      revokedCount: 0,
      failedCount: 0,
    });
  }

  const failed: ForceReauthFailedRevoke[] = [];
  let revokedCount = 0;
  for (const authUid of plan.revokeUids) {
    try {
      await auth.revokeRefreshTokens(authUid);
      revokedCount += 1;
    } catch (err) {
      const staff = staffForUid(plan.targets, authUid);
      failed.push({
        userId: staff.userId,
        username: staff.username,
        authUid,
        error: lookupErrorMessage(err),
      });
    }
  }

  const failedCount = failed.length;
  const complete = failedCount === 0 && revokedCount === plan.revokeUids.length;
  return resultFromPlan(plan, {
    ok: complete,
    dryRun: false,
    complete,
    revokedCount,
    failedCount,
    ...(failedCount > 0 ? { failed, error: 'PARTIAL_REVOKE_FAILURE' } : {}),
  });
}

function cliFlag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
  return undefined;
}

export type ForceReauthActiveStaffCliArgs = {
  projectId: string;
  databaseId: string;
  credentialsPath: string;
  apply: boolean;
  dryRun: boolean;
};

export function parseForceReauthActiveStaffCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = {},
): ForceReauthActiveStaffCliArgs {
  const projectId = (cliFlag(argv, 'project') ?? '').trim();
  const databaseId = (cliFlag(argv, 'database') ?? '').trim();
  const credentialsPath = (cliFlag(argv, 'credentials') ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim();
  if (!projectId) throw new Error('MISSING_PROJECT: pass --project=<id> (no default)');
  if (!databaseId) throw new Error('MISSING_DATABASE: pass --database=<id> (no default)');
  if (!credentialsPath) {
    throw new Error('MISSING_CREDENTIALS: pass --credentials=<path> or GOOGLE_APPLICATION_CREDENTIALS');
  }
  const apply = argv.includes('--apply');
  const dryRun = argv.includes('--dry-run');
  if (apply && dryRun) throw new Error('INVALID_MODE: pass only --dry-run or --apply');
  if (!apply && !dryRun) throw new Error('MISSING_MODE: pass --dry-run or --apply');
  return {
    projectId,
    databaseId,
    credentialsPath,
    apply,
    dryRun,
  };
}

export async function executeForceReauthActiveStaffCli(
  args: ForceReauthActiveStaffCliArgs,
  deps: { database: Firestore; auth: ForceReauthAuth },
): Promise<ForceReauthResult> {
  if (args.dryRun) {
    return runForceReauthActiveStaff(deps.database, deps.auth, { dryRun: true });
  }
  if (!args.apply) throw new Error('MISSING_APPLY: pass --apply to execute');
  return runForceReauthActiveStaff(deps.database, deps.auth, { dryRun: false });
}

export function formatForceReauthActiveStaffResult(result: ForceReauthResult): string {
  return JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    complete: result.complete,
    activeStaffCount: result.activeStaffCount,
    authUsersScanned: result.authUsersScanned,
    authPagesScanned: result.authPagesScanned,
    mappedAuthUidCount: result.mappedAuthUidCount,
    perStaffMappedUidCount: result.perStaffMappedUidCount,
    nonTargetClaimCount: result.nonTargetClaimCount,
    targetCount: result.targetCount,
    revokedCount: result.revokedCount,
    failedCount: result.failedCount,
    targets: result.targets,
    failed: result.failed,
    invalidTargets: result.invalidTargets,
    error: result.error,
  });
}

export function isForceReauthActiveStaffCliEntry(entry = process.argv[1] ?? ''): boolean {
  return /forceReauthActiveStaff\.(ts|js)$/.test(entry.replace(/\\/g, '/'));
}

async function openOperatorClients(
  args: ForceReauthActiveStaffCliArgs,
): Promise<{ database: Firestore; auth: ForceReauthAuth }> {
  const { readFileSync, existsSync } = await import('node:fs');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { getAuth } = await import('firebase-admin/auth');
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
    return {
      database: getFirestore(existing, args.databaseId),
      auth: getAuth(existing),
    };
  }
  const app = initializeApp({
    credential: cert({
      projectId: args.projectId,
      clientEmail: raw.clientEmail ?? raw.client_email ?? '',
      privateKey: raw.privateKey ?? raw.private_key ?? '',
    }),
    projectId: args.projectId,
  });
  return {
    database: getFirestore(app, args.databaseId),
    auth: getAuth(app),
  };
}

async function main(): Promise<void> {
  const args = parseForceReauthActiveStaffCliArgs(process.argv.slice(2), process.env);
  const clients = await openOperatorClients(args);
  const result = await executeForceReauthActiveStaffCli(args, clients);
  console.log(formatForceReauthActiveStaffResult(result));
  if (!result.ok) process.exit(1);
}

if (isForceReauthActiveStaffCliEntry()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
