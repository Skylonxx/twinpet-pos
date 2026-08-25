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
vi.mock('bcryptjs', () => ({ default: { compare: async (pin: string, hash: string) => pin === hash } }));

import { performResolveReversal } from './resolveReversal';

const req = {
  idempotencyKey: 'k',
  actionType: 'receiving_reversal' as const,
  sourceDocumentId: 'R1',
  sourceDocumentType: 'receiving' as const,
  branchId: 'B1',
  reasonCode: 'wrong_entry',
  localIntentId: 'LI1',
  pin: '1234',
};

describe('resolveReversal canonical credential', () => {
  test('staff PIN is compared against userCredentials, not users.pin', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['users/s-staff', { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', pin: 'LEGACY' }],
      [
        'userCredentials/s-staff',
        { pinHash: '1234', credentialState: 'rotated_authoritative', disabled: false },
      ],
    ]);
    let comparedAgainstLegacy = false;
    const db = {
      collection: (c: string) => ({
        doc: (id: string) => ({ path: `${c}/${id}`, id, collection: (n: string) => ({ path: `${c}/${id}/${n}` }) }),
        where: () => ({ orderBy: () => ({}) }),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: async (r: { path: string }) => {
            if (r.path === 'users/s-staff' && store.get(r.path)?.pin === 'LEGACY') {
              comparedAgainstLegacy = comparedAgainstLegacy || false;
            }
            const data = store.get(r.path);
            return { exists: data !== undefined, data: () => data, docs: [], empty: true, size: 0 };
          },
          set: () => undefined,
          update: () => undefined,
        };
        return fn(tx);
      },
    };
    const res = await performResolveReversal(db as never, req, {
      uid: 'u',
      token: { role: 'staff', staffId: 's-staff', branchIds: ['B1'], authVersion: 0 },
    });
    expect(comparedAgainstLegacy).toBe(false);
    expect(res.ok).toBe(false);
    expect(res.rejectCode).toBe('source_document_not_found');
  });

  test('legacy users.pin is not sufficient when credential store is empty', async () => {
    const store = new Map<string, Record<string, unknown>>([
      ['users/s-staff', { isActive: true, deletedAt: null, authVersion: 0, role: 'staff', pin: '1234' }],
    ]);
    const db = {
      collection: (c: string) => ({
        doc: (id: string) => ({ path: `${c}/${id}`, id }),
      }),
      runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          get: async (r: { path: string }) => {
            const data = store.get(r.path);
            return { exists: data !== undefined, data: () => data };
          },
          set: () => undefined,
          update: () => undefined,
        };
        return fn(tx);
      },
    };
    const res = await performResolveReversal(db as never, req, {
      uid: 'u',
      token: { role: 'staff', staffId: 's-staff', branchIds: ['B1'], authVersion: 0 },
    });
    expect(res.ok).toBe(false);
    expect(res.rejectCode).toBe('invalid_pin');
  });
});
