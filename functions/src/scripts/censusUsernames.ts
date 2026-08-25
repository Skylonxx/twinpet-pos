/**
 * Full unfiltered users census. Absent/null deletedAt is LIVE.
 * Writes entries/{userId} batches first, header last (publish signal).
 */
import { createHash } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { canonicalJSON, COLLECTIONS, normalizeUsername } from '../credentialStore';

export const CENSUS_NAMESPACE_DOC = 'usernameCensus';
export const CENSUS_HEADERS_SUB = 'headers';
export const CENSUS_ENTRIES_SUB = 'entries';

export type CensusEntry = {
  userId: string;
  rawUsername: string;
  normalizedUsername: string;
};

export type CensusHeader = {
  censusOperationId: string;
  createdAt: unknown;
  totalUserCount: number;
  liveUserCount: number;
  deletedUserCount: number;
  snapshotDigest: string;
  requestedEpoch: number;
  status: 'published';
};

export function isLiveDeletedAt(deletedAt: unknown): boolean {
  return deletedAt == null;
}

export function classifyUsers(
  docs: Array<{ id: string; data: () => Record<string, unknown> }>,
): { live: CensusEntry[]; deletedCount: number; totalUserCount: number } {
  const live: CensusEntry[] = [];
  let deletedCount = 0;
  for (const doc of docs) {
    const data = doc.data() ?? {};
    if (isLiveDeletedAt(data.deletedAt)) {
      const rawUsername = typeof data.username === 'string' ? data.username : '';
      live.push({
        userId: doc.id,
        rawUsername,
        normalizedUsername: normalizeUsername(rawUsername),
      });
    } else {
      deletedCount += 1;
    }
  }
  live.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return { live, deletedCount, totalUserCount: docs.length };
}

export function snapshotDigestOf(entries: CensusEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  return createHash('sha256').update(canonicalJSON(sorted)).digest('hex');
}

export function censusHeaderRef(database: Firestore, censusOperationId: string) {
  return database
    .collection(COLLECTIONS.migrationControl)
    .doc(CENSUS_NAMESPACE_DOC)
    .collection(CENSUS_HEADERS_SUB)
    .doc(censusOperationId);
}

export function censusEntriesCol(database: Firestore, censusOperationId: string) {
  return censusHeaderRef(database, censusOperationId).collection(CENSUS_ENTRIES_SUB);
}

export async function loadAllUsersUnfiltered(
  database: Firestore,
): Promise<Array<{ id: string; data: () => Record<string, unknown> }>> {
  const snap = await database.collection(COLLECTIONS.users).get();
  return snap.docs.map((d) => ({
    id: d.id,
    data: () => (d.data() ?? {}) as Record<string, unknown>,
  }));
}

export async function loadPublishedCensus(
  database: Firestore,
  censusOperationId: string,
): Promise<{ header: CensusHeader; entries: CensusEntry[] }> {
  const headerSnap = await censusHeaderRef(database, censusOperationId).get();
  if (!headerSnap.exists) {
    throw new Error(`CENSUS_HEADER_ABSENT:${censusOperationId}`);
  }
  const header = headerSnap.data() as CensusHeader;
  const entriesSnap = await censusEntriesCol(database, censusOperationId).get();
  const entries = entriesSnap.docs.map((d) => d.data() as CensusEntry);
  if (entries.length !== header.liveUserCount) {
    throw new Error(`CENSUS_COUNT_MISMATCH:entries=${entries.length},header=${header.liveUserCount}`);
  }
  const digest = snapshotDigestOf(entries);
  if (digest !== header.snapshotDigest) {
    throw new Error(`CENSUS_DIGEST_MISMATCH`);
  }
  return { header, entries };
}

export async function runCensusUsernames(
  database: Firestore,
  censusOperationId: string,
  requestedEpoch = 0,
): Promise<CensusHeader> {
  const docs = await loadAllUsersUnfiltered(database);
  const classified = classifyUsers(docs);
  const snapshotDigest = snapshotDigestOf(classified.live);
  const headerRef = censusHeaderRef(database, censusOperationId);
  const entriesCol = censusEntriesCol(database, censusOperationId);

  for (let i = 0; i < classified.live.length; i += 500) {
    const chunk = classified.live.slice(i, i + 500);
    const batch = database.batch();
    for (const entry of chunk) {
      batch.set(entriesCol.doc(entry.userId), entry);
    }
    await batch.commit();
  }

  const header: CensusHeader = {
    censusOperationId,
    createdAt: FieldValue.serverTimestamp(),
    totalUserCount: classified.totalUserCount,
    liveUserCount: classified.live.length,
    deletedUserCount: classified.deletedCount,
    snapshotDigest,
    requestedEpoch,
    status: 'published',
  };
  await headerRef.set(header);
  return header;
}
