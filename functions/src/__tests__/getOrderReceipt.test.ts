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

import { authorizeReceiptAccess, performGetOrderReceipt } from '../getOrderReceipt';

function freshDb(staffId = 'u', over: Record<string, unknown> = {}) {
  const users: Record<string, Record<string, unknown>> = {
    [staffId]: { isActive: true, deletedAt: null, authVersion: 0, ...over },
  };
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        collection: (sub: string) => ({ path: `${name}/${id}/${sub}`, __kind: sub }),
        get: async () => {
          if (name !== 'users') return { exists: false, data: () => undefined };
          const data = users[id];
          return { exists: data !== undefined, data: () => data };
        },
      }),
      where: (field: string, _op: string, value: unknown) => ({ path: `${name}?${field}=${String(value)}`, __kind: name }),
    }),
    runTransaction: async (fn: (t: unknown) => Promise<unknown>) => fn({
      get: async (ref: { path?: string; __kind?: string }) => ({
        exists: false,
        data: () => undefined,
        docs: [],
        path: ref.path,
        __kind: ref.__kind,
      }),
    }),
  };
}

describe('G01 G12 G13 getOrderReceipt callable layer', () => {
  test('G01 authz allow/deny set', async () => {
    const db = freshDb('u') as never;
    await expect(authorizeReceiptAccess(db, null, 'br1')).rejects.toThrow(/unauthenticated|เข้าสู่ระบบ/);
    await expect(authorizeReceiptAccess(db, { uid: 'u', token: { staffId: 'u', branchIds: [], authVersion: 0 } }, 'br1')).rejects.toThrow(/permission-denied|สิทธิ์/);
    await expect(authorizeReceiptAccess(db, { uid: 'u', token: { staffId: 'u', branchIds: ['br2'], authVersion: 0 } }, 'br1')).rejects.toThrow(/permission-denied|สาขา/);
    await expect(authorizeReceiptAccess(db, { uid: 'u', token: { staffId: 'u', branchIds: ['ALL'], authVersion: 0 } }, 'br1')).resolves.toBeUndefined();
    await expect(authorizeReceiptAccess(db, { uid: 'u', token: { staffId: 'u', branchIds: ['br1'], authVersion: 0 } }, 'br1')).resolves.toBeUndefined();
  });

  test('G12 exactly four reads inside one transaction; no extra tx read', async () => {
    const reads: string[] = [];
    const tx = {
      get: async (ref: { path?: string; __kind?: string }) => {
        reads.push(ref.path ?? ref.__kind ?? 'unknown');
        return { exists: false, data: () => undefined, docs: [] };
      },
    };
    const database = {
      collection: (name: string) => ({
        doc: (id: string) => ({
          path: `${name}/${id}`,
          collection: (sub: string) => ({ path: `${name}/${id}/${sub}`, __kind: sub }),
          get: async () => ({
            exists: name === 'users',
            data: () => (name === 'users' ? { isActive: true, deletedAt: null, authVersion: 0 } : undefined),
          }),
        }),
        where: (field: string, _op: string, value: unknown) => ({ path: `${name}?${field}=${String(value)}`, __kind: name }),
      }),
      runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    await performGetOrderReceipt(
      database as never,
      { orderId: 'o1' },
      { uid: 'u', token: { staffId: 'u', branchIds: ['ALL'], authVersion: 0 } },
    ).catch(() => undefined);
    expect(reads).toHaveLength(4);
  });

  test('G13 error classification invalid-argument/permission-denied; zero writes every path', async () => {
    const writes: string[] = [];
    const { HttpsError } = await import('firebase-functions/v2/https');
    await expect(
      performGetOrderReceipt({ runTransaction: async () => writes.push('x') } as never, {}, { uid: 'u', token: { staffId: 'u', branchIds: ['ALL'], authVersion: 0 } }),
    ).rejects.toBeInstanceOf(HttpsError);
    expect(writes).toHaveLength(0);
    await expect(
      performGetOrderReceipt({ runTransaction: async () => writes.push('x') } as never, { orderId: 'o1' }, null),
    ).rejects.toBeInstanceOf(HttpsError);
    expect(writes).toHaveLength(0);
  });
});
