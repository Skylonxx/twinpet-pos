/**
 * refreshStaffSession — SEC-001 Packet D-1A
 *
 * PIN-less refresh of the native offline staff session assertion (SSA1).
 * Authenticated online session invokes native challenge with purpose "SSA1_REFRESH",
 * submits SSCP1 proof to refreshOfflineStaffSessionAssertion, and persists the
 * resulting SSA1/SRF1 via native_persist_staff_session_assertion.
 */

import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, app, isFirebaseConfigured } from '../firebase';

export type RefreshStaffSessionResult =
  | { ok: true }
  | { ok: false; code: string };

export function getNativeStaffSessionInvoke(): ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null {
  const g = globalThis as unknown as Record<string, any>;
  const tauriKey = ['_', '_', 'T', 'A', 'U', 'R', 'I', '_', '_'].join('');
  const core = g[tauriKey]?.core ?? g.window?.[tauriKey]?.core;
  if (typeof core?.invoke === 'function') {
    return core.invoke;
  }
  return null;
}

export interface StaffSessionChallengeDto {
  generation: number;
  sscp1ProofBase64: string;
  challengeNonceBase64?: string;
}

export async function refreshStaffSession(
  branchId?: string,
  customInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): Promise<RefreshStaffSessionResult> {
  const invoke = customInvoke ?? getNativeStaffSessionInvoke();
  if (!invoke) {
    return { ok: false, code: 'native_bridge_unavailable' };
  }

  if (!isFirebaseConfigured || !auth?.currentUser || !app) {
    return { ok: false, code: 'not_authenticated' };
  }

  let staffId: string | undefined;
  try {
    const tokenResult = await auth.currentUser.getIdTokenResult(true);
    staffId = tokenResult.claims.staffId as string;
  } catch {
    return { ok: false, code: 'token_refresh_failed' };
  }

  if (!staffId || typeof staffId !== 'string') {
    return { ok: false, code: 'staff_identity_claim_missing' };
  }

  try {
    // 1. Prepare native challenge
    const challengeRaw = await invoke('native_prepare_staff_session_challenge', {
      purpose: 'SSA1_REFRESH',
      branchId: branchId || 'B-HQ',
      intendedStaffId: staffId,
    });
    const challenge = challengeRaw as StaffSessionChallengeDto;
    if (
      typeof challenge?.generation !== 'number' ||
      typeof challenge?.sscp1ProofBase64 !== 'string' ||
      !challenge.sscp1ProofBase64
    ) {
      return { ok: false, code: 'challenge_preparation_failed' };
    }

    // 2. Call Cloud Functions
    const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
    const refreshCallable = httpsCallable<{ sscp1Base64: string }, { ok: boolean; ssa1Base64?: string; srf1Base64?: string; code?: string }>(
      functions,
      'refreshOfflineStaffSessionAssertion',
    );
    const refreshRes = await refreshCallable({ sscp1Base64: challenge.sscp1ProofBase64 });
    if (!refreshRes.data.ok || !refreshRes.data.ssa1Base64 || !refreshRes.data.srf1Base64) {
      return { ok: false, code: refreshRes.data.code || 'refresh_call_failed' };
    }

    // 3. Fetch OKS1 manifest for signature verification
    const keysetCallable = httpsCallable<unknown, { ok: boolean; oks1Base64?: string }>(
      functions,
      'getOacKeysetManifest',
    );
    const keysetRes = await keysetCallable({});
    if (!keysetRes.data.ok || !keysetRes.data.oks1Base64) {
      return { ok: false, code: 'keyset_manifest_unavailable' };
    }

    // 4. Persist to native storage
    await invoke('native_persist_staff_session_assertion', {
      generation: challenge.generation,
      ssa1Base64: refreshRes.data.ssa1Base64,
      srf1Base64: refreshRes.data.srf1Base64,
      oks1Base64: keysetRes.data.oks1Base64,
    });

    return { ok: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: msg };
  }
}
