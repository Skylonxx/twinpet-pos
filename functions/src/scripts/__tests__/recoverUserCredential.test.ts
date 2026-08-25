import { describe, expect, test, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
}));

import { runRecoverUserCredential, resolveRecoveryUserId } from '../recoverUserCredential';

type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  const resolveVal = (cur: unknown, v: unknown): unknown => {
    if (v && typeof v === 'object' && (v as { __fv?: string }).__fv === 'inc') {
      return ((cur as number) ?? 0) + ((v as { n: number }).n ?? 0);
    }
    return v;
  };
  function docRef(path: string) {
    return { path, id: path.slice(path.lastIndexOf('/') + 1) };
  }
  return {
    collection: (c: string) => ({
      doc: (id: string) => docRef(`${c}/${id}`),
      get: async () => {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${c}/`) && !p.slice(c.length + 1).includes('/'))
          .map(([p, data]) => ({ id: p.slice(p.lastIndexOf('/') + 1), data: () => data }));
        return { docs };
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        get: async (r: { path: string }) => {
          const data = store.get(r.path);
          return { exists: data !== undefined, data: () => data };
        },
        set: (r: { path: string }, data: Doc, opts?: { merge?: boolean }) => {
          const existing = opts?.merge ? (store.get(r.path) ?? {}) : {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        update: (r: { path: string }, data: Doc) => {
          const existing = store.get(r.path) ?? {};
          const next: Doc = { ...existing };
          for (const [k, v] of Object.entries(data)) next[k] = resolveVal(existing[k], v);
          store.set(r.path, next);
        },
        delete: (r: { path: string }) => store.delete(r.path),
      };
      return fn(tx);
    },
    __store: store,
  };
}

describe('recoverUserCredential P2', () => {
  test('username ambiguity lists candidate userIds only', async () => {
    const db = makeDb({
      'users/a': { username: 'Same', deletedAt: null },
      'users/b': { username: 'same', deletedAt: null },
    });
    const res = await resolveRecoveryUserId(db as never, { username: 'same' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('USERNAME_AMBIGUOUS');
      expect(res.candidateUserIds).toEqual(['a', 'b']);
    }
  });

  test('operator rotate calls canonical core in-process', async () => {
    const db = makeDb({
      'migrationControl/usernameReservations': { complete: true, maintenanceMode: false, epoch: 1 },
      'users/target': { username: 'admin', role: 'admin', isActive: true, deletedAt: null, authVersion: 0 },
    });
    const res = await runRecoverUserCredential(db as never, { userId: 'target' }, '7777', 'rec-1');
    expect(res.ok).toBe(true);
    expect(res.status).toBe('rotated');
    expect(JSON.stringify(db.__store)).not.toContain('7777');
  });
});
