/**
 * privilegedLockoutRecovery — admin recovery of one manager's native offline
 * privileged-approval lockout on this device (Tech Lead D-V12..D-V17,
 * TPOS-USABLE-POS-VOID-LOCKOUT-RECOVERY-SURFACE-CLAUDE-001).
 *
 * Bridges the two EXISTING protocol halves, unchanged:
 *   - server `issuePrivilegedLockoutClear` (active Firebase Auth admin only;
 *     signs an LCT1 bound to device + manager + current lockout generation);
 *   - native `native_clear_offline_lockout` (verifies the LCT1 and records it
 *     through `record_lockout_clear_token`).
 *
 * One explicit admin confirmation = exactly one episode (D-V14):
 *   1. admin gate: operator role admin AND the CURRENT PRIMARY Firebase Auth
 *      user is that admin's own non-anonymous account carrying `role=admin`
 *      (the shape the callable authorizes). Never a secondary/anonymous
 *      principal, never a custom token, never a manager PIN;
 *   2. fresh native `native_get_privileged_lockout_recovery_context` read;
 *   3. require the exact selected managerStaffId, lockedOut, cooldown 0;
 *   4. `issuePrivilegedLockoutClear` exactly once;
 *   5. validate the response tuple against the native context;
 *   6. `native_clear_offline_lockout` exactly once with the returned LCT1;
 *   7. re-read the native context and require NOT_LOCKED.
 * Nothing is retried. A failed/uncertain issuance never reaches the native
 * clear; a failed/uncertain clear never re-issues.
 *
 * The device id, lockout id and LCT1 exist only in this module's local
 * variables: never returned to the UI, rendered, persisted or logged. Callers
 * receive only coarse outcome kinds — never raw DENIED_* / server codes.
 */

import { getIdTokenResult } from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { app, auth, getEmulatorHost, isFirebaseConfigured, USE_EMULATOR } from '../firebase';

export type NativeInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export const NATIVE_RECOVERY_CONTEXT_COMMAND = 'native_get_privileged_lockout_recovery_context' as const;
export const NATIVE_CLEAR_LOCKOUT_COMMAND = 'native_clear_offline_lockout' as const;
export const ISSUE_LOCKOUT_CLEAR_CALLABLE = 'issuePrivilegedLockoutClear' as const;

/** LCT1 TTL frozen by the server (`LOCKOUT_CLEAR_TOKEN_TTL_MS`) and native verifier. */
const LCT1_MAX_TTL_MS = 15 * 60 * 1000;
const CANONICAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type IssueLockoutClearRequest = {
  securityDeviceIdHex: string;
  managerStaffId: string;
  lockoutIdHex: string;
};

export type IssueLockoutClearTransport = (req: IssueLockoutClearRequest) => Promise<unknown>;

/** Display-safe native status for one manager. Carries no identifiers. */
export type PrivilegedLockoutStatus =
  | { kind: 'not_locked' }
  | { kind: 'locked'; cooldownRemainingMs: number }
  | { kind: 'unavailable' };

export type PrivilegedLockoutRecoveryOutcome =
  | { kind: 'recovered' }
  /** Not the primary admin principal the callable requires: nothing was called. */
  | { kind: 'not_admin' }
  | { kind: 'not_locked' }
  /** Protocol cooldown still running: nothing was issued. */
  | { kind: 'cooldown'; cooldownRemainingMs: number }
  /** Terminal for this episode (refused, mismatched or uncertain). Never retried. */
  | { kind: 'failed' };

export type RecoveryOperator = { id: string; role: string } | null | undefined;

export interface PrivilegedLockoutRecoveryDeps {
  invoke?: NativeInvoke | null;
  issueLockoutClear?: IssueLockoutClearTransport;
  /** True only when the current primary Firebase user is this admin's own account with `role=admin`. */
  isPrimaryAdminPrincipal?: (operatorId: string) => Promise<boolean>;
}

type LockedContext = {
  managerStaffId: string;
  cooldownRemainingMs: number;
  securityDeviceIdHex: string;
  lockoutIdHex: string;
};

type ContextRead =
  | { kind: 'locked'; context: LockedContext }
  | { kind: 'not_locked' }
  | { kind: 'unavailable' };

let episodeInFlight = false;

/** Test-only: reset the module single-flight guard. */
export function __resetPrivilegedLockoutRecoveryForTests(): void {
  episodeInFlight = false;
}

export function getPrivilegedLockoutRecoveryInvoke(): NativeInvoke | null {
  const g = globalThis as unknown as Record<string, unknown>;
  const key = ['_', '_', 'T', 'A', 'U', 'R', 'I', '_', '_'].join('');
  const win = g.window as Record<string, unknown> | undefined;
  const bridge = (g[key] ?? win?.[key]) as { core?: { invoke?: unknown } } | undefined;
  const invoke = bridge?.core?.invoke;
  return typeof invoke === 'function' ? (invoke as NativeInvoke) : null;
}

export function isRecoveryTargetId(id: unknown): id is string {
  return typeof id === 'string' && CANONICAL_ID_RE.test(id);
}

function isNonNegativeFinite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

async function readContext(invoke: NativeInvoke, managerStaffId: string): Promise<ContextRead> {
  let raw: unknown;
  try {
    raw = await invoke(NATIVE_RECOVERY_CONTEXT_COMMAND, { managerStaffId });
  } catch {
    return { kind: 'unavailable' };
  }
  if (raw == null || typeof raw !== 'object') return { kind: 'unavailable' };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    return r.errorCode === 'NOT_LOCKED' ? { kind: 'not_locked' } : { kind: 'unavailable' };
  }
  if (
    r.lockedOut !== true ||
    r.managerStaffId !== managerStaffId ||
    !isNonNegativeFinite(r.cooldownRemainingMs) ||
    typeof r.securityDeviceIdHex !== 'string' ||
    !HEX32_RE.test(r.securityDeviceIdHex) ||
    typeof r.lockoutIdHex !== 'string' ||
    !HEX64_RE.test(r.lockoutIdHex)
  ) {
    return { kind: 'unavailable' };
  }
  return {
    kind: 'locked',
    context: {
      managerStaffId,
      cooldownRemainingMs: r.cooldownRemainingMs,
      securityDeviceIdHex: r.securityDeviceIdHex,
      lockoutIdHex: r.lockoutIdHex,
    },
  };
}

/** Read-only, display-safe status for one manager on this device. */
export async function readPrivilegedLockoutStatus(
  managerStaffId: string,
  deps: Pick<PrivilegedLockoutRecoveryDeps, 'invoke'> = {},
): Promise<PrivilegedLockoutStatus> {
  const invoke = deps.invoke === undefined ? getPrivilegedLockoutRecoveryInvoke() : deps.invoke;
  if (!invoke || !isRecoveryTargetId(managerStaffId)) return { kind: 'unavailable' };
  const read = await readContext(invoke, managerStaffId);
  if (read.kind === 'locked') return { kind: 'locked', cooldownRemainingMs: read.context.cooldownRemainingMs };
  return read;
}

/** Returns the LCT1 only when the response is ok and its tuple is exactly the native context. */
function acceptIssuedLct1(raw: unknown, ctx: LockedContext): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return null;
  if (typeof r.lct1Base64 !== 'string' || r.lct1Base64.length === 0 || !BASE64_RE.test(r.lct1Base64)) return null;
  if (
    r.securityDeviceIdHex !== ctx.securityDeviceIdHex ||
    r.managerStaffId !== ctx.managerStaffId ||
    r.lockoutIdHex !== ctx.lockoutIdHex
  ) {
    return null;
  }
  const issued = r.issuedAtServerMs;
  const expires = r.expiresAtServerMs;
  if (!isNonNegativeFinite(issued) || !isNonNegativeFinite(expires)) return null;
  if (expires <= issued || expires - issued > LCT1_MAX_TTL_MS) return null;
  return r.lct1Base64;
}

function nativeClearSucceeded(raw: unknown, managerStaffId: string): boolean {
  if (raw == null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return r.ok === true && r.managerStaffId === managerStaffId && r.reopensNow === true;
}

let emulatorConnected = false;

export const defaultIssueLockoutClearTransport: IssueLockoutClearTransport = async (req) => {
  if (!isFirebaseConfigured || !app) throw new Error('Firebase is not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR && !emulatorConnected) {
    connectFunctionsEmulator(functions, getEmulatorHost(), 5001);
    emulatorConnected = true;
  }
  // Default app => the current primary Firebase Auth principal (D-V12).
  const callable = httpsCallable<IssueLockoutClearRequest, unknown>(functions, ISSUE_LOCKOUT_CLEAR_CALLABLE);
  return (await callable(req)).data;
};

/**
 * Advisory pre-check mirroring the callable's authority (`token.role ===
 * 'admin'` on the caller's own `users/{uid}` account). The server stays
 * authoritative; this only avoids issuing a call that must be refused.
 */
export async function defaultIsPrimaryAdminPrincipal(operatorId: string): Promise<boolean> {
  const current = auth?.currentUser;
  if (!current || current.isAnonymous || current.uid !== operatorId) return false;
  try {
    const token = await getIdTokenResult(current);
    return token.claims.role === 'admin';
  } catch {
    return false;
  }
}

/** Runs exactly one recovery episode. Never throws; never retries. */
export async function runPrivilegedLockoutRecovery(
  input: { managerStaffId: string; operator: RecoveryOperator },
  deps: PrivilegedLockoutRecoveryDeps = {},
): Promise<PrivilegedLockoutRecoveryOutcome> {
  const { managerStaffId, operator } = input;
  if (!operator || operator.role !== 'admin' || !isRecoveryTargetId(operator.id)) return { kind: 'not_admin' };
  if (!isRecoveryTargetId(managerStaffId) || managerStaffId === operator.id) return { kind: 'failed' };
  if (episodeInFlight) return { kind: 'failed' };
  episodeInFlight = true;
  try {
    const invoke = deps.invoke === undefined ? getPrivilegedLockoutRecoveryInvoke() : deps.invoke;
    if (!invoke) return { kind: 'failed' };

    const isPrimaryAdmin = deps.isPrimaryAdminPrincipal ?? defaultIsPrimaryAdminPrincipal;
    let primaryAdmin = false;
    try {
      primaryAdmin = await isPrimaryAdmin(operator.id);
    } catch {
      primaryAdmin = false;
    }
    if (!primaryAdmin) return { kind: 'not_admin' };

    const read = await readContext(invoke, managerStaffId);
    if (read.kind === 'not_locked') return { kind: 'not_locked' };
    if (read.kind !== 'locked') return { kind: 'failed' };
    const ctx = read.context;
    if (ctx.cooldownRemainingMs > 0) return { kind: 'cooldown', cooldownRemainingMs: ctx.cooldownRemainingMs };

    const issue = deps.issueLockoutClear ?? defaultIssueLockoutClearTransport;
    let issued: unknown;
    try {
      issued = await issue({
        securityDeviceIdHex: ctx.securityDeviceIdHex,
        managerStaffId: ctx.managerStaffId,
        lockoutIdHex: ctx.lockoutIdHex,
      });
    } catch {
      // Outcome unknown: terminal, and the native clear is never reached.
      return { kind: 'failed' };
    }
    const lct1Base64 = acceptIssuedLct1(issued, ctx);
    if (lct1Base64 === null) return { kind: 'failed' };

    let cleared: unknown;
    try {
      cleared = await invoke(NATIVE_CLEAR_LOCKOUT_COMMAND, { lct1BytesBase64: lct1Base64 });
    } catch {
      return { kind: 'failed' };
    }
    if (!nativeClearSucceeded(cleared, ctx.managerStaffId)) return { kind: 'failed' };

    const after = await readContext(invoke, managerStaffId);
    return after.kind === 'not_locked' ? { kind: 'recovered' } : { kind: 'failed' };
  } finally {
    episodeInFlight = false;
  }
}
