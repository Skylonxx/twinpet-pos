/**
 * Canonical credential backfill + forced-rotation state machine.
 * Never executes against live data from this module's default export; tests inject a db.
 * Legacy users.pin is cleared only after every in-scope account is rotated or waived.
 */
import bcrypt from 'bcryptjs';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  COLLECTIONS,
  isUsableForLogin,
  type CredentialState,
  type UserCredentialDoc,
} from '../credentialStore';
import { classifyUsers, loadAllUsersUnfiltered } from './censusUsernames';

export type MigrateCredentialsPhase =
  | 'backfill'
  | 'cut_over_readers'
  | 'clear_legacy_pin';

export type MigrateCredentialsResult = {
  ok: boolean;
  phase: MigrateCredentialsPhase;
  scanned: number;
  mutated: number;
  skipped: number;
  error?: string;
  pendingRotation?: number;
};

function inScopePin(data: Record<string, unknown>): boolean {
  return typeof data.pin === 'string' && data.pin.length > 0;
}

export async function runMigrateCredentials(
  database: Firestore,
  phase: MigrateCredentialsPhase,
): Promise<MigrateCredentialsResult> {
  const docs = await loadAllUsersUnfiltered(database);
  const live = classifyUsers(docs).live;
  const liveIds = new Set(live.map((e) => e.userId));
  let mutated = 0;
  let skipped = 0;
  let pendingRotation = 0;

  if (phase === 'backfill') {
    for (const doc of docs) {
      if (!liveIds.has(doc.id)) {
        skipped += 1;
        continue;
      }
      const data = doc.data();
      if (!inScopePin(data)) {
        skipped += 1;
        continue;
      }
      const credRef = database.collection(COLLECTIONS.userCredentials).doc(doc.id);
      const credSnap = await credRef.get();
      if (!credSnap.exists) {
        await credRef.set({
          pinHash: data.pin,
          algo: 'bcrypt',
          cost: 10,
          credentialVersion: 0,
          credentialState: 'backfilled_not_trusted' satisfies CredentialState,
          disabled: false,
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: 'migrateCredentials',
        });
        mutated += 1;
      } else {
        skipped += 1;
      }
      const userRef = database.collection(COLLECTIONS.users).doc(doc.id);
      const userSnap = await userRef.get();
      const user = (userSnap.data() ?? {}) as { authVersion?: unknown };
      if (user.authVersion === undefined) {
        await userRef.set({ authVersion: 0 }, { merge: true });
        mutated += 1;
      }
    }
    return { ok: true, phase, scanned: docs.length, mutated, skipped };
  }

  if (phase === 'cut_over_readers') {
    const creds = await database.collection(COLLECTIONS.userCredentials).get();
    for (const cred of creds.docs) {
      const data = cred.data() as UserCredentialDoc;
      if (data.credentialState === 'backfilled_not_trusted') {
        await cred.ref.set(
          {
            credentialState: 'readers_cut_over_rotation_required' satisfies CredentialState,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        mutated += 1;
      } else {
        skipped += 1;
      }
      if (data.credentialState !== 'rotated_authoritative' && data.disabled !== true) {
        pendingRotation += 1;
      }
    }
    return { ok: true, phase, scanned: creds.size, mutated, skipped, pendingRotation };
  }

  const creds = await database.collection(COLLECTIONS.userCredentials).get();
  for (const cred of creds.docs) {
    const data = cred.data() as UserCredentialDoc;
    const done = data.credentialState === 'rotated_authoritative' || data.disabled === true;
    if (!done) pendingRotation += 1;
  }
  if (pendingRotation > 0) {
    return {
      ok: false,
      phase,
      scanned: creds.size,
      mutated: 0,
      skipped: 0,
      pendingRotation,
      error: 'LEGACY_PIN_CLEAR_BLOCKED_PENDING_ROTATION',
    };
  }
  for (const doc of docs) {
    if (!liveIds.has(doc.id)) continue;
    const data = doc.data();
    if (!inScopePin(data)) {
      skipped += 1;
      continue;
    }
    await database.collection(COLLECTIONS.users).doc(doc.id).set({ pin: '' }, { merge: true });
    mutated += 1;
  }
  return { ok: true, phase, scanned: docs.length, mutated, skipped, pendingRotation: 0 };
}

export async function waiveCredential(
  database: Firestore,
  userId: string,
): Promise<void> {
  const credRef = database.collection(COLLECTIONS.userCredentials).doc(userId);
  const credSnap = await credRef.get();
  const cred = (credSnap.data() ?? {}) as UserCredentialDoc;
  await credRef.set(
    {
      disabled: true,
      credentialVersion: (typeof cred.credentialVersion === 'number' ? cred.credentialVersion : 0) + 1,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: 'migrateCredentials:waiver',
    },
    { merge: true },
  );
  await database.collection(COLLECTIONS.users).doc(userId).set(
    { authVersion: FieldValue.increment(1) },
    { merge: true },
  );
}

export function credentialUsableForLogin(cred: UserCredentialDoc | null): boolean {
  return isUsableForLogin(cred);
}

export async function pinHashLooksLikeBcrypt(hash: string): Promise<boolean> {
  try {
    await bcrypt.getRounds(hash);
    return hash.startsWith('$2');
  } catch {
    return hash.startsWith('$2');
  }
}
