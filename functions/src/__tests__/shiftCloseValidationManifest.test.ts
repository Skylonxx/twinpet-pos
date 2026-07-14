import { createHash } from 'node:crypto';
import { describe, test, expect } from 'vitest';
import {
  computeAsyncOrderRelevantFieldsDigest,
  computeCashTransactionRelevantFieldsDigest,
  computeCreditPaymentRelevantFieldsDigest,
  computeOrderRelevantFieldsDigest,
  computeManifestDocsDigest,
  encodeCanonicalPayments,
  encodeCanonicalPaymentsField,
  encodeTimestampField,
  normalizeMoneyField,
  normalizeRelevantField,
  orderManifestDocs,
  type AsyncOrderRelevantFields,
} from '../shiftCloseValidationManifest';
import { encodeCanonicalField } from '../shiftCloseValidationHash';
import type { SourceManifestDoc } from '../shiftCloseValidationTypes';

function doc(overrides: Partial<SourceManifestDoc>): SourceManifestDoc {
  return {
    collection: 'asyncOrders',
    docId: 'd1',
    updateTimeMicros: '1000',
    relevantFieldsDigest: 'digest',
    ...overrides,
  };
}

describe('normalizeRelevantField (non-money, non-timestamp scalars)', () => {
  test('maps undefined and null to literal null', () => {
    expect(normalizeRelevantField(undefined)).toBeNull();
    expect(normalizeRelevantField(null)).toBeNull();
  });
  test('passes through strings, booleans, and integer numbers', () => {
    expect(normalizeRelevantField('x')).toBe('x');
    expect(normalizeRelevantField(false)).toBe(false);
    expect(normalizeRelevantField(1050)).toBe(1050);
  });
  test('throws on a non-integer number (a number is never a valid scalar field)', () => {
    expect(() => normalizeRelevantField(10.5)).toThrow();
  });
});

describe('normalizeMoneyField — raw Baht => validated integer satang', () => {
  test('raw ฿10.50 converts to 1050 satang (both envelopes)', () => {
    expect(normalizeMoneyField(10.5, 'positive')).toBe(1050);
    expect(normalizeMoneyField(10.5, 'nonNegative')).toBe(1050);
  });

  test('raw ฿1 converts to 100 satang', () => {
    expect(normalizeMoneyField(1, 'positive')).toBe(100);
  });

  test('missing (undefined / null) money maps to literal null, never a throw', () => {
    expect(normalizeMoneyField(undefined, 'positive')).toBeNull();
    expect(normalizeMoneyField(null, 'nonNegative')).toBeNull();
  });

  test('over-precision (>2dp) money is tagged, not thrown', () => {
    const tag = normalizeMoneyField(10.005, 'positive');
    expect(typeof tag).toBe('string');
    expect(tag).toContain('INV');
    expect(tag).toContain('amount_precision');
  });

  test('non-finite money is tagged deterministically', () => {
    expect(normalizeMoneyField(Number.NaN, 'positive')).toContain('INV');
    expect(normalizeMoneyField(Number.POSITIVE_INFINITY, 'nonNegative')).toContain('INV');
  });

  test('a non-number money value is tagged by its type, never thrown', () => {
    expect(normalizeMoneyField('10.50', 'positive')).toBe(`INV${String.fromCharCode(0x1f)}type${String.fromCharCode(0x1f)}string`);
  });

  test("envelope 'positive' rejects 0 / negative; 'nonNegative' accepts 0", () => {
    expect(normalizeMoneyField(0, 'positive')).toContain('INV'); // non_positive_amount
    expect(normalizeMoneyField(-5, 'positive')).toContain('INV');
    expect(normalizeMoneyField(0, 'nonNegative')).toBe(0); // a sale with no change back
    expect(normalizeMoneyField(-5, 'nonNegative')).toContain('INV'); // negative_total
  });

  test('the tag is environment-independent (plain string reason + raw value)', () => {
    expect(normalizeMoneyField(10.005, 'positive')).toBe(normalizeMoneyField(10.005, 'positive'));
  });
});

describe('encodeTimestampField — frozen nested {seconds, nanoseconds} OBJECT (exact wire form)', () => {
  test('missing (undefined / null) timestamp encodes as the literal text "null", never a throw', () => {
    expect(encodeTimestampField(undefined)).toBe('null');
    expect(encodeTimestampField(null)).toBe('null');
  });

  test('a present Timestamp encodes as an exact nested JSON OBJECT, not a JSON-stringified struct', () => {
    const enc = encodeTimestampField({ seconds: 1_700_000_000, nanoseconds: 500 });
    // Exact wire text — a real object literal, key order seconds-then-nanoseconds, no extra keys.
    expect(enc).toBe('{"seconds":1700000000,"nanoseconds":500}');
    // Must NOT be a JSON-stringified (double-escaped) struct: no surrounding quotes, no escaped quotes.
    expect(enc.startsWith('"')).toBe(false);
    expect(enc).not.toContain('\\"');
    // Must NOT carry a nested canonicalSchemaVersion key (that belongs only to the parent struct, never here).
    expect(enc).not.toContain('canonicalSchemaVersion');
  });

  test('the Admin-SDK serialized shape ({_seconds,_nanoseconds}) canonicalizes to the identical exact wire object', () => {
    const plain = encodeTimestampField({ seconds: 12, nanoseconds: 34 });
    const serialized = encodeTimestampField({ _seconds: 12, _nanoseconds: 34 });
    expect(plain).toBe('{"seconds":12,"nanoseconds":34}');
    expect(serialized).toBe(plain);
  });

  test('distinct instants canonicalize distinctly; a present timestamp differs from null', () => {
    const a = encodeTimestampField({ seconds: 1, nanoseconds: 0 });
    const b = encodeTimestampField({ seconds: 2, nanoseconds: 0 });
    expect(a).not.toBe(b);
    expect(a).not.toBe('null');
  });

  test('a malformed timestamp (missing / non-integer component / non-object) is a deterministic quoted tag, not thrown', () => {
    expect(() => encodeTimestampField({ seconds: 1 })).not.toThrow();
    const missingComponent = encodeTimestampField({ seconds: 1 });
    const nonIntegerComponent = encodeTimestampField({ seconds: 1.5, nanoseconds: 0 });
    const wrongType = encodeTimestampField(12345);
    for (const tag of [missingComponent, nonIntegerComponent, wrongType]) {
      expect(tag.startsWith('"INV')).toBe(true); // a quoted string tag, not a bare object/null
      expect(tag).not.toMatch(/^\{"seconds"/); // never confusable with the frozen object shape
    }
  });

  test('accepted-shape policy is EXACTLY two complete shapes — a hybrid mix is rejected, never silently accepted', () => {
    // { seconds, _nanoseconds } matches neither complete shape (P5-A frozen policy):
    // components are never resolved independently field-by-field.
    const hybrid = encodeTimestampField({ seconds: 1, _nanoseconds: 0 });
    expect(hybrid.startsWith('"INV')).toBe(true);
    const hybridReverse = encodeTimestampField({ _seconds: 1, nanoseconds: 0 });
    expect(hybridReverse.startsWith('"INV')).toBe(true);
    // Both complete shapes remain accepted and produce the exact frozen object.
    expect(encodeTimestampField({ seconds: 1, nanoseconds: 0 })).toBe('{"seconds":1,"nanoseconds":0}');
    expect(encodeTimestampField({ _seconds: 1, _nanoseconds: 0 })).toBe('{"seconds":1,"nanoseconds":0}');
  });
});

describe('orderManifestDocs — canonical (collection, docId) total order', () => {
  test('orders by the frozen collection enum order first', () => {
    const docs = [doc({ collection: 'orders', docId: 'a' }), doc({ collection: 'asyncOrders', docId: 'z' }), doc({ collection: 'creditPayments', docId: 'm' })];
    const ordered = orderManifestDocs(docs);
    expect(ordered.map((d) => d.collection)).toEqual(['asyncOrders', 'creditPayments', 'orders']);
  });

  test('orders by docId ASC within the same collection', () => {
    const docs = [doc({ collection: 'asyncOrders', docId: 'z' }), doc({ collection: 'asyncOrders', docId: 'a' })];
    const ordered = orderManifestDocs(docs);
    expect(ordered.map((d) => d.docId)).toEqual(['a', 'z']);
  });

  test('is independent of input array order (no query/page-order dependence)', () => {
    const a = [doc({ collection: 'orders', docId: '1' }), doc({ collection: 'asyncOrders', docId: '2' })];
    const b = [doc({ collection: 'asyncOrders', docId: '2' }), doc({ collection: 'orders', docId: '1' })];
    expect(orderManifestDocs(a)).toEqual(orderManifestDocs(b));
  });
});

describe('computeManifestDocsDigest', () => {
  test('is stable regardless of the order docs were read/appended in', () => {
    const a = [doc({ collection: 'orders', docId: '1' }), doc({ collection: 'asyncOrders', docId: '2' })];
    const b = [doc({ collection: 'asyncOrders', docId: '2' }), doc({ collection: 'orders', docId: '1' })];
    expect(computeManifestDocsDigest(a)).toBe(computeManifestDocsDigest(b));
  });

  test('changes when a doc set differs', () => {
    const a = [doc({ collection: 'asyncOrders', docId: '1' })];
    const b = [doc({ collection: 'asyncOrders', docId: '2' })];
    expect(computeManifestDocsDigest(a)).not.toBe(computeManifestDocsDigest(b));
  });
});

describe('cashTransactions relevant-field sensitivity + missing normalization', () => {
  const base = { id: '1', shiftId: 's', branchId: 'b', type: 'pay_in', amount: 1 };

  test('a missing (undefined) relevant field digests identically to explicit null, and differently from a present value', () => {
    const undefinedBranch = computeCashTransactionRelevantFieldsDigest({ ...base, branchId: undefined });
    const nullBranch = computeCashTransactionRelevantFieldsDigest({ ...base, branchId: null });
    const presentBranch = computeCashTransactionRelevantFieldsDigest({ ...base, branchId: 'b' });
    expect(undefinedBranch).toBe(nullBranch); // missing maps to literal null
    expect(undefinedBranch).not.toBe(presentBranch);
  });

  test('does not throw on missing fields (incl. missing money => null)', () => {
    expect(() => computeCashTransactionRelevantFieldsDigest({ id: undefined, shiftId: undefined, branchId: undefined, type: undefined, amount: undefined })).not.toThrow();
  });

  test('amount is treated as RAW Baht (฿10.50 => 1050 satang), distinct from an already-satang reading', () => {
    // If amount were treated as already-minor-units, 10.5 would throw and 1050 would stay 1050;
    // treating it as raw Baht, 10.5 => 1050 satang while 1050 (Baht) => 105000 satang.
    expect(() => computeCashTransactionRelevantFieldsDigest({ ...base, amount: 10.5 })).not.toThrow();
    expect(computeCashTransactionRelevantFieldsDigest({ ...base, amount: 10.5 })).not.toBe(
      computeCashTransactionRelevantFieldsDigest({ ...base, amount: 1050 }),
    );
  });

  test('type / amount changes change the digest', () => {
    expect(computeCashTransactionRelevantFieldsDigest(base)).not.toBe(computeCashTransactionRelevantFieldsDigest({ ...base, type: 'pay_out' }));
    expect(computeCashTransactionRelevantFieldsDigest(base)).not.toBe(computeCashTransactionRelevantFieldsDigest({ ...base, amount: 2 }));
  });
});

describe('creditPayments relevant-field sensitivity', () => {
  const base = { id: '1', shiftId: 's', paymentMethod: 'cash', amount: 1 };
  test('each field is sensitive', () => {
    expect(computeCreditPaymentRelevantFieldsDigest(base)).not.toBe(computeCreditPaymentRelevantFieldsDigest({ ...base, id: '2' }));
    expect(computeCreditPaymentRelevantFieldsDigest(base)).not.toBe(computeCreditPaymentRelevantFieldsDigest({ ...base, shiftId: 't' }));
    expect(computeCreditPaymentRelevantFieldsDigest(base)).not.toBe(computeCreditPaymentRelevantFieldsDigest({ ...base, paymentMethod: 'transfer' }));
    expect(computeCreditPaymentRelevantFieldsDigest(base)).not.toBe(computeCreditPaymentRelevantFieldsDigest({ ...base, amount: 2 }));
  });
  test('amount is raw Baht (฿10.50 => 1050 satang), not already-satang', () => {
    expect(() => computeCreditPaymentRelevantFieldsDigest({ ...base, amount: 10.5 })).not.toThrow();
    expect(computeCreditPaymentRelevantFieldsDigest({ ...base, amount: 10.5 })).not.toBe(
      computeCreditPaymentRelevantFieldsDigest({ ...base, amount: 1050 }),
    );
  });
  test('missing field normalizes to null (undefined == null digest)', () => {
    expect(computeCreditPaymentRelevantFieldsDigest({ ...base, shiftId: undefined })).toBe(computeCreditPaymentRelevantFieldsDigest({ ...base, shiftId: null }));
    expect(computeCreditPaymentRelevantFieldsDigest({ ...base, amount: undefined })).toBe(computeCreditPaymentRelevantFieldsDigest({ ...base, amount: null }));
  });
});

describe('orders relevant-field sensitivity', () => {
  const base = { shiftId: 's', branchId: 'b', deviceId: 'd', status: 'settled', voidRequested: false, reconcileStatus: 'settled' };
  test('each field is sensitive', () => {
    expect(computeOrderRelevantFieldsDigest(base)).not.toBe(computeOrderRelevantFieldsDigest({ ...base, shiftId: 't' }));
    expect(computeOrderRelevantFieldsDigest(base)).not.toBe(computeOrderRelevantFieldsDigest({ ...base, branchId: 'c' }));
    expect(computeOrderRelevantFieldsDigest(base)).not.toBe(computeOrderRelevantFieldsDigest({ ...base, deviceId: 'e' }));
    expect(computeOrderRelevantFieldsDigest(base)).not.toBe(computeOrderRelevantFieldsDigest({ ...base, status: 'voided' }));
    expect(computeOrderRelevantFieldsDigest(base)).not.toBe(computeOrderRelevantFieldsDigest({ ...base, voidRequested: true }));
    expect(computeOrderRelevantFieldsDigest(base)).not.toBe(computeOrderRelevantFieldsDigest({ ...base, reconcileStatus: 'exception' }));
  });
  test('missing field normalizes to null', () => {
    expect(computeOrderRelevantFieldsDigest({ ...base, deviceId: undefined })).toBe(computeOrderRelevantFieldsDigest({ ...base, deviceId: null }));
  });
});

describe('encodeCanonicalPayments — {method, amount} schema, satang conversion, byte-order sort', () => {
  test('the serialized nested payment key is exactly `amount` (never `amountMinor`), value in satang', () => {
    const encoded = encodeCanonicalPayments([{ method: 'cash', amount: 10.5 }]); // ฿10.50 => 1050 satang
    expect(encoded).toContain('"amount":1050');
    expect(encoded).not.toContain('amountMinor');
  });

  test('sorts internally by method (UTF-8 byte order) then amount (NUMERIC canonical satang)', () => {
    const unsorted = encodeCanonicalPayments([{ method: 'cash', amount: 3 }, { method: 'card', amount: 5 }, { method: 'cash', amount: 1 }]);
    const sorted = encodeCanonicalPayments([{ method: 'card', amount: 5 }, { method: 'cash', amount: 1 }, { method: 'cash', amount: 3 }]);
    expect(unsorted).toBe(sorted);
    // card < cash, and within cash ฿1 (100 satang) < ฿3 (300 satang)
    expect(unsorted.indexOf('card')).toBeLessThan(unsorted.indexOf('cash'));
    expect(unsorted.indexOf('"amount":100')).toBeLessThan(unsorted.indexOf('"amount":300'));
  });

  test('equal-method amounts sort by NUMERIC canonical satang value, not lexical decimal-string order (20 before 100)', () => {
    // Regression for the Codex-flagged defect: Buffer.compare on the decimal
    // TEXT "100" vs "20" puts "100" first ('1' < '2' byte-wise), which is the
    // WRONG canonical order. Raw ฿1.00 => 100 satang, raw ฿0.20 => 20 satang.
    const unsorted = encodeCanonicalPayments([{ method: 'cash', amount: 1.0 }, { method: 'cash', amount: 0.2 }]);
    const sorted = encodeCanonicalPayments([{ method: 'cash', amount: 0.2 }, { method: 'cash', amount: 1.0 }]);
    expect(unsorted).toBe(sorted);
    expect(unsorted.indexOf('"amount":20')).toBeLessThan(unsorted.indexOf('"amount":100'));
    // Sanity: a lexical string comparison of "100" vs "20" would have put "100" first — prove it does not here.
    expect(unsorted.indexOf('"amount":20')).toBeLessThan(unsorted.indexOf('"amount":100'));
  });

  test('a genuinely different equal-method multiset with numerically close amounts still differs', () => {
    const a = encodeCanonicalPayments([{ method: 'cash', amount: 0.2 }, { method: 'cash', amount: 1.0 }]);
    const b = encodeCanonicalPayments([{ method: 'cash', amount: 0.2 }, { method: 'cash', amount: 1.5 }]);
    expect(a).not.toBe(b);
  });

  test('null and malformed-tag amounts have a deterministic explicit sort position: null < number < tag', () => {
    const payments = [
      { method: 'cash', amount: 5 }, // numeric satang 500
      { method: 'cash', amount: undefined }, // missing => canonical null
      { method: 'cash', amount: 'bad' as unknown }, // non-number => INV tag string
    ];
    const forward = encodeCanonicalPayments(payments as never);
    const reversed = encodeCanonicalPayments([...payments].reverse() as never);
    expect(forward).toBe(reversed); // order-independent regardless of caller iteration order
    expect(forward.indexOf('"amount":null')).toBeLessThan(forward.indexOf('"amount":500'));
    expect(forward.indexOf('"amount":500')).toBeLessThan(forward.indexOf('"amount":"INV'));
  });

  test('method ordering is deterministic for non-ASCII / mixed-case methods (byte order, not localeCompare)', () => {
    const methods = ['cash', 'Cash', 'café', 'CARD', 'promptpay', 'พร้อมเพย์'];
    const shuffledA = methods.map((method, i) => ({ method, amount: i + 1 }));
    const shuffledB = [...shuffledA].reverse();
    // The internal byte-order sort makes the canonical output independent of input order.
    expect(encodeCanonicalPayments(shuffledA)).toBe(encodeCanonicalPayments(shuffledB));
  });

  test('a missing method normalizes to null and sorts deterministically before concrete methods', () => {
    const withMissing = encodeCanonicalPayments([{ method: 'cash', amount: 1 }, { method: undefined, amount: 2 }]);
    const reversed = encodeCanonicalPayments([{ method: undefined, amount: 2 }, { method: 'cash', amount: 1 }]);
    expect(withMissing).toBe(reversed);
  });
});

describe('encodeCanonicalPaymentsField — missing vs empty vs present', () => {
  test('missing (undefined / null / non-array) payments encodes as canonical null, never throwing', () => {
    expect(encodeCanonicalPaymentsField(undefined)).toBe('null');
    expect(encodeCanonicalPaymentsField(null)).toBe('null');
    expect(encodeCanonicalPaymentsField('not-an-array' as unknown)).toBe('null');
  });

  test('a present EMPTY array encodes as canonical [] — distinct from missing/null', () => {
    expect(encodeCanonicalPaymentsField([])).toBe('[]');
    expect(encodeCanonicalPaymentsField([])).not.toBe(encodeCanonicalPaymentsField(null));
  });
});

describe('computeAsyncOrderRelevantFieldsDigest — payments, changeAmt, voidedAt', () => {
  function base(overrides: Partial<AsyncOrderRelevantFields> = {}): AsyncOrderRelevantFields {
    return {
      shiftId: 's',
      branchId: 'b',
      deviceId: 'd',
      status: 'settled',
      voidRequested: false,
      voidedAt: null,
      reconcileStatus: 'settled',
      changeAmt: 0,
      payments: [{ method: 'cash', amount: 10 }],
      ...overrides,
    };
  }

  test('shuffled payments digest equals sorted payments digest (canonicalizer sorts internally)', () => {
    const sorted = computeAsyncOrderRelevantFieldsDigest(
      base({ payments: [{ method: 'card', amount: 5 }, { method: 'cash', amount: 1 }, { method: 'cash', amount: 3 }] }),
    );
    const shuffled = computeAsyncOrderRelevantFieldsDigest(
      base({ payments: [{ method: 'cash', amount: 3 }, { method: 'card', amount: 5 }, { method: 'cash', amount: 1 }] }),
    );
    expect(shuffled).toBe(sorted);
  });

  test('a genuinely different payment multiset differs', () => {
    const a = computeAsyncOrderRelevantFieldsDigest(base({ payments: [{ method: 'cash', amount: 1 }] }));
    const b = computeAsyncOrderRelevantFieldsDigest(base({ payments: [{ method: 'cash', amount: 2 }] }));
    expect(a).not.toBe(b);
  });

  test('missing payments digests identically to explicit null, and distinctly from an empty [] — no throw', () => {
    const missing = computeAsyncOrderRelevantFieldsDigest(base({ payments: undefined }));
    const nulled = computeAsyncOrderRelevantFieldsDigest(base({ payments: null }));
    const empty = computeAsyncOrderRelevantFieldsDigest(base({ payments: [] }));
    expect(() => computeAsyncOrderRelevantFieldsDigest(base({ payments: undefined }))).not.toThrow();
    expect(missing).toBe(nulled); // missing == null
    expect(missing).not.toBe(empty); // empty payment list is a distinct canonical value
  });

  test('payments[].amount is raw Baht (฿10.50 => 1050 satang)', () => {
    const encoded = encodeCanonicalPayments([{ method: 'cash', amount: 10.5 }]);
    expect(encoded).toContain('"amount":1050');
  });

  test('changeAmt is raw Baht (฿10.50 => 1050 satang), 0 is valid, and it is sensitive', () => {
    expect(() => computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: 10.5 }))).not.toThrow();
    expect(computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: 0 }))).not.toBe(computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: 10.5 })));
    // raw-Baht semantics: ฿10.50 => 1050 satang, distinct from treating 1050 as raw Baht
    expect(computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: 10.5 }))).not.toBe(computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: 1050 })));
  });

  test('missing changeAmt normalizes to null (undefined == null digest)', () => {
    expect(computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: undefined }))).toBe(computeAsyncOrderRelevantFieldsDigest(base({ changeAmt: null })));
  });

  test('voidedAt Timestamp is canonicalized; present vs null vs a different instant all differ', () => {
    const nullVoid = computeAsyncOrderRelevantFieldsDigest(base({ voidedAt: null }));
    const presentVoid = computeAsyncOrderRelevantFieldsDigest(base({ voidedAt: { seconds: 100, nanoseconds: 0 } }));
    const laterVoid = computeAsyncOrderRelevantFieldsDigest(base({ voidedAt: { seconds: 200, nanoseconds: 0 } }));
    expect(presentVoid).not.toBe(nullVoid);
    expect(presentVoid).not.toBe(laterVoid);
  });

  test('voidedAt accepts the Admin-SDK serialized shape identically', () => {
    const plain = computeAsyncOrderRelevantFieldsDigest(base({ voidedAt: { seconds: 100, nanoseconds: 7 } }));
    const serialized = computeAsyncOrderRelevantFieldsDigest(base({ voidedAt: { _seconds: 100, _nanoseconds: 7 } }));
    expect(serialized).toBe(plain);
  });

  test('end-to-end exact canonical wire: the digest matches an independently reconstructed JSON string with voidedAt as a real nested OBJECT (not a string)', () => {
    const f = base({ voidedAt: { seconds: 100, nanoseconds: 7 }, payments: [{ method: 'cash', amount: 1.0 }] });
    // Reconstruct the exact expected canonical JSON by hand, mirroring the
    // production field order (shiftId, branchId, deviceId, status,
    // voidRequested, voidedAt, reconcileStatus, changeAmt, payments) and
    // encoding conventions — this proves the shipped function actually emits
    // voidedAt as `{"seconds":100,"nanoseconds":7}` (a bare object literal),
    // not `"voidedAt":"{...}"` (a JSON-stringified struct).
    const expectedJson =
      '{"canonicalSchemaVersion":1,' +
      `"shiftId":${encodeCanonicalField('s')},` +
      `"branchId":${encodeCanonicalField('b')},` +
      `"deviceId":${encodeCanonicalField('d')},` +
      `"status":${encodeCanonicalField('settled')},` +
      `"voidRequested":${encodeCanonicalField(false)},` +
      '"voidedAt":{"seconds":100,"nanoseconds":7},' +
      `"reconcileStatus":${encodeCanonicalField('settled')},` +
      `"changeAmt":${encodeCanonicalField(0)},` +
      '"payments":[{"canonicalSchemaVersion":1,"method":"cash","amount":100}]}';
    expect(expectedJson).not.toContain('"voidedAt":"{'); // sanity: this is genuinely NOT the stringified form
    expect(expectedJson).not.toContain('canonicalSchemaVersion":1,"seconds"'); // no nested schema-version key inside voidedAt
    const expectedDigest = createHash('sha256').update(expectedJson, 'utf8').digest('hex');
    expect(computeAsyncOrderRelevantFieldsDigest(f)).toBe(expectedDigest);
  });
});
