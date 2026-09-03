import { describe, expect, it } from 'vitest';
import {
  VIRGIN_REVOCATION_EPOCH,
  buildBumpedRevocationState,
  parseRevocationState,
  readRevocationEpoch,
} from '../privilegedRevocationState';
import type { Firestore } from 'firebase-admin/firestore';

function fakeDb(exists: boolean, data?: unknown): Firestore {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists, data: () => data }),
      }),
    }),
  } as unknown as Firestore;
}

describe('parseRevocationState', () => {
  it('parses a well-formed doc', () => {
    const parsed = parseRevocationState({
      revocationEpoch: 3,
      updatedAtServerMs: 1000,
      updatedBy: 'ops',
      reason: 'compromised device',
    });
    expect(parsed).toEqual({ revocationEpoch: 3, updatedAtServerMs: 1000, updatedBy: 'ops', reason: 'compromised device' });
  });

  it('accepts a null reason', () => {
    expect(
      parseRevocationState({ revocationEpoch: 0, updatedAtServerMs: 1, updatedBy: 'ops', reason: null }),
    ).not.toBeNull();
  });

  it('rejects malformed docs', () => {
    expect(parseRevocationState(null)).toBeNull();
    expect(parseRevocationState({ revocationEpoch: -1, updatedAtServerMs: 1, updatedBy: 'ops', reason: null })).toBeNull();
    expect(parseRevocationState({ revocationEpoch: 1.5, updatedAtServerMs: 1, updatedBy: 'ops', reason: null })).toBeNull();
    expect(parseRevocationState({ revocationEpoch: 1, updatedAtServerMs: 1, updatedBy: 7, reason: null })).toBeNull();
  });
});

describe('readRevocationEpoch', () => {
  it('reads 0 for a virgin (missing) doc', async () => {
    expect(await readRevocationEpoch(fakeDb(false))).toBe(VIRGIN_REVOCATION_EPOCH);
  });

  it('reads the stored epoch', async () => {
    expect(
      await readRevocationEpoch(fakeDb(true, { revocationEpoch: 5, updatedAtServerMs: 1, updatedBy: 'ops', reason: null })),
    ).toBe(5);
  });

  it('fails closed to 0 for a malformed doc rather than throwing', async () => {
    expect(await readRevocationEpoch(fakeDb(true, { garbage: true }))).toBe(VIRGIN_REVOCATION_EPOCH);
  });
});

describe('buildBumpedRevocationState', () => {
  it('increments by exactly 1', () => {
    const next = buildBumpedRevocationState(5, 2000, 'ops-carol', 'rotation drill');
    expect(next).toEqual({ revocationEpoch: 6, updatedAtServerMs: 2000, updatedBy: 'ops-carol', reason: 'rotation drill' });
  });

  it('rejects a blank operator identity', () => {
    expect(() => buildBumpedRevocationState(0, 1, '  ', null)).toThrow();
  });
});
