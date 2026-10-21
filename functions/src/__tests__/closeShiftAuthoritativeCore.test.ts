/**
 * closeShiftAuthoritativeCore — pure decision tests (packet 012).
 *
 * Provenance: GREEN-only design-acceptance tests of a NEW module (no
 * pre-change behavior exists to be RED against). They exercise the actual
 * core source and, for compatibility, the actual CLIENT strict parser /
 * snapshot equality / W4 decision and the actual P5 evidence-capture planner.
 */
import { describe, expect, test } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import {
  CLOSE_BUSINESS_SNAPSHOT_FIELDS,
  CLOSE_MAX_CASH_ENTRIES,
  CLOSE_MAX_REFUND_RECORDS,
  CLOSE_NOTE_MAX,
  buildAuthorityRecord,
  callerBranchEligible,
  canonicalResponseFromDurable,
  decideCaller,
  decideClosedShiftReplay,
  deriveCloseRequestDigest,
  foldShiftCashEntriesStrict,
  parseOpenShiftIdentity,
  planAuthoritativeClose,
  validateCloseShiftRequest,
  verifyRefundAudit,
  type OpenShiftView,
  type RawRecord,
  type ValidatedCloseRequest,
} from '../closeShiftAuthoritativeCore';
import { deriveCashRefundEntryId } from '../saleReturnCore';
import { planCapture } from '../shiftCloseEvidenceCaptureCore';
import { toNonNegativeTotalMinor, toPositiveEntryMinor } from '../shiftCloseValidationCore';
import {
  parseCommittedOwnClose,
  shiftCloseConfirmationDocFromData,
  shiftCloseNormalizationDecision,
} from '../../../src/lib/pos/offline/shiftCloseReconciler';
import { snapshotsEqual } from '../../../src/lib/pos/offline/shiftCloseIntentStore';

const UUID = '0f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7b';
const RID = 'a'.repeat(40);
const RFD = deriveCashRefundEntryId(RID);

function req(over: Record<string, unknown> = {}, sales: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    shiftId: 'SH1',
    closeCorrelationId: UUID,
    actualCashCount: 1419,
    note: '',
    attestedSales: { expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3, ...sales },
    deviceId: 'dev-1',
    ...over,
  };
}

function valid(over: Record<string, unknown> = {}, sales: Record<string, unknown> = {}): ValidatedCloseRequest {
  const r = validateCloseShiftRequest(req(over, sales));
  if (!r.ok) throw new Error(`fixture invalid: ${r.code}`);
  return r.value;
}

const SHIFT: OpenShiftView = { shiftId: 'SH1', branchId: 'B1', staffId: 's1', staffName: 'Staff One', startingCash: 500, startingCashMinor: 50000 };

function refundEntry(amount = 81, id = RFD, type = 'pay_out'): Record<string, unknown> {
  return { id, type, amount, note: 'คืนเงินสด', staffId: 's1', staffName: 'Staff One', at: 1 };
}

function refundDoc(over: Record<string, unknown> = {}, id = RID): RawRecord {
  return {
    id,
    data: {
      schemaVersion: 1,
      refundId: id,
      returnId: id,
      method: 'cash',
      executionMode: 'cash_drawer',
      amount: 81,
      shiftId: 'SH1',
      branchId: 'B1',
      cashEntryId: deriveCashRefundEntryId(id),
      requesterStaffId: 's1',
      ...over,
    },
  };
}

function returnDoc(over: Record<string, unknown> = {}, refundOver: Record<string, unknown> = {}, id = RID): RawRecord {
  return {
    id,
    data: {
      schemaVersion: 1,
      returnId: id,
      status: 'completed',
      branchId: 'B1',
      requesterStaffId: 's1',
      refund: { refundId: id, method: 'cash', amount: 81, shiftId: 'SH1', cashEntryId: deriveCashRefundEntryId(id), ...refundOver },
      ...over,
    },
  };
}

function fold(entries: unknown, present = true) {
  const r = foldShiftCashEntriesStrict(entries, present);
  if (!r.ok) throw new Error(`fold refused: ${r.code}`);
  return r.value;
}

function audit(entries: unknown[], refunds: RawRecord[], returns: RawRecord[]) {
  const cash = foldShiftCashEntriesStrict(entries, true);
  if (!cash.ok) return cash;
  return verifyRefundAudit({ shift: SHIFT, refunds, returns, serverRefundEntries: cash.value.serverRefundEntries });
}

/** A resolved server Timestamp (what the Admin SDK reads back). */
function ts(ms: number) {
  return Timestamp.fromMillis(ms);
}

describe('request validation (strict contract)', () => {
  test('a well-formed request validates to integer satang', () => {
    const v = valid({ actualCashCount: 1419.25 }, { expectedQr: 0.1, totalBills: 0 });
    expect(v.actualCashCountMinor).toBe(141925);
    expect(v.attestedSales.expectedQrMinor).toBe(10);
    expect(v.attestedSales.totalBills).toBe(0);
  });

  test.each([
    ['client payOutTotal', { payOutTotal: 0 }],
    ['client payInTotal', { payInTotal: 0 }],
    ['client variance', { variance: 0 }],
    ['client startingCash', { startingCash: 500 }],
    ['client branchId', { branchId: 'B1' }],
    ['client staffId', { staffId: 's1' }],
    ['client role', { role: 'admin' }],
    ['client buildId', { buildId: 'rel-0.1.12' }],
  ])('an unexpected key (%s) is rejected', (_name, extra) => {
    expect(validateCloseShiftRequest(req(extra))).toEqual({ ok: false, code: 'invalid_request' });
  });

  test.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['string', '1419'],
    ['negative', -1],
    ['fractional satang', 0.001],
    ['over the aggregate envelope', 10_000_000_000.01],
    ['null', null],
    ['boolean', true],
  ])('actualCashCount %s is rejected', (_name, value) => {
    expect(validateCloseShiftRequest(req({ actualCashCount: value })).ok).toBe(false);
  });

  test.each([
    ['NaN', { expectedCash: NaN }],
    ['negative', { expectedQr: -0.01 }],
    ['fractional satang', { expectedCard: 1.005 }],
    ['string', { expectedKbank: '1' }],
    ['overflow', { expectedCredit: 1e11 }],
    ['fractional bills', { totalBills: 1.5 }],
    ['negative bills', { totalBills: -1 }],
    ['too many bills', { totalBills: 100_001 }],
    ['unsafe bills', { totalBills: Number.MAX_SAFE_INTEGER + 2 }],
    ['extra sales key', { payOutTotal: 0 }],
  ])('attestedSales %s is rejected', (_name, sales) => {
    expect(validateCloseShiftRequest(req({}, sales)).ok).toBe(false);
  });

  test.each([
    ['uppercase UUID', { closeCorrelationId: UUID.toUpperCase() }],
    ['v1 UUID', { closeCorrelationId: '0f8c2a4e-5b6d-1c3e-9a1b-2c3d4e5f6a7b' }],
    ['blank UUID', { closeCorrelationId: '' }],
    ['null UUID', { closeCorrelationId: null }],
    ['shiftId with slash', { shiftId: 'a/b' }],
    ['padded shiftId', { shiftId: ' SH1' }],
    ['empty shiftId', { shiftId: '' }],
    ['non-string note', { note: 5 }],
    ['oversized note', { note: 'x'.repeat(CLOSE_NOTE_MAX + 1) }],
    ['empty deviceId', { deviceId: '' }],
    ['padded deviceId', { deviceId: ' dev' }],
    ['oversized deviceId', { deviceId: 'd'.repeat(201) }],
    ['wrong contract version', { contractVersion: 2 }],
    ['array attestedSales', { attestedSales: [] }],
  ])('%s is rejected', (_name, over) => {
    expect(validateCloseShiftRequest(req(over)).ok).toBe(false);
  });

  test('non-object / missing-key requests are rejected', () => {
    expect(validateCloseShiftRequest(null).ok).toBe(false);
    expect(validateCloseShiftRequest([]).ok).toBe(false);
    const missing = req();
    delete missing.note;
    expect(validateCloseShiftRequest(missing).ok).toBe(false);
  });

  test('the request digest binds every field, including the informational deviceId', () => {
    const base = deriveCloseRequestDigest(valid());
    expect(deriveCloseRequestDigest(valid())).toBe(base);
    expect(deriveCloseRequestDigest(valid({ deviceId: 'dev-2' }))).not.toBe(base);
    expect(deriveCloseRequestDigest(valid({ actualCashCount: 1418 }))).not.toBe(base);
    expect(deriveCloseRequestDigest(valid({}, { totalBills: 4 }))).not.toBe(base);
  });
});

describe('caller authority (live user doc)', () => {
  const live = { isActive: true, deletedAt: null, authVersion: 3, role: 'staff', branchIds: ['B1'] };
  test('active, fresh, operator role ⇒ ok', () => {
    expect(decideCaller(live, 3)).toEqual({ ok: true, role: 'staff' });
  });
  test.each([
    ['missing doc', null, 3, 'not_authorized'],
    ['inactive', { ...live, isActive: false }, 3, 'not_authorized'],
    ['deleted', { ...live, deletedAt: 1 }, 3, 'not_authorized'],
    ['stale authVersion', live, 2, 'session_stale'],
    ['token without authVersion vs live 0', { ...live, authVersion: undefined }, -1, 'session_stale'],
    ['unknown role', { ...live, role: 'owner' }, 3, 'not_authorized'],
  ])('%s ⇒ refused', (_n, user, tokenVersion, code) => {
    expect(decideCaller(user as Record<string, unknown> | null, tokenVersion as number)).toEqual({ ok: false, code });
  });
  test('branch: staff/manager exact; admin exact or ALL; revoked branch refused', () => {
    expect(callerBranchEligible('staff', live, 'B1')).toBe(true);
    expect(callerBranchEligible('staff', { ...live, branchIds: ['B2'] }, 'B1')).toBe(false);
    expect(callerBranchEligible('staff', { ...live, branchIds: ['ALL'] }, 'B1')).toBe(false);
    expect(callerBranchEligible('manager', { ...live, branchIds: [] }, 'B1')).toBe(false);
    expect(callerBranchEligible('admin', { ...live, branchIds: ['ALL'] }, 'B1')).toBe(true);
    expect(callerBranchEligible('admin', { ...live, branchIds: 'B1' }, 'B1')).toBe(false);
  });
});

describe('open-shift identity', () => {
  const base = { id: 'SH1', branchId: 'B1', staffId: 's1', staffName: 'S', openedAt: ts(1), startingCash: 500 };
  test('a W0 shift parses', () => {
    expect(parseOpenShiftIdentity('SH1', base)).toMatchObject({ ok: true, value: { startingCashMinor: 50000 } });
  });
  test.each([
    ['id mismatch', { id: 'SH2' }],
    ['branch ALL', { branchId: 'ALL' }],
    ['blank staff', { staffId: '' }],
    ['no staffName', { staffName: 5 }],
    ['no openedAt', { openedAt: null }],
    ['NaN startingCash', { startingCash: NaN }],
    ['fractional-satang startingCash', { startingCash: 0.001 }],
    ['string startingCash', { startingCash: '500' }],
  ])('%s ⇒ shift_record_invalid', (_n, over) => {
    expect(parseOpenShiftIdentity('SH1', { ...base, ...over })).toEqual({ ok: false, code: 'shift_record_invalid' });
  });
});

describe('strict cash-entry fold (integer satang)', () => {
  test('absent list = empty; sums are exact integers even for float-noisy decimals', () => {
    expect(fold(undefined, false)).toMatchObject({ entryCount: 0, payInMinor: 0, payOutMinor: 0 });
    const f = fold([
      { id: 'c1', type: 'pay_in', amount: 0.1 },
      { id: 'c2', type: 'pay_in', amount: 0.2 },
      refundEntry(81),
      { id: 'c3', type: 'pay_out', amount: 19.99 },
    ]);
    expect(f.payInMinor).toBe(30);
    expect(f.payOutMinor).toBe(8100 + 1999);
    expect(f.manualPayInMinor).toBe(30);
    expect(f.manualPayOutMinor).toBe(1999);
    expect(f.manualEntryCount).toBe(3);
    expect([...f.serverRefundEntries]).toEqual([[RFD, { type: 'pay_out', minor: 8100 }]]);
  });

  test('a case/lookalike variant is NOT a server refund id (exact, case-sensitive prefix)', () => {
    const f = fold([{ id: 'RFD_x', type: 'pay_out', amount: 1 }, { id: 'xrfd_y', type: 'pay_out', amount: 1 }]);
    expect(f.serverRefundEntries.size).toBe(0);
    expect(f.manualEntryCount).toBe(2);
  });

  test.each([
    ['null list', null, 'cash_entries_invalid'],
    ['string list', 'x', 'cash_entries_invalid'],
    ['map list', { 0: {} }, 'cash_entries_invalid'],
    ['null entry', [null], 'cash_entries_invalid'],
    ['array entry', [[]], 'cash_entries_invalid'],
    ['missing id', [{ type: 'pay_in', amount: 1 }], 'cash_entries_invalid'],
    ['blank id', [{ id: '', type: 'pay_in', amount: 1 }], 'cash_entries_invalid'],
    ['numeric id', [{ id: 7, type: 'pay_in', amount: 1 }], 'cash_entries_invalid'],
    ['unknown type', [{ id: 'c', type: 'adjust', amount: 1 }], 'cash_entries_invalid'],
    ['NaN amount', [{ id: 'c', type: 'pay_in', amount: NaN }], 'cash_entries_invalid'],
    ['Infinity amount', [{ id: 'c', type: 'pay_in', amount: Infinity }], 'cash_entries_invalid'],
    ['zero amount', [{ id: 'c', type: 'pay_in', amount: 0 }], 'cash_entries_invalid'],
    ['negative amount', [{ id: 'c', type: 'pay_out', amount: -5 }], 'cash_entries_invalid'],
    ['fractional satang', [{ id: 'c', type: 'pay_out', amount: 0.005 }], 'cash_entries_invalid'],
    ['string amount', [{ id: 'c', type: 'pay_out', amount: '5' }], 'cash_entries_invalid'],
    ['over the W1 entry bound', [{ id: 'c', type: 'pay_in', amount: 10_000_000.01 }], 'cash_entries_invalid'],
    ['duplicate ids', [{ id: 'c', type: 'pay_in', amount: 1 }, { id: 'c', type: 'pay_in', amount: 1 }], 'cash_entry_duplicate'],
    ['duplicate rfd_', [refundEntry(81), refundEntry(81)], 'cash_entry_duplicate'],
  ])('%s ⇒ %s', (_n, list, code) => {
    expect(foldShiftCashEntriesStrict(list, true)).toEqual({ ok: false, code });
  });

  test('a sparse hole is refused', () => {
    const sparse: unknown[] = [];
    sparse[1] = { id: 'c', type: 'pay_in', amount: 1 };
    expect(foldShiftCashEntriesStrict(sparse, true)).toEqual({ ok: false, code: 'cash_entries_invalid' });
  });

  test('a list over the cap is refused, never truncated (pathological lists)', () => {
    const list = Array.from({ length: CLOSE_MAX_CASH_ENTRIES + 1 }, (_, i) => ({ id: `c${i}`, type: 'pay_in', amount: 1 }));
    expect(foldShiftCashEntriesStrict(list, true)).toEqual({ ok: false, code: 'cash_entries_over_cap' });
    expect(fold(list.slice(0, CLOSE_MAX_CASH_ENTRIES)).payInMinor).toBe(100 * CLOSE_MAX_CASH_ENTRIES);
  });
});

describe('Return refund audit — saleRefunds ⇄ saleReturns ⇄ rfd_ entries', () => {
  test('an authentic 81 payout pairs with both server records', () => {
    expect(audit([refundEntry(81)], [refundDoc()], [returnDoc()])).toEqual({
      ok: true,
      value: { refundCount: 1, refundTotalMinor: 8100, returnIds: [RID] },
    });
  });

  test('no refunds and no rfd_ entries ⇒ empty, ok', () => {
    expect(audit([{ id: 'c1', type: 'pay_out', amount: 5 }], [], [])).toMatchObject({ ok: true, value: { refundCount: 0 } });
  });

  test.each([
    ['payout missing from the shift', [], [refundDoc()], [returnDoc()], 'refund_missing_in_shift'],
    ['wrong satang amount in the shift', [refundEntry(80.99)], [refundDoc()], [returnDoc()], 'refund_entry_mismatch'],
    ['rfd_ entry typed pay_in', [refundEntry(81, RFD, 'pay_in')], [refundDoc()], [returnDoc()], 'refund_entry_mismatch'],
    ['orphan fake rfd_ entry', [refundEntry(81), refundEntry(5, 'rfd_' + 'b'.repeat(40))], [refundDoc()], [returnDoc()], 'orphan_refund_entry'],
    ['rfd_ entry with no server refund at all', [refundEntry(81)], [], [], 'orphan_refund_entry'],
    ['refund without its Return record', [refundEntry(81)], [refundDoc()], [], 'refund_return_mismatch'],
    ['Return without its refund record', [refundEntry(81)], [], [returnDoc()], 'refund_return_mismatch'],
    ['refund vs Return amount mismatch', [refundEntry(81)], [refundDoc()], [returnDoc({}, { amount: 80 })], 'refund_return_mismatch'],
    ['refund on another branch', [refundEntry(81)], [refundDoc({ branchId: 'B2' })], [returnDoc()], 'refund_record_invalid'],
    ['refund for another shift', [refundEntry(81)], [refundDoc({ shiftId: 'SH9' })], [returnDoc()], 'refund_record_invalid'],
    ['refund by another staff', [refundEntry(81)], [refundDoc({ requesterStaffId: 's2' })], [returnDoc()], 'refund_record_invalid'],
    ['non-cash refund bound to the shift', [refundEntry(81)], [refundDoc({ method: 'qr' })], [returnDoc()], 'refund_record_invalid'],
    ['refund with a foreign cashEntryId', [refundEntry(81)], [refundDoc({ cashEntryId: 'rfd_x' })], [returnDoc()], 'refund_record_invalid'],
    ['refund fractional amount', [refundEntry(81)], [refundDoc({ amount: 81.001 })], [returnDoc()], 'refund_record_invalid'],
    ['refund unknown schema', [refundEntry(81)], [refundDoc({ schemaVersion: 2 })], [returnDoc()], 'refund_record_invalid'],
    ['Return not completed', [refundEntry(81)], [refundDoc()], [returnDoc({ status: 'pending' })], 'refund_record_invalid'],
    ['Return on another branch', [refundEntry(81)], [refundDoc()], [returnDoc({ branchId: 'B2' })], 'refund_record_invalid'],
    ['Return refund method not cash', [refundEntry(81)], [refundDoc()], [returnDoc({}, { method: 'card' })], 'refund_record_invalid'],
    ['Return refund missing', [refundEntry(81)], [refundDoc()], [returnDoc({ refund: null })], 'refund_record_invalid'],
    ['duplicate refund records (same id twice)', [refundEntry(81)], [refundDoc(), refundDoc()], [returnDoc()], 'refund_record_invalid'],
  ])('%s ⇒ %s', (_n, entries, refunds, returns, code) => {
    expect(audit(entries as unknown[], refunds as RawRecord[], returns as RawRecord[])).toEqual({ ok: false, code });
  });

  test('a refund set beyond the read cap fails closed (never a partial set)', () => {
    const many = Array.from({ length: CLOSE_MAX_REFUND_RECORDS + 1 }, (_, i) => refundDoc({}, String(i).padStart(40, '0')));
    expect(audit([], many, [])).toEqual({ ok: false, code: 'refund_set_over_cap' });
  });
});

describe('W3 plan — server-recomputed money, client-identical stored variance', () => {
  test('honest close: 500 + 1000 − Return 81 = 1419; count 1419 ⇒ variance 0', () => {
    const cash = fold([refundEntry(81)]);
    const plan = planAuthoritativeClose({ shift: SHIFT, request: valid(), cash });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.money).toMatchObject({ expectedDrawerMinor: 141900, payOutMinor: 8100, payInMinor: 0, varianceMinor: 0 });
    expect(plan.value.snapshot).toMatchObject({ payOutTotal: 81, payInTotal: 0, expectedCash: 1000, variance: 0, actualCashCount: 1419 });
  });

  test('a shortage stays visible (count 1319 ⇒ −100), whatever the client believes', () => {
    const plan = planAuthoritativeClose({ shift: SHIFT, request: valid({ actualCashCount: 1319 }), cash: fold([refundEntry(81)]) });
    expect(plan.ok && plan.value.money.varianceMinor).toBe(-10000);
    expect(plan.ok && plan.value.snapshot.variance).toBe(-100);
  });

  test('W3 field set = the client closeWritePayload / Rules isW3ShiftClose affected keys (minus closedAt)', () => {
    const plan = planAuthoritativeClose({ shift: SHIFT, request: valid(), cash: fold([]) });
    expect(plan.ok && Object.keys(plan.value.w3Fields).sort()).toEqual(
      [
        'status', 'actualCashCount', 'variance', 'note', 'expectedCash', 'expectedQr', 'expectedKbank', 'expectedCard',
        'expectedCredit', 'totalBills', 'payInTotal', 'payOutTotal', 'closedOffline', 'syncState', 'deviceId', 'closeCorrelationId',
      ].sort(),
    );
    expect(plan.ok && plan.value.w3Fields).toMatchObject({ status: 'closed', closedOffline: true, syncState: 'pending' });
  });

  test('float-noisy decimals: stored variance satisfies the client strict identity bit-for-bit', () => {
    const shift = { ...SHIFT, startingCash: 0.1, startingCashMinor: 10 };
    const request = valid({ actualCashCount: 0.3 }, { expectedCash: 0.2 });
    const plan = planAuthoritativeClose({ shift, request, cash: fold([]) });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const s = plan.value.snapshot;
    expect(plan.value.money.varianceMinor).toBe(0);
    expect(s.variance).toBe(s.actualCashCount - (s.startingCash + s.expectedCash + s.payInTotal - s.payOutTotal));
  });

  test('out-of-envelope aggregates are refused', () => {
    const big = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, type: 'pay_out', amount: 10_000_000 }));
    const cash = fold(big);
    const r = planAuthoritativeClose({ shift: SHIFT, request: valid({ actualCashCount: 10_000_000_000 }), cash });
    expect(r).toEqual({ ok: false, code: 'amount_out_of_bounds' });
  });
});

function durablePair(over: { shift?: Record<string, unknown>; record?: Record<string, unknown> } = {}) {
  const request = valid();
  const cash = fold([refundEntry(81)]);
  const plan = planAuthoritativeClose({ shift: SHIFT, request, cash });
  if (!plan.ok) throw new Error('plan');
  const auditR = verifyRefundAudit({ shift: SHIFT, refunds: [refundDoc()], returns: [returnDoc()], serverRefundEntries: cash.serverRefundEntries });
  if (!auditR.ok) throw new Error('audit');
  const digest = deriveCloseRequestDigest(request);
  const record = {
    ...buildAuthorityRecord({ request, requestDigest: digest, plan: plan.value, cash, audit: auditR.value, callerStaffId: 's1', nowMillis: 7 }),
    closedAt: ts(1_700_000_000_000),
    ...over.record,
  } as Record<string, unknown>;
  const shiftData = {
    id: 'SH1',
    openedAt: ts(1),
    closedAt: ts(1_700_000_000_000),
    cashEntries: [refundEntry(81)],
    ...plan.value.snapshot,
    ...plan.value.w3Fields,
    ...over.shift,
  } as Record<string, unknown>;
  delete shiftData.shiftId;
  return { request, digest, record, shiftData, plan: plan.value };
}

describe('canonical response, replay and idempotency (no writes)', () => {
  test('same UUID + same content ⇒ the durable canonical response (replay)', () => {
    const { request, digest, record, shiftData, plan } = durablePair();
    const r = decideClosedShiftReplay({ shiftData, record, request, requestDigest: digest });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.idempotentReplay).toBe(true);
    expect(r.snapshot).toEqual(plan.snapshot);
    expect(r.closedAtMillis).toBe(1_700_000_000_000);
    expect(r.provenance).toEqual({
      cashMovements: 'server_recomputed',
      returnRefunds: { status: 'server_audit_matched', count: 1, totalMinor: 8100 },
      manualCashEntries: { status: 'shift_recorded_unattested', count: 0, payInMinor: 0, payOutMinor: 0 },
      salesTotals: { status: 'attested_unverified', reason: 'sale_sync_completeness_not_provable' },
      clientJournal: 'not_finalized_by_server',
    });
  });

  test('W4 (pending → synced) does not change the canonical response', () => {
    const { request, digest, record, shiftData } = durablePair();
    const a = decideClosedShiftReplay({ shiftData, record, request, requestDigest: digest });
    const b = decideClosedShiftReplay({ shiftData: { ...shiftData, syncState: 'synced' }, record, request, requestDigest: digest });
    expect(b).toEqual(a);
    expect(a.ok && a.persistedClose.syncStateAtClose).toBe('pending');
  });

  test('different UUID ⇒ already_closed; same UUID other content ⇒ idempotency_conflict', () => {
    const { record, shiftData } = durablePair();
    const other = valid({ closeCorrelationId: '1f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7b' });
    expect(decideClosedShiftReplay({ shiftData, record, request: other, requestDigest: deriveCloseRequestDigest(other) })).toEqual({
      ok: false,
      code: 'already_closed',
    });
    const changed = valid({ actualCashCount: 1500 });
    expect(decideClosedShiftReplay({ shiftData, record, request: changed, requestDigest: deriveCloseRequestDigest(changed) })).toEqual({
      ok: false,
      code: 'idempotency_conflict',
    });
    const otherDevice = valid({ deviceId: 'dev-2' });
    expect(
      decideClosedShiftReplay({ shiftData, record, request: otherDevice, requestDigest: deriveCloseRequestDigest(otherDevice) }),
    ).toEqual({ ok: false, code: 'idempotency_conflict' });
  });

  test('closed by a direct client W3 with this UUID (no authority record) ⇒ closed_outside_authority, never success', () => {
    const { request, digest, shiftData } = durablePair();
    expect(decideClosedShiftReplay({ shiftData, record: null, request, requestDigest: digest })).toEqual({
      ok: false,
      code: 'closed_outside_authority',
    });
  });

  test.each([
    ['shift totals drifted from the record', { shift: { payOutTotal: 0 } }],
    ['shift variance drifted', { shift: { variance: 81 } }],
    ['closedAt differs', { shift: { closedAt: ts(2) } }],
    ['closedAt unresolved', { shift: { closedAt: null } }],
    ['syncState malformed', { shift: { syncState: 'weird' } }],
    ['record snapshot drifted', { record: { snapshot: { shiftId: 'SH1' } } }],
    ['record money malformed', { record: { money: { varianceMinor: 0.5 } } }],
    ['unknown record schema', { record: { schemaVersion: 9 } }],
  ])('%s ⇒ close_record_inconsistent', (_n, over) => {
    const { request, digest, record, shiftData } = durablePair(over);
    expect(decideClosedShiftReplay({ shiftData, record, request, requestDigest: digest })).toEqual({
      ok: false,
      code: 'close_record_inconsistent',
    });
  });

  test('canonicalResponseFromDurable never reports success for an open shift', () => {
    const { record, shiftData } = durablePair({ shift: { status: 'open' } });
    expect(canonicalResponseFromDurable({ shiftData, record, idempotentReplay: false })).toEqual({
      ok: false,
      code: 'close_record_inconsistent',
    });
  });
});

describe('client / P5 compatibility (actual client parser, snapshot equality, W4 decision, capture planner)', () => {
  test('the persisted close passes parseCommittedOwnClose and equals the response snapshot (17 fields)', () => {
    const { request, digest, record, shiftData } = durablePair();
    const response = decideClosedShiftReplay({ shiftData, record, request, requestDigest: digest });
    if (!response.ok) throw new Error(response.code);
    const parsed = parseCommittedOwnClose(
      { shiftId: 'SH1', branchId: 'B1', staffId: 's1', staffName: 'Staff One', deviceId: 'dev-1', closeCorrelationId: UUID },
      shiftCloseConfirmationDocFromData(shiftData),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(CLOSE_BUSINESS_SNAPSHOT_FIELDS).toHaveLength(17);
    expect(snapshotsEqual(parsed.snapshot, response.snapshot)).toBe(true);
    expect(parsed.closedAt.getTime()).toBe(response.closedAtMillis);
  });

  test('the client strict parser accepts the float-noisy close too', () => {
    const shift = { ...SHIFT, startingCash: 0.1, startingCashMinor: 10 };
    const request = valid({ actualCashCount: 0.3 }, { expectedCash: 0.2 });
    const plan = planAuthoritativeClose({ shift, request, cash: fold([]) });
    if (!plan.ok) throw new Error(plan.code);
    const doc = { ...plan.value.snapshot, ...plan.value.w3Fields, closedAt: ts(5) };
    const parsed = parseCommittedOwnClose(
      { shiftId: 'SH1', branchId: 'B1', staffId: 's1', staffName: 'Staff One', deviceId: 'dev-1', closeCorrelationId: UUID },
      shiftCloseConfirmationDocFromData(doc),
    );
    expect(parsed.ok).toBe(true);
  });

  test('a follow-on W4 is possible exactly once (client decision function)', () => {
    const { shiftData } = durablePair();
    expect(shiftCloseNormalizationDecision(shiftData, { closeCorrelationId: UUID, deviceId: 'dev-1' })).toBe('write');
    expect(shiftCloseNormalizationDecision({ ...shiftData, syncState: 'synced' }, { closeCorrelationId: UUID, deviceId: 'dev-1' })).toBe(
      'already_synced',
    );
  });

  test('P5 evidence capture plans a capture for the callable W3 (not a structural refusal)', () => {
    const { shiftData } = durablePair();
    const before: Record<string, unknown> = { ...shiftData, status: 'open', closedAt: null };
    delete before.syncState;
    delete before.closedOffline;
    delete before.closeCorrelationId;
    const plan = planCapture({ shiftId: 'SH1', before, after: shiftData, eventTimeIso: new Date(1_700_000_000_000).toISOString() });
    expect(plan.kind).toBe('capture');
  });
});

// ---------------------------------------------------------------------------
// Packet 013 — Codex-012 F1: satang-EXACT money, no sub-satang normalization.
// Behavioral RED on cbd4ce0 (the shared P5 converters' 1e-6 epsilon on
// amount × 100 accepted and rounded these values); GREEN once every money
// value must BE the canonical JS number `minor / 100` of its satang count.
// ---------------------------------------------------------------------------

/** The adjacent IEEE-754 double above (dir 1) / below (dir −1) a positive finite x. */
function adjacentDouble(x: number, dir: 1 | -1): number {
  const f = new Float64Array([x]);
  const bits = new BigInt64Array(f.buffer);
  bits[0] = bits[0]! + BigInt(dir);
  return f[0]!;
}

/** 0.010000001 × 100 = 1.0000001 — inside the P5 epsilon, so it used to be stored as 0.01. */
const OFF_CENT = 0.010000001;
/** 81.000000001 × 100 = 8100.0000001 — used to fold / pair as exactly 8100 satang. */
const OFF_81 = 81.000000001;

describe('013 — strict satang exactness (Codex-012 F1)', () => {
  const W0 = { id: 'SH1', branchId: 'B1', staffId: 's1', staffName: 'S', openedAt: ts(1), startingCash: 500 };

  test('premise: the shared P5 converters are unchanged and still epsilon-tolerant (their callers keep P5 semantics)', () => {
    expect(OFF_CENT).not.toBe(0.01);
    expect(OFF_81).not.toBe(81);
    expect(toNonNegativeTotalMinor(OFF_CENT)).toEqual({ ok: true, minor: 1 });
    expect(toPositiveEntryMinor(OFF_81)).toEqual({ ok: true, minor: 8100 });
    expect(toNonNegativeTotalMinor(0.001)).toEqual({ ok: false, reason: 'total_precision' });
  });

  // ── 4A · request money ────────────────────────────────────────────────
  test.each([
    ['actualCashCount 0.010000001', { actualCashCount: OFF_CENT }, {}],
    ['actualCashCount one ulp above 0.01', { actualCashCount: adjacentDouble(0.01, 1) }, {}],
    ['actualCashCount one ulp below 1419', { actualCashCount: adjacentDouble(1419, -1) }, {}],
    ['actualCashCount float sum 0.1 + 0.2 (≠ canonical 0.3)', { actualCashCount: 0.1 + 0.2 }, {}],
    ['expectedCash 81.000000001', {}, { expectedCash: OFF_81 }],
    ['expectedQr 0.100000001', {}, { expectedQr: 0.100000001 }],
    ['expectedKbank 1000.000000001', {}, { expectedKbank: 1000.000000001 }],
    ['expectedCard one ulp above 19.99', {}, { expectedCard: adjacentDouble(19.99, 1) }],
    ['expectedCredit 0.009999999', {}, { expectedCredit: 0.009999999 }],
  ])('request %s ⇒ invalid_request (never silently rounded to a satang)', (_n, over, sales) => {
    expect(validateCloseShiftRequest(req(over, sales))).toEqual({ ok: false, code: 'invalid_request' });
  });

  test.each([
    [0, 0],
    [0.01, 1],
    [0.1, 10],
    [0.3, 30],
    [19.99, 1999],
    [81, 8100],
    [1419.25, 141925],
    [9_999_999_999.99, 999_999_999_999],
    [10_000_000_000, 1_000_000_000_000],
  ])('canonical %s stays accepted in every request money field (= %s satang)', (x, minor) => {
    const r = validateCloseShiftRequest(
      req({ actualCashCount: x }, { expectedCash: x, expectedQr: x, expectedKbank: x, expectedCard: x, expectedCredit: x }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.actualCashCountMinor).toBe(minor);
    expect(r.value.attestedSales).toEqual({
      expectedCashMinor: minor,
      expectedQrMinor: minor,
      expectedKbankMinor: minor,
      expectedCardMinor: minor,
      expectedCreditMinor: minor,
      totalBills: 3,
    });
  });

  test('bounds/shape refusals are unchanged at the edges (one ulp over the envelope, NaN, string, negative)', () => {
    for (const bad of [adjacentDouble(10_000_000_000, 1), NaN, Infinity, '0.01', -0.01, null]) {
      expect(validateCloseShiftRequest(req({ actualCashCount: bad }))).toEqual({ ok: false, code: 'invalid_request' });
      expect(validateCloseShiftRequest(req({}, { expectedCredit: bad }))).toEqual({ ok: false, code: 'invalid_request' });
    }
  });

  test('-0 keeps its pre-existing meaning: 0 for non-negative totals, refused as a movement/refund', () => {
    expect(validateCloseShiftRequest(req({ actualCashCount: -0 }, { expectedQr: -0 }))).toMatchObject({
      ok: true,
      value: { actualCashCountMinor: 0, attestedSales: { expectedQrMinor: 0 } },
    });
    expect(parseOpenShiftIdentity('SH1', { ...W0, startingCash: -0 })).toMatchObject({ ok: true, value: { startingCashMinor: 0 } });
    expect(foldShiftCashEntriesStrict([{ id: 'c', type: 'pay_in', amount: -0 }], true)).toEqual({ ok: false, code: 'cash_entries_invalid' });
    expect(audit([refundEntry(81)], [refundDoc({ amount: -0 })], [returnDoc()])).toEqual({ ok: false, code: 'refund_record_invalid' });
  });

  // ── 4B · stored W0 startingCash ───────────────────────────────────────
  test.each([
    ['0.010000001', OFF_CENT],
    ['500.000000001', 500.000000001],
    ['one ulp below 500', adjacentDouble(500, -1)],
  ])('stored W0 startingCash %s ⇒ shift_record_invalid (never re-based to a satang)', (_n, startingCash) => {
    expect(parseOpenShiftIdentity('SH1', { ...W0, startingCash })).toEqual({ ok: false, code: 'shift_record_invalid' });
  });

  test.each([
    [0, 0],
    [0.01, 1],
    [0.1, 10],
    [500, 50000],
    [9_999_999_999.99, 999_999_999_999],
  ])('canonical stored startingCash %s parses (= %s satang), value kept as stored', (startingCash, minor) => {
    expect(parseOpenShiftIdentity('SH1', { ...W0, startingCash })).toEqual({
      ok: true,
      value: { shiftId: 'SH1', branchId: 'B1', staffId: 's1', staffName: 'S', startingCash, startingCashMinor: minor },
    });
  });

  // ── 4C · shift cash movements ─────────────────────────────────────────
  test.each([
    ['manual pay_out 81.000000001', [{ id: 'c1', type: 'pay_out', amount: OFF_81 }]],
    ['manual pay_in 0.010000001', [{ id: 'c1', type: 'pay_in', amount: OFF_CENT }]],
    ['manual pay_in one ulp below 0.3', [{ id: 'c1', type: 'pay_in', amount: adjacentDouble(0.3, -1) }]],
    ['manual pay_in float sum 0.1 + 0.2', [{ id: 'c1', type: 'pay_in', amount: 0.1 + 0.2 }]],
    ['server rfd_ payout 81.000000001', [refundEntry(OFF_81)]],
    [
      'an off-cent entry after canonical ones',
      [
        { id: 'c1', type: 'pay_in', amount: 0.1 },
        { id: 'c2', type: 'pay_out', amount: 10 },
        { id: 'c3', type: 'pay_out', amount: OFF_81 },
      ],
    ],
  ])('cash entry %s ⇒ cash_entries_invalid (never folded as an exact satang)', (_n, entries) => {
    expect(foldShiftCashEntriesStrict(entries, true)).toEqual({ ok: false, code: 'cash_entries_invalid' });
  });

  test('canonical entries at the edges fold exactly (0.01, 0.1, 9,999,999.99, the ฿10,000,000 W1 bound)', () => {
    const f = fold([
      { id: 'c1', type: 'pay_in', amount: 0.01 },
      { id: 'c2', type: 'pay_in', amount: 0.1 },
      { id: 'c3', type: 'pay_out', amount: 9_999_999.99 },
      { id: 'c4', type: 'pay_out', amount: 10_000_000 },
    ]);
    expect(f).toMatchObject({ payInMinor: 11, payOutMinor: 999_999_999 + 1_000_000_000 });
  });

  // ── 4D/4E · refund authority ──────────────────────────────────────────
  test.each([
    ['saleRefunds.amount 81.000000001 vs Return 81 vs payout 81', [refundEntry(81)], [refundDoc({ amount: OFF_81 })], [returnDoc()], 'refund_record_invalid'],
    ['saleReturns.refund.amount 81.000000001 vs refund 81 vs payout 81', [refundEntry(81)], [refundDoc()], [returnDoc({}, { amount: OFF_81 })], 'refund_record_invalid'],
    [
      'refund 81.000000001 vs Return 80.999999999 (both Math.round(×100) = 8100)',
      [refundEntry(81)],
      [refundDoc({ amount: OFF_81 })],
      [returnDoc({}, { amount: 80.999999999 })],
      'refund_record_invalid',
    ],
    ['refund one ulp below 81 vs Return 81', [refundEntry(81)], [refundDoc({ amount: adjacentDouble(81, -1) })], [returnDoc()], 'refund_record_invalid'],
    [
      'all three consistently 81.000000001 (the payout itself is refused first)',
      [refundEntry(OFF_81)],
      [refundDoc({ amount: OFF_81 })],
      [returnDoc({}, { amount: OFF_81 })],
      'cash_entries_invalid',
    ],
  ])('%s ⇒ typed refusal, never "server_audit_matched"', (_n, entries, refunds, returns, code) => {
    expect(audit(entries as unknown[], refunds as RawRecord[], returns as RawRecord[])).toEqual({ ok: false, code });
  });

  test('canonical identical amounts across the distinct legitimate sources still pair (two Returns of 81, one of 0.01)', () => {
    const R2 = 'b'.repeat(40);
    const R3 = 'c'.repeat(40);
    expect(
      audit(
        [refundEntry(81), refundEntry(81, deriveCashRefundEntryId(R2)), refundEntry(0.01, deriveCashRefundEntryId(R3))],
        [refundDoc(), refundDoc({}, R2), refundDoc({ amount: 0.01 }, R3)],
        [returnDoc(), returnDoc({}, {}, R2), returnDoc({}, { amount: 0.01 }, R3)],
      ),
    ).toEqual({ ok: true, value: { refundCount: 3, refundTotalMinor: 16201, returnIds: [RID, R2, R3].sort() } });
  });
});
