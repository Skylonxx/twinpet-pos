/**
 * P2 operator recovery: resolve target by --userId or full-scan --username,
 * then call setUserAccountCore rotate in-process. Never auth.createUser.
 * Never logs the PIN.
 */
import { performSetUserAccount, type SetUserAccountResult } from '../setUserAccountCore';
import { loadAllUsersUnfiltered } from './censusUsernames';
import { normalizeUsername } from '../credentialStore';
import type { Firestore } from 'firebase-admin/firestore';

export type RecoverTarget =
  | { userId: string }
  | { username: string };

export async function resolveRecoveryUserId(
  database: Firestore,
  target: RecoverTarget,
): Promise<{ ok: true; userId: string } | { ok: false; error: string; candidateUserIds?: string[] }> {
  if ('userId' in target && target.userId.trim()) {
    return { ok: true, userId: target.userId.trim() };
  }
  if (!('username' in target)) return { ok: false, error: 'MISSING_TARGET' };
  const wanted = normalizeUsername(target.username);
  const docs = await loadAllUsersUnfiltered(database);
  const matches: string[] = [];
  for (const doc of docs) {
    const data = doc.data();
    if (data.deletedAt != null) continue;
    if (normalizeUsername(String(data.username ?? '')) === wanted) matches.push(doc.id);
  }
  if (matches.length === 1) return { ok: true, userId: matches[0]! };
  if (matches.length === 0) return { ok: false, error: 'USERNAME_NOT_FOUND' };
  return { ok: false, error: 'USERNAME_AMBIGUOUS', candidateUserIds: matches };
}

export async function runRecoverUserCredential(
  database: Firestore,
  target: RecoverTarget,
  pin: string,
  rotateIdempotencyKey: string,
): Promise<SetUserAccountResult> {
  const resolved = await resolveRecoveryUserId(database, target);
  if (!resolved.ok) {
    return { ok: false, status: 'not_found', message: resolved.error };
  }
  return performSetUserAccount(
    database,
    { kind: 'operator_cli' },
    {
      op: 'rotate',
      rotateIdempotencyKey,
      userId: resolved.userId,
      pin,
      reasonCode: 'p2_operator_recovery',
    },
  );
}
