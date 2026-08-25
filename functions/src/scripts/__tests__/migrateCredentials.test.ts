import { describe, expect, test, vi } from 'vitest';

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: {
    increment: (n: number) => ({ __fv: 'inc', n }),
    serverTimestamp: () => ({ __fv: 'ts' }),
  },
}));

import { runMigrateCredentials, waiveCredential } from '../migrateCredentials';

type Doc = Record<string, unknown>;

function makeDb(seed: Record<string, Doc>) {
  const store = new Map<string, Doc>(Object.entries(seed).map(([k, v]) => [k, { ...v }]));
  function docRef(path: string) {
    return {
      path,
      get: async () => {
        const data = store.get(path);
        return { exists: data !== undefined, data: () => data };
      },
      set: async (data: Doc, opts?: { merge?: boolean }) => {
        store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...data } : { ...data });
      },
    };
  }
  function col(path: string) {
    return {
      doc: (id: string) => docRef(`${path}/${id}`),
      get: async () => {
        const docs = [...store.entries()]
          .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
          .map(([p, data]) => ({
            id: p.slice(p.lastIndexOf('/') + 1),
            data: () => data,
            ref: docRef(p),
          }));
        return { docs, size: docs.length };
      },
    };
  }
  return { collection: (c: string) => col(c), __store: store };
}

describe('migrateCredentials', () => {
  test('backfill copies users.pin into userCredentials as backfilled_not_trusted', async () => {
    const db = makeDb({ 'users/u1': { username: 'a', pin: '$2b$10$hash', deletedAt: null } });
    const res = await runMigrateCredentials(db as never, 'backfill');
    expect(res.ok).toBe(true);
    expect(db.__store.get('userCredentials/u1')).toMatchObject({
      pinHash: '$2b$10$hash',
      credentialState: 'backfilled_not_trusted',
    });
  });

  test('cut_over_readers moves backfilled to rotation required', async () => {
    const db = makeDb({
      'users/u1': { username: 'a', pin: '$2b$10$hash', deletedAt: null },
      'userCredentials/u1': { pinHash: '$2b$10$hash', credentialState: 'backfilled_not_trusted', disabled: false },
    });
    const res = await runMigrateCredentials(db as never, 'cut_over_readers');
    expect(res.ok).toBe(true);
    expect(db.__store.get('userCredentials/u1')).toMatchObject({
      credentialState: 'readers_cut_over_rotation_required',
    });
  });

  test('clear_legacy_pin is blocked until every account is rotated or waived', async () => {
    const db = makeDb({
      'users/u1': { username: 'a', pin: '$2b$10$hash', deletedAt: null },
      'userCredentials/u1': {
        pinHash: '$2b$10$hash',
        credentialState: 'readers_cut_over_rotation_required',
        disabled: false,
      },
    });
    const res = await runMigrateCredentials(db as never, 'clear_legacy_pin');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('LEGACY_PIN_CLEAR_BLOCKED_PENDING_ROTATION');
    expect(db.__store.get('users/u1')).toMatchObject({ pin: '$2b$10$hash' });
  });

  test('waiver plus rotated allows legacy pin clear', async () => {
    const db = makeDb({
      'users/u1': { username: 'a', pin: '$2b$10$hash', deletedAt: null, authVersion: 0 },
      'userCredentials/u1': { pinHash: 'x', credentialState: 'rotated_authoritative', disabled: false, credentialVersion: 1 },
    });
    await waiveCredential(db as never, 'u1');
    const res = await runMigrateCredentials(db as never, 'clear_legacy_pin');
    expect(res.ok).toBe(true);
    expect(db.__store.get('users/u1')).toMatchObject({ pin: '' });
  });
});
