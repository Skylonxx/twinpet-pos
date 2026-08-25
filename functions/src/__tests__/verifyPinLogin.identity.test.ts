import { describe, expect, test, vi } from 'vitest';
import bcrypt from 'bcryptjs';

vi.mock('../db', () => ({ db: { __unused: true } }));
vi.mock('../deployConfig', () => ({ FUNCTIONS_REGION: 'asia-southeast1', FIRESTORE_DATABASE_ID: 'pos-db' }));
vi.mock('firebase-functions/v2', () => ({ setGlobalOptions: () => {} }));
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
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ setCustomUserClaims: async () => undefined }) }));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => ({ __fv: 'ts' }) },
  Timestamp: class Timestamp {},
}));
vi.mock('../reconcileOrder', () => ({ reconcileOrder: {} }));
vi.mock('../retryReconcile', () => ({ retryReconcile: {} }));
vi.mock('../resolveTransferDiscrepancy', () => ({ resolveTransferDiscrepancy: {} }));
vi.mock('../resolveReversal', () => ({ resolveReversal: {} }));
vi.mock('../shiftCloseEvidenceCapture', () => ({ shiftCloseEvidenceCapture: {} }));
vi.mock('../shiftCloseValidationWorker', () => ({ shiftCloseValidationSweep: {} }));
vi.mock('../shiftCloseSourceEvents', () => ({
  shiftCloseSourceEventAsyncOrders: {},
  shiftCloseSourceEventOrders: {},
  shiftCloseSourceEventCashTransactions: {},
  shiftCloseSourceEventCreditPayments: {},
}));
vi.mock('../resolveShiftCloseAlert', () => ({ resolveShiftCloseAlert: {} }));
vi.mock('../getShiftCloseCaseFigures', () => ({ getShiftCloseCaseFigures: {} }));
vi.mock('../getOrderReceipt', () => ({ getOrderReceipt: {} }));
vi.mock('../setUserAccount', () => ({ setUserAccount: {} }));

import { LOGIN_DUMMY_PIN_HASH, resolvePinLoginIdentity } from '../index';

type Doc = Record<string, unknown>;

function makeDb(docs: Array<{ id: string; data: Doc }>) {
  const byId = new Map(docs.map((d) => [d.id, d.data]));
  return {
    collection: (name: string) => {
      if (name === 'userCredentials') {
        return {
          doc: (id: string) => ({
            get: async () => {
              const data = byId.get(`cred:${id}`);
              return { exists: data !== undefined, data: () => data };
            },
          }),
        };
      }
      return {
        doc: (id: string) => ({
          get: async () => {
            const data = byId.get(id);
            return { exists: data !== undefined, id, data: () => data };
          },
        }),
        where: () => ({
          where: () => ({
            where: () => ({
              limit: () => ({
                get: async () => ({
                  docs: docs
                    .filter((d) => !String(d.id).startsWith('cred:'))
                    .map((d) => ({ id: d.id, data: () => d.data })),
                }),
              }),
            }),
          }),
        }),
      };
    },
  };
}

const pin = '1234';

describe('resolvePinLoginIdentity', () => {
  test('missing username and userId is invalid-argument (not well-formed)', async () => {
    await expect(resolvePinLoginIdentity(makeDb([]) as never, pin, 'LDP-001')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  test('zero candidates: exactly one dummy compare, no match', async () => {
    const spy = vi.spyOn(bcrypt, 'compare');
    const out = await resolvePinLoginIdentity(makeDb([]) as never, pin, 'LDP-001', 'ghost');
    expect(out.match).toBeNull();
    expect(out.bcryptComparisons).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBe(LOGIN_DUMMY_PIN_HASH);
    spy.mockRestore();
  });

  test('ambiguous candidates: dummy work, never first-match', async () => {
    const hash = await bcrypt.hash(pin, 4);
    const spy = vi.spyOn(bcrypt, 'compare');
    const db = makeDb([
      { id: 'a', data: { username: 'dup', role: 'staff', branchIds: ['LDP-001'], isActive: true, deletedAt: null } },
      { id: 'b', data: { username: 'dup', role: 'staff', branchIds: ['LDP-001'], isActive: true, deletedAt: null } },
      { id: 'cred:a', data: { pinHash: hash, credentialState: 'rotated_authoritative', disabled: false } },
      { id: 'cred:b', data: { pinHash: hash, credentialState: 'rotated_authoritative', disabled: false } },
    ]);
    const out = await resolvePinLoginIdentity(db as never, pin, 'LDP-001', 'dup');
    expect(out.match).toBeNull();
    expect(out.bcryptComparisons).toBe(1);
    expect(spy.mock.calls[0]![1]).toBe(LOGIN_DUMMY_PIN_HASH);
    spy.mockRestore();
  });

  test('exactly one staff with readers_cut_over may login', async () => {
    const hash = await bcrypt.hash(pin, 4);
    const db = makeDb([
      {
        id: 's1',
        data: {
          username: 'suda',
          role: 'staff',
          branchIds: ['LDP-001'],
          isActive: true,
          deletedAt: null,
          firstName: 'Suda',
          lastName: 'S',
          permissions: {},
        },
      },
      {
        id: 'cred:s1',
        data: { pinHash: hash, credentialState: 'readers_cut_over_rotation_required', disabled: false },
      },
    ]);
    const out = await resolvePinLoginIdentity(db as never, pin, 'LDP-001', 'suda');
    expect(out.bcryptComparisons).toBe(1);
    expect(out.match?.id).toBe('s1');
  });

  test('manager pre-rotation cannot mint after a real compare', async () => {
    const hash = await bcrypt.hash(pin, 4);
    const spy = vi.spyOn(bcrypt, 'compare');
    const db = makeDb([
      {
        id: 'm1',
        data: {
          username: 'boss',
          role: 'manager',
          branchIds: ['LDP-001'],
          isActive: true,
          deletedAt: null,
          firstName: 'Boss',
          lastName: 'M',
          permissions: {},
        },
      },
      {
        id: 'cred:m1',
        data: { pinHash: hash, credentialState: 'readers_cut_over_rotation_required', disabled: false },
      },
    ]);
    const out = await resolvePinLoginIdentity(db as never, pin, 'LDP-001', 'boss');
    expect(out.match).toBeNull();
    expect(out.bcryptComparisons).toBe(1);
    expect(spy.mock.calls[0]![1]).toBe(hash);
    spy.mockRestore();
  });
});
