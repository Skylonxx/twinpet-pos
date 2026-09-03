import { describe, expect, it } from 'vitest';
import { isValidRequestId, recordIssuerRequestOnce } from '../issuerRequestChallenge';
import type { Firestore } from 'firebase-admin/firestore';

function fakeDb(): { db: Firestore; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const db = {
    collection: () => ({
      doc: (id: string) => ({ id }),
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { id: string }) => ({ exists: store.has(ref.id) }),
        create: (ref: { id: string }, data: unknown) => {
          if (store.has(ref.id)) throw new Error('already exists');
          store.set(ref.id, data);
        },
      };
      await fn(tx);
    },
  } as unknown as Firestore;
  return { db, store };
}

describe('isValidRequestId', () => {
  it('accepts a well-formed id', () => {
    expect(isValidRequestId('a'.repeat(32))).toBe(true);
  });
  it('rejects too-short/invalid-char ids', () => {
    expect(isValidRequestId('short')).toBe(false);
    expect(isValidRequestId('has spaces'.padEnd(20, 'x'))).toBe(false);
    expect(isValidRequestId(42)).toBe(false);
  });
});

describe('recordIssuerRequestOnce', () => {
  it('accepts the first use of a requestId', async () => {
    const { db } = fakeDb();
    const outcome = await recordIssuerRequestOnce(db, 'registerIssuer', 'r'.repeat(32), 1000);
    expect(outcome).toBe('accepted');
  });

  it('rejects a replayed requestId for the same purpose', async () => {
    const { db } = fakeDb();
    const requestId = 'r'.repeat(32);
    expect(await recordIssuerRequestOnce(db, 'registerIssuer', requestId, 1000)).toBe('accepted');
    expect(await recordIssuerRequestOnce(db, 'registerIssuer', requestId, 2000)).toBe('replayed');
  });

  it('scopes replay records per-purpose (same requestId, different purpose, both accepted)', async () => {
    const { db } = fakeDb();
    const requestId = 'r'.repeat(32);
    expect(await recordIssuerRequestOnce(db, 'registerIssuer', requestId, 1000)).toBe('accepted');
    expect(await recordIssuerRequestOnce(db, 'beginDeviceEnrollment', requestId, 1000)).toBe('accepted');
  });

  it('rejects a malformed requestId without touching the store', async () => {
    const { db } = fakeDb();
    expect(await recordIssuerRequestOnce(db, 'registerIssuer', 'too-short', 1000)).toBe('invalid_request_id');
  });
});
