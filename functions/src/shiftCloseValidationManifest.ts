// Packet 5 / P5-B pure core — source manifest hashing (P5-A R1 §9.5, R2
// §8.2-§8.3, R3 §8.3). Pure, deterministic: no Firestore reads happen here —
// the caller supplies already-observed doc data; this module orders,
// normalizes, and digests it. Normalization is OWNED here (not a caller
// comment obligation):
//
//   * A missing (`undefined`/`null`) relevant field maps to literal canonical
//     `null` (provable absence). Digest helpers never throw on a missing field.
//   * Money fields (`payments[].amount`, `changeAmt`, cash-transaction amount,
//     credit-payment amount) are RAW Baht numbers verbatim from the source doc
//     (P5-A R2 §7.1/§8.3 — `src/lib/types.ts` types them as raw Baht, never
//     minor units). They are converted to validated integer satang HERE using
//     the frozen converters from shiftCloseValidationCore, mirroring the
//     terminal fold. A malformed / over-precision / non-finite / out-of-envelope
//     money value is encoded as a deterministic `INV<US>…` tag (the same
//     no-throw convention shiftCloseValidationHash uses for malformed cash-entry
//     amounts), so the digest stays stable for an `insufficient_evidence` run.
//   * Firestore Timestamp fields (`voidedAt`) canonicalize to the frozen
//     `{seconds, nanoseconds}` encoding by SHAPE — no Firestore import. This is
//     an actual nested JSON OBJECT spliced directly into the parent digest
//     input, never a JSON-stringified struct (which would double-escape it).

import {
  encodeCanonicalField,
  encodeCanonicalStruct,
  sha256Hex,
  type CanonicalFieldValue,
} from './shiftCloseValidationHash';
import { toNonNegativeTotalMinor, toPositiveEntryMinor } from './shiftCloseValidationCore';
import { MANIFEST_COLLECTION_ORDER, type ManifestCollection, type SourceManifestDoc } from './shiftCloseValidationTypes';

// ASCII unit separator (0x1F) — domain-separates the `INV` malformed tag
// segments, identical to shiftCloseValidationHash's cash-entry amount tags
// (P5-A R3 §7.4 convention), e.g. "INV<US>amount_precision<US>10.005".
const UNIT_SEP = String.fromCharCode(0x1f);

// ---------------------------------------------------------------------------
// Raw scalar normalization (P5-A R2 §8.3): a missing relevant field encodes as
// literal null (provable absence), never a silent omission and never a throw.
// This handles NON-money, NON-timestamp scalar fields only (ids, statuses,
// booleans, payment method). Money and Timestamp fields have dedicated
// normalizers below. A number is never a valid value for these scalar fields
// in the frozen schema, so one is surfaced as a programming error.
// ---------------------------------------------------------------------------

export function normalizeRelevantField(value: unknown): CanonicalFieldValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`relevant scalar field must not be a non-integer number, got ${value}`);
    }
    return value;
  }
  throw new Error(`unsupported relevant field type: ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Raw money normalization (P5-A R2 §7.1-§7.3 / §8.3): a raw Baht number is
// converted to validated integer satang with the SAME frozen converters the
// cash fold uses. Missing (`undefined`/`null`) => canonical null. A malformed
// value (non-number / non-finite / non-positive|negative per envelope /
// over-precision / out-of-envelope) is encoded as a deterministic tag rather
// than thrown, so canonicalization is total and the digest is stable for an
// otherwise-unverifiable run (mirrors shiftCloseValidationHash.encodeCashEntryAmount).
//
// Envelope choice per field (matches each field's real writer):
//   'positive'    — strictly > 0, ≤ ฿10,000,000, ≤2dp  (cash-transaction amount:
//                   recordCashTransaction throws on amount ≤ 0; payment/credit
//                   amounts are received tenders, always > 0).
//   'nonNegative' — ≥ 0 (0 valid), ≤ ฿10,000,000,000, ≤2dp  (changeAmt: a sale
//                   with no change back is a legitimate 0).
// ---------------------------------------------------------------------------

export type MoneyEnvelope = 'positive' | 'nonNegative';

export function normalizeMoneyField(value: unknown, envelope: MoneyEnvelope): CanonicalFieldValue {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number') {
    return `INV${UNIT_SEP}type${UNIT_SEP}${typeof value}`;
  }
  const converted = envelope === 'positive' ? toPositiveEntryMinor(value) : toNonNegativeTotalMinor(value);
  if (converted.ok) return converted.minor;
  // Deterministic, environment-independent tag: reason + the exact raw value.
  return `INV${UNIT_SEP}${converted.reason}${UNIT_SEP}${value.toString(10)}`;
}

// ---------------------------------------------------------------------------
// Raw Firestore Timestamp encoding (P5-A R2 §8.3): canonicalize to the frozen
// NESTED OBJECT `{"seconds":<int>,"nanoseconds":<int>}` — an actual JSON
// object spliced as its own raw segment into the parent digest input, never a
// `CanonicalFieldValue` routed through `encodeCanonicalField()` (which would
// JSON-stringify it into an escaped string, e.g. `"voidedAt":"{...}"`, and
// would also require an incorrect nested `canonicalSchemaVersion`). Missing
// (`undefined`/`null`) => literal `null`.
//
// Accepted-shape policy (frozen, EXACT — no partial/hybrid shape is accepted):
//   1. { seconds: <int>, nanoseconds: <int> }   — plain frozen shape / SDK Timestamp
//   2. { _seconds: <int>, _nanoseconds: <int> } — Admin-SDK JSON-serialized shape
// A value that mixes prefixed and unprefixed components (e.g.
// `{ seconds, _nanoseconds }`) matches NEITHER complete shape and is tagged
// malformed — components are never resolved independently field-by-field.
// A present-but-malformed timestamp (wrong type, missing/non-integer
// component, hybrid shape) encodes as a deterministic quoted `INV<US>…` tag
// string (never thrown) — distinguishable from the frozen object by JSON type
// alone (object literal vs. quoted string vs. bare `null`).
// ---------------------------------------------------------------------------

function isIntegerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function encodeTimestampField(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') {
    return encodeCanonicalField(`INV${UNIT_SEP}timestamp${UNIT_SEP}${typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  let seconds: number | null = null;
  let nanoseconds: number | null = null;
  if (isIntegerNumber(obj.seconds) && isIntegerNumber(obj.nanoseconds)) {
    seconds = obj.seconds;
    nanoseconds = obj.nanoseconds;
  } else if (isIntegerNumber(obj._seconds) && isIntegerNumber(obj._nanoseconds)) {
    seconds = obj._seconds;
    nanoseconds = obj._nanoseconds;
  }
  if (seconds === null || nanoseconds === null) {
    return encodeCanonicalField(`INV${UNIT_SEP}timestamp${UNIT_SEP}shape`);
  }
  return `{"seconds":${seconds},"nanoseconds":${nanoseconds}}`;
}

// ---------------------------------------------------------------------------
// Per-collection relevant-field schema (P5-A R2 §8.3) — fixed field order,
// each field routed through the field-aware normalizer (scalar / money /
// timestamp) so a missing field => null and a malformed money/timestamp is a
// deterministic tag, never a throw.
// ---------------------------------------------------------------------------

/** payments[] element: `amount` is a RAW Baht number. Frozen nested key name is `amount`. */
export interface RawPayment {
  method: unknown;
  amount: unknown; // raw Baht number
}

export interface AsyncOrderRelevantFields {
  shiftId: unknown;
  branchId: unknown;
  deviceId: unknown;
  status: unknown;
  voidRequested: unknown;
  voidedAt: unknown; // Firestore Timestamp | null
  reconcileStatus: unknown;
  changeAmt: unknown; // raw Baht number (0 valid)
  payments: readonly RawPayment[] | null | undefined; // missing => canonical null; present (incl []) => canonical array
}

export interface CashTransactionRelevantFields {
  id: unknown;
  shiftId: unknown;
  branchId: unknown;
  type: unknown;
  amount: unknown; // raw Baht number (> 0)
}

export interface CreditPaymentRelevantFields {
  id: unknown;
  shiftId: unknown;
  paymentMethod: unknown;
  amount: unknown; // raw Baht number (> 0)
}

export interface OrderRelevantFields {
  shiftId: unknown;
  branchId: unknown;
  deviceId: unknown;
  status: unknown;
  voidRequested: unknown;
  reconcileStatus: unknown;
}

/**
 * Deterministic total order over a normalized payment `amount` (a canonical
 * satang integer, `null` for missing, or an `INV<US>…` malformed tag string):
 * `null` sorts before every number, numbers sort by their actual NUMERIC
 * value (never their decimal text — text-order would put `100` before `20`),
 * and malformed tag strings sort last, ordered deterministically among
 * themselves by UTF-8 byte order (never `localeCompare`).
 */
function amountSortRank(value: CanonicalFieldValue): 0 | 1 | 2 {
  if (value === null) return 0;
  if (typeof value === 'number') return 1;
  return 2;
}

function compareCanonicalAmount(a: CanonicalFieldValue, b: CanonicalFieldValue): number {
  const rankDiff = amountSortRank(a) - amountSortRank(b);
  if (rankDiff !== 0) return rankDiff;
  if (typeof a === 'number' && typeof b === 'number') return a - b; // numeric canonical satang comparison
  if (typeof a === 'string' && typeof b === 'string') return utf8ByteCompare(a, b); // deterministic tag ordering
  return 0; // both null
}

/**
 * Canonicalizes a PRESENT payments[] array INTERNALLY (P5-A R2 §8.3): each
 * element is normalized to `{method, amount}` (frozen nested key name `amount`,
 * NOT `amountMinor`; `amount` is the raw Baht number converted to validated
 * satang), then the array is sorted by (method ASC, amount ASC). `method` uses
 * an explicit UTF-8 BYTE comparator over its canonical encoding — never
 * `localeCompare`, so ordering is environment/ICU-independent. `amount` uses
 * NUMERIC canonical-satang comparison (see `compareCanonicalAmount`) — never a
 * lexical comparison of the decimal text, which would incorrectly order `100`
 * before `20`. Equivalent payment sets therefore hash identically regardless
 * of caller iteration order.
 */
export function encodeCanonicalPayments(payments: readonly RawPayment[]): string {
  const normalized = payments.map((p) => ({
    method: normalizeRelevantField(p.method),
    amount: normalizeMoneyField(p.amount, 'positive'),
  }));
  normalized.sort((a, b) => {
    const methodCmp = utf8ByteCompare(encodeCanonicalField(a.method), encodeCanonicalField(b.method));
    if (methodCmp !== 0) return methodCmp;
    return compareCanonicalAmount(a.amount, b.amount);
  });
  const encoded = normalized.map((p) => encodeCanonicalStruct([['method', p.method], ['amount', p.amount]]));
  return `[${encoded.join(',')}]`;
}

/**
 * Field-level payments canonicalizer (P5-A R2 §8.3): a MISSING (`undefined`/
 * `null`) or non-array payments field encodes as canonical `null` (provable
 * absence) — it never throws. A PRESENT array (including the empty `[]`)
 * encodes as its internally-sorted canonical array, so an empty payment list is
 * a distinct canonical value from a missing one.
 */
export function encodeCanonicalPaymentsField(payments: unknown): string {
  if (payments === undefined || payments === null || !Array.isArray(payments)) {
    return encodeCanonicalField(null); // 'null'
  }
  return encodeCanonicalPayments(payments as readonly RawPayment[]);
}

export function computeAsyncOrderRelevantFieldsDigest(fields: AsyncOrderRelevantFields): string {
  const head = encodeCanonicalStruct([
    ['shiftId', normalizeRelevantField(fields.shiftId)],
    ['branchId', normalizeRelevantField(fields.branchId)],
    ['deviceId', normalizeRelevantField(fields.deviceId)],
    ['status', normalizeRelevantField(fields.status)],
    ['voidRequested', normalizeRelevantField(fields.voidRequested)],
  ]);
  // `voidedAt` (nested {seconds,nanoseconds} OBJECT or null) and `payments`
  // (nested ARRAY or null) are both NOT scalar `CanonicalFieldValue`s, so they
  // are spliced in as their own raw JSON segments — bypassing
  // `encodeCanonicalField()`'s string/number/boolean/null-only encoder, which
  // would otherwise double-JSON-stringify them. The remaining scalar fields
  // are individually encoded with the same `encodeCanonicalField()`
  // `encodeCanonicalStruct()` uses internally, so the frozen fixed field
  // order (P5-A R2 §8.3: shiftId, branchId, deviceId, status, voidRequested,
  // voidedAt, reconcileStatus, changeAmt, payments) is preserved exactly.
  const voidedAtSeg = encodeTimestampField(fields.voidedAt);
  const reconcileStatusSeg = encodeCanonicalField(normalizeRelevantField(fields.reconcileStatus));
  const changeAmtSeg = encodeCanonicalField(normalizeMoneyField(fields.changeAmt, 'nonNegative'));
  const paymentsSeg = encodeCanonicalPaymentsField(fields.payments);
  const body = `${head.slice(0, -1)},"voidedAt":${voidedAtSeg},"reconcileStatus":${reconcileStatusSeg},"changeAmt":${changeAmtSeg},"payments":${paymentsSeg}}`;
  return sha256Hex(body);
}

export function computeCashTransactionRelevantFieldsDigest(fields: CashTransactionRelevantFields): string {
  return sha256Hex(
    encodeCanonicalStruct([
      ['id', normalizeRelevantField(fields.id)],
      ['shiftId', normalizeRelevantField(fields.shiftId)],
      ['branchId', normalizeRelevantField(fields.branchId)],
      ['type', normalizeRelevantField(fields.type)],
      ['amount', normalizeMoneyField(fields.amount, 'positive')],
    ]),
  );
}

export function computeCreditPaymentRelevantFieldsDigest(fields: CreditPaymentRelevantFields): string {
  return sha256Hex(
    encodeCanonicalStruct([
      ['id', normalizeRelevantField(fields.id)],
      ['shiftId', normalizeRelevantField(fields.shiftId)],
      ['paymentMethod', normalizeRelevantField(fields.paymentMethod)],
      ['amount', normalizeMoneyField(fields.amount, 'positive')],
    ]),
  );
}

export function computeOrderRelevantFieldsDigest(fields: OrderRelevantFields): string {
  return sha256Hex(
    encodeCanonicalStruct([
      ['shiftId', normalizeRelevantField(fields.shiftId)],
      ['branchId', normalizeRelevantField(fields.branchId)],
      ['deviceId', normalizeRelevantField(fields.deviceId)],
      ['status', normalizeRelevantField(fields.status)],
      ['voidRequested', normalizeRelevantField(fields.voidRequested)],
      ['reconcileStatus', normalizeRelevantField(fields.reconcileStatus)],
    ]),
  );
}

// ---------------------------------------------------------------------------
// Canonical manifest doc ordering (P5-A R2 §8.2): sorted by
// (collection ASC by fixed enum order, then docId ASC UTF-8) — a total order
// independent of query/page iteration order.
// ---------------------------------------------------------------------------

function collectionRank(collection: ManifestCollection): number {
  return MANIFEST_COLLECTION_ORDER.indexOf(collection);
}

function utf8ByteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function compareManifestDocOrder(a: SourceManifestDoc, b: SourceManifestDoc): number {
  const rankDiff = collectionRank(a.collection) - collectionRank(b.collection);
  if (rankDiff !== 0) return rankDiff;
  return utf8ByteCompare(a.docId, b.docId);
}

export function orderManifestDocs(docs: readonly SourceManifestDoc[]): SourceManifestDoc[] {
  return [...docs].sort(compareManifestDocOrder);
}

/** Digests the ordered manifest doc list — stable regardless of read/query order. */
export function computeManifestDocsDigest(docs: readonly SourceManifestDoc[]): string {
  const ordered = orderManifestDocs(docs);
  const encoded = ordered.map((doc) =>
    encodeCanonicalStruct([
      ['collection', doc.collection],
      ['docId', doc.docId],
      ['updateTimeMicros', doc.updateTimeMicros],
      ['relevantFieldsDigest', doc.relevantFieldsDigest],
    ]),
  );
  return sha256Hex(`[${encoded.join(',')}]`);
}
