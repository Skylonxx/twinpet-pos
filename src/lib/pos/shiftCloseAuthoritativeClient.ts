/**
 * Return/Refund V1 packet 014 — client adapter for the server-authoritative
 * shift close (`closeShiftAuthoritative`, docs/contracts/close-shift-authoritative-v1.md).
 *
 * STAGED, OFF BY DEFAULT: {@link SERVER_AUTHORITATIVE_CLOSE_ENABLED} is a
 * hardcoded `false`; nothing reads it from `.env`, storage, the URL or the UI.
 * Only a test can turn the ON path on (`CloseShiftDeps.authoritativeCloseGate`).
 * While OFF, `closeShift` is the unchanged legacy close and this module only
 * contributes types.
 *
 * Pure pieces (no Firestore): canonical satang money, the frozen v1 request,
 * the expected close from an authoritative pre-call shift read, and the
 * response classification. The close orchestration (durable attempt, call,
 * proof-before-Z, finalize) lives in `shiftService.ts` with the other close
 * paths, whose helpers it shares.
 */

import type { Shift, ShiftCashEntry } from '../types';
import type { LocalSale } from './localLedger';
import type {
  AuthoritativeCloseRequestBody,
  AuthoritativeServerProof,
  ShiftCloseIntentBusinessSnapshot,
} from './offline/shiftCloseIntentTypes';

/**
 * THE source gate. `false` = every production close is the legacy close; the
 * callable is never invoked. A later, separately authorized cutover packet is
 * the only thing allowed to change it.
 */
export const SERVER_AUTHORITATIVE_CLOSE_ENABLED: boolean = false;

export const CLOSE_SHIFT_AUTHORITATIVE_CALLABLE = 'closeShiftAuthoritative';

// ── Server contract bounds (functions/src/closeShiftAuthoritativeCore.ts) ──

export const AUTHORITATIVE_NOTE_MAX = 1000;
export const AUTHORITATIVE_DEVICE_ID_MAX = 200;
export const AUTHORITATIVE_MAX_TOTAL_BILLS = 100_000;
export const AUTHORITATIVE_MAX_CASH_ENTRIES = 1000;
const MAX_ENTRY_BAHT = 10_000_000;
const MAX_TOTAL_BAHT = 10_000_000_000;
const MAX_TOTAL_MINOR = MAX_TOTAL_BAHT * 100;
/** The server's P5 converter tolerance — mirrored so the client never sends a value the server refuses. */
const P5_PRECISION_EPSILON = 1e-6;
const SHIFT_ID_RE = /^[^/]{1,200}$/;
const LOWERCASE_UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Baht → satang exactly as the server accepts it (P5 bound + precision check,
 * then 013's `minor / 100 === x`): the value must BE the canonical JS number
 * of its satang count. Never rounds an off-cent value into an accepted one.
 */
function exactMinor(x: unknown, positive: boolean): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  if (positive ? x <= 0 || x > MAX_ENTRY_BAHT : x < 0 || x > MAX_TOTAL_BAHT) return null;
  if (Object.is(x, -0)) return 0;
  const scaled = x * 100;
  const minor = Math.round(scaled);
  if (Math.abs(scaled - minor) > P5_PRECISION_EPSILON) return null;
  if (!Number.isSafeInteger(minor) || minor / 100 !== x) return null;
  return minor;
}

/** A total / aggregate (≥ 0, ≤ ฿10,000,000,000), satang-exact; `null` otherwise. */
export function canonicalTotalMinor(x: unknown): number | null {
  return exactMinor(x, false);
}

/** One cash movement (> 0, ≤ ฿10,000,000), satang-exact; `null` otherwise. */
export function canonicalEntryMinor(x: unknown): number | null {
  return exactMinor(x, true);
}

/** The canonical JS number of a satang count (what the server stores and echoes). */
export function minorToCanonicalBaht(minor: number): number {
  return minor / 100;
}

// ── Attested sales: integer-satang fold of the ledger line items ──

export type AttestedSalesMinor = {
  expectedCashMinor: number;
  expectedQrMinor: number;
  expectedKbankMinor: number;
  expectedCardMinor: number;
  expectedCreditMinor: number;
  totalBills: number;
};

export type LedgerFoldFailure =
  | 'sale_malformed'
  | 'sale_wrong_shift'
  | 'sale_duplicate'
  | 'payment_malformed'
  | 'amount_not_canonical'
  | 'total_out_of_bounds'
  | 'too_many_bills';

const PAYMENT_METHODS = ['cash', 'qr', 'kbank', 'card', 'credit'] as const;

/**
 * The shift's sale totals folded in INTEGER satang from each sale's own
 * payment lines and change (the same per-sale formula as `summarizeDrawer`:
 * net cash = max(0, cash tendered − change)). Every line amount and change must
 * already be canonical; a missing / malformed component, an unknown method, a
 * sale of another shift or a repeated sale id refuses — nothing is rounded.
 */
export function foldAttestedSalesMinor(
  shiftId: string,
  sales: readonly LocalSale[],
): { ok: true; value: AttestedSalesMinor } | { ok: false; reason: LedgerFoldFailure } {
  if (!Array.isArray(sales)) return { ok: false, reason: 'sale_malformed' };
  if (sales.length > AUTHORITATIVE_MAX_TOTAL_BILLS) return { ok: false, reason: 'too_many_bills' };
  const totals = { cash: 0, qr: 0, kbank: 0, card: 0, credit: 0 };
  const seen = new Set<string>();
  for (const sale of sales) {
    if (sale === null || typeof sale !== 'object' || typeof sale.id !== 'string' || sale.id.length === 0) {
      return { ok: false, reason: 'sale_malformed' };
    }
    if (sale.shiftId !== shiftId) return { ok: false, reason: 'sale_wrong_shift' };
    if (seen.has(sale.id)) return { ok: false, reason: 'sale_duplicate' };
    seen.add(sale.id);
    if (!Array.isArray(sale.payments)) return { ok: false, reason: 'payment_malformed' };
    const changeMinor = canonicalTotalMinor(sale.changeAmt);
    if (changeMinor === null) return { ok: false, reason: 'amount_not_canonical' };
    let cashInMinor = 0;
    for (const p of sale.payments as readonly unknown[]) {
      if (p === null || typeof p !== 'object') return { ok: false, reason: 'payment_malformed' };
      const { method, amount } = p as { method?: unknown; amount?: unknown };
      if (!(PAYMENT_METHODS as readonly unknown[]).includes(method)) return { ok: false, reason: 'payment_malformed' };
      const minor = canonicalTotalMinor(amount);
      if (minor === null) return { ok: false, reason: 'amount_not_canonical' };
      if (method === 'cash') cashInMinor += minor;
      else totals[method as Exclude<(typeof PAYMENT_METHODS)[number], 'cash'>] += minor;
    }
    totals.cash += Math.max(0, cashInMinor - changeMinor);
  }
  if (Object.values(totals).some((m) => !Number.isSafeInteger(m) || m > MAX_TOTAL_MINOR)) {
    return { ok: false, reason: 'total_out_of_bounds' };
  }
  return {
    ok: true,
    value: {
      expectedCashMinor: totals.cash,
      expectedQrMinor: totals.qr,
      expectedKbankMinor: totals.kbank,
      expectedCardMinor: totals.card,
      expectedCreditMinor: totals.credit,
      totalBills: sales.length,
    },
  };
}

// ── The frozen v1 request ──

export type AuthoritativeRequestFailure =
  | { reason: 'shift_id_invalid' | 'device_id_invalid' | 'note_too_long' | 'count_not_canonical' }
  | { reason: 'ledger'; detail: LedgerFoldFailure }
  | { reason: 'attested_not_canonical' }
  | { reason: 'attested_differs_from_drawer'; field: string };

const ATTESTED_FIELDS = ['expectedCash', 'expectedQr', 'expectedKbank', 'expectedCard', 'expectedCredit'] as const;

/**
 * The request body (everything but the attempt's correlation id). Money is the
 * canonical `minor / 100` of the integer-satang ledger fold. The drawer the
 * cashier was shown (`shift`, derived from the same ledger) must carry exactly
 * these values — a raw float aggregate such as 0.1 + 0.2 is refused, never
 * forwarded or silently replaced. No branch / staff / role / payIn / payOut /
 * variance / startingCash field exists in the request (the server owns them).
 */
export function buildAuthoritativeCloseRequestBody(input: {
  shift: Shift;
  sales: readonly LocalSale[];
  actualCashCount: number;
  note: string;
  deviceId: string;
}): { ok: true; body: AuthoritativeCloseRequestBody } | ({ ok: false } & AuthoritativeRequestFailure) {
  const { shift, sales, actualCashCount, note, deviceId } = input;
  if (typeof shift.id !== 'string' || !SHIFT_ID_RE.test(shift.id) || shift.id !== shift.id.trim()) {
    return { ok: false, reason: 'shift_id_invalid' };
  }
  if (
    typeof deviceId !== 'string' ||
    deviceId.length === 0 ||
    deviceId.length > AUTHORITATIVE_DEVICE_ID_MAX ||
    deviceId !== deviceId.trim()
  ) {
    return { ok: false, reason: 'device_id_invalid' };
  }
  if (typeof note !== 'string' || note.length > AUTHORITATIVE_NOTE_MAX) return { ok: false, reason: 'note_too_long' };
  if (canonicalTotalMinor(actualCashCount) === null) return { ok: false, reason: 'count_not_canonical' };
  const folded = foldAttestedSalesMinor(shift.id, sales);
  if (!folded.ok) return { ok: false, reason: 'ledger', detail: folded.reason };
  const m = folded.value;
  const attestedSales = {
    expectedCash: minorToCanonicalBaht(m.expectedCashMinor),
    expectedQr: minorToCanonicalBaht(m.expectedQrMinor),
    expectedKbank: minorToCanonicalBaht(m.expectedKbankMinor),
    expectedCard: minorToCanonicalBaht(m.expectedCardMinor),
    expectedCredit: minorToCanonicalBaht(m.expectedCreditMinor),
    totalBills: m.totalBills,
  };
  // The server's own acceptance of each value (e.g. its P5 high-total precision limit).
  if (ATTESTED_FIELDS.some((f) => canonicalTotalMinor(attestedSales[f]) === null)) {
    return { ok: false, reason: 'attested_not_canonical' };
  }
  for (const f of [...ATTESTED_FIELDS, 'totalBills'] as const) {
    if (shift[f] !== attestedSales[f]) {
      return { ok: false, reason: 'attested_differs_from_drawer', field: f };
    }
  }
  return {
    ok: true,
    body: {
      contractVersion: 1,
      shiftId: shift.id,
      actualCashCount: Object.is(actualCashCount, -0) ? 0 : actualCashCount,
      note,
      attestedSales,
      deviceId,
    },
  };
}

/** The exact v1 request sent for an attempt (body + the attempt's own correlation id). */
export function authoritativeCloseRequest(
  body: AuthoritativeCloseRequestBody,
  closeCorrelationId: string,
): Record<string, unknown> {
  return {
    contractVersion: body.contractVersion,
    shiftId: body.shiftId,
    closeCorrelationId,
    actualCashCount: body.actualCashCount,
    note: body.note,
    attestedSales: { ...body.attestedSales },
    deviceId: body.deviceId,
  };
}

/** Field-for-field (`===`) equality of two request bodies. */
export function sameAuthoritativeRequestBody(a: AuthoritativeCloseRequestBody, b: AuthoritativeCloseRequestBody): boolean {
  return (
    a.contractVersion === b.contractVersion &&
    a.shiftId === b.shiftId &&
    a.actualCashCount === b.actualCashCount &&
    a.note === b.note &&
    a.deviceId === b.deviceId &&
    ATTESTED_FIELDS.every((f) => a.attestedSales[f] === b.attestedSales[f]) &&
    a.attestedSales.totalBills === b.attestedSales.totalBills
  );
}

// ── The expected close (from an authoritative pre-call shift read) ──

export type ExpectationFailure =
  | 'starting_cash_invalid'
  | 'cash_entries_invalid'
  | 'cash_entries_over_cap'
  | 'cash_entry_duplicate'
  | 'amount_out_of_bounds'
  | 'money_precision_unsafe';

/**
 * What the server will commit for `body` against the shift as just read from
 * the server — the same strict integer-satang fold and the same stored-double
 * expressions as `planAuthoritativeClose` (pay-in / pay-out = minor / 100;
 * variance = actual − (starting + expectedCash + payIn − payOut)). A list the
 * server would refuse is refused here before anything is sent.
 */
export function buildAuthoritativeExpectation(params: {
  identity: { shiftId: string; branchId: string; staffId: string; staffName: string; deviceId: string };
  body: AuthoritativeCloseRequestBody;
  serverData: Record<string, unknown>;
}): { ok: true; expected: ShiftCloseIntentBusinessSnapshot; serverEntries: ShiftCashEntry[] } | { ok: false; reason: ExpectationFailure } {
  const { identity, body, serverData } = params;
  const startingCash = serverData.startingCash;
  const startingCashMinor = canonicalTotalMinor(startingCash);
  if (startingCashMinor === null) return { ok: false, reason: 'starting_cash_invalid' };
  const present = 'cashEntries' in serverData;
  const raw = serverData.cashEntries;
  if (present && !Array.isArray(raw)) return { ok: false, reason: 'cash_entries_invalid' };
  const list: unknown[] = present ? (raw as unknown[]) : [];
  if (list.length > AUTHORITATIVE_MAX_CASH_ENTRIES) return { ok: false, reason: 'cash_entries_over_cap' };
  const seen = new Set<string>();
  let payInMinor = 0;
  let payOutMinor = 0;
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i] as Record<string, unknown> | undefined;
    if (e === null || typeof e !== 'object' || Array.isArray(e)) return { ok: false, reason: 'cash_entries_invalid' };
    if (typeof e.id !== 'string' || e.id.length === 0) return { ok: false, reason: 'cash_entries_invalid' };
    if (seen.has(e.id)) return { ok: false, reason: 'cash_entry_duplicate' };
    seen.add(e.id);
    if (e.type !== 'pay_in' && e.type !== 'pay_out') return { ok: false, reason: 'cash_entries_invalid' };
    const minor = canonicalEntryMinor(e.amount);
    if (minor === null) return { ok: false, reason: 'cash_entries_invalid' };
    if (e.type === 'pay_in') payInMinor += minor;
    else payOutMinor += minor;
  }
  if (payInMinor > MAX_TOTAL_MINOR || payOutMinor > MAX_TOTAL_MINOR) return { ok: false, reason: 'amount_out_of_bounds' };
  const s = body.attestedSales;
  const expectedCashMinor = canonicalTotalMinor(s.expectedCash)!;
  const actualMinor = canonicalTotalMinor(body.actualCashCount)!;
  const varianceMinor = actualMinor - (startingCashMinor + expectedCashMinor + payInMinor - payOutMinor);
  if (!Number.isSafeInteger(varianceMinor) || Math.abs(varianceMinor) > MAX_TOTAL_MINOR) {
    return { ok: false, reason: 'amount_out_of_bounds' };
  }
  const payInTotal = minorToCanonicalBaht(payInMinor);
  const payOutTotal = minorToCanonicalBaht(payOutMinor);
  const variance = body.actualCashCount - ((startingCash as number) + s.expectedCash + payInTotal - payOutTotal);
  if (!Number.isFinite(variance) || Math.abs(variance) > MAX_TOTAL_BAHT) return { ok: false, reason: 'amount_out_of_bounds' };
  if (Math.abs(variance * 100 - varianceMinor) >= 0.01) return { ok: false, reason: 'money_precision_unsafe' };
  return {
    ok: true,
    serverEntries: list as ShiftCashEntry[],
    expected: {
      shiftId: identity.shiftId,
      branchId: identity.branchId,
      staffId: identity.staffId,
      staffName: identity.staffName,
      startingCash: startingCash as number,
      expectedCash: s.expectedCash,
      expectedQr: s.expectedQr,
      expectedKbank: s.expectedKbank,
      expectedCard: s.expectedCard,
      expectedCredit: s.expectedCredit,
      payInTotal,
      payOutTotal,
      totalBills: s.totalBills,
      actualCashCount: body.actualCashCount,
      variance,
      note: body.note,
      deviceId: identity.deviceId,
    },
  };
}

// ── Callable boundary + response classification ──

/** Injectable transport: resolves to the callable's `data`, rejects on any SDK / network failure. */
export type CloseShiftAuthoritativeCallable = (request: Record<string, unknown>) => Promise<unknown>;

/** Every typed definitive refusal of contract v1 §6 (nothing was written by THAT call). */
export const AUTHORITATIVE_REFUSAL_CODES = [
  'invalid_request',
  'unauthenticated',
  'not_authorized',
  'session_stale',
  'branch_not_authorized',
  'shift_not_found',
  'not_shift_owner',
  'shift_record_invalid',
  'shift_state_invalid',
  'already_closed',
  'closed_outside_authority',
  'idempotency_conflict',
  'close_record_inconsistent',
  'cash_entries_invalid',
  'cash_entries_over_cap',
  'cash_entry_duplicate',
  'refund_audit_unavailable',
  'refund_set_over_cap',
  'refund_record_invalid',
  'refund_return_mismatch',
  'refund_missing_in_shift',
  'refund_entry_mismatch',
  'orphan_refund_entry',
  'amount_out_of_bounds',
  'money_precision_unsafe',
] as const;

export type AuthoritativeRefusalCode = (typeof AUTHORITATIVE_REFUSAL_CODES)[number];

/** The server canonical success, checked field by field (contract v1 §6). */
export type AuthoritativeCloseSuccess = {
  idempotentReplay: boolean;
  closedAtMillis: number;
  snapshot: ShiftCloseIntentBusinessSnapshot;
};

/**
 *   committed              `ok: true`, well formed, THIS shift + correlation id
 *   refused                a typed definitive refusal (nothing written by that call)
 *   committed_unconfirmed  the server committed but could not read it back
 *   unknown                transport / SDK failure, lost response, unknown code:
 *                          the close MAY have committed (never a refusal)
 *   malformed_success      `ok: true` the client cannot validate: a commit is
 *                          likely, but nothing in it can be trusted
 */
export type AuthoritativeCloseOutcome =
  | { kind: 'committed'; success: AuthoritativeCloseSuccess }
  | { kind: 'refused'; code: AuthoritativeRefusalCode }
  | { kind: 'committed_unconfirmed' }
  | { kind: 'unknown'; cause: 'transport' | 'unrecognized_response' }
  | { kind: 'malformed_success' };

const SNAPSHOT_STRING_FIELDS = ['shiftId', 'branchId', 'staffId', 'staffName', 'note', 'deviceId'] as const;
const SNAPSHOT_NUMBER_FIELDS = [
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
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function parseSuccess(raw: Record<string, unknown>, shiftId: string, closeCorrelationId: string): AuthoritativeCloseSuccess | null {
  if (raw.contractVersion !== 1 || raw.closeProtocol !== 'server_authoritative_v1') return null;
  if (typeof raw.idempotentReplay !== 'boolean') return null;
  if (raw.shiftId !== shiftId || raw.closeCorrelationId !== closeCorrelationId) return null;
  if (typeof raw.closedAtMillis !== 'number' || !Number.isFinite(raw.closedAtMillis)) return null;
  const snap = raw.snapshot;
  if (!isPlainObject(snap) || Object.keys(snap).length !== SNAPSHOT_STRING_FIELDS.length + SNAPSHOT_NUMBER_FIELDS.length) {
    return null;
  }
  if (!SNAPSHOT_STRING_FIELDS.every((f) => typeof snap[f] === 'string')) return null;
  if (!SNAPSHOT_NUMBER_FIELDS.every((f) => typeof snap[f] === 'number' && Number.isFinite(snap[f]))) return null;
  if (snap.shiftId !== shiftId) return null;
  const persisted = raw.persistedClose;
  if (!isPlainObject(persisted) || persisted.status !== 'closed' || persisted.closedOffline !== true) return null;
  // Honest provenance: the server never certifies sale totals in v1.
  const provenance = raw.provenance;
  if (!isPlainObject(provenance) || !isPlainObject(provenance.salesTotals)) return null;
  if (provenance.salesTotals.status !== 'attested_unverified') return null;
  return {
    idempotentReplay: raw.idempotentReplay,
    closedAtMillis: raw.closedAtMillis,
    snapshot: snap as unknown as ShiftCloseIntentBusinessSnapshot,
  };
}

/** Classifies one call. Never throws; a thrown call is an UNKNOWN outcome. */
export async function invokeCloseShiftAuthoritative(
  callable: CloseShiftAuthoritativeCallable,
  request: Record<string, unknown>,
): Promise<AuthoritativeCloseOutcome> {
  let raw: unknown;
  try {
    raw = await callable(request);
  } catch (err) {
    // Never logged with the request (no secret is in it, but the cashier sees only typed copy).
    console.warn('[shiftCloseAuthoritative] callable outcome unknown', (err as { code?: unknown } | null)?.code ?? 'error');
    return { kind: 'unknown', cause: 'transport' };
  }
  const shiftId = request.shiftId as string;
  const closeCorrelationId = request.closeCorrelationId as string;
  if (!isPlainObject(raw)) return { kind: 'unknown', cause: 'unrecognized_response' };
  if (raw.ok === true) {
    const success = parseSuccess(raw, shiftId, closeCorrelationId);
    return success ? { kind: 'committed', success } : { kind: 'malformed_success' };
  }
  if (raw.ok === false) {
    if (raw.code === 'committed_unconfirmed') return { kind: 'committed_unconfirmed' };
    if ((AUTHORITATIVE_REFUSAL_CODES as readonly unknown[]).includes(raw.code)) {
      return { kind: 'refused', code: raw.code as AuthoritativeRefusalCode };
    }
  }
  return { kind: 'unknown', cause: 'unrecognized_response' };
}

let cachedCallable: CloseShiftAuthoritativeCallable | null = null;

/**
 * Production transport, following the existing callable convention
 * (`saleReturnService.ts`): the project's Functions instance in
 * `VITE_FUNCTIONS_REGION` (generated from firebase.json — asia-southeast1),
 * the emulator only under the existing `USE_EMULATOR` switch. Created lazily —
 * never touched while the gate is OFF.
 */
export async function getDefaultCloseShiftAuthoritativeCallable(): Promise<CloseShiftAuthoritativeCallable> {
  if (cachedCallable) return cachedCallable;
  const [{ getFunctions, httpsCallable, connectFunctionsEmulator }, { app, USE_EMULATOR }] = await Promise.all([
    import('firebase/functions'),
    import('../firebase'),
  ]);
  if (!app) throw new Error('Firebase not configured');
  const functions = getFunctions(app, import.meta.env.VITE_FUNCTIONS_REGION);
  if (USE_EMULATOR) connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  const fn = httpsCallable(functions, CLOSE_SHIFT_AUTHORITATIVE_CALLABLE);
  cachedCallable = async (request) => (await fn(request)).data;
  return cachedCallable;
}

export function isLowercaseUuidV4(v: unknown): v is string {
  return typeof v === 'string' && LOWERCASE_UUID_V4_RE.test(v);
}

// ── Cashier copy (Thai). Never includes request data, tokens or ids beyond the code. ──

export const CLOSE_SHIFT_AUTHORITATIVE_OFFLINE_MESSAGE =
  'ปิดกะได้เฉพาะเมื่อเชื่อมต่ออินเทอร์เน็ตเท่านั้น — ยังไม่ได้ปิดกะ และไม่มีการบันทึกการปิดกะในเครื่อง กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วปิดกะอีกครั้ง';
export const CLOSE_SHIFT_AUTHORITATIVE_SALES_UNAVAILABLE_MESSAGE =
  'ไม่สามารถรวมยอดขายของกะนี้จากบิลในเครื่องได้ — ยังไม่ได้ปิดกะ กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ให้แจ้งผู้จัดการ';
export const CLOSE_SHIFT_AUTHORITATIVE_LEDGER_INVALID_MESSAGE =
  'ยอดขายในบิลของกะนี้มีจำนวนเงินที่ไม่ใช่จำนวนสตางค์ที่ถูกต้อง ข้อมูลบิลไม่ครบ หรือยอดรวมเกินวงเงินที่ระบบรองรับ — ยังไม่ได้ปิดกะ กรุณาแจ้งผู้จัดการให้ตรวจสอบ (ห้ามแก้ไขบิลเอง)';
/** The callable transport could not even be created — nothing was sent. */
export const CLOSE_SHIFT_AUTHORITATIVE_UNAVAILABLE_MESSAGE =
  'บริการปิดกะของเซิร์ฟเวอร์ไม่พร้อมใช้งาน — ยังไม่ได้ส่งการปิดกะ กรุณาลองใหม่อีกครั้ง';
export const CLOSE_SHIFT_AUTHORITATIVE_DRAWER_INCONSISTENT_MESSAGE =
  'ยอดขายที่รวมจากบิลไม่ตรงกับยอดที่แสดงในหน้าปิดกะ — ยังไม่ได้ปิดกะ กรุณาปิดหน้าต่างนี้แล้วเปิดใหม่อีกครั้ง';
export const CLOSE_SHIFT_AUTHORITATIVE_COUNT_INVALID_MESSAGE =
  'จำนวนเงินสดที่นับได้ต้องเป็นจำนวนเงินที่มีทศนิยมไม่เกิน 2 ตำแหน่ง และไม่เกินวงเงินที่ระบบรองรับ — ยังไม่ได้ปิดกะ';
export const CLOSE_SHIFT_AUTHORITATIVE_NOTE_TOO_LONG_MESSAGE = `หมายเหตุยาวเกิน ${AUTHORITATIVE_NOTE_MAX} ตัวอักษร — ยังไม่ได้ปิดกะ กรุณาย่อหมายเหตุแล้วลองใหม่`;
export const CLOSE_SHIFT_AUTHORITATIVE_DEVICE_INVALID_MESSAGE =
  'รหัสเครื่องหรือรหัสกะของเครื่องนี้ไม่ถูกต้อง — ยังไม่ได้ปิดกะ กรุณาแจ้งผู้จัดการ';
export const CLOSE_SHIFT_AUTHORITATIVE_SERVER_CASH_INVALID_MESSAGE =
  'ข้อมูลเงินทอนเริ่มต้นหรือรายการเงินสดของกะบนเซิร์ฟเวอร์ไม่ถูกต้อง — ยังไม่ได้ปิดกะและยังไม่บันทึกยอดใด ๆ กรุณาแจ้งผู้จัดการให้ตรวจสอบกะนี้ (ห้ามแก้ไขหรือลบรายการเอง)';
export const CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CASH_NOT_ON_SERVER_MESSAGE =
  'รายการนำเงินเข้า/ออกของเครื่องนี้ยังไม่อยู่บนเซิร์ฟเวอร์ — ยังไม่ได้ปิดกะ กรุณารอสักครู่แล้วลองใหม่ หากยังไม่ได้ให้แจ้งผู้จัดการ';
/**
 * An earlier close of this shift recorded on this device (an offline-queued
 * close, a legacy transaction attempt, or a journal entry the server cannot
 * prove now) is unresolved: no server-authoritative close is sent over it.
 */
export const CLOSE_SHIFT_AUTHORITATIVE_LOCAL_CLOSE_PENDING_MESSAGE =
  'มีการปิดกะของกะนี้ค้างอยู่ในเครื่องนี้และยังยืนยันผลกับเซิร์ฟเวอร์ไม่ได้ — ระบบไม่ส่งการปิดกะซ้ำและไม่แสดงรายงานปิดกะ (Z) กรุณาตรวจสอบสถานะการซิงก์และแจ้งผู้จัดการ';
/** The same attempt (same correlation id) must carry exactly the same request. */
export const CLOSE_SHIFT_AUTHORITATIVE_REQUEST_CHANGED_MESSAGE =
  'มีการส่งปิดกะนี้ไปแล้วด้วยยอดนับเงินสด หมายเหตุ หรือยอดขายชุดเดิมซึ่งยังยืนยันผลไม่ได้ — ระบบไม่ส่งยอดชุดใหม่ซ้ำ กรุณาปิดกะอีกครั้งด้วยยอดนับและหมายเหตุเดิม หรือแจ้งผู้จัดการ';
/** The drawer's cash entries on the server changed since this attempt's values were recorded. */
export const CLOSE_SHIFT_AUTHORITATIVE_DRAWER_CHANGED_MESSAGE =
  'รายการเงินสดของกะบนเซิร์ฟเวอร์เปลี่ยนไปหลังจากส่งปิดกะครั้งก่อน (เช่น มีการคืนเงินสด) — ยังไม่ได้ปิดกะ ระบบไม่ส่งยอดชุดใหม่แทนชุดเดิม กรุณาแจ้งผู้จัดการให้ตรวจสอบ';
/** The server committed a close whose values this device did not expect: no Z, never adopted. */
export const CLOSE_SHIFT_AUTHORITATIVE_RESULT_MISMATCH_MESSAGE =
  'เซิร์ฟเวอร์ปิดกะแล้ว แต่ยอดที่บันทึกไม่ตรงกับยอดที่เครื่องนี้ส่งไป — ไม่แสดงรายงานปิดกะ (Z) และไม่บันทึกผลในเครื่อง กรุณาแจ้งผู้จัดการให้ตรวจสอบกะนี้';

const REFUSAL_COPY: Record<AuthoritativeRefusalCode, string> = {
  invalid_request: 'ข้อมูลปิดกะที่ส่งไม่ถูกต้อง',
  unauthenticated: 'เซสชันการเข้าสู่ระบบไม่พร้อมใช้งาน กรุณาเข้าสู่ระบบใหม่',
  session_stale: 'สิทธิ์ของบัญชีนี้เปลี่ยนไป กรุณาเข้าสู่ระบบใหม่',
  not_authorized: 'บัญชีนี้ไม่มีสิทธิ์ปิดกะ',
  branch_not_authorized: 'บัญชีนี้ไม่มีสิทธิ์ในสาขาของกะนี้',
  not_shift_owner: 'ปิดกะได้เฉพาะพนักงานเจ้าของกะเท่านั้น',
  shift_not_found: 'ไม่พบกะนี้บนเซิร์ฟเวอร์ กรุณาแจ้งผู้จัดการ',
  shift_record_invalid: 'ข้อมูลกะบนเซิร์ฟเวอร์ไม่ถูกต้อง กรุณาแจ้งผู้จัดการ',
  shift_state_invalid: 'สถานะกะบนเซิร์ฟเวอร์ไม่ถูกต้อง กรุณาแจ้งผู้จัดการ',
  already_closed: 'กะนี้ถูกปิดไปแล้ว',
  closed_outside_authority: 'กะนี้ถูกปิดด้วยรหัสการปิดกะของเครื่องนี้โดยไม่ผ่านการยืนยันจากเซิร์ฟเวอร์ ไม่แสดงรายงานปิดกะ (Z) กรุณาแจ้งผู้จัดการ',
  idempotency_conflict: 'กะนี้ถูกปิดด้วยรหัสการปิดกะของเครื่องนี้แต่ด้วยยอดชุดอื่น ไม่แสดงรายงานปิดกะ (Z) กรุณาแจ้งผู้จัดการ',
  close_record_inconsistent: 'บันทึกการปิดกะบนเซิร์ฟเวอร์ไม่ตรงกัน กรุณาแจ้งผู้จัดการ',
  cash_entries_invalid: 'รายการเงินสดของกะไม่ถูกต้อง กรุณาแจ้งผู้จัดการ (ห้ามแก้ไขหรือลบรายการเอง)',
  cash_entries_over_cap: 'รายการเงินสดของกะมีมากเกินกว่าที่ระบบรองรับ กรุณาแจ้งผู้จัดการ',
  cash_entry_duplicate: 'รายการเงินสดของกะมีรหัสซ้ำกัน กรุณาแจ้งผู้จัดการ (ห้ามแก้ไขหรือลบรายการเอง)',
  refund_audit_unavailable: 'ตรวจสอบรายการคืนเงินของกะไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง',
  refund_set_over_cap: 'รายการคืนเงินของกะมีมากเกินกว่าที่ระบบรองรับ กรุณาแจ้งผู้จัดการ',
  refund_record_invalid: 'บันทึกการคืนเงินของกะไม่ถูกต้อง กรุณาแจ้งผู้จัดการ',
  refund_return_mismatch: 'บันทึกการคืนเงินกับบันทึกการคืนสินค้าไม่ตรงกัน กรุณาแจ้งผู้จัดการ',
  refund_missing_in_shift: 'มีการคืนเงินสดที่ไม่ปรากฏในลิ้นชักของกะ กรุณาแจ้งผู้จัดการ',
  refund_entry_mismatch: 'ยอดคืนเงินสดในลิ้นชักไม่ตรงกับบันทึกการคืนเงิน กรุณาแจ้งผู้จัดการ',
  orphan_refund_entry: 'มีรายการคืนเงินสดในลิ้นชักที่ไม่มีบันทึกการคืนเงิน กรุณาแจ้งผู้จัดการ',
  amount_out_of_bounds: 'ยอดเงินของกะเกินวงเงินที่ระบบรองรับ กรุณาแจ้งผู้จัดการ',
  money_precision_unsafe: 'ยอดเงินของกะคำนวณให้ตรงระดับสตางค์ไม่ได้ กรุณาแจ้งผู้จัดการ',
};

/** Cashier copy for a definitive server refusal: nothing was closed by that call. */
export function authoritativeRefusalMessage(code: AuthoritativeRefusalCode): string {
  if (code === 'already_closed') return `${REFUSAL_COPY[code]} (รหัส: ${code})`;
  const notClosed =
    code === 'closed_outside_authority' || code === 'idempotency_conflict' || code === 'close_record_inconsistent'
      ? ''
      : ' — ยังไม่ได้ปิดกะ';
  return `${REFUSAL_COPY[code]}${notClosed} (รหัส: ${code})`;
}

// ── Packet 015 · F1/F4: server-authored close proof (the idempotent replay) ──

/** Field-for-field equality of two 17-field snapshots (the store's `snapshotsEqual`, kept local: the store imports THIS module). */
function sameSnapshot(a: ShiftCloseIntentBusinessSnapshot, b: ShiftCloseIntentBusinessSnapshot): boolean {
  return (
    SNAPSHOT_STRING_FIELDS.every((f) => a[f] === b[f]) &&
    SNAPSHOT_NUMBER_FIELDS.every((f) => a[f] === b[f]) &&
    a.deviceId === b.deviceId
  );
}

/**
 * The v1 request that reproduces a close from its 17-field snapshot — the
 * exact request the attempt sent (every request field is a snapshot field).
 * Used to replay a close that is only known from a journal entry.
 */
export function authoritativeRequestFromSnapshot(
  snapshot: ShiftCloseIntentBusinessSnapshot,
  closeCorrelationId: string,
): Record<string, unknown> {
  return {
    contractVersion: 1,
    shiftId: snapshot.shiftId,
    closeCorrelationId,
    actualCashCount: snapshot.actualCashCount,
    note: snapshot.note,
    attestedSales: {
      expectedCash: snapshot.expectedCash,
      expectedQr: snapshot.expectedQr,
      expectedKbank: snapshot.expectedKbank,
      expectedCard: snapshot.expectedCard,
      expectedCredit: snapshot.expectedCredit,
      totalBills: snapshot.totalBills,
    },
    deviceId: snapshot.deviceId,
  };
}

/** A definitive refusal that only means "the server cannot verify right now" (retry later), never "not server-authored". */
const REPLAY_RETRYABLE_REFUSALS: ReadonlySet<AuthoritativeRefusalCode> = new Set<AuthoritativeRefusalCode>([
  'unauthenticated',
  'session_stale',
  'refund_audit_unavailable',
]);

export type ServerAuthoredCloseProof =
  | { kind: 'proven'; proof: AuthoritativeServerProof }
  /** Nothing is established either way (transport / unconfirmed / cannot verify now): keep everything, retry later. */
  | { kind: 'unreachable'; reason: 'transport' | 'unconfirmed' | 'unverifiable_now' | 'unrecognized_response' }
  /** The server said it did NOT author this close, or its answer cannot be trusted: keep everything, manual attention. */
  | { kind: 'manual_attention'; reason: 'refused' | 'malformed_success' | 'not_a_replay' | 'differs_from_doc'; code?: AuthoritativeRefusalCode };

/**
 * Packet 015 — THE proof that a closed `shifts` document is the work of
 * `closeShiftAuthoritative` (so of a `shiftCloseAuthorityRecords` document whose
 * request digest matches). While direct client W3 exists, a shift doc alone —
 * even one with the right UUID, device and amounts — proves nothing.
 *
 * Call ONLY after an independent authoritative read showed the shift CLOSED by
 * this very UUID (`closedDoc` = that read, strictly parsed): the callable then
 * takes its idempotency path and never writes. The request is the attempt's
 * immutable stored request + UUID. The answer must be a well-formed `ok: true`
 * for this shift and UUID that is a REPLAY (`idempotentReplay: true` — the doc
 * was already closed), and its server-built snapshot and close time must equal
 * the independently read doc. `closed_outside_authority`, `idempotency_conflict`,
 * `close_record_inconsistent`, any other refusal, a malformed success, a
 * timeout or an unknown answer are never proof.
 */
export async function proveServerAuthoredClose(input: {
  callable: CloseShiftAuthoritativeCallable;
  request: Record<string, unknown>;
  closedDoc: { snapshot: ShiftCloseIntentBusinessSnapshot; closedAtMillis: number };
}): Promise<ServerAuthoredCloseProof> {
  const outcome = await invokeCloseShiftAuthoritative(input.callable, input.request);
  switch (outcome.kind) {
    case 'unknown':
      return { kind: 'unreachable', reason: outcome.cause === 'transport' ? 'transport' : 'unrecognized_response' };
    case 'committed_unconfirmed':
      return { kind: 'unreachable', reason: 'unconfirmed' };
    case 'refused':
      return REPLAY_RETRYABLE_REFUSALS.has(outcome.code)
        ? { kind: 'unreachable', reason: 'unverifiable_now' }
        : { kind: 'manual_attention', reason: 'refused', code: outcome.code };
    case 'malformed_success':
      return { kind: 'manual_attention', reason: 'malformed_success' };
    case 'committed': {
      const { success } = outcome;
      if (!success.idempotentReplay) return { kind: 'manual_attention', reason: 'not_a_replay' };
      if (!sameSnapshot(success.snapshot, input.closedDoc.snapshot) || success.closedAtMillis !== input.closedDoc.closedAtMillis) {
        return { kind: 'manual_attention', reason: 'differs_from_doc' };
      }
      return {
        kind: 'proven',
        proof: authoritativeServerProof(success, input.request.shiftId as string, input.request.closeCorrelationId as string),
      };
    }
  }
}

/** The (non-persisted) proof object a validated success yields; the store re-checks it against the attempt and the snapshot. */
export function authoritativeServerProof(
  success: AuthoritativeCloseSuccess,
  shiftId: string,
  closeCorrelationId: string,
): AuthoritativeServerProof {
  return { protocol: 'server_authoritative_v1', shiftId, closeCorrelationId, closedAtMillis: success.closedAtMillis, snapshot: success.snapshot };
}

// ── Packet 015 · F5: the persisted binding, validated against the exact contract ──

const BINDING_REQUEST_KEYS = ['contractVersion', 'shiftId', 'actualCashCount', 'note', 'attestedSales', 'deviceId'] as const;
const BINDING_SALES_KEYS = ['expectedCash', 'expectedQr', 'expectedKbank', 'expectedCard', 'expectedCredit', 'totalBills'] as const;
const BINDING_SNAPSHOT_KEYS: readonly string[] = [...SNAPSHOT_STRING_FIELDS, ...SNAPSHOT_NUMBER_FIELDS];

function hasExactKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(v);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
}

/**
 * Packet 015 — strict structural + numeric validation of a persisted
 * server-authoritative binding (`{ protocol, request, expected }`) of the
 * attempt `attempt` (journal read / prepare boundary):
 *   - the exact key sets of binding, request, `attestedSales` and the 17
 *     `expected` business fields (no extra / missing key);
 *   - the contract-v1 request: `contractVersion 1`, the attempt's shift and
 *     device id (bounded, untrimmed), a note ≤ 1000, a canonical-satang count
 *     and attested money, an integer `totalBills` in 0 … 100,000;
 *   - `expected` = the attempt's identity + the request's cashier / attested
 *     fields, with canonical-satang startingCash / payIn / payOut and a
 *     `variance` that is exactly `actualCashCount − (startingCash +
 *     expectedCash + payInTotal − payOutTotal)` (the expression the server
 *     stores and `parseCommittedOwnClose` re-checks).
 * Local integrity only — NOT a substitute for the server proof.
 */
export function isStrictAuthoritativeBinding(b: unknown, attempt: Readonly<Record<string, unknown>>): boolean {
  if (!isPlainObject(b) || !hasExactKeys(b, ['protocol', 'request', 'expected']) || b.protocol !== 'server_authoritative_v1') return false;
  const { request: req, expected: exp } = b;
  if (!isPlainObject(req) || !hasExactKeys(req, BINDING_REQUEST_KEYS) || req.contractVersion !== 1) return false;
  const sales = req.attestedSales;
  if (!isPlainObject(sales) || !hasExactKeys(sales, BINDING_SALES_KEYS)) return false;
  if (typeof req.shiftId !== 'string' || !SHIFT_ID_RE.test(req.shiftId) || req.shiftId !== req.shiftId.trim() || req.shiftId !== attempt.shiftId) {
    return false;
  }
  if (
    typeof req.deviceId !== 'string' ||
    req.deviceId.length === 0 ||
    req.deviceId.length > AUTHORITATIVE_DEVICE_ID_MAX ||
    req.deviceId !== req.deviceId.trim() ||
    req.deviceId !== attempt.deviceId
  ) {
    return false;
  }
  if (typeof req.note !== 'string' || req.note.length > AUTHORITATIVE_NOTE_MAX) return false;
  if (canonicalTotalMinor(req.actualCashCount) === null) return false;
  if (ATTESTED_FIELDS.some((f) => canonicalTotalMinor(sales[f]) === null)) return false;
  const bills = sales.totalBills;
  if (typeof bills !== 'number' || !Number.isSafeInteger(bills) || bills < 0 || bills > AUTHORITATIVE_MAX_TOTAL_BILLS) return false;

  if (!isPlainObject(exp) || !hasExactKeys(exp, BINDING_SNAPSHOT_KEYS)) return false;
  if (!SNAPSHOT_STRING_FIELDS.every((f) => typeof exp[f] === 'string')) return false;
  if (!SNAPSHOT_NUMBER_FIELDS.every((f) => typeof exp[f] === 'number' && Number.isFinite(exp[f]))) return false;
  if (typeof exp.deviceId !== 'string') return false;
  if (
    exp.shiftId !== attempt.shiftId ||
    exp.branchId !== attempt.branchId ||
    exp.staffId !== attempt.staffId ||
    exp.staffName !== attempt.staffName ||
    exp.deviceId !== attempt.deviceId
  ) {
    return false;
  }
  if (exp.actualCashCount !== req.actualCashCount || exp.note !== req.note || exp.totalBills !== bills) return false;
  if (ATTESTED_FIELDS.some((f) => exp[f] !== sales[f])) return false;
  const starting = exp.startingCash as number;
  const payIn = exp.payInTotal as number;
  const payOut = exp.payOutTotal as number;
  if (canonicalTotalMinor(starting) === null || canonicalTotalMinor(payIn) === null || canonicalTotalMinor(payOut) === null) return false;
  const variance = exp.variance as number;
  if (Math.abs(variance) > MAX_TOTAL_BAHT) return false;
  return variance === (req.actualCashCount as number) - (starting + (sales.expectedCash as number) + payIn - payOut);
}

// ── Packet 015 · F2: the operator-reviewed drawer ──

/** Freshness of the display's server cash refresh at the moment of Confirm. */
export type ReviewedDrawerRefresh = 'loaded' | 'pending' | 'unavailable';

/**
 * Packet 015 — an immutable witness of the drawer the cashier was SHOWN when
 * they pressed Confirm: the exact `displayShift` of the close modal (local
 * shift merged with the server cash refresh) and whether that refresh had
 * loaded. The ON close compares it with the freshly read authoritative cash
 * data BEFORE it prepares an attempt or calls the server.
 */
export type ReviewedDrawerWitness = Readonly<{
  shiftId: string;
  branchId: string;
  startingCash: number;
  cashEntries: ReadonlyArray<Readonly<{ id: string; type: 'pay_in' | 'pay_out'; amount: number }>>;
  payInTotal: number;
  payOutTotal: number;
  /** The "expected drawer" number the modal rendered: startingCash + expectedCash + payIn − payOut. */
  expectedDrawer: number;
  serverRefresh: ReviewedDrawerRefresh;
}>;

/** Freezes a witness from the displayed shift. Never reads the server; pure. */
export function buildReviewedDrawerWitness(displayShift: Shift, serverRefresh: ReviewedDrawerRefresh): ReviewedDrawerWitness {
  const entries = (Array.isArray(displayShift.cashEntries) ? displayShift.cashEntries : []).map((e) =>
    Object.freeze({ id: e.id, type: e.type, amount: e.amount }),
  );
  return Object.freeze({
    shiftId: displayShift.id,
    branchId: displayShift.branchId,
    startingCash: displayShift.startingCash,
    cashEntries: Object.freeze(entries),
    payInTotal: displayShift.payInTotal || 0,
    payOutTotal: displayShift.payOutTotal || 0,
    expectedDrawer:
      displayShift.startingCash + displayShift.expectedCash + (displayShift.payInTotal || 0) - (displayShift.payOutTotal || 0),
    serverRefresh,
  });
}

export type ReviewedDrawerCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'not_loaded' | 'identity' | 'starting_cash' | 'cash_entries' | 'drawer' };

/**
 * Compares the witness with the authoritative cash data the close will use
 * (`serverData` = the fresh shift read, `expected` = the close built from it).
 * Everything must agree exactly: identity, startingCash, every cash entry
 * (id, type, amount — none added, none missing), and the displayed drawer total
 * to the satang. A witness that is absent, malformed or taken before the
 * display's server refresh loaded is never accepted.
 */
export function checkReviewedDrawerWitness(
  witness: unknown,
  server: { shiftId: string; branchId: string; serverData: Record<string, unknown>; expected: ShiftCloseIntentBusinessSnapshot },
): ReviewedDrawerCheck {
  if (!isPlainObject(witness)) return { ok: false, reason: 'missing' };
  const w = witness;
  if (
    typeof w.shiftId !== 'string' ||
    typeof w.branchId !== 'string' ||
    typeof w.startingCash !== 'number' ||
    typeof w.expectedDrawer !== 'number' ||
    !Array.isArray(w.cashEntries)
  ) {
    return { ok: false, reason: 'missing' };
  }
  if (w.serverRefresh !== 'loaded') return { ok: false, reason: 'not_loaded' };
  if (w.shiftId !== server.shiftId || w.branchId !== server.branchId) return { ok: false, reason: 'identity' };
  if (w.startingCash !== server.serverData.startingCash) return { ok: false, reason: 'starting_cash' };
  const serverEntries = Array.isArray(server.serverData.cashEntries) ? (server.serverData.cashEntries as unknown[]) : [];
  if (w.cashEntries.length !== serverEntries.length) return { ok: false, reason: 'cash_entries' };
  const shown = new Map<string, { type: unknown; amount: unknown }>();
  for (const e of w.cashEntries as unknown[]) {
    if (!isPlainObject(e) || typeof e.id !== 'string' || shown.has(e.id)) return { ok: false, reason: 'cash_entries' };
    shown.set(e.id, { type: e.type, amount: e.amount });
  }
  for (const raw of serverEntries) {
    const e = raw as { id?: unknown; type?: unknown; amount?: unknown } | null;
    const seen = typeof e?.id === 'string' ? shown.get(e.id) : undefined;
    if (!seen || seen.type !== e?.type || seen.amount !== e?.amount) return { ok: false, reason: 'cash_entries' };
  }
  const x = server.expected;
  const serverDrawer = x.startingCash + x.expectedCash + x.payInTotal - x.payOutTotal;
  if (Math.round(w.expectedDrawer * 100) !== Math.round(serverDrawer * 100)) return { ok: false, reason: 'drawer' };
  return { ok: true };
}

/**
 * The refusal copy for a drawer the cashier did not review (changed, absent or
 * not yet refreshed). The call that throws it carries `cause.reviewRequired`
 * so the modal refreshes the display; the next Confirm is a new explicit act.
 */
export const CLOSE_SHIFT_AUTHORITATIVE_DISPLAY_CHANGED_MESSAGE =
  'ยอดเงินสดในลิ้นชักที่แสดงอยู่ไม่ตรงกับข้อมูลล่าสุดบนเซิร์ฟเวอร์ หรือยังโหลดยอดล่าสุดไม่เสร็จ (เช่น มีการคืนเงินสดหรือนำเงินเข้า/ออก) — ยังไม่ได้ปิดกะ ระบบกำลังอัปเดตยอดที่แสดงแล้ว กรุณาตรวจนับเงินสดแล้วกดยืนยันปิดกะอีกครั้ง';
/** A close journaled on this device by the legacy (direct-W3) protocol is never shown as a server-authoritative Z. */
export const CLOSE_SHIFT_AUTHORITATIVE_LEGACY_ENTRY_MESSAGE =
  'การปิดกะของกะนี้ที่บันทึกในเครื่องนี้ไม่ได้ผ่านการยืนยันจากเซิร์ฟเวอร์ (ปิดด้วยวิธีเดิม) — ระบบไม่แสดงรายงานปิดกะ (Z) และไม่ส่งการปิดกะซ้ำ กรุณาแจ้งผู้จัดการให้ตรวจสอบกะนี้';
