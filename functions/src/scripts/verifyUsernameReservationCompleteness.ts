/**
 * Completeness verification + the only two writers of maintenanceMode:false.
 * Initial complete:false→true (+ epoch:1 + maintenanceMode:false).
 * Re-migration success: epoch→requestedEpoch + maintenanceMode:false, complete stays true.
 * Failure leaves maintenanceMode:true and epoch unchanged.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS, normalizeUsername } from '../credentialStore';
import { classifyUsers, loadAllUsersUnfiltered } from './censusUsernames';

export type VerifyResult = {
  ok: boolean;
  complete: boolean;
  maintenanceMode: boolean;
  epoch: number;
  error?: string;
};

export async function verifyZeroMissNoOrphan(
  database: Firestore,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const docs = await loadAllUsersUnfiltered(database);
  const live = classifyUsers(docs).live;
  const reservations = await database.collection(COLLECTIONS.usernames).get();
  const byUsername = new Map<string, string>();
  for (const doc of reservations.docs) {
    const userId = String((doc.data() as { userId?: string }).userId ?? '');
    byUsername.set(doc.id, userId);
  }
  for (const entry of live) {
    const owner = byUsername.get(entry.normalizedUsername);
    if (owner !== entry.userId) {
      return { ok: false, error: `MISS_OR_OWNER_MISMATCH:${entry.userId}` };
    }
  }
  for (const [username, userId] of byUsername) {
    const liveEntry = live.find((e) => e.userId === userId);
    if (!liveEntry || liveEntry.normalizedUsername !== username) {
      return { ok: false, error: `ORPHAN_RESERVATION:${username}` };
    }
  }
  return { ok: true };
}

export async function runVerifyUsernameReservationCompleteness(
  database: Firestore,
  requestedEpoch: number,
): Promise<VerifyResult> {
  const ref = database.collection(COLLECTIONS.migrationControl).doc('usernameReservations');
  const snap = await ref.get();
  const current = (snap.data() ?? {}) as {
    complete?: boolean;
    maintenanceMode?: boolean;
    epoch?: number;
  };
  const complete = current.complete === true;
  const maintenanceMode = current.maintenanceMode === true;
  const epoch = typeof current.epoch === 'number' ? current.epoch : 0;

  const check = await verifyZeroMissNoOrphan(database);
  if (!check.ok) {
    return {
      ok: false,
      complete,
      maintenanceMode: maintenanceMode || true,
      epoch,
      error: check.error,
    };
  }

  if (!complete) {
    await ref.set({
      complete: true,
      epoch: 1,
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, complete: true, maintenanceMode: false, epoch: 1 };
  }

  if (maintenanceMode && requestedEpoch === epoch + 1) {
    await ref.set({
      complete: true,
      epoch: requestedEpoch,
      maintenanceMode: false,
      updatedAt: new Date().toISOString(),
    });
    return { ok: true, complete: true, maintenanceMode: false, epoch: requestedEpoch };
  }

  return { ok: true, complete, maintenanceMode, epoch };
}

export function normalizedEquals(a: string, b: string): boolean {
  return normalizeUsername(a) === normalizeUsername(b);
}
