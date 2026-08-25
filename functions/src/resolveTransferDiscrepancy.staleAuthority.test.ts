import { describe, expect, test, vi } from 'vitest';

vi.mock('./db', () => ({ db: { __unused: true } }));
vi.mock('./deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: () => ({}), serverTimestamp: () => ({}) },
  Timestamp: class Timestamp {},
}));

import { performResolveTransferDiscrepancy } from './resolveTransferDiscrepancy';

function dbWithUser(user: Record<string, unknown> | null) {
  return {
    collection: (c: string) => ({
      doc: (id: string) => ({
        path: `${c}/${id}`,
        get: async () => ({ exists: c === 'users' && user != null, data: () => user }),
      }),
    }),
    runTransaction: async () => {
      throw new Error('should not enter tx when stale');
    },
  };
}

const origin = {
  uid: 'u1',
  token: { role: 'staff', staffId: 's-origin', branchIds: ['BR-ORIGIN'], authVersion: 0 },
};

describe('resolveTransferDiscrepancy stale authority', () => {
  test('stale token cannot resolve', async () => {
    await expect(
      performResolveTransferDiscrepancy(
        dbWithUser({ isActive: true, deletedAt: null, authVersion: 9 }) as never,
        { transferId: 'T1', discrepancyId: 'D1' } as never,
        origin,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
