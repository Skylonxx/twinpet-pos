/**
 * Repair username reservations from a durable census.
 * 8-step load: header → entries → count → digest → manifest binding → re-scan → fwd/bwd drift → halt.
 * Applied-entry targets occupy uniqueness for later undone entries.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { COLLECTIONS } from '../credentialStore';
import {
  classifyUsers,
  loadAllUsersUnfiltered,
  loadPublishedCensus,
  type CensusEntry,
} from './censusUsernames';

export type RepairManifest = {
  censusOperationId: string;
  snapshotDigest: string;
  appliedUserIds?: string[];
};

export type RepairResult = {
  ok: boolean;
  writes: number;
  applied: string[];
  error?: string;
  driftedUserIds?: string[];
};

function liveMap(entries: CensusEntry[]): Map<string, CensusEntry> {
  return new Map(entries.map((e) => [e.userId, e]));
}

export function detectDrift(
  censusEntries: CensusEntry[],
  currentLive: CensusEntry[],
): string[] {
  const a = liveMap(censusEntries);
  const b = liveMap(currentLive);
  const drifted = new Set<string>();
  for (const [id, entry] of a) {
    const now = b.get(id);
    if (!now) {
      drifted.add(id);
      continue;
    }
    if (now.normalizedUsername !== entry.normalizedUsername) drifted.add(id);
  }
  for (const [id] of b) {
    if (!a.has(id)) drifted.add(id);
  }
  return [...drifted].sort();
}

export function planReservationWrites(
  entries: CensusEntry[],
  alreadyApplied: Set<string>,
): { ok: true; writes: Array<{ username: string; userId: string }> } | { ok: false; error: string } {
  const occupied = new Map<string, string>();
  const writes: Array<{ username: string; userId: string }> = [];
  const ordered = [...entries].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  for (const entry of ordered) {
    if (!entry.normalizedUsername) {
      return { ok: false, error: `EMPTY_USERNAME:${entry.userId}` };
    }
    const owner = occupied.get(entry.normalizedUsername);
    if (owner && owner !== entry.userId) {
      return { ok: false, error: `NORMALIZATION_COLLISION:${entry.normalizedUsername}:${owner}:${entry.userId}` };
    }
    occupied.set(entry.normalizedUsername, entry.userId);
    if (!alreadyApplied.has(entry.userId)) {
      writes.push({ username: entry.normalizedUsername, userId: entry.userId });
    }
  }
  return { ok: true, writes };
}

export async function runRepairUsernameReservations(
  database: Firestore,
  manifest: RepairManifest,
): Promise<RepairResult> {
  let published;
  try {
    published = await loadPublishedCensus(database, manifest.censusOperationId);
  } catch (err) {
    return { ok: false, writes: 0, applied: [], error: err instanceof Error ? err.message : String(err) };
  }
  if (manifest.snapshotDigest !== published.header.snapshotDigest) {
    return { ok: false, writes: 0, applied: [], error: 'MANIFEST_BINDING_MISMATCH' };
  }

  const currentDocs = await loadAllUsersUnfiltered(database);
  const current = classifyUsers(currentDocs).live;
  const drifted = detectDrift(published.entries, current);
  if (drifted.length > 0) {
    return { ok: false, writes: 0, applied: [], error: 'DRIFT_HALT', driftedUserIds: drifted };
  }

  const alreadyApplied = new Set(manifest.appliedUserIds ?? []);
  const plan = planReservationWrites(published.entries, alreadyApplied);
  if (!plan.ok) return { ok: false, writes: 0, applied: [], error: plan.error };

  let writes = 0;
  const applied = [...alreadyApplied];
  for (const item of plan.writes) {
    await database.collection(COLLECTIONS.usernames).doc(item.username).set({
      userId: item.userId,
      reservedAt: new Date().toISOString(),
    });
    writes += 1;
    applied.push(item.userId);
  }
  return { ok: true, writes, applied };
}
