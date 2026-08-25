import { describe, expect, test, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
}));

import {
  classifyUsers,
  isLiveDeletedAt,
  runCensusUsernames,
  snapshotDigestOf,
  type CensusEntry,
} from '../censusUsernames';

type Doc = Record<string, unknown>;

function makeDb() {
  const store = new Map<string, Doc>();
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
    batch: () => {
      const ops: Array<() => void> = [];
      return {
        set: (ref: { path: string }, data: Doc) => {
          ops.push(() => {
            store.set(ref.path, { ...data });
          });
        },
        commit: async () => {
          for (const op of ops) op();
        },
      };
    },
    __store: store,
  };
}

describe('censusUsernames', () => {
  test('absent and null deletedAt are LIVE', () => {
    expect(isLiveDeletedAt(null)).toBe(true);
    expect(isLiveDeletedAt(undefined)).toBe(true);
    expect(isLiveDeletedAt('2020-01-01')).toBe(false);
  });

  test('full unfiltered scan includes deleted users in total but not live', () => {
    const classified = classifyUsers([
      { id: 'a', data: () => ({ username: 'A', deletedAt: null }) },
      { id: 'b', data: () => ({ username: 'B' }) },
      { id: 'c', data: () => ({ username: 'C', deletedAt: 'x' }) },
    ]);
    expect(classified.totalUserCount).toBe(3);
    expect(classified.deletedCount).toBe(1);
    expect(classified.live.map((e) => e.userId)).toEqual(['a', 'b']);
  });

  test('entries are written before header; header absence is distinct from entries', async () => {
    const db = makeDb();
    db.__store.set('users/u1', { username: 'Somchai', deletedAt: null });
    const header = await runCensusUsernames(db as never, 'op-1', 0);
    const entryKeys = [...db.__store.keys()].filter((k) => k.includes('/entries/'));
    expect(entryKeys).toContain(
      'migrationControl/usernameCensus/headers/op-1/entries/u1',
    );
    expect(db.__store.has('migrationControl/usernameCensus/headers/op-1')).toBe(true);
    expect(header.liveUserCount).toBe(1);
    expect(header.snapshotDigest).toBe(
      snapshotDigestOf([{ userId: 'u1', rawUsername: 'Somchai', normalizedUsername: 'somchai' } as CensusEntry]),
    );
  });
});
