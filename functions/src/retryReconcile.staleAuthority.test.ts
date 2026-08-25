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

import { performReconcileRetry } from './retryReconcile';

function dbWithUser(user: Record<string, unknown> | null) {
  return {
    collection: (c: string) => ({
      doc: (id: string) => ({
        path: `${c}/${id}`,
        get: async () => {
          if (c !== 'users') return { exists: false, data: () => undefined };
          return { exists: user != null, data: () => user };
        },
      }),
    }),
    runTransaction: async () => {
      throw new Error('should not enter tx when stale');
    },
    __store: new Map(),
  };
}

const admin = { uid: 'u', token: { role: 'admin', staffId: 'admin1', authVersion: 0 } };

describe('retryReconcile stale authority', () => {
  test('stale authVersion is permission-denied before re-arm', async () => {
    await expect(
      performReconcileRetry(
        dbWithUser({ isActive: true, deletedAt: null, authVersion: 4 }) as never,
        'o1',
        admin,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('disabled admin is permission-denied', async () => {
    await expect(
      performReconcileRetry(
        dbWithUser({ isActive: false, deletedAt: null, authVersion: 0 }) as never,
        'o1',
        admin,
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
