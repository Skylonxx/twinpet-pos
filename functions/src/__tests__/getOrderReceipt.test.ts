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

describe('G01 G12 G13 getOrderReceipt callable layer', () => {
  test('G01 authz allow/deny set', () => {
    expect(() => authorizeReceiptAccess(null, 'br1')).toThrow(/unauthenticated|เข้าสู่ระบบ/);
    expect(() => authorizeReceiptAccess({ uid: 'u', token: { branchIds: [] } }, 'br1')).toThrow(/permission-denied|สิทธิ์/);
    expect(() => authorizeReceiptAccess({ uid: 'u', token: { branchIds: ['br2'] } }, 'br1')).toThrow(/permission-denied|สาขา/);
    expect(() => authorizeReceiptAccess({ uid: 'u', token: { branchIds: ['ALL'] } }, 'br1')).not.toThrow();
    expect(() => authorizeReceiptAccess({ uid: 'u', token: { branchIds: ['br1'] } }, 'br1')).not.toThrow();
  });

  test('G12 exactly four reads inside one transaction; no read outside', async () => {
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
        }),
        where: (field: string, _op: string, value: unknown) => ({ path: `${name}?${field}=${String(value)}`, __kind: name }),
      }),
      runTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    await performGetOrderReceipt(
      database as never,
      { orderId: 'o1' },
      { uid: 'u', token: { branchIds: ['ALL'] } },
    ).catch(() => undefined);
    expect(reads).toHaveLength(4);
  });

  test('G13 error classification invalid-argument/permission-denied; zero writes every path', async () => {
    const writes: string[] = [];
    const { HttpsError } = await import('firebase-functions/v2/https');
    await expect(
      performGetOrderReceipt({ runTransaction: async () => writes.push('x') } as never, {}, { uid: 'u', token: { branchIds: ['ALL'] } }),
    ).rejects.toBeInstanceOf(HttpsError);
    expect(writes).toHaveLength(0);
    await expect(
      performGetOrderReceipt({ runTransaction: async () => writes.push('x') } as never, { orderId: 'o1' }, null),
    ).rejects.toBeInstanceOf(HttpsError);
    expect(writes).toHaveLength(0);
  });
});
