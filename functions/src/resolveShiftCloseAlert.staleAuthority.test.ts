import { describe, expect, test, vi } from 'vitest';

vi.mock('./db', () => ({ db: { __unused: true } }));
vi.mock('./deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: () => () => {},
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
  Timestamp: class Timestamp {
    static fromMillis(ms: number) {
      return { toMillis: () => ms };
    }
  },
}));

import { performResolveShiftCloseAlert } from './resolveShiftCloseAlert';

const req = {
  commandId: 'cmd-1',
  shiftId: 'S1',
  branchId: 'B1',
  expectedCaseVersion: 5,
  requestedOutcome: 'acknowledge' as const,
  reasonCode: 'drawer_discrepancy',
  reasonNote: 'ok',
};

describe('resolveShiftCloseAlert D3 freshness', () => {
  test('stale manager is unauthorized and does not write', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['users/m1', { isActive: true, deletedAt: null, authVersion: 8, role: 'manager' }],
    ]);
    const db = {
      collection: (c: string) => ({
        doc: (id: string) => ({
          path: `${c}/${id}`,
          id,
          get: async () => {
            const data = store.get(`${c}/${id}`);
            return { exists: data !== undefined, data: () => data };
          },
        }),
      }),
      runTransaction: async () => {
        throw new Error('no tx on stale');
      },
    };
    const res = await performResolveShiftCloseAlert(db as never, req, {
      uid: 'u',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.rejectCode).toBe('unauthorized');
  });

  test('fresh manager proceeds past the freshness gate (payload still validated)', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['users/m1', { isActive: true, deletedAt: null, authVersion: 0, role: 'manager' }],
    ]);
    const db = {
      collection: (c: string) => ({
        doc: (id: string) => ({
          path: `${c}/${id}`,
          id,
          get: async () => {
            const data = store.get(`${c}/${id}`);
            return { exists: data !== undefined, data: () => data };
          },
        }),
      }),
      runTransaction: async () => ({ ok: true, status: 'confirmed', commandId: 'cmd-1', shiftId: 'S1' }),
    };
    const res = await performResolveShiftCloseAlert(db as never, req, {
      uid: 'u',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 },
    });
    expect(res.rejectCode).not.toBe('unauthorized');
  });
});
