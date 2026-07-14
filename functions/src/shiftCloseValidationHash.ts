// Packet 5 / P5-B pure core — canonical hashing (P5-A §12 / Blocker 1 §7.4,
// §7.6 / R4-D1 full-identity digest). Pure, deterministic: node:crypto's
// `createHash` is a built-in synchronous primitive (no network, no
// filesystem, no Admin SDK) and is used only as an implementation detail of
// otherwise-pure functions.

import { createHash } from 'node:crypto';
import {
  toPositiveEntryMinor,
  canonicalOrder,
  classifyCashEntry,
  type ClassifiedCashEntry,
} from './shiftCloseValidationCore';
import { CAP_SNAPSHOT_ENTRIES, type ShiftCashEntrySnapshot } from './shiftCloseValidationTypes';

const CANONICAL_SCHEMA_VERSION = 1;
// ASCII unit separator (0x1F) — domain-separates the INV malformed-amount tag
// segments (P5-A R3 section 7.4), e.g. "INV<US>num<US>10.005".
const UNIT_SEP = String.fromCharCode(0x1f);
export const CANONICAL_ABSENT = '__absent__';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Generic canonical struct encoder (P5-A §12.1): explicit field order,
// leading canonicalSchemaVersion tag, UTF-8 bytes, no insignificant
// whitespace, present-null vs missing-sentinel distinct.
// ---------------------------------------------------------------------------

export type CanonicalFieldValue = string | number | boolean | null | typeof CANONICAL_ABSENT;

export function encodeCanonicalField(value: CanonicalFieldValue): string {
  if (value === CANONICAL_ABSENT) return '"__absent__"';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`canonical field encoding requires an integer, got ${value}`);
    }
    return String(value);
  }
  throw new Error('unreachable canonical field value');
}

/** `fields` must already be in the frozen explicit field order for the struct being encoded. */
export function encodeCanonicalStruct(fields: ReadonlyArray<readonly [string, CanonicalFieldValue]>): string {
  const body = fields.map(([key, value]) => `${JSON.stringify(key)}:${encodeCanonicalField(value)}`).join(',');
  return `{"canonicalSchemaVersion":${CANONICAL_SCHEMA_VERSION},${body}}`;
}

export function encodeCanonicalArray(items: readonly string[]): string {
  return `[${items.join(',')}]`;
}

// ---------------------------------------------------------------------------
// Malformed raw-number digest encoding (P5-A R3 §7.4) — literal, exact.
// ---------------------------------------------------------------------------

export function encodeCashEntryAmount(amount: number): string {
  if (Number.isNaN(amount)) return `INV${UNIT_SEP}nan`;
  if (amount === Number.POSITIVE_INFINITY) return `INV${UNIT_SEP}+inf`;
  if (amount === Number.NEGATIVE_INFINITY) return `INV${UNIT_SEP}-inf`;
  if (Object.is(amount, -0)) return `INV${UNIT_SEP}-0`;
  const converted = toPositiveEntryMinor(amount);
  if (converted.ok) return String(converted.minor);
  return `INV${UNIT_SEP}num${UNIT_SEP}${amount.toString(10)}`;
}

function encodeCashEntryAmountField(rawAmount: unknown): string {
  if (typeof rawAmount !== 'number') return CANONICAL_ABSENT;
  return encodeCashEntryAmount(rawAmount);
}

function encodeSoftStringField(rawValue: unknown): string {
  return typeof rawValue === 'string' ? rawValue : '';
}

function encodeIdField(rawId: unknown): string {
  if (typeof rawId === 'string' && rawId.length > 0) return rawId;
  return CANONICAL_ABSENT;
}

function encodeTypeField(rawType: unknown): string {
  if (rawType === 'pay_in' || rawType === 'pay_out') return rawType;
  if (rawType === undefined || rawType === null) return CANONICAL_ABSENT;
  return `INV${UNIT_SEP}type${UNIT_SEP}${String(rawType)}`;
}

function encodeAtField(rawAt: unknown): number | null {
  return typeof rawAt === 'number' && Number.isFinite(rawAt) && Number.isInteger(rawAt) ? rawAt : null;
}

/**
 * Encodes one canonical-order cash entry in the frozen fixed field order
 * `[id, type, amountEnc, noteEnc, staffId, staffName, atEnc]` (P5-A R3 §7.6).
 * Deterministic even for a fold-blocking (malformed) entry, so the digest —
 * and therefore `closeHash`/`evidenceId` — remains stable for an
 * `insufficient_evidence` run.
 */
export function encodeCashEntryForDigest(entry: ClassifiedCashEntry): string {
  const raw = entry.raw;
  const idEnc = encodeIdField(raw.id);
  const typeEnc = encodeTypeField(raw.type);
  const amountEnc = encodeCashEntryAmountField(raw.amount);
  const noteEnc = encodeSoftStringField(raw.note);
  const staffIdEnc = encodeSoftStringField(raw.staffId);
  const staffNameEnc = encodeSoftStringField(raw.staffName);
  const atEnc = encodeAtField(raw.at);

  return encodeCanonicalStruct([
    ['id', idEnc],
    ['type', typeEnc],
    ['amountEnc', amountEnc],
    ['noteEnc', noteEnc],
    ['staffId', staffIdEnc],
    ['staffName', staffNameEnc],
    ['atEnc', atEnc],
  ]);
}

// ---------------------------------------------------------------------------
// cashEntriesDigest (stored prefix) / cashEntriesFullDigest (all raw entries)
// — P5-A R1 §7.4 / R4-D1.
// ---------------------------------------------------------------------------

export interface CashEntriesDigestResult {
  cashEntriesDigest: string; // over the stored (≤1000) canonical-order prefix
  cashEntriesFullDigest: string; // over ALL raw entries, canonical order, same encoding
  sourceEntryCount: number;
  cashEntriesOverflowed: boolean;
}

/**
 * Computes both digests from the same raw array the capture trigger already
 * holds in memory — no additional read, no reread of mutable `shifts`
 * (P5-A R4-D1 §7.1). When `cashEntriesOverflowed === false`, the two digests
 * are identical by construction (same input set, same encoding, same order).
 */
export function computeCashEntriesDigests(rawEntries: readonly ShiftCashEntrySnapshot[]): CashEntriesDigestResult {
  const sourceEntryCount = rawEntries.length;
  const cashEntriesOverflowed = sourceEntryCount > CAP_SNAPSHOT_ENTRIES;

  const seenIds = new Set<string>();
  const classified = rawEntries.map((raw, index) => classifyCashEntry(raw, index, seenIds));
  const ordered = canonicalOrder(classified);

  const fullEncoded = ordered.map(encodeCashEntryForDigest);
  const cashEntriesFullDigest = sha256Hex(encodeCanonicalArray(fullEncoded));

  const storedEncoded = ordered.slice(0, CAP_SNAPSHOT_ENTRIES).map(encodeCashEntryForDigest);
  const cashEntriesDigest = sha256Hex(encodeCanonicalArray(storedEncoded));

  return { cashEntriesDigest, cashEntriesFullDigest, sourceEntryCount, cashEntriesOverflowed };
}

// ---------------------------------------------------------------------------
// closeHash / inputsDigest helpers (P5-A §12.6-§12.7, R1-D1/D-2, R4-D2).
// These are pure builders over caller-supplied, already-canonicalized field
// values — no evidence-document construction (that is P5-C scope). The
// frozen hashed comparison field set (§12.6) plus the R4-D1 full-identity
// fields is the exact, fixed field order below.
// ---------------------------------------------------------------------------

export interface CloseHashFields {
  branchId: CanonicalFieldValue;
  staffId: CanonicalFieldValue;
  deviceId: CanonicalFieldValue;
  startingCash: CanonicalFieldValue; // int minor units
  actualCashCount: CanonicalFieldValue;
  variance: CanonicalFieldValue;
  expectedCash: CanonicalFieldValue;
  expectedQr: CanonicalFieldValue;
  expectedKbank: CanonicalFieldValue;
  expectedCard: CanonicalFieldValue;
  expectedCredit: CanonicalFieldValue;
  payInTotal: CanonicalFieldValue;
  payOutTotal: CanonicalFieldValue;
  totalBills: CanonicalFieldValue;
  note: CanonicalFieldValue;
  cashEntriesDigest: string;
  cashEntriesFullDigest: string; // [P5-A R4-D2]
  sourceEntryCount: number; // [P5-A R4-D2]
}

/** Fixed field order per P5-A §12.6, extended by R4-D2 with full-identity fields. */
export function computeCloseHash(fields: CloseHashFields): string {
  return sha256Hex(
    encodeCanonicalStruct([
      ['branchId', fields.branchId],
      ['staffId', fields.staffId],
      ['deviceId', fields.deviceId],
      ['startingCash', fields.startingCash],
      ['actualCashCount', fields.actualCashCount],
      ['variance', fields.variance],
      ['expectedCash', fields.expectedCash],
      ['expectedQr', fields.expectedQr],
      ['expectedKbank', fields.expectedKbank],
      ['expectedCard', fields.expectedCard],
      ['expectedCredit', fields.expectedCredit],
      ['payInTotal', fields.payInTotal],
      ['payOutTotal', fields.payOutTotal],
      ['totalBills', fields.totalBills],
      ['note', fields.note],
      ['cashEntriesDigest', fields.cashEntriesDigest],
      ['cashEntriesFullDigest', fields.cashEntriesFullDigest],
      ['sourceEntryCount', fields.sourceEntryCount],
    ]),
  );
}

export interface InputsDigestFields {
  sourceManifestDigest: string; // pre-computed by shiftCloseValidationManifest
  foldSummaryDigest: string; // caller-computed digest of the device-scoped fold summary
  cashEntriesDigest: string;
  cashEntriesFullDigest: string;
  sourceEntryCount: number; // [P5-A R4-D2] inputsDigest gains cashEntriesFullDigest + sourceEntryCount
  creditDebtReceiptsObservedDigest: string;
  sourceRevision: number;
}

/** Digests the validation input set (P5-A §12.7 / R1 §9.5 / R4-D2). */
export function computeInputsDigest(fields: InputsDigestFields): string {
  return sha256Hex(
    encodeCanonicalStruct([
      ['sourceManifestDigest', fields.sourceManifestDigest],
      ['foldSummaryDigest', fields.foldSummaryDigest],
      ['cashEntriesDigest', fields.cashEntriesDigest],
      ['cashEntriesFullDigest', fields.cashEntriesFullDigest],
      ['sourceEntryCount', fields.sourceEntryCount],
      ['creditDebtReceiptsObservedDigest', fields.creditDebtReceiptsObservedDigest],
      ['sourceRevision', fields.sourceRevision],
    ]),
  );
}
