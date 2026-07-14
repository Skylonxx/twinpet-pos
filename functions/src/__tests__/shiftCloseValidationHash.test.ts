import { describe, test, expect } from 'vitest';
import {
  encodeCashEntryAmount,
  computeCashEntriesDigests,
  computeCloseHash,
  computeInputsDigest,
  encodeCanonicalStruct,
  sha256Hex,
  CANONICAL_ABSENT,
  type CloseHashFields,
} from '../shiftCloseValidationHash';
import type { ShiftCashEntrySnapshot } from '../shiftCloseValidationTypes';
import { CAP_SNAPSHOT_ENTRIES } from '../shiftCloseValidationTypes';

function entry(overrides: Partial<Record<string, unknown>> = {}): ShiftCashEntrySnapshot {
  return {
    id: 'e1',
    type: 'pay_in',
    amount: 10.5,
    note: 'note',
    staffId: 'staff-1',
    staffName: 'Staff One',
    at: 1000,
    ...overrides,
  };
}

describe('encodeCashEntryAmount — malformed raw-number digest tags', () => {
  test('NaN', () => {
    expect(encodeCashEntryAmount(NaN)).toBe('INV\x1Fnan');
  });
  test('+Infinity', () => {
    expect(encodeCashEntryAmount(Infinity)).toBe('INV\x1F+inf');
  });
  test('-Infinity', () => {
    expect(encodeCashEntryAmount(-Infinity)).toBe('INV\x1F-inf');
  });
  test('-0 gets its own distinct tag (not the generic finite-invalid bucket)', () => {
    expect(encodeCashEntryAmount(-0)).toBe('INV\x1F-0');
  });
  test('+0 falls into the generic finite-invalid bucket, distinct from -0', () => {
    expect(encodeCashEntryAmount(0)).toBe('INV\x1Fnum\x1F0');
    expect(encodeCashEntryAmount(0)).not.toBe(encodeCashEntryAmount(-0));
  });
  test('a valid amount encodes as a plain decimal satang integer', () => {
    expect(encodeCashEntryAmount(10.5)).toBe('1050');
  });
  test('finite but invalid (>2dp) encodes with the toString(10) bucket', () => {
    expect(encodeCashEntryAmount(10.005)).toBe(`INV\x1Fnum\x1F${(10.005).toString(10)}`);
  });
});

describe('computeCashEntriesDigests — full vs stored-prefix identity (P5-A R4-D1)', () => {
  test('same first-1000 prefix and equal totals but a different tail id -> different full digest / closeHash', () => {
    const prefix = Array.from({ length: CAP_SNAPSHOT_ENTRIES }, (_, i) => entry({ id: `p${i}`, at: i, amount: 1 }));
    const withTailA = [...prefix, entry({ id: 'tail-a', at: 9999, amount: 5 })];
    const withTailB = [...prefix, entry({ id: 'tail-b', at: 9999, amount: 5 })];

    const digestA = computeCashEntriesDigests(withTailA);
    const digestB = computeCashEntriesDigests(withTailB);

    expect(digestA.cashEntriesFullDigest).not.toBe(digestB.cashEntriesFullDigest);
    // Stored prefix (first 1000, canonical order) is identical in both cases.
    expect(digestA.cashEntriesDigest).toBe(digestB.cashEntriesDigest);
  });

  test('same first-1000 prefix and equal totals but a different tail amount -> different full digest', () => {
    const prefix = Array.from({ length: CAP_SNAPSHOT_ENTRIES }, (_, i) => entry({ id: `p${i}`, at: i, amount: 1 }));
    const withTailA = [...prefix, entry({ id: 'tail', at: 9999, amount: 5 })];
    const withTailB = [...prefix, entry({ id: 'tail', at: 9999, amount: 6 })];

    const digestA = computeCashEntriesDigests(withTailA);
    const digestB = computeCashEntriesDigests(withTailB);
    expect(digestA.cashEntriesFullDigest).not.toBe(digestB.cashEntriesFullDigest);
  });

  test('identical full raw input retried (crash-retry) produces an identical digest', () => {
    const entries = [entry({ id: '1' }), entry({ id: '2', type: 'pay_out', amount: 5 })];
    const first = computeCashEntriesDigests(entries);
    const second = computeCashEntriesDigests([...entries]);
    expect(first.cashEntriesFullDigest).toBe(second.cashEntriesFullDigest);
    expect(first.cashEntriesDigest).toBe(second.cashEntriesDigest);
  });

  test('non-overflow input: full digest equals stored-prefix digest', () => {
    const entries = [entry({ id: '1' }), entry({ id: '2', type: 'pay_out', amount: 5 })];
    const result = computeCashEntriesDigests(entries);
    expect(result.cashEntriesFullDigest).toBe(result.cashEntriesDigest);
    expect(result.cashEntriesOverflowed).toBe(false);
  });

  test('overflow: sourceEntryCount and cashEntriesOverflowed are consistent', () => {
    const entries = Array.from({ length: CAP_SNAPSHOT_ENTRIES + 5 }, (_, i) => entry({ id: `e${i}`, at: i }));
    const result = computeCashEntriesDigests(entries);
    expect(result.sourceEntryCount).toBe(CAP_SNAPSHOT_ENTRIES + 5);
    expect(result.cashEntriesOverflowed).toBe(true);
  });

  test('deterministic duplicate malformed (at,id) behavior: digest is stable across runs', () => {
    const entries = [entry({ id: 'dup', at: 1 }), entry({ id: 'dup', at: 1, amount: 20 })];
    const first = computeCashEntriesDigests(entries);
    const second = computeCashEntriesDigests([...entries]);
    expect(first.cashEntriesFullDigest).toBe(second.cashEntriesFullDigest);
  });

  test('malformed entries still produce a deterministic, non-throwing digest', () => {
    const entries = [entry({ id: undefined, type: 'bogus', amount: NaN, note: null, staffId: null, staffName: null, at: 'bad' })];
    expect(() => computeCashEntriesDigests(entries)).not.toThrow();
    const result = computeCashEntriesDigests(entries);
    expect(typeof result.cashEntriesFullDigest).toBe('string');
    expect(result.cashEntriesFullDigest).toHaveLength(64);
  });
});

describe('canonical struct encoding — null vs missing sentinel', () => {
  test('null and the absent sentinel encode distinctly', () => {
    const withNull = encodeCanonicalStruct([['a', null]]);
    const withAbsent = encodeCanonicalStruct([['a', CANONICAL_ABSENT]]);
    expect(withNull).not.toBe(withAbsent);
    expect(withNull).toContain('"a":null');
    expect(withAbsent).toContain('"a":"__absent__"');
  });

  test('leading canonicalSchemaVersion tag is present', () => {
    expect(encodeCanonicalStruct([['a', 1]])).toMatch(/^\{"canonicalSchemaVersion":1,/);
  });
});

describe('sha256Hex', () => {
  test('is deterministic for identical input', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });
  test('differs for different input', () => {
    expect(sha256Hex('hello')).not.toBe(sha256Hex('hello2'));
  });
});

describe('computeCloseHash / computeInputsDigest', () => {
  function baseFields(overrides: Partial<CloseHashFields> = {}): CloseHashFields {
    return {
      branchId: 'branch-1',
      staffId: 'staff-1',
      deviceId: 'device-1',
      startingCash: 100000,
      actualCashCount: 100000,
      variance: 0,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      payInTotal: 0,
      payOutTotal: 0,
      totalBills: 0,
      note: '',
      cashEntriesDigest: 'digest-a',
      cashEntriesFullDigest: 'digest-a',
      sourceEntryCount: 0,
      ...overrides,
    };
  }

  test('two closes with equal totals but different cash-entry digests produce distinct closeHash', () => {
    const a = computeCloseHash(baseFields({ cashEntriesDigest: 'digest-a', cashEntriesFullDigest: 'digest-a' }));
    const b = computeCloseHash(baseFields({ cashEntriesDigest: 'digest-b', cashEntriesFullDigest: 'digest-b' }));
    expect(a).not.toBe(b);
  });

  test('closeHash is deterministic for identical fields', () => {
    expect(computeCloseHash(baseFields())).toBe(computeCloseHash(baseFields()));
  });

  test('inputsDigest is deterministic and sensitive to sourceRevision', () => {
    const base = {
      sourceManifestDigest: 'm',
      foldSummaryDigest: 'f',
      cashEntriesDigest: 'c',
      cashEntriesFullDigest: 'c',
      sourceEntryCount: 3,
      creditDebtReceiptsObservedDigest: 'd',
    };
    const rev1 = computeInputsDigest({ ...base, sourceRevision: 1 });
    const rev2 = computeInputsDigest({ ...base, sourceRevision: 2 });
    expect(rev1).not.toBe(rev2);
    expect(computeInputsDigest({ ...base, sourceRevision: 1 })).toBe(rev1);
  });

  test('inputsDigest changes when ONLY sourceEntryCount changes (P5-A R4-D2)', () => {
    const base = {
      sourceManifestDigest: 'm',
      foldSummaryDigest: 'f',
      cashEntriesDigest: 'c',
      cashEntriesFullDigest: 'c',
      creditDebtReceiptsObservedDigest: 'd',
      sourceRevision: 1,
    };
    const count3 = computeInputsDigest({ ...base, sourceEntryCount: 3 });
    const count4 = computeInputsDigest({ ...base, sourceEntryCount: 4 });
    expect(count3).not.toBe(count4);
    // stable when re-computed with the same count
    expect(computeInputsDigest({ ...base, sourceEntryCount: 3 })).toBe(count3);
  });
});
