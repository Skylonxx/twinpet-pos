/**
 * Admin & Security Center V1 — the single service the in-POS admin surface
 * uses for credential / authority administration.
 *
 * Access model (frozen):
 *   - every action requires the CURRENT PRIMARY Firebase user to be the
 *     operator's own username+password account (non-anonymous, UID = staff
 *     id, `signInProvider === 'password'`, claims `role=admin`). A Quick PIN
 *     session — including an admin's — never qualifies. The server enforces
 *     the same rule (`setUserAccount`, `getAdminSecurityOverview`,
 *     `issuePrivilegedLockoutClear`); this gate only avoids calls that must
 *     be refused;
 *   - an admin never mutates their own account here (a password session's
 *     claims are static, so bumping its own authVersion would strand it);
 *   - D-ASC8/D-ASC9/D-ASC12/D-ASC13: ANY row is mutable ONLY when the
 *     server classified it `QUICK_PIN_ONLY` (no Firebase Auth user, so no
 *     static password claims an authVersion bump could strand); an `admin`
 *     row must also be `POS_ADMIN`. A password-backed row (Security Admin, or
 *     a username/password staff / manager) or an `UNKNOWN` row is read-only
 *     here — no edit, PIN, enable/disable, OAC reissue or lockout clear. The
 *     server refuses the same targets independently.
 *
 * Mutation discipline: one explicit action = exactly one canonical
 * `setUserAccount` call. Nothing is retried. A server-accepted mutation of a
 * user — and an unknown outcome — immediately removes ONLY that user's local
 * OAC slot on this terminal (every accepted op bumps the target's
 * authVersion, which server adjudication already treats as revoking that
 * OAC). A definite refusal touches nothing. PINs are passed straight to the
 * callable / ceremony and never stored, logged or returned.
 */

import { getIdTokenResult } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { app, auth, collections, db, getEmulatorHost, isFirebaseConfigured, USE_EMULATOR } from '../firebase';
import { setUserAccount, SetUserAccountError, type SetUserAccountClientCommand, type SetUserAccountClientResult } from '../auth/setUserAccount';
import {
  runPrivilegedLockoutRecovery,
  type PrivilegedLockoutRecoveryDeps,
  type PrivilegedLockoutRecoveryOutcome,
} from '../auth/privilegedLockoutRecovery';
import {
  provisionManagerOac,
  type ProvisionManagerOacDeps,
  type ProvisionManagerOacOutcome,
} from '../pos/privilegedVoid/provisionManagerOac';
import { cloneDefaultMatrix, permissionsForRole, ROLE_PERMISSIONS_DOC_ID, type RolePermissionMatrix } from '../staffManagement/types';
import type { UserRole } from '../types';
import { revokeManagerOac, type ManagerOacRevokeResult } from './managerOac';

export const ADMIN_PIN_RE = /^\d{4}$/;
export const ADMIN_SECURITY_ROLES: readonly UserRole[] = ['admin', 'manager', 'staff'];

export type AdminOperator = { id: string; role: string } | null | undefined;

export type SecurityAdminClassification = 'PASSWORD_ADMIN' | 'POS_ADMIN' | 'UNKNOWN';
export type AccountAuthClassification = 'QUICK_PIN_ONLY' | 'PASSWORD_PRINCIPAL' | 'UNKNOWN';

export type AdminSecurityUser = {
  userId: string;
  firstName: string;
  lastName: string;
  username: string;
  role: UserRole;
  branchIds: string[];
  isActive: boolean;
  authVersion: number;
  quickPinState: 'set' | 'required';
  /** Every role; a missing / unrecognized server answer is `UNKNOWN` (read-only). */
  accountAuthClassification: AccountAuthClassification;
  /** `null` for non-admin roles; an admin with no clean server answer is `UNKNOWN`. */
  securityAdminClassification: SecurityAdminClassification | null;
};

/** Target fields every mutation / capability action needs to decide mutability. */
export type AdminTargetRef = Pick<AdminSecurityUser, 'userId' | 'role' | 'securityAdminClassification' | 'accountAuthClassification'>;

/**
 * D-ASC9 fail-closed admin mutability: an `admin` is mutable only when the
 * server proved it is a POS (Quick PIN) admin.
 */
export function isProtectedAdminTarget(target: Pick<AdminSecurityUser, 'role' | 'securityAdminClassification'>): boolean {
  return target.role === 'admin' && target.securityAdminClassification !== 'POS_ADMIN';
}

/**
 * D-ASC12/D-ASC13 fail-closed account mutability for every role: only a
 * server-proven Quick-PIN-only account (and, for an admin, a POS admin).
 */
export function isProtectedAccountTarget(
  target: Pick<AdminSecurityUser, 'role' | 'securityAdminClassification' | 'accountAuthClassification'>,
): boolean {
  return isProtectedAdminTarget(target) || target.accountAuthClassification !== 'QUICK_PIN_ONLY';
}

export type AdminSecurityEvent = {
  type: string;
  actorStaffId: string;
  targetStaffId: string;
  changedFields: string[];
  roleBefore: string | null;
  roleAfter: string | null;
  branchIdsBefore: string[] | null;
  branchIdsAfter: string[] | null;
  deviceBranchId: string | null;
  createdAtMs: number | null;
};

export type AdminSecurityOverview = { users: AdminSecurityUser[]; events: AdminSecurityEvent[] };

export type AccountMutationResult =
  | { kind: 'ok'; userId: string; oacRevoke: ManagerOacRevokeResult }
  /** A definite server refusal. Nothing changed; no local state touched. */
  | { kind: 'rejected'; message: string }
  /** Outcome unknown. Never replayed; the target's local OAC was revoked (fail closed). */
  | { kind: 'uncertain'; oacRevoke: ManagerOacRevokeResult }
  /** Not the primary password-admin principal: nothing was called. */
  | { kind: 'not_admin' }
  | { kind: 'self_target' }
  /** Password-backed or unclassified target (any role): nothing was called. */
  | { kind: 'protected_target' }
  | { kind: 'invalid'; reason: 'pin_format' | 'missing_fields' }
  | { kind: 'busy' };

export type ReissueOacResult =
  | ProvisionManagerOacOutcome
  | { kind: 'not_admin' }
  | { kind: 'self_target' }
  | { kind: 'protected_target' }
  | { kind: 'not_eligible_target' }
  | { kind: 'invalid'; reason: 'pin_format' };

export type LockoutClearResult = PrivilegedLockoutRecoveryOutcome | { kind: 'self_target' } | { kind: 'protected_target' };

export interface AdminSecurityDeps {
  isAdminPasswordSession?: (operatorId: string) => Promise<boolean>;
  callSetUserAccount?: (command: SetUserAccountClientCommand) => Promise<SetUserAccountClientResult>;
  revokeOac?: (managerStaffId: string) => Promise<ManagerOacRevokeResult>;
  loadRoleMatrix?: () => Promise<RolePermissionMatrix>;
  fetchOverview?: () => Promise<unknown>;
  provision?: typeof provisionManagerOac;
  provisionDeps?: ProvisionManagerOacDeps;
  runLockoutRecovery?: typeof runPrivilegedLockoutRecovery;
  lockoutDeps?: PrivilegedLockoutRecoveryDeps;
  newKey?: () => string;
}

// ---------------------------------------------------------------------------
// Access gate
// ---------------------------------------------------------------------------

/** True only for the operator's own non-anonymous password session with `role=admin`. */
export async function defaultIsAdminPasswordSession(operatorId: string): Promise<boolean> {
  const current = auth?.currentUser;
  if (!current || current.isAnonymous || current.uid !== operatorId) return false;
  try {
    const token = await getIdTokenResult(current);
    return (
      token.signInProvider === 'password' &&
      token.claims.role === 'admin' &&
      token.claims.staffId === current.uid
    );
  } catch {
    return false;
  }
}

async function passesGate(operator: AdminOperator, deps: AdminSecurityDeps): Promise<boolean> {
  if (!operator || operator.role !== 'admin' || !operator.id) return false;
  const check = deps.isAdminPasswordSession ?? defaultIsAdminPasswordSession;
  try {
    return await check(operator.id);
  } catch {
    return false;
  }
}

export async function checkAdminPasswordSession(operator: AdminOperator, deps: AdminSecurityDeps = {}): Promise<boolean> {
  return passesGate(operator, deps);
}

// ---------------------------------------------------------------------------
// Overview (read-only)
// ---------------------------------------------------------------------------

let overviewEmulatorConnected = false;

async function defaultFetchOverview(): Promise<unknown> {
  if (!isFirebaseConfigured || !app) throw new Error('firebase_not_configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR && !overviewEmulatorConnected) {
    connectFunctionsEmulator(functions, getEmulatorHost(), 5001);
    overviewEmulatorConnected = true;
  }
  return (await httpsCallable<Record<string, never>, unknown>(functions, 'getAdminSecurityOverview')({})).data;
}

function strArr(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...(v as string[])] : null;
}

function parseUser(raw: unknown): AdminSecurityUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.userId !== 'string' || !r.userId) return null;
  if (r.role !== 'admin' && r.role !== 'manager' && r.role !== 'staff') return null;
  return {
    userId: r.userId,
    firstName: typeof r.firstName === 'string' ? r.firstName : '',
    lastName: typeof r.lastName === 'string' ? r.lastName : '',
    username: typeof r.username === 'string' ? r.username : '',
    role: r.role,
    branchIds: strArr(r.branchIds) ?? [],
    isActive: r.isActive === true,
    authVersion: typeof r.authVersion === 'number' && Number.isFinite(r.authVersion) ? r.authVersion : 0,
    quickPinState: r.quickPinState === 'set' ? 'set' : 'required',
    accountAuthClassification:
      r.accountAuthClassification === 'QUICK_PIN_ONLY' || r.accountAuthClassification === 'PASSWORD_PRINCIPAL'
        ? r.accountAuthClassification
        : 'UNKNOWN',
    securityAdminClassification:
      r.role !== 'admin'
        ? null
        : r.securityAdminClassification === 'PASSWORD_ADMIN' || r.securityAdminClassification === 'POS_ADMIN'
          ? r.securityAdminClassification
          : 'UNKNOWN',
  };
}

function parseEvent(raw: unknown): AdminSecurityEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.type !== 'string') return null;
  return {
    type: r.type,
    actorStaffId: typeof r.actorStaffId === 'string' ? r.actorStaffId : '',
    targetStaffId: typeof r.targetStaffId === 'string' ? r.targetStaffId : '',
    changedFields: strArr(r.changedFields) ?? [],
    roleBefore: typeof r.roleBefore === 'string' ? r.roleBefore : null,
    roleAfter: typeof r.roleAfter === 'string' ? r.roleAfter : null,
    branchIdsBefore: strArr(r.branchIdsBefore),
    branchIdsAfter: strArr(r.branchIdsAfter),
    deviceBranchId: typeof r.deviceBranchId === 'string' ? r.deviceBranchId : null,
    createdAtMs: typeof r.createdAtMs === 'number' ? r.createdAtMs : null,
  };
}

export type OverviewLoadResult = { kind: 'ok'; overview: AdminSecurityOverview } | { kind: 'not_admin' } | { kind: 'failed' };

export async function loadAdminSecurityOverview(
  operator: AdminOperator,
  deps: AdminSecurityDeps = {},
): Promise<OverviewLoadResult> {
  if (!(await passesGate(operator, deps))) return { kind: 'not_admin' };
  let raw: unknown;
  try {
    raw = await (deps.fetchOverview ?? defaultFetchOverview)();
  } catch {
    return { kind: 'failed' };
  }
  if (!raw || typeof raw !== 'object') return { kind: 'failed' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return r.code === 'admin_password_session_required' ? { kind: 'not_admin' } : { kind: 'failed' };
  if (!Array.isArray(r.users) || !Array.isArray(r.events)) return { kind: 'failed' };
  return {
    kind: 'ok',
    overview: {
      users: r.users.map(parseUser).filter((u): u is AdminSecurityUser => u !== null),
      events: r.events.map(parseEvent).filter((e): e is AdminSecurityEvent => e !== null),
    },
  };
}

// ---------------------------------------------------------------------------
// Account mutations
// ---------------------------------------------------------------------------

const DEFINITE_FUNCTION_CODES = new Set([
  'functions/permission-denied',
  'functions/unauthenticated',
  'functions/invalid-argument',
  'functions/not-found',
  'functions/failed-precondition',
  'functions/already-exists',
]);

function isDefiniteRefusal(err: unknown): boolean {
  if (!(err instanceof SetUserAccountError)) return false;
  return err.code.startsWith('status:') || DEFINITE_FUNCTION_CODES.has(err.code);
}

function refusalMessage(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'ไม่สามารถบันทึกบัญชีผู้ใช้ได้';
}

let mutationInFlight = false;

/** Test-only: reset the module single-flight guard. */
export function __resetAdminSecurityServiceForTests(): void {
  mutationInFlight = false;
}

function defaultNewKey(): string {
  return crypto.randomUUID();
}

async function defaultLoadRoleMatrix(): Promise<RolePermissionMatrix> {
  if (!isFirebaseConfigured || !db) return cloneDefaultMatrix();
  try {
    const snap = await getDoc(doc(db, collections.settings, ROLE_PERMISSIONS_DOC_ID));
    const data = snap.data() as { rolePermissions?: RolePermissionMatrix } | undefined;
    return data?.rolePermissions ?? cloneDefaultMatrix();
  } catch {
    return cloneDefaultMatrix();
  }
}

/**
 * Runs exactly one canonical `setUserAccount` call. `revokeTargetId` (when
 * set) is the user whose local OAC is removed after acceptance or on an
 * unknown outcome.
 */
async function runOneMutation(
  operator: AdminOperator,
  command: SetUserAccountClientCommand,
  revokeTargetId: string | null,
  deps: AdminSecurityDeps,
): Promise<AccountMutationResult> {
  if (!(await passesGate(operator, deps))) return { kind: 'not_admin' };
  if (mutationInFlight) return { kind: 'busy' };
  mutationInFlight = true;
  const call = deps.callSetUserAccount ?? setUserAccount;
  const revoke = deps.revokeOac ?? ((id: string) => revokeManagerOac(id));
  try {
    let result: SetUserAccountClientResult;
    try {
      result = await call(command);
    } catch (err) {
      if (isDefiniteRefusal(err)) return { kind: 'rejected', message: refusalMessage(err) };
      const oacRevoke = revokeTargetId ? await revoke(revokeTargetId) : 'none';
      return { kind: 'uncertain', oacRevoke };
    }
    const userId = typeof result.userId === 'string' && result.userId ? result.userId : (revokeTargetId ?? '');
    const oacRevoke = revokeTargetId ? await revoke(revokeTargetId) : 'none';
    return { kind: 'ok', userId, oacRevoke };
  } finally {
    mutationInFlight = false;
  }
}

export type CreateUserInput = {
  firstName: string;
  lastName: string;
  username: string;
  role: UserRole;
  branchIds: string[];
  pin: string;
};

export async function createAdminUser(
  operator: AdminOperator,
  input: CreateUserInput,
  deps: AdminSecurityDeps = {},
): Promise<AccountMutationResult> {
  const username = input.username.trim().toLowerCase();
  if (!username || !input.firstName.trim() || input.branchIds.length === 0 || !ADMIN_SECURITY_ROLES.includes(input.role)) {
    return { kind: 'invalid', reason: 'missing_fields' };
  }
  if (!ADMIN_PIN_RE.test(input.pin)) return { kind: 'invalid', reason: 'pin_format' };
  if (!(await passesGate(operator, deps))) return { kind: 'not_admin' };
  const matrix = await (deps.loadRoleMatrix ?? defaultLoadRoleMatrix)();
  const key = (deps.newKey ?? defaultNewKey)();
  return runOneMutation(
    operator,
    {
      op: 'create',
      idempotencyKey: `admin-center-create:${username}:${key}`,
      username,
      firstName: input.firstName.trim(),
      lastName: input.lastName.trim(),
      role: input.role,
      branchIds: [...input.branchIds],
      permissions: permissionsForRole(input.role, matrix),
      isActive: true,
      pin: input.pin,
    },
    null,
    deps,
  );
}

export type UpdateUserInput = { firstName: string; lastName: string; role: UserRole; branchIds: string[] };

export async function updateAdminUser(
  operator: AdminOperator,
  target: AdminTargetRef,
  input: UpdateUserInput,
  deps: AdminSecurityDeps = {},
): Promise<AccountMutationResult> {
  if (operator?.id && target.userId === operator.id) return { kind: 'self_target' };
  if (isProtectedAccountTarget(target)) return { kind: 'protected_target' };
  if (!input.firstName.trim() || input.branchIds.length === 0 || !ADMIN_SECURITY_ROLES.includes(input.role)) {
    return { kind: 'invalid', reason: 'missing_fields' };
  }
  if (!(await passesGate(operator, deps))) return { kind: 'not_admin' };
  const command: SetUserAccountClientCommand = {
    op: 'updateProfile',
    userId: target.userId,
    firstName: input.firstName.trim(),
    lastName: input.lastName.trim(),
    role: input.role,
    branchIds: [...input.branchIds],
  };
  if (input.role !== target.role) {
    const matrix = await (deps.loadRoleMatrix ?? defaultLoadRoleMatrix)();
    command.permissions = permissionsForRole(input.role, matrix);
  }
  return runOneMutation(operator, command, target.userId, deps);
}

export async function rotateAdminUserPin(
  operator: AdminOperator,
  target: AdminTargetRef,
  pin: string,
  deps: AdminSecurityDeps = {},
): Promise<AccountMutationResult> {
  if (operator?.id && target.userId === operator.id) return { kind: 'self_target' };
  if (isProtectedAccountTarget(target)) return { kind: 'protected_target' };
  if (!ADMIN_PIN_RE.test(pin)) return { kind: 'invalid', reason: 'pin_format' };
  const key = (deps.newKey ?? defaultNewKey)();
  return runOneMutation(
    operator,
    { op: 'rotate', userId: target.userId, pin, rotateIdempotencyKey: `admin-center-rotate:${target.userId}:${key}` },
    target.userId,
    deps,
  );
}

export async function setAdminUserActive(
  operator: AdminOperator,
  target: AdminTargetRef,
  isActive: boolean,
  deps: AdminSecurityDeps = {},
): Promise<AccountMutationResult> {
  if (operator?.id && target.userId === operator.id) return { kind: 'self_target' };
  if (isProtectedAccountTarget(target)) return { kind: 'protected_target' };
  return runOneMutation(operator, { op: 'setActive', userId: target.userId, isActive }, target.userId, deps);
}

// ---------------------------------------------------------------------------
// Approval lockout + OAC reissue (reuse of the reviewed surfaces)
// ---------------------------------------------------------------------------

export async function clearManagerApprovalLockout(
  operator: AdminOperator,
  target: AdminTargetRef,
  deps: AdminSecurityDeps = {},
): Promise<LockoutClearResult> {
  if (operator?.id && target.userId === operator.id) return { kind: 'self_target' };
  if (isProtectedAccountTarget(target)) return { kind: 'protected_target' };
  if (!(await passesGate(operator, deps))) return { kind: 'not_admin' };
  const run = deps.runLockoutRecovery ?? runPrivilegedLockoutRecovery;
  return run({ managerStaffId: target.userId, operator }, deps.lockoutDeps ?? {});
}

/**
 * One explicit reissue attempt for the selected, physically present manager
 * using THEIR OWN Quick PIN on an isolated secondary principal (the primary
 * admin identity is never rebound). Exactly one begin + one complete inside
 * `provisionManagerOac`; nothing here retries.
 */
export async function reissueManagerOac(
  operator: AdminOperator,
  target: AdminTargetRef & Pick<AdminSecurityUser, 'isActive' | 'branchIds'>,
  terminalBranchId: string | null,
  pin: string,
  deps: AdminSecurityDeps = {},
): Promise<ReissueOacResult> {
  if (operator?.id && target.userId === operator.id) return { kind: 'self_target' };
  if (isProtectedAccountTarget(target)) return { kind: 'protected_target' };
  if (!ADMIN_PIN_RE.test(pin)) return { kind: 'invalid', reason: 'pin_format' };
  const eligible =
    (target.role === 'manager' || target.role === 'admin') &&
    target.isActive &&
    !!terminalBranchId &&
    terminalBranchId !== 'ALL' &&
    (target.branchIds.includes(terminalBranchId) || target.branchIds.includes('ALL'));
  if (!eligible || !terminalBranchId) return { kind: 'not_eligible_target' };
  if (!(await passesGate(operator, deps))) return { kind: 'not_admin' };
  const provision = deps.provision ?? provisionManagerOac;
  return provision({ managerStaffId: target.userId, branchId: terminalBranchId, pin }, deps.provisionDeps ?? {});
}
