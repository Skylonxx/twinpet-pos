import { describe, expect, test, vi } from 'vitest';

vi.mock('./db', () => ({ db: {} }));
vi.mock('firebase-functions/v2/https', () => ({
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { assertFreshPrivilegedAuthority, evaluateFreshPrivilegedAuthority } from './authorityFence';

function dbWithUser(staffId: string, data: Record<string, unknown> | null) {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          if (name !== 'users' || id !== staffId || data == null) {
            return { exists: false, data: () => undefined };
          }
          return { exists: true, data: () => data };
        },
      }),
    }),
  };
}

const live = { isActive: true, deletedAt: null, authVersion: 3 };

describe('authorityFence', () => {
  test('unauthenticated', async () => {
    const r = await evaluateFreshPrivilegedAuthority(dbWithUser('s1', live) as never, null);
    expect(r).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  test('missing staffId', async () => {
    const r = await evaluateFreshPrivilegedAuthority(dbWithUser('s1', live) as never, { token: {} });
    expect(r).toEqual({ ok: false, reason: 'missing_staff' });
  });

  test('missing user', async () => {
    const r = await evaluateFreshPrivilegedAuthority(
      dbWithUser('s1', null) as never,
      { token: { staffId: 's1', authVersion: 0 } },
    );
    expect(r).toEqual({ ok: false, reason: 'missing_user' });
  });

  test('disabled', async () => {
    const r = await evaluateFreshPrivilegedAuthority(
      dbWithUser('s1', { ...live, isActive: false }) as never,
      { token: { staffId: 's1', authVersion: 3 } },
    );
    expect(r).toEqual({ ok: false, reason: 'disabled' });
  });

  test('deleted', async () => {
    const r = await evaluateFreshPrivilegedAuthority(
      dbWithUser('s1', { ...live, deletedAt: 'now' }) as never,
      { token: { staffId: 's1', authVersion: 3 } },
    );
    expect(r).toEqual({ ok: false, reason: 'deleted' });
  });

  test('stale: token default -1 vs doc default 0', async () => {
    const r = await evaluateFreshPrivilegedAuthority(
      dbWithUser('s1', { isActive: true, deletedAt: null }) as never,
      { token: { staffId: 's1' } },
    );
    expect(r).toEqual({ ok: false, reason: 'stale' });
  });

  test('fresh match', async () => {
    const r = await evaluateFreshPrivilegedAuthority(
      dbWithUser('s1', live) as never,
      { token: { staffId: 's1', authVersion: 3 } },
    );
    expect(r).toEqual({ ok: true, staffId: 's1', authVersion: 3 });
  });

  test('assertFreshPrivilegedAuthority throws permission-denied when stale', async () => {
    await expect(
      assertFreshPrivilegedAuthority(
        dbWithUser('s1', live) as never,
        { token: { staffId: 's1', authVersion: 0 } },
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
