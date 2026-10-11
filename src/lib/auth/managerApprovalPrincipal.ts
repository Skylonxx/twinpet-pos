/**
 * managerApprovalPrincipal — one-shot, isolated Firebase principal for the
 * SELECTED approving manager/admin (Tech Lead decision D-V6,
 * TPOS-USABLE-POS-VOID-OAC-DECISION-IMPLEMENT-CLAUDE-002).
 *
 * The OAC issuance ceremony (`beginPrivilegedOacIssuanceSession` /
 * `completePrivilegedOacIssuanceSession`) mints the capability for the
 * CALLER's own Firebase principal. On a POS terminal the primary principal is
 * the operator, so the selected manager is authenticated here, on a separate
 * named Firebase app with in-memory Auth persistence:
 *
 *   - the primary app / `auth.currentUser` / its claims are never read for
 *     authority, never signed out, never replaced, never re-claimed;
 *   - manager claims are stamped (by the existing `verifyPinLogin`) onto a
 *     fresh anonymous UID that exists only inside this secondary app;
 *   - the secondary principal is verified to be EXACTLY the selected manager,
 *     with an approver role and access to the target branch, before `body`
 *     runs;
 *   - in `finally` the anonymous secondary user is deleted (best effort),
 *     signed out, and the secondary app deleted — nothing outlives the
 *     ceremony, nothing is persisted.
 *
 * The PIN is passed through to `verifyPinLogin` only. It is never logged,
 * stored, or returned, and this module keeps no reference to it after the
 * call resolves.
 */

import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  deleteUser,
  inMemoryPersistence,
  initializeAuth,
  signInAnonymously,
  signOut,
  connectAuthEmulator,
  type Auth,
} from 'firebase/auth';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';
import { FirebaseError } from 'firebase/app';
import { app as primaryApp, getEmulatorHost, isFirebaseConfigured, USE_EMULATOR } from '../firebase';

/** One isolated secondary Firebase context. All methods are scoped to it. */
export interface SecondaryFirebaseContext {
  signInAnonymously(): Promise<void>;
  call<Req, Res>(callableName: string, data: Req): Promise<Res>;
  /** Force-refreshed ID-token claims of the secondary principal. */
  getClaims(): Promise<Record<string, unknown>>;
  /** Deletes the anonymous secondary user (best effort), signs out, deletes the app. Never throws. */
  dispose(): Promise<void>;
}

export interface SecondaryFirebaseFactory {
  create(appName: string): SecondaryFirebaseContext;
}

export type ManagerPrincipalFailureCode =
  /** Firebase not configured / secondary app could not be created or signed in. */
  | 'principal_unavailable'
  /** `verifyPinLogin` refused the selected manager's PIN (or branch access). */
  | 'pin_rejected'
  /** The authenticated secondary principal is not exactly the selected manager/role/branch. */
  | 'identity_mismatch'
  /** Network / server failure while establishing the principal. */
  | 'network';

export type ManagerPrincipalResult<T> = { ok: true; value: T } | { ok: false; code: ManagerPrincipalFailureCode };

/** What `body` may do with the verified manager principal: call Functions as that manager. */
export interface ManagerPrincipal {
  readonly managerStaffId: string;
  call<Req, Res>(callableName: string, data: Req): Promise<Res>;
}

export interface ManagerPrincipalParams {
  managerStaffId: string;
  pin: string;
  branchId: string;
}

type VerifyPinLoginPayload = { success?: unknown; user?: { id?: unknown } | null };

const APPROVER_ROLES = new Set(['manager', 'admin']);
let secondaryAppCounter = 0;

/** Unique per ceremony: a monotonic counter plus randomness — never the default app name. */
export function nextManagerApprovalAppName(): string {
  secondaryAppCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `twinpet-manager-approval-${secondaryAppCounter}-${rand}`;
}

function claimsMatchSelectedManager(
  claims: Record<string, unknown>,
  managerStaffId: string,
  branchId: string,
): boolean {
  if (claims.staffId !== managerStaffId) return false;
  if (typeof claims.role !== 'string' || !APPROVER_ROLES.has(claims.role)) return false;
  const branchIds = Array.isArray(claims.branchIds) ? claims.branchIds : [];
  return branchIds.includes(branchId) || branchIds.includes('ALL');
}

function classifyVerifyPinLoginError(err: unknown): ManagerPrincipalFailureCode {
  if (err instanceof FirebaseError || (err && typeof err === 'object' && 'code' in err)) {
    const code = String((err as { code?: unknown }).code ?? '');
    // verifyPinLogin: wrong PIN / no branch access => permission-denied;
    // malformed PIN => invalid-argument. Both are a refused PIN, never a retry.
    if (code === 'functions/permission-denied' || code === 'functions/invalid-argument') return 'pin_rejected';
    // A non-dedicated anonymous identity => the secondary context is unusable.
    if (code === 'functions/failed-precondition' || code === 'functions/unauthenticated') {
      return 'principal_unavailable';
    }
  }
  return 'network';
}

/**
 * Runs `body` as the selected manager on an isolated secondary principal and
 * always tears that principal down afterwards. `body` errors propagate to the
 * caller unchanged (after cleanup); the caller owns their classification.
 */
export async function withManagerApprovalPrincipal<T>(
  params: ManagerPrincipalParams,
  body: (principal: ManagerPrincipal) => Promise<T>,
  factory: SecondaryFirebaseFactory = defaultSecondaryFirebaseFactory,
): Promise<ManagerPrincipalResult<T>> {
  const { managerStaffId, branchId } = params;
  if (!managerStaffId || !branchId || branchId === 'ALL') return { ok: false, code: 'identity_mismatch' };

  let context: SecondaryFirebaseContext;
  try {
    context = factory.create(nextManagerApprovalAppName());
  } catch {
    return { ok: false, code: 'principal_unavailable' };
  }

  try {
    try {
      await context.signInAnonymously();
    } catch {
      return { ok: false, code: 'principal_unavailable' };
    }

    let payload: VerifyPinLoginPayload;
    try {
      payload = await context.call<
        { pin: string; branchId: string; userId: string },
        VerifyPinLoginPayload
      >('verifyPinLogin', { pin: params.pin, branchId, userId: managerStaffId });
    } catch (err) {
      return { ok: false, code: classifyVerifyPinLoginError(err) };
    }
    if (payload?.success !== true || payload.user?.id !== managerStaffId) {
      return { ok: false, code: 'identity_mismatch' };
    }

    let claims: Record<string, unknown>;
    try {
      claims = await context.getClaims();
    } catch {
      return { ok: false, code: 'network' };
    }
    if (!claimsMatchSelectedManager(claims, managerStaffId, branchId)) {
      return { ok: false, code: 'identity_mismatch' };
    }

    const principal: ManagerPrincipal = {
      managerStaffId,
      call: (name, data) => context.call(name, data),
    };
    return { ok: true, value: await body(principal) };
  } finally {
    await context.dispose();
  }
}

// ---------------------------------------------------------------------------
// Real Firebase implementation.
// ---------------------------------------------------------------------------

function createRealSecondaryContext(appName: string): SecondaryFirebaseContext {
  if (!isFirebaseConfigured || !primaryApp) throw new Error('firebase_not_configured');
  const options: FirebaseOptions = primaryApp.options;
  const secondaryApp: FirebaseApp = initializeApp(options, appName);
  let secondaryAuth: Auth;
  try {
    // In-memory persistence: the manager principal is never written to
    // IndexedDB/localStorage and dies with this app instance.
    secondaryAuth = initializeAuth(secondaryApp, { persistence: inMemoryPersistence });
  } catch (err) {
    void deleteApp(secondaryApp).catch(() => undefined);
    throw err;
  }
  const functions = getFunctions(secondaryApp, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) {
    const host = getEmulatorHost();
    connectAuthEmulator(secondaryAuth, `http://${host}:9099`, { disableWarnings: true });
    connectFunctionsEmulator(functions, host, 5001);
  }

  return {
    async signInAnonymously() {
      await signInAnonymously(secondaryAuth);
    },
    async call<Req, Res>(callableName: string, data: Req): Promise<Res> {
      const callable = httpsCallable<Req, Res>(functions, callableName);
      const res = await callable(data);
      return res.data;
    },
    async getClaims() {
      const user = secondaryAuth.currentUser;
      if (!user) throw new Error('secondary_principal_absent');
      const token = await user.getIdTokenResult(true);
      return token.claims as Record<string, unknown>;
    },
    async dispose() {
      const user = secondaryAuth.currentUser;
      if (user && user.isAnonymous) {
        // The throwaway anonymous UID carries manager claims; remove it.
        await deleteUser(user).catch(() => undefined);
      }
      await signOut(secondaryAuth).catch(() => undefined);
      await deleteApp(secondaryApp).catch(() => undefined);
    },
  };
}

export const defaultSecondaryFirebaseFactory: SecondaryFirebaseFactory = {
  create: createRealSecondaryContext,
};
