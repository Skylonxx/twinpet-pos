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

import { performGetShiftCloseCaseFigures } from './getShiftCloseCaseFigures';

const request = { branchId: 'LDP-001', shiftId: 'SHIFT-1', expectedCaseVersion: 1 };

describe('getShiftCloseCaseFigures stale authority', () => {
  test('stale token is unauthorized with only the users read', async () => {
    const reads: { collection: string; id: string }[] = [];
    const db = {
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            reads.push({ collection: name, id });
            if (name === 'users') {
              return { exists: true, data: () => ({ isActive: true, deletedAt: null, authVersion: 5 }) };
            }
            throw new Error('case must not be read');
          },
        }),
      }),
    };
    const res = await performGetShiftCloseCaseFigures(db as never, request, {
      token: { staffId: 'STAFF-1', role: 'manager', branchIds: ['LDP-001'], authVersion: 0 },
    });
    expect(res).toEqual({ status: 'unauthorized' });
    expect(reads).toEqual([{ collection: 'users', id: 'STAFF-1' }]);
  });
});
