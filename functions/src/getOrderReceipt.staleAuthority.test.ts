import { describe, expect, test, vi } from 'vitest';

vi.mock('./db', () => ({ db: { __unused: true } }));
vi.mock('./deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2/https', () => ({
  onCall: () => () => {},
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import { authorizeReceiptAccess } from './getOrderReceipt';

describe('getOrderReceipt stale authority', () => {
  test('stale token is permission-denied', async () => {
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => ({ exists: true, data: () => ({ isActive: true, deletedAt: null, authVersion: 2 }) }),
        }),
      }),
    };
    await expect(
      authorizeReceiptAccess(
        db as never,
        { uid: 'u', token: { staffId: 'u', branchIds: ['ALL'], authVersion: 0 } },
        'br1',
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
