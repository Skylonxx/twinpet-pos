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
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: () => ({}), serverTimestamp: () => ({}) },
  Timestamp: class Timestamp {
    static fromMillis(ms: number) {
      return { seconds: Math.floor(ms / 1000), nanoseconds: 0, toMillis: () => ms };
    }
  },
}));
vi.mock('bcryptjs', () => ({ default: { compare: async () => true } }));

import { performResolveReversal } from './resolveReversal';

const req = {
  idempotencyKey: 'k',
  actionType: 'receiving_reversal' as const,
  sourceDocumentId: 'R1',
  sourceDocumentType: 'receiving' as const,
  branchId: 'B1',
  reasonCode: 'wrong_entry',
  localIntentId: 'LI1',
};

describe('resolveReversal stale authority', () => {
  test('stale authVersion rejects unauthorized without stock mutation', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['users/m1', { isActive: true, deletedAt: null, authVersion: 2, role: 'manager' }],
    ]);
    const db = {
      collection: (c: string) => ({ doc: (id: string) => ({ path: `${c}/${id}`, id }) }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: async (r: { path: string }) => {
            const data = store.get(r.path);
            return { exists: data !== undefined, data: () => data };
          },
          set: () => {
            throw new Error('no writes on stale');
          },
          update: () => {
            throw new Error('no writes on stale');
          },
        };
        return fn(tx);
      },
    };
    const res = await performResolveReversal(db as never, req, {
      uid: 'u',
      token: { role: 'manager', staffId: 'm1', branchIds: ['B1'], authVersion: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.rejectCode).toBe('unauthorized');
  });
});
