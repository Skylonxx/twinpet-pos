/**
 * Username reservation backfill. Same A-OR-B self-gate as repair.
 * Zero writes when census binding or drift fails.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';
import { runRepairUsernameReservations, type RepairManifest, type RepairResult } from './repairUsernameReservations';

export async function reservationsSelfGateAllows(
  database: Firestore,
  requestedEpoch: number,
): Promise<{ allowed: boolean; reason?: string }> {
  const snap = await database.collection(COLLECTIONS.migrationControl).doc('usernameReservations').get();
  const data = (snap.data() ?? {}) as {
    complete?: boolean;
    maintenanceMode?: boolean;
    epoch?: number;
  };
  const complete = data.complete === true;
  const maintenanceMode = data.maintenanceMode === true;
  const epoch = typeof data.epoch === 'number' ? data.epoch : 0;
  if (!complete) return { allowed: true };
  if (complete && maintenanceMode && requestedEpoch === epoch + 1) return { allowed: true };
  return { allowed: false, reason: 'SELF_GATE_DENIED' };
}

export async function runMigrateUsernameReservations(
  database: Firestore,
  manifest: RepairManifest,
  requestedEpoch: number,
): Promise<RepairResult> {
  const gate = await reservationsSelfGateAllows(database, requestedEpoch);
  if (!gate.allowed) {
    return { ok: false, writes: 0, applied: [], error: gate.reason };
  }
  return runRepairUsernameReservations(database, manifest);
}
