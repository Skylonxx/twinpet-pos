/**
 * Asymmetric maintenanceMode writer: may only request false→true, or no-op at true.
 * Hard-rejects any request to set maintenanceMode false before any write.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';

export type EnterMaintenanceResult = {
  ok: boolean;
  maintenanceMode: boolean;
  noop: boolean;
  error?: string;
};

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
