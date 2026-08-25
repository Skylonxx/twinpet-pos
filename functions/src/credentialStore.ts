/**
 * Canonical server-only credential store: userCredentials/{userId}.
 * After reader cutover, no path may treat users.pin as authoritative.
 */
import { createHash } from 'node:crypto';
import type { DocumentData, Firestore, Transaction } from 'firebase-admin/firestore';

export const COLLECTIONS = {
  users: 'users',
  userCredentials: 'userCredentials',
  usernames: 'usernames',
  userAccountCommandIntents: 'userAccountCommandIntents',
  migrationControl: 'migrationControl',
  usernameCensus: 'usernameCensus',
  usernameCensusEntries: 'entries',
} as const;

export const USERNAME_RESERVATIONS_DOC_ID = 'usernameReservations';

export type CredentialState =
  | 'backfilled_not_trusted'
  | 'readers_cut_over_rotation_required'
  | 'rotated_authoritative';

export type UserCredentialDoc = {
  pinHash: string;
  algo: 'bcrypt';
  cost: number;
  credentialVersion: number;
  credentialState: CredentialState;
  disabled: boolean;
  updatedAt: unknown;
  updatedBy: string;
};

export function normalizeUsername(raw: string): string {
  return String(raw ?? '').trim().toLowerCase();
}

export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJSON(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(',')}}`;
}

export function sha256Hex(preimage: string): string {
  return createHash('sha256').update(preimage).digest('hex');
}

export function sha256Slice40(preimage: string): string {
  return sha256Hex(preimage).slice(0, 40);
}

export function credentialRef(database: Firestore, userId: string) {
  return database.collection(COLLECTIONS.userCredentials).doc(userId);
}

export async function readUserCredential(
  database: Firestore,
  userId: string,
  tx?: Transaction,
): Promise<UserCredentialDoc | null> {
  const ref = credentialRef(database, userId);
  const snap = tx ? await tx.get(ref) : await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() as DocumentData;
  if (typeof data.pinHash !== 'string' || !data.pinHash) return null;
  return {
    pinHash: data.pinHash,
    algo: data.algo === 'bcrypt' ? 'bcrypt' : 'bcrypt',
    cost: typeof data.cost === 'number' ? data.cost : 10,
    credentialVersion: typeof data.credentialVersion === 'number' ? data.credentialVersion : 0,
    credentialState: isCredentialState(data.credentialState)
      ? data.credentialState
      : 'backfilled_not_trusted',
    disabled: data.disabled === true,
    updatedAt: data.updatedAt ?? null,
    updatedBy: typeof data.updatedBy === 'string' ? data.updatedBy : '',
  };
}

export function isCredentialState(value: unknown): value is CredentialState {
  return (
    value === 'backfilled_not_trusted' ||
    value === 'readers_cut_over_rotation_required' ||
    value === 'rotated_authoritative'
  );
}

export function isAuthoritativeRotated(cred: UserCredentialDoc | null): boolean {
  return !!cred && cred.disabled !== true && cred.credentialState === 'rotated_authoritative';
}

export function isUsableForLogin(cred: UserCredentialDoc | null): cred is UserCredentialDoc {
  return !!cred && cred.disabled !== true && typeof cred.pinHash === 'string' && cred.pinHash.length > 0;
}

export function isPrivilegedRole(role: unknown): boolean {
  return role === 'admin' || role === 'manager';
}
