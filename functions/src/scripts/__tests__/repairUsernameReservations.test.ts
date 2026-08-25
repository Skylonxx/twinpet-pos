import { describe, expect, test } from 'vitest';
import { detectDrift, planReservationWrites, runRepairUsernameReservations } from '../repairUsernameReservations';
import { snapshotDigestOf, type CensusEntry } from '../censusUsernames';

type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc> = {}) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  function docRef(path: string) {
    return {
      path,
      id: path.slice(path.lastIndexOf('/') + 1),
      collection: (n: string) => col(`${path}/${n}`),
      set: async (data: Doc) => {
        store.set(path, { ...data });
      },
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
    };
  }
  function col(path: string) {
    return {
      doc: (id: string) => docRef(`${path}/${id}`),
      get: async () => {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .map(([p, data]) => ({ id: p.slice(p.lastIndexOf('/') + 1), data: () => data, ref: docRef(p) }));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
    };
  }
  return {
    collection: (c: string) => col(c),
    __store: store,
  };
}

const e = (userId: string, username: string): CensusEntry => ({
  userId,
  rawUsername: username,
  normalizedUsername: username.trim().toLowerCase(),
});

describe('repairUsernameReservations', () => {
  test('forward and backward drift halt with zero writes', () => {
    expect(detectDrift([e('a', 'x')], [e('a', 'y')])).toEqual(['a']);
    expect(detectDrift([e('a', 'x')], [e('a', 'x'), e('b', 'z')])).toEqual(['b']);
    expect(detectDrift([e('a', 'x'), e('b', 'z')], [e('a', 'x')])).toEqual(['b']);
  });

  test('applied-entry target occupies uniqueness for later undone entries', () => {
    const plan = planReservationWrites([e('a', 'same'), e('b', 'same')], new Set(['a']));
    expect(plan.ok).toBe(false);
  });

  test('header absent hard-fails before writes', async () => {
    const db = makeDb({ 'users/a': { username: 'a', deletedAt: null } });
    const res = await runRepairUsernameReservations(db as never, {
      censusOperationId: 'missing',
      snapshotDigest: 'nope',
    });
    expect(res.ok).toBe(false);
    expect(res.writes).toBe(0);
    expect(res.error).toMatch(/CENSUS_HEADER_ABSENT/);
  });

  test('digest mismatch writes nothing', async () => {
    const entries = [e('a', 'ann')];
    const db = makeDb({
      'users/a': { username: 'ann', deletedAt: null },
      'migrationControl/usernameCensus/headers/op1': {
        liveUserCount: 1,
        snapshotDigest: snapshotDigestOf(entries),
      },
      'migrationControl/usernameCensus/headers/op1/entries/a': entries[0],
    });
    const res = await runRepairUsernameReservations(db as never, {
      censusOperationId: 'op1',
      snapshotDigest: 'wrong',
    });
    expect(res.ok).toBe(false);
    expect(res.writes).toBe(0);
  });
});
