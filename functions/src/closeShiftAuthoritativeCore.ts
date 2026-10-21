/**
 * closeShiftAuthoritativeCore — Return/Refund V1 packet 012 (server-authoritative W3).
 *
 * Pure decision core of the `closeShiftAuthoritative` callable: request
 * validation, the strict integer-satang cash-entry fold, the Return refund
 * audit cross-check (`saleRefunds` ⇄ `saleReturns` ⇄ `rfd_` shift entries),
 * the W3 close plan and the canonical response. No Admin SDK, no clock, no
 * I/O — the transaction/auth wrapper lives in `closeShiftAuthoritative.ts`.
 *
 * Contract: docs/contracts/close-shift-authoritative-v1.md.
 *
 * Authority split (honest provenance):
 *  - cash movements (pay-in / pay-out) are RECOMPUTED from the shift's own
 *    `cashEntries`; client totals are never accepted (the request has no
 *    such field);
 *  - every cash Return payout is cross-checked against the server-only
 *    `saleRefunds` / `saleReturns` records — never against client-creatable
 *    `cashTransactions`;
 *  - sale-derived totals (`expected*`, `totalBills`) are the terminal's
 *    ATTESTED figures and are labelled `attested_unverified`: the server
 *    cannot prove the terminal's sales are completely synced.
 *
 * The W3 write is field-for-field the client `closeWritePayload` shape
 * (firestore.rules `isW3ShiftClose`), so the existing strict proof
 * (`parseCommittedOwnClose` + `snapshotsEqual`), W4 and P5 evidence capture
 * read it unchanged. Server-only provenance goes to a separate
 * `shiftCloseAuthorityRecords/{shiftId}` doc, never onto `shifts`.
 */

import { sha256Hex } from './shiftCloseValidationHash';
import { toNonNegativeTotalMinor, toPositiveEntryMinor } from './shiftCloseValidationCore';
import { CAP_SNAPSHOT_ENTRIES, MAX_TOTAL_BAHT } from './shiftCloseValidationTypes';
import { SALE_RETURN_SCHEMA_VERSION, deriveCashRefundEntryId, minorToBaht } from './saleReturnCore';

export const CLOSE_SHIFT_AUTHORITATIVE_CONTRACT_VERSION = 1 as const;
export const CLOSE_PROTOCOL = 'server_authoritative_v1' as const;
export const SHIFT_CLOSE_AUTHORITY_RECORD_SCHEMA_VERSION = 1 as const;

/** Server-only (Rules catch-all deny): one immutable record per authoritatively closed shift. */
export const SHIFT_CLOSE_AUTHORITY_COLLECTION = 'shiftCloseAuthorityRecords';

export const CLOSE_NOTE_MAX = 1000;
export const CLOSE_DEVICE_ID_MAX = 200;
/** = firestore.rules `shiftMaxTotalBills()`. */
export const CLOSE_MAX_TOTAL_BILLS = 100_000;
/** = P5 evidence capture cap: a longer list is refused, never truncated. */
export const CLOSE_MAX_CASH_ENTRIES = CAP_SNAPSHOT_ENTRIES;
/** Refund queries read `limit(CLOSE_MAX_REFUND_RECORDS + 1)`; more ⇒ refuse (never a partial set). */
export const CLOSE_MAX_REFUND_RECORDS = CAP_SNAPSHOT_ENTRIES;
/** Exact, case-sensitive server refund entry prefix (= Rules `(?s)rfd_.*`, `deriveCashRefundEntryId`). */
export const SERVER_REFUND_ENTRY_PREFIX = 'rfd_';

const MAX_TOTAL_MINOR = MAX_TOTAL_BAHT * 100;

export type CloseShiftAuthoritativeErrorCode =
  | 'invalid_request'
  | 'unauthenticated'
  | 'not_authorized'
  | 'session_stale'
  | 'branch_not_authorized'
  | 'shift_not_found'
  | 'not_shift_owner'
  | 'shift_record_invalid'
  | 'shift_state_invalid'
  | 'already_closed'
  | 'closed_outside_authority'
  | 'idempotency_conflict'
  | 'close_record_inconsistent'
  | 'cash_entries_invalid'
  | 'cash_entries_over_cap'
  | 'cash_entry_duplicate'
  | 'refund_audit_unavailable'
  | 'refund_set_over_cap'
  | 'refund_record_invalid'
  | 'refund_return_mismatch'
  | 'refund_missing_in_shift'
  | 'refund_entry_mismatch'
  | 'orphan_refund_entry'
  | 'amount_out_of_bounds'
  | 'money_precision_unsafe'
  | 'committed_unconfirmed';

type Fail = { ok: false; code: CloseShiftAuthoritativeErrorCode };

function fail(code: CloseShiftAuthoritativeErrorCode): Fail {
  return { ok: false, code };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Packet 013 (Codex-012 F1): this contract is satang-EXACT. The shared P5
 * converters (unchanged, still used by P5) tolerate a 1e-6 epsilon on
 * amount × 100 and round, so e.g. 0.010000001 or 81.000000001 would be taken
 * as an exact satang. Here a value is accepted only when it IS the canonical
 * JS number of its satang count (`minor / 100 === x`, IEEE division is
 * correctly rounded, so this is the double every 2-dp decimal literal parses
 * to); anything else refuses — never adjusted. −0 keeps its existing meaning
 * (=== 0: a zero total, never a positive movement). Bounds/shape stay the
 * converters' own.
 */
function exactSatangMinor(x: number, r: { ok: true; minor: number } | { ok: false }): number | null {
  if (!r.ok || !Number.isSafeInteger(r.minor)) return null;
  return r.minor / 100 === x ? r.minor : null;
}

/** Baht → satang for a total/aggregate (≥ 0, ≤ ฿10,000,000,000, satang-exact); `null` otherwise. */
function strictNonnegativeMinor(v: unknown): number | null {
  if (typeof v !== 'number') return null;
  return exactSatangMinor(v, toNonNegativeTotalMinor(v));
}

/** Baht → satang for one cash movement / refund (> 0, ≤ ฿10,000,000, satang-exact); `null` otherwise. */
function strictPositiveMinor(v: unknown): number | null {
  if (typeof v !== 'number') return null;
  return exactSatangMinor(v, toPositiveEntryMinor(v));
}


// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type CloseShiftAuthoritativeRequest = Record<string, unknown>;

const REQUEST_KEYS = [
  'contractVersion',
  'shiftId',
  'closeCorrelationId',
  'actualCashCount',
  'note',
  'attestedSales',
  'deviceId',
] as const;

const ATTESTED_SALES_KEYS = [
  'expectedCash',
  'expectedQr',
  'expectedKbank',
  'expectedCard',
  'expectedCredit',
  'totalBills',
] as const;

const SHIFT_ID_RE = /^[^/]{1,200}$/;
/** Same lowercase RFC-4122 v4 pattern as Rules `isValidOptionalCloseCorrelationId` and the client store. */
const LOWERCASE_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type AttestedSalesMinor = {
  expectedCashMinor: number;
  expectedQrMinor: number;
  expectedKbankMinor: number;
  expectedCardMinor: number;
  expectedCreditMinor: number;
  totalBills: number;
};

export type ValidatedCloseRequest = {
  shiftId: string;
  closeCorrelationId: string;
  actualCashCountMinor: number;
  note: string;
  attestedSales: AttestedSalesMinor;
  /** Informational terminal id — recorded, never an authority. */
  deviceId: string;
};

/**
 * Strict: exactly the contract keys (an unexpected key — e.g. a client
 * `payOutTotal` / `variance` / `branchId` / `staffId` — is `invalid_request`),
 * exact ids (no trimming), satang-exact non-negative money inside the Rules
 * aggregate envelope, a safe-integer bill count.
 */
export function validateCloseShiftRequest(raw: unknown): { ok: true; value: ValidatedCloseRequest } | Fail {
  const bad = fail('invalid_request');
  if (!isPlainObject(raw) || !hasExactKeys(raw, REQUEST_KEYS)) return bad;
  if (raw.contractVersion !== CLOSE_SHIFT_AUTHORITATIVE_CONTRACT_VERSION) return bad;
  const { shiftId, closeCorrelationId, note, deviceId, attestedSales } = raw;
  if (typeof shiftId !== 'string' || !SHIFT_ID_RE.test(shiftId) || shiftId !== shiftId.trim()) return bad;
  if (typeof closeCorrelationId !== 'string' || !LOWERCASE_UUID_V4_RE.test(closeCorrelationId)) return bad;
  if (typeof note !== 'string' || note.length > CLOSE_NOTE_MAX) return bad;
  if (
    typeof deviceId !== 'string' ||
    deviceId.length === 0 ||
    deviceId.length > CLOSE_DEVICE_ID_MAX ||
    deviceId.trim() !== deviceId
  ) {
    return bad;
  }
  const actualCashCountMinor = strictNonnegativeMinor(raw.actualCashCount);
  if (actualCashCountMinor == null) return bad;

  if (!isPlainObject(attestedSales) || !hasExactKeys(attestedSales, ATTESTED_SALES_KEYS)) return bad;
  const expectedCashMinor = strictNonnegativeMinor(attestedSales.expectedCash);
  const expectedQrMinor = strictNonnegativeMinor(attestedSales.expectedQr);
  const expectedKbankMinor = strictNonnegativeMinor(attestedSales.expectedKbank);
  const expectedCardMinor = strictNonnegativeMinor(attestedSales.expectedCard);
  const expectedCreditMinor = strictNonnegativeMinor(attestedSales.expectedCredit);
  if (
    expectedCashMinor == null ||
    expectedQrMinor == null ||
    expectedKbankMinor == null ||
    expectedCardMinor == null ||
    expectedCreditMinor == null
  ) {
    return bad;
  }
  const totalBills = attestedSales.totalBills;
  if (typeof totalBills !== 'number' || !Number.isSafeInteger(totalBills) || totalBills < 0 || totalBills > CLOSE_MAX_TOTAL_BILLS) {
    return bad;
  }
  return {
    ok: true,
    value: {
      shiftId,
      closeCorrelationId,
      actualCashCountMinor,
      note,
      attestedSales: {
        expectedCashMinor,
        expectedQrMinor,
        expectedKbankMinor,
        expectedCardMinor,
        expectedCreditMinor,
        totalBills: Object.is(totalBills, -0) ? 0 : totalBills,
      },
      deviceId,
    },
  };
}

/** Digest of every validated request field: a same-UUID retry must carry exactly this content. */
export function deriveCloseRequestDigest(v: ValidatedCloseRequest): string {
  const s = v.attestedSales;
  return sha256Hex(
    'closeShiftAuthoritative:v1:' +
      JSON.stringify([
        v.shiftId,
        v.closeCorrelationId,
        v.actualCashCountMinor,
        v.note,
        s.expectedCashMinor,
        s.expectedQrMinor,
        s.expectedKbankMinor,
        s.expectedCardMinor,
        s.expectedCreditMinor,
        s.totalBills,
        v.deviceId,
      ]),
  );
}

// ---------------------------------------------------------------------------
// Caller authority (live users/{staffId}; no client-supplied authority)
// ---------------------------------------------------------------------------

export type CallerDecision =
  | { ok: true; role: 'admin' | 'manager' | 'staff' }
  | { ok: false; code: 'not_authorized' | 'session_stale' };

/**
 * Same freshness semantics as `evaluateFreshPrivilegedAuthority`
 * (live doc default 0, token default −1; disabled / deleted fail closed),
 * evaluated on the user doc read INSIDE the close transaction.
 */
export function decideCaller(user: Record<string, unknown> | null, tokenAuthVersion: number): CallerDecision {
  if (user == null || user.isActive !== true || user.deletedAt != null) return { ok: false, code: 'not_authorized' };
  const live = typeof user.authVersion === 'number' && Number.isFinite(user.authVersion) ? user.authVersion : 0;
  if (live !== tokenAuthVersion) return { ok: false, code: 'session_stale' };
  const role = user.role;
  if (role !== 'admin' && role !== 'manager' && role !== 'staff') return { ok: false, code: 'not_authorized' };
  return { ok: true, role };
}

/** Staff / manager: exact live branch. Admin: exact branch or live `ALL` (= the Return requester rule). */
export function callerBranchEligible(role: 'admin' | 'manager' | 'staff', user: Record<string, unknown>, branchId: string): boolean {
  const ids = Array.isArray(user.branchIds) ? user.branchIds.filter((v): v is string => typeof v === 'string') : [];
  if (role === 'admin') return ids.includes('ALL') || ids.includes(branchId);
  return ids.includes(branchId);
}

// ---------------------------------------------------------------------------
// Open shift identity
// ---------------------------------------------------------------------------

export type OpenShiftView = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  /** The stored value, untouched (W3 never writes it; the client parser reads it as stored). */
  startingCash: number;
  startingCashMinor: number;
};

/** The W0 identity a W3 must preserve; anything malformed refuses (`shift_record_invalid`). */
export function parseOpenShiftIdentity(shiftId: string, data: Record<string, unknown>): { ok: true; value: OpenShiftView } | Fail {
  const bad = fail('shift_record_invalid');
  if (data.id !== shiftId) return bad;
  if (!isNonEmptyString(data.branchId) || data.branchId === 'ALL') return bad;
  if (!isNonEmptyString(data.staffId)) return bad;
  if (typeof data.staffName !== 'string') return bad;
  if (data.openedAt == null) return bad;
  if (typeof data.startingCash !== 'number') return bad;
  const startingCashMinor = strictNonnegativeMinor(data.startingCash);
  if (startingCashMinor == null) return bad;
  return {
    ok: true,
    value: {
      shiftId,
      branchId: data.branchId,
      staffId: data.staffId,
      staffName: data.staffName,
      startingCash: data.startingCash,
      startingCashMinor,
    },
  };
}

// ---------------------------------------------------------------------------
// Cash entries — strict integer-satang fold
// ---------------------------------------------------------------------------

export type ServerRefundEntry = { type: 'pay_in' | 'pay_out'; minor: number };

export type CashFold = {
  entryCount: number;
  payInMinor: number;
  payOutMinor: number;
  manualEntryCount: number;
  manualPayInMinor: number;
  manualPayOutMinor: number;
  /** Every `rfd_`-prefixed entry by id (must each pair with one server refund). */
  serverRefundEntries: Map<string, ServerRefundEntry>;
  /** sha256 over the ordered [id, type, minor] triples actually folded. */
  digest: string;
};

/**
 * Absent ⇒ empty (W0 creates none). Present but not a list, over the cap, a
 * non-object element, a blank / non-string / duplicate id, an unknown type or
 * an amount that is not a positive satang-exact value within the W1 entry
 * bound ⇒ refuse. Never dedupes, drops, rounds or repairs.
 */
export function foldShiftCashEntriesStrict(raw: unknown, present: boolean): { ok: true; value: CashFold } | Fail {
  if (present && !Array.isArray(raw)) return fail('cash_entries_invalid');
  const list: unknown[] = present ? (raw as unknown[]) : [];
  if (list.length > CLOSE_MAX_CASH_ENTRIES) return fail('cash_entries_over_cap');
  const seen = new Set<string>();
  const serverRefundEntries = new Map<string, ServerRefundEntry>();
  const triples: Array<[string, string, number]> = [];
  let payInMinor = 0;
  let payOutMinor = 0;
  let manualPayInMinor = 0;
  let manualPayOutMinor = 0;
  let manualEntryCount = 0;
  for (let i = 0; i < list.length; i += 1) {
    // A sparse hole reads as `undefined` here and is refused like any non-object.
    const e = list[i];
    if (!isPlainObject(e)) return fail('cash_entries_invalid');
    if (!isNonEmptyString(e.id)) return fail('cash_entries_invalid');
    if (seen.has(e.id)) return fail('cash_entry_duplicate');
    seen.add(e.id);
    if (e.type !== 'pay_in' && e.type !== 'pay_out') return fail('cash_entries_invalid');
    if (typeof e.amount !== 'number') return fail('cash_entries_invalid');
    const minor = strictPositiveMinor(e.amount);
    if (minor == null) return fail('cash_entries_invalid');
    if (e.type === 'pay_in') payInMinor += minor;
    else payOutMinor += minor;
    if (e.id.startsWith(SERVER_REFUND_ENTRY_PREFIX)) {
      serverRefundEntries.set(e.id, { type: e.type, minor });
    } else {
      manualEntryCount += 1;
      if (e.type === 'pay_in') manualPayInMinor += minor;
      else manualPayOutMinor += minor;
    }
    triples.push([e.id, e.type, minor]);
  }
  return {
    ok: true,
    value: {
      entryCount: list.length,
      payInMinor,
      payOutMinor,
      manualEntryCount,
      manualPayInMinor,
      manualPayOutMinor,
      serverRefundEntries,
      digest: sha256Hex('closeShiftCashEntries:v1:' + JSON.stringify(triples)),
    },
  };
}

// ---------------------------------------------------------------------------
// Return refund audit — server records are the authority
// ---------------------------------------------------------------------------

export type RawRecord = { id: string; data: Record<string, unknown> };

export type RefundAudit = {
  refundCount: number;
  refundTotalMinor: number;
  /** Sorted returnIds of the matched cash refunds. */
  returnIds: string[];
};

type RefundFact = { returnId: string; cashEntryId: string; minor: number };

function parseRefundRecord(r: RawRecord, shift: OpenShiftView): RefundFact | null {
  const d = r.data;
  const returnId = r.id;
  if (d.schemaVersion !== SALE_RETURN_SCHEMA_VERSION) return null;
  if (d.refundId !== returnId || d.returnId !== returnId) return null;
  if (d.method !== 'cash' || d.executionMode !== 'cash_drawer') return null;
  if (d.shiftId !== shift.shiftId || d.branchId !== shift.branchId) return null;
  if (d.requesterStaffId !== shift.staffId) return null;
  if (d.cashEntryId !== deriveCashRefundEntryId(returnId)) return null;
  if (typeof d.amount !== 'number') return null;
  const minor = strictPositiveMinor(d.amount);
  if (minor == null) return null;
  return { returnId, cashEntryId: d.cashEntryId, minor };
}

function parseReturnRecord(r: RawRecord, shift: OpenShiftView): RefundFact | null {
  const d = r.data;
  const returnId = r.id;
  if (d.schemaVersion !== SALE_RETURN_SCHEMA_VERSION) return null;
  if (d.returnId !== returnId || d.status !== 'completed') return null;
  if (d.branchId !== shift.branchId || d.requesterStaffId !== shift.staffId) return null;
  const refund = d.refund;
  if (!isPlainObject(refund)) return null;
  if (refund.method !== 'cash' || refund.refundId !== returnId || refund.shiftId !== shift.shiftId) return null;
  if (refund.cashEntryId !== deriveCashRefundEntryId(returnId)) return null;
  if (typeof refund.amount !== 'number') return null;
  const minor = strictPositiveMinor(refund.amount);
  if (minor == null) return null;
  return { returnId, cashEntryId: refund.cashEntryId, minor };
}

/**
 * Inputs: the COMPLETE `saleRefunds where shiftId == S` and
 * `saleReturns where refund.shiftId == S` results read inside the close
 * transaction (each `limit(cap + 1)`), and the shift's `rfd_` entries.
 * Every server cash refund must pair 1:1 with its Return record (same
 * returnId, satang amount) and with exactly one `pay_out` shift entry of the
 * same id and satang amount; every `rfd_` entry must pair with a refund.
 * Every amount is satang-exact (an off-cent record is `refund_record_invalid`,
 * an off-cent entry `cash_entries_invalid`), so equal satang ⇔ equal raw
 * numbers. Any other shape refuses — the server never picks a side.
 */
export function verifyRefundAudit(params: {
  shift: OpenShiftView;
  refunds: readonly RawRecord[];
  returns: readonly RawRecord[];
  serverRefundEntries: ReadonlyMap<string, ServerRefundEntry>;
}): { ok: true; value: RefundAudit } | Fail {
  const { shift, refunds, returns, serverRefundEntries } = params;
  if (refunds.length > CLOSE_MAX_REFUND_RECORDS || returns.length > CLOSE_MAX_REFUND_RECORDS) {
    return fail('refund_set_over_cap');
  }
  const byRefund = new Map<string, RefundFact>();
  for (const r of refunds) {
    const fact = parseRefundRecord(r, shift);
    if (fact == null || byRefund.has(fact.returnId)) return fail('refund_record_invalid');
    byRefund.set(fact.returnId, fact);
  }
  const byReturn = new Map<string, RefundFact>();
  for (const r of returns) {
    const fact = parseReturnRecord(r, shift);
    if (fact == null || byReturn.has(fact.returnId)) return fail('refund_record_invalid');
    byReturn.set(fact.returnId, fact);
  }
  if (byRefund.size !== byReturn.size) return fail('refund_return_mismatch');
  for (const [returnId, refund] of byRefund) {
    const ret = byReturn.get(returnId);
    if (ret == null || ret.minor !== refund.minor || ret.cashEntryId !== refund.cashEntryId) {
      return fail('refund_return_mismatch');
    }
  }
  const pairedEntryIds = new Set<string>();
  let refundTotalMinor = 0;
  for (const refund of byRefund.values()) {
    const entry = serverRefundEntries.get(refund.cashEntryId);
    if (entry == null) return fail('refund_missing_in_shift');
    if (entry.type !== 'pay_out' || entry.minor !== refund.minor) return fail('refund_entry_mismatch');
    pairedEntryIds.add(refund.cashEntryId);
    refundTotalMinor += refund.minor;
  }
  for (const id of serverRefundEntries.keys()) {
    if (!pairedEntryIds.has(id)) return fail('orphan_refund_entry');
  }
  return {
    ok: true,
    value: {
      refundCount: byRefund.size,
      refundTotalMinor,
      returnIds: [...byRefund.keys()].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// W3 plan
// ---------------------------------------------------------------------------

/** The 17 `ShiftCloseIntentBusinessSnapshot` fields (src/lib/pos/offline/shiftCloseIntentTypes.ts), exact stored values. */
export type CloseBusinessSnapshot = {
  shiftId: string;
  branchId: string;
  staffId: string;
  staffName: string;
  startingCash: number;
  expectedCash: number;
  expectedQr: number;
  expectedKbank: number;
  expectedCard: number;
  expectedCredit: number;
  payInTotal: number;
  payOutTotal: number;
  totalBills: number;
  actualCashCount: number;
  variance: number;
  note: string;
  deviceId: string;
};

export const CLOSE_BUSINESS_SNAPSHOT_FIELDS: readonly (keyof CloseBusinessSnapshot)[] = [
  'shiftId',
  'branchId',
  'staffId',
  'staffName',
  'startingCash',
  'expectedCash',
  'expectedQr',
  'expectedKbank',
  'expectedCard',
  'expectedCredit',
  'payInTotal',
  'payOutTotal',
  'totalBills',
  'actualCashCount',
  'variance',
  'note',
  'deviceId',
];

export type CloseMoneyMinor = {
  startingCashMinor: number;
  expectedCashMinor: number;
  expectedQrMinor: number;
  expectedKbankMinor: number;
  expectedCardMinor: number;
  expectedCreditMinor: number;
  payInMinor: number;
  payOutMinor: number;
  expectedDrawerMinor: number;
  actualCashCountMinor: number;
  varianceMinor: number;
};

export type ClosePlan = {
  snapshot: CloseBusinessSnapshot;
  money: CloseMoneyMinor;
  /** Every W3 field except `closedAt` (a server-timestamp sentinel added by the wrapper). */
  w3Fields: Record<string, unknown>;
};

/**
 * expectedDrawer = startingCash + expectedCash + payIn − payOut and
 * variance = actualCashCount − expectedDrawer, both in integer satang.
 *
 * The stored `variance` is the client parser's exact float expression over
 * the stored values (`actual − (starting + expectedCash + payIn − payOut)`),
 * so `parseCommittedOwnClose`'s strict identity holds bit-for-bit; it must
 * equal the integer-satang variance, else `money_precision_unsafe`.
 */
export function planAuthoritativeClose(input: {
  shift: OpenShiftView;
  request: ValidatedCloseRequest;
  cash: CashFold;
}): { ok: true; value: ClosePlan } | Fail {
  const { shift, request, cash } = input;
  const s = request.attestedSales;
  if (cash.payInMinor > MAX_TOTAL_MINOR || cash.payOutMinor > MAX_TOTAL_MINOR) return fail('amount_out_of_bounds');
  const expectedDrawerMinor = shift.startingCashMinor + s.expectedCashMinor + cash.payInMinor - cash.payOutMinor;
  const varianceMinor = request.actualCashCountMinor - expectedDrawerMinor;
  if (!Number.isSafeInteger(expectedDrawerMinor) || !Number.isSafeInteger(varianceMinor)) return fail('amount_out_of_bounds');
  if (Math.abs(varianceMinor) > MAX_TOTAL_MINOR) return fail('amount_out_of_bounds');

  const expectedCash = minorToBaht(s.expectedCashMinor);
  const payInTotal = minorToBaht(cash.payInMinor);
  const payOutTotal = minorToBaht(cash.payOutMinor);
  const actualCashCount = minorToBaht(request.actualCashCountMinor);
  const variance = actualCashCount - (shift.startingCash + expectedCash + payInTotal - payOutTotal);
  if (!Number.isFinite(variance) || Math.abs(variance) > MAX_TOTAL_BAHT) return fail('amount_out_of_bounds');
  if (Math.abs(variance * 100 - varianceMinor) >= 0.01) return fail('money_precision_unsafe');

  const snapshot: CloseBusinessSnapshot = {
    shiftId: shift.shiftId,
    branchId: shift.branchId,
    staffId: shift.staffId,
    staffName: shift.staffName,
    startingCash: shift.startingCash,
    expectedCash,
    expectedQr: minorToBaht(s.expectedQrMinor),
    expectedKbank: minorToBaht(s.expectedKbankMinor),
    expectedCard: minorToBaht(s.expectedCardMinor),
    expectedCredit: minorToBaht(s.expectedCreditMinor),
    payInTotal,
    payOutTotal,
    totalBills: s.totalBills,
    actualCashCount,
    variance,
    note: request.note,
    deviceId: request.deviceId,
  };
  return {
    ok: true,
    value: {
      snapshot,
      money: {
        startingCashMinor: shift.startingCashMinor,
        expectedCashMinor: s.expectedCashMinor,
        expectedQrMinor: s.expectedQrMinor,
        expectedKbankMinor: s.expectedKbankMinor,
        expectedCardMinor: s.expectedCardMinor,
        expectedCreditMinor: s.expectedCreditMinor,
        payInMinor: cash.payInMinor,
        payOutMinor: cash.payOutMinor,
        expectedDrawerMinor,
        actualCashCountMinor: request.actualCashCountMinor,
        varianceMinor,
      },
      // = src/lib/pos/shiftService.ts `closeWritePayload` minus `closedAt`:
      // exactly the Rules `isW3ShiftClose` affected-key set.
      w3Fields: {
        status: 'closed',
        actualCashCount: snapshot.actualCashCount,
        variance: snapshot.variance,
        note: snapshot.note,
        expectedCash: snapshot.expectedCash,
        expectedQr: snapshot.expectedQr,
        expectedKbank: snapshot.expectedKbank,
        expectedCard: snapshot.expectedCard,
        expectedCredit: snapshot.expectedCredit,
        totalBills: snapshot.totalBills,
        payInTotal: snapshot.payInTotal,
        payOutTotal: snapshot.payOutTotal,
        closedOffline: true,
        syncState: 'pending',
        deviceId: snapshot.deviceId,
        closeCorrelationId: request.closeCorrelationId,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Authority record + canonical response
// ---------------------------------------------------------------------------

export const SALES_VERIFICATION = {
  status: 'attested_unverified',
  reason: 'sale_sync_completeness_not_provable',
} as const;

export type CashAuditRecord = {
  cashEntryCount: number;
  cashEntriesDigest: string;
  manualEntryCount: number;
  manualPayInMinor: number;
  manualPayOutMinor: number;
  refundCount: number;
  refundTotalMinor: number;
  refundReturnIds: string[];
};

/** `shiftCloseAuthorityRecords/{shiftId}` minus `closedAt` (server timestamp, same commit as the W3). */
export type AuthorityRecordBody = {
  schemaVersion: typeof SHIFT_CLOSE_AUTHORITY_RECORD_SCHEMA_VERSION;
  contractVersion: typeof CLOSE_SHIFT_AUTHORITATIVE_CONTRACT_VERSION;
  closeProtocol: typeof CLOSE_PROTOCOL;
  shiftId: string;
  branchId: string;
  staffId: string;
  closedByStaffId: string;
  closeCorrelationId: string;
  deviceId: string;
  requestDigest: string;
  snapshot: CloseBusinessSnapshot;
  money: CloseMoneyMinor;
  cashAudit: CashAuditRecord;
  salesVerification: typeof SALES_VERIFICATION;
  createdAtMillis: number;
};

export function buildAuthorityRecord(params: {
  request: ValidatedCloseRequest;
  requestDigest: string;
  plan: ClosePlan;
  cash: CashFold;
  audit: RefundAudit;
  callerStaffId: string;
  nowMillis: number;
}): AuthorityRecordBody {
  const { request, plan, cash, audit } = params;
  return {
    schemaVersion: SHIFT_CLOSE_AUTHORITY_RECORD_SCHEMA_VERSION,
    contractVersion: CLOSE_SHIFT_AUTHORITATIVE_CONTRACT_VERSION,
    closeProtocol: CLOSE_PROTOCOL,
    shiftId: plan.snapshot.shiftId,
    branchId: plan.snapshot.branchId,
    staffId: plan.snapshot.staffId,
    closedByStaffId: params.callerStaffId,
    closeCorrelationId: request.closeCorrelationId,
    deviceId: request.deviceId,
    requestDigest: params.requestDigest,
    snapshot: { ...plan.snapshot },
    money: { ...plan.money },
    cashAudit: {
      cashEntryCount: cash.entryCount,
      cashEntriesDigest: cash.digest,
      manualEntryCount: cash.manualEntryCount,
      manualPayInMinor: cash.manualPayInMinor,
      manualPayOutMinor: cash.manualPayOutMinor,
      refundCount: audit.refundCount,
      refundTotalMinor: audit.refundTotalMinor,
      refundReturnIds: [...audit.returnIds],
    },
    salesVerification: { ...SALES_VERIFICATION },
    createdAtMillis: params.nowMillis,
  };
}

export type CloseShiftAuthoritativeSuccess = {
  ok: true;
  contractVersion: typeof CLOSE_SHIFT_AUTHORITATIVE_CONTRACT_VERSION;
  closeProtocol: typeof CLOSE_PROTOCOL;
  /** `true` = this call wrote nothing; the durable close of the same UUID is returned. */
  idempotentReplay: boolean;
  shiftId: string;
  closeCorrelationId: string;
  /** The resolved server commit time of the W3 (`shifts.closedAt`). */
  closedAtMillis: number;
  /** Exactly the persisted 17 business fields (the client journal's snapshot). */
  snapshot: CloseBusinessSnapshot;
  persistedClose: { status: 'closed'; closedOffline: true; syncStateAtClose: 'pending' };
  money: CloseMoneyMinor;
  provenance: {
    cashMovements: 'server_recomputed';
    returnRefunds: { status: 'server_audit_matched'; count: number; totalMinor: number };
    manualCashEntries: { status: 'shift_recorded_unattested'; count: number; payInMinor: number; payOutMinor: number };
    salesTotals: typeof SALES_VERIFICATION;
    /** The server commit never implies the terminal's IndexedDB journal / Z / W4 happened. */
    clientJournal: 'not_finalized_by_server';
  };
};

export type CloseShiftAuthoritativeResponse = CloseShiftAuthoritativeSuccess | Fail;

function readMillis(v: unknown): number | null {
  if (v == null || typeof v !== 'object') return null;
  const fn = (v as { toMillis?: unknown }).toMillis;
  if (typeof fn !== 'function') return null;
  const ms = fn.call(v);
  return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

function readNumberMap(v: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!isPlainObject(v)) return null;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const x = v[k];
    if (typeof x !== 'number' || !Number.isSafeInteger(x)) return null;
    out[k] = x;
  }
  return out;
}

const MONEY_KEYS: readonly (keyof CloseMoneyMinor)[] = [
  'startingCashMinor',
  'expectedCashMinor',
  'expectedQrMinor',
  'expectedKbankMinor',
  'expectedCardMinor',
  'expectedCreditMinor',
  'payInMinor',
  'payOutMinor',
  'expectedDrawerMinor',
  'actualCashCountMinor',
  'varianceMinor',
];

/**
 * The ONE canonical response builder, for the first commit (post-commit
 * read-back) and every replay: built only from the durable authority record
 * and the closed shift doc, after checking they still describe the same
 * close. W4 (`pending → synced`) is the only change tolerated on the shift.
 */
export function canonicalResponseFromDurable(params: {
  shiftData: Record<string, unknown>;
  record: Record<string, unknown>;
  idempotentReplay: boolean;
}): CloseShiftAuthoritativeSuccess | Fail {
  const { shiftData, record } = params;
  const inconsistent = fail('close_record_inconsistent');
  if (record.schemaVersion !== SHIFT_CLOSE_AUTHORITY_RECORD_SCHEMA_VERSION) return inconsistent;
  if (record.closeProtocol !== CLOSE_PROTOCOL) return inconsistent;
  if (shiftData.status !== 'closed') return inconsistent;
  if (typeof record.closeCorrelationId !== 'string' || shiftData.closeCorrelationId !== record.closeCorrelationId) {
    return inconsistent;
  }
  if (shiftData.closedOffline !== true) return inconsistent;
  if (shiftData.syncState !== 'pending' && shiftData.syncState !== 'synced') return inconsistent;
  const shiftClosedAt = readMillis(shiftData.closedAt);
  const recordClosedAt = readMillis(record.closedAt);
  if (shiftClosedAt == null || recordClosedAt == null || shiftClosedAt !== recordClosedAt) return inconsistent;

  const snap = record.snapshot;
  if (!isPlainObject(snap)) return inconsistent;
  const snapshot = {} as Record<string, unknown>;
  for (const k of CLOSE_BUSINESS_SNAPSHOT_FIELDS) {
    const v = snap[k];
    if (k === 'shiftId') {
      if (v !== record.shiftId) return inconsistent;
    } else if (shiftData[k] !== v) {
      return inconsistent;
    }
    snapshot[k] = v;
  }
  if (snapshot.branchId !== record.branchId || snapshot.staffId !== record.staffId) return inconsistent;

  const money = readNumberMap(record.money, MONEY_KEYS);
  const cashAudit = readNumberMap(record.cashAudit, [
    'manualEntryCount',
    'manualPayInMinor',
    'manualPayOutMinor',
    'refundCount',
    'refundTotalMinor',
  ]);
  if (money == null || cashAudit == null) return inconsistent;

  return {
    ok: true,
    contractVersion: CLOSE_SHIFT_AUTHORITATIVE_CONTRACT_VERSION,
    closeProtocol: CLOSE_PROTOCOL,
    idempotentReplay: params.idempotentReplay,
    shiftId: record.shiftId as string,
    closeCorrelationId: record.closeCorrelationId,
    closedAtMillis: shiftClosedAt,
    snapshot: snapshot as CloseBusinessSnapshot,
    persistedClose: { status: 'closed', closedOffline: true, syncStateAtClose: 'pending' },
    money: money as CloseMoneyMinor,
    provenance: {
      cashMovements: 'server_recomputed',
      returnRefunds: {
        status: 'server_audit_matched',
        count: cashAudit.refundCount!,
        totalMinor: cashAudit.refundTotalMinor!,
      },
      manualCashEntries: {
        status: 'shift_recorded_unattested',
        count: cashAudit.manualEntryCount!,
        payInMinor: cashAudit.manualPayInMinor!,
        payOutMinor: cashAudit.manualPayOutMinor!,
      },
      salesTotals: { ...SALES_VERIFICATION },
      clientJournal: 'not_finalized_by_server',
    },
  };
}

/**
 * A request against an already-closed shift (after the owner/branch checks).
 * Never writes. Same UUID + same request digest + a consistent durable
 * authority record ⇒ the canonical response; anything else is a typed refusal.
 */
export function decideClosedShiftReplay(params: {
  shiftData: Record<string, unknown>;
  record: Record<string, unknown> | null;
  request: ValidatedCloseRequest;
  requestDigest: string;
}): CloseShiftAuthoritativeSuccess | Fail {
  const { shiftData, record, request } = params;
  if (shiftData.closeCorrelationId !== request.closeCorrelationId) return fail('already_closed');
  // Closed with this UUID by a direct client W3 — not a server-authoritative close.
  if (record == null) return fail('closed_outside_authority');
  if (record.closeCorrelationId !== request.closeCorrelationId) return fail('close_record_inconsistent');
  if (record.requestDigest !== params.requestDigest) return fail('idempotency_conflict');
  return canonicalResponseFromDurable({ shiftData, record, idempotentReplay: true });
}
