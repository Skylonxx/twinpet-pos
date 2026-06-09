import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { app, USE_EMULATOR } from '../firebase';
import type { ResolveTransferDiscrepancyInput } from './transferTypes';

/**
 * Thin client wrapper for the ORIGIN-controlled `resolveTransferDiscrepancy`
 * Cloud Function (Phase 7B-2). Discrepancy resolution is server-authoritative:
 * the destination branch can only REPORT (metadata), and the actual stock
 * correction runs in the Cloud Function under Admin SDK authority — gated to the
 * origin branch by the caller's VERIFIED auth claims, NOT client input.
 *
 * The client therefore NEVER mutates destination stock for a discrepancy; it only
 * invokes the function. `branchId` / `staffId` on the input are ignored for
 * authority (the server derives it from the verified token) — kept only for the
 * caller's convenience. Returns the resolving inventory adjustment id.
 *
 * Mirrors the region/emulator wiring of `retryReconcile.ts` / `verifyPinLogin.ts`.
 */
let emulatorConnected = false;

export async function resolveTransferDiscrepancy(
  input: ResolveTransferDiscrepancyInput,
): Promise<string> {
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR && !emulatorConnected) {
    connectFunctionsEmulator(functions, '127.0.0.1', 5001);
    emulatorConnected = true;
  }
  const callable = httpsCallable<
    { transferId: string; discrepancyId: string; adjustDate: string; reason?: string; staffName?: string },
    { success: boolean; adjustmentId: string }
  >(functions, 'resolveTransferDiscrepancy');

  const res = await callable({
    transferId: input.transferId,
    discrepancyId: input.discrepancyId,
    adjustDate: input.adjustDate,
    reason: input.reason,
    staffName: input.staffName,
  });
  return res.data.adjustmentId;
}
