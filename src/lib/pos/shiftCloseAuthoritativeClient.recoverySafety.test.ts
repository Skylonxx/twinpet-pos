// Return/Refund V1 packet 015 — pure pieces added to the (default-OFF)
// server-authoritative close adapter: the replay proof (F1/F4), the strict
// persisted-binding schema (F5) and the operator-reviewed drawer witness (F2).
// GREEN-only contract tests (the symbols are new in 015; the behavioural RED
// evidence on the parent lives in the service / store / modal / rules suites).
import { describe, expect, test, vi } from 'vitest';
import type { Shift, ShiftCashEntry } from '../types';
import {
  authoritativeRequestFromSnapshot,
  buildReviewedDrawerWitness,
  checkReviewedDrawerWitness,
  isStrictAuthoritativeBinding,
  proveServerAuthoredClose,
} from './shiftCloseAuthoritativeClient';
import { validateCloseShiftRequest } from '../../../functions/src/closeShiftAuthoritativeCore';
import type { ShiftCloseIntentBusinessSnapshot } from './offline/shiftCloseIntentTypes';

const UUID = '0f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7b';
const CLOSED_AT_MS = Date.parse('2026-10-22T10:00:00Z');

const SNAP: ShiftCloseIntentBusinessSnapshot = {
  shiftId: 'S1',
  branchId: 'B1',
  staffId: 's1',
  staffName: 'Staff',
  startingCash: 500,
  expectedCash: 1000,
  expectedQr: 0,
  expectedKbank: 0,
  expectedCard: 0,
  expectedCredit: 0,
  payInTotal: 0,
  payOutTotal: 81,
  totalBills: 3,
  actualCashCount: 1419,
  variance: 0,
  note: 'n',
  deviceId: 'DEV1',
};

function success(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    contractVersion: 1,
    closeProtocol: 'server_authoritative_v1',
    idempotentReplay: true,
    shiftId: 'S1',
    closeCorrelationId: UUID,
    closedAtMillis: CLOSED_AT_MS,
    snapshot: { ...SNAP },
    persistedClose: { status: 'closed', closedOffline: true, syncStateAtClose: 'pending' },
    provenance: { salesTotals: { status: 'attested_unverified', reason: 'sale_sync_completeness_not_provable' } },
    ...over,
  };
}

const REQUEST = authoritativeRequestFromSnapshot(SNAP, UUID);
const DOC = { snapshot: SNAP, closedAtMillis: CLOSED_AT_MS };

describe('015 authoritativeRequestFromSnapshot', () => {
  test('is accepted by the PRODUCTION server request validator and reproduces the exact v1 key set', () => {
    const v = validateCloseShiftRequest(JSON.parse(JSON.stringify(REQUEST)));
    expect(v.ok).toBe(true);
    expect(Object.keys(REQUEST).sort()).toEqual(
      ['actualCashCount', 'attestedSales', 'closeCorrelationId', 'contractVersion', 'deviceId', 'note', 'shiftId'].sort(),
    );
    expect(REQUEST).toMatchObject({ shiftId: 'S1', closeCorrelationId: UUID, actualCashCount: 1419, deviceId: 'DEV1' });
  });
});

describe('015 proveServerAuthoredClose', () => {
  const prove = (raw: unknown | (() => never)) =>
    proveServerAuthoredClose({
      callable: async () => {
        if (typeof raw === 'function') return (raw as () => never)();
        return raw;
      },
      request: REQUEST,
      closedDoc: DOC,
    });

  test('a canonical idempotent replay equal to the independently read doc is the ONLY proof', async () => {
    const r = await prove(success());
    expect(r).toMatchObject({ kind: 'proven', proof: { protocol: 'server_authoritative_v1', shiftId: 'S1', closeCorrelationId: UUID, closedAtMillis: CLOSED_AT_MS } });
  });

  test('sends exactly the stored request (no mutation) once', async () => {
    const callable = vi.fn(async () => success());
    await proveServerAuthoredClose({ callable, request: REQUEST, closedDoc: DOC });
    expect(callable).toHaveBeenCalledTimes(1);
    expect(callable).toHaveBeenCalledWith(REQUEST);
  });

  test.each([
    ['closed_outside_authority', 'manual_attention'],
    ['idempotency_conflict', 'manual_attention'],
    ['close_record_inconsistent', 'manual_attention'],
    ['already_closed', 'manual_attention'],
    ['not_shift_owner', 'manual_attention'],
    ['invalid_request', 'manual_attention'],
    ['session_stale', 'unreachable'],
    ['unauthenticated', 'unreachable'],
    ['refund_audit_unavailable', 'unreachable'],
  ])('definitive refusal %s ⇒ %s (never proof)', async (code, kind) => {
    expect(await prove({ ok: false, code })).toMatchObject({ kind });
  });

  test('transport failure, committed_unconfirmed and unrecognized answers are unreachable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await prove(() => { throw new Error('deadline'); })).toMatchObject({ kind: 'unreachable', reason: 'transport' });
    expect(await prove({ ok: false, code: 'committed_unconfirmed' })).toMatchObject({ kind: 'unreachable', reason: 'unconfirmed' });
    expect(await prove({ ok: false, code: 'brand_new_code' })).toMatchObject({ kind: 'unreachable', reason: 'unrecognized_response' });
    expect(await prove('nope')).toMatchObject({ kind: 'unreachable', reason: 'unrecognized_response' });
    vi.restoreAllMocks();
  });

  test.each([
    ['another correlation id', { closeCorrelationId: '22222222-2222-4222-8222-222222222222' }],
    ['another shift', { shiftId: 'S2' }],
    ['a wrong protocol', { closeProtocol: 'legacy' }],
    ['a missing snapshot', { snapshot: undefined }],
    ['a verified-sales claim', { provenance: { salesTotals: { status: 'verified' } } }],
  ])('a malformed success (%s) ⇒ manual_attention', async (_label, over) => {
    expect(await prove(success(over))).toMatchObject({ kind: 'manual_attention', reason: 'malformed_success' });
  });

  test('a success that is not a replay (a fresh commit claim on a closed shift) ⇒ manual_attention', async () => {
    expect(await prove(success({ idempotentReplay: false }))).toMatchObject({ kind: 'manual_attention', reason: 'not_a_replay' });
  });

  test('a success that differs from the doc (any one of 17 fields, or the close time) ⇒ manual_attention', async () => {
    for (const k of Object.keys(SNAP) as Array<keyof ShiftCloseIntentBusinessSnapshot>) {
      const v = SNAP[k];
      const tampered = typeof v === 'number' ? v + 1 : `${String(v)}x`;
      const r = await prove(success({ snapshot: { ...SNAP, [k]: tampered } }));
      expect(r, `field ${k}`).toMatchObject({ kind: 'manual_attention' });
    }
    expect(await prove(success({ closedAtMillis: CLOSED_AT_MS + 1 }))).toMatchObject({ kind: 'manual_attention', reason: 'differs_from_doc' });
  });
});

describe('015 isStrictAuthoritativeBinding', () => {
  const identity = { shiftId: 'S1', branchId: 'B1', staffId: 's1', staffName: 'Staff', deviceId: 'DEV1' };
  const good = () => ({
    protocol: 'server_authoritative_v1',
    request: {
      contractVersion: 1,
      shiftId: 'S1',
      actualCashCount: 1419,
      note: 'n',
      attestedSales: { expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3 },
      deviceId: 'DEV1',
    },
    expected: { ...SNAP },
  });

  test('accepts a coherent satang-exact binding (Return 81, variance 0)', () => {
    expect(isStrictAuthoritativeBinding(good(), identity)).toBe(true);
  });

  test('the variance must be the exact stored expression, in both directions', () => {
    const over = good();
    over.expected.variance = 0.01;
    expect(isStrictAuthoritativeBinding(over, identity)).toBe(false);
    const short = good();
    short.request.actualCashCount = 1418;
    short.expected.actualCashCount = 1418;
    short.expected.variance = -1;
    expect(isStrictAuthoritativeBinding(short, identity)).toBe(true); // coherent shortfall
    short.expected.variance = 1;
    expect(isStrictAuthoritativeBinding(short, identity)).toBe(false);
  });

  test('a different attempt identity (shift / branch / staff / name / device) is refused', () => {
    for (const k of Object.keys(identity) as Array<keyof typeof identity>) {
      expect(isStrictAuthoritativeBinding(good(), { ...identity, [k]: 'other' }), k).toBe(false);
    }
  });

  test('bounds: bills 0 and 100000 pass, 100001 / -1 / 1.5 fail; note 1000 passes, 1001 fails; device 200 passes, 201 fails', () => {
    const withBills = (n: number) => {
      const b = good();
      b.request.attestedSales.totalBills = n;
      b.expected.totalBills = n;
      return b;
    };
    expect(isStrictAuthoritativeBinding(withBills(0), identity)).toBe(true);
    expect(isStrictAuthoritativeBinding(withBills(100_000), identity)).toBe(true);
    for (const n of [100_001, -1, 1.5, Number.NaN]) expect(isStrictAuthoritativeBinding(withBills(n), identity)).toBe(false);
    const note = (len: number) => {
      const b = good();
      b.request.note = 'x'.repeat(len);
      b.expected.note = 'x'.repeat(len);
      return b;
    };
    expect(isStrictAuthoritativeBinding(note(1000), identity)).toBe(true);
    expect(isStrictAuthoritativeBinding(note(1001), identity)).toBe(false);
    const dev = (len: number) => {
      const b = good();
      const d = 'D'.repeat(len);
      b.request.deviceId = d;
      b.expected.deviceId = d;
      return { b, id: { ...identity, deviceId: d } };
    };
    expect(isStrictAuthoritativeBinding(dev(200).b, dev(200).id)).toBe(true);
    expect(isStrictAuthoritativeBinding(dev(201).b, dev(201).id)).toBe(false);
  });

  test.each([null, undefined, 'x', 5, [], {}])('non-object / empty binding %j is refused', (v) => {
    expect(isStrictAuthoritativeBinding(v, identity)).toBe(false);
  });
});

describe('015 operator-reviewed drawer witness', () => {
  const RFD: ShiftCashEntry = { id: 'rfd_r1', type: 'pay_out', amount: 81, note: 'คืนเงินสด', staffId: 's1', staffName: 'Staff', at: 2 };
  const shift = (entries: ShiftCashEntry[] = [], over: Partial<Shift> = {}): Shift => ({
    id: 'S1',
    branchId: 'B1',
    staffId: 's1',
    staffName: 'Staff',
    status: 'open',
    openedAt: null as unknown as Shift['openedAt'],
    closedAt: null,
    startingCash: 500,
    actualCashCount: 0,
    expectedCash: 1000,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 3,
    payInTotal: 0,
    payOutTotal: entries.reduce((s, e) => s + (e.type === 'pay_out' ? e.amount : 0), 0),
    variance: 0,
    note: '',
    cashEntries: entries,
    ...over,
  });
  const serverCtx = (entries: ShiftCashEntry[], startingCash = 500, payOut = entries.reduce((s, e) => s + (e.type === 'pay_out' ? e.amount : 0), 0)) => ({
    shiftId: 'S1',
    branchId: 'B1',
    serverData: { startingCash, cashEntries: entries },
    expected: { ...SNAP, startingCash, payOutTotal: payOut, payInTotal: 0 },
  });

  test('is immutable and carries exactly the displayed basis', () => {
    const w = buildReviewedDrawerWitness(shift([RFD]), 'loaded');
    expect(w).toEqual({
      shiftId: 'S1',
      branchId: 'B1',
      startingCash: 500,
      cashEntries: [{ id: 'rfd_r1', type: 'pay_out', amount: 81 }],
      payInTotal: 0,
      payOutTotal: 81,
      expectedDrawer: 1419,
      serverRefresh: 'loaded',
    });
    expect(Object.isFrozen(w)).toBe(true);
    expect(Object.isFrozen(w.cashEntries)).toBe(true);
    expect(() => {
      (w as { expectedDrawer: number }).expectedDrawer = 1;
    }).toThrow();
  });

  test('unchanged honest display (Return 81 shown and present) ⇒ ok; an empty drawer ⇒ ok', () => {
    expect(checkReviewedDrawerWitness(buildReviewedDrawerWitness(shift([RFD]), 'loaded'), serverCtx([RFD]))).toEqual({ ok: true });
    expect(checkReviewedDrawerWitness(buildReviewedDrawerWitness(shift([]), 'loaded'), serverCtx([]))).toEqual({ ok: true });
  });

  test.each<[string, () => unknown, ReturnType<typeof serverCtx>, string]>([
    ['absent', () => undefined, serverCtx([]), 'missing'],
    ['malformed', () => ({ shiftId: 'S1' }), serverCtx([]), 'missing'],
    ['refresh pending', () => buildReviewedDrawerWitness(shift([]), 'pending'), serverCtx([]), 'not_loaded'],
    ['refresh unavailable', () => buildReviewedDrawerWitness(shift([]), 'unavailable'), serverCtx([]), 'not_loaded'],
    ['another shift', () => buildReviewedDrawerWitness(shift([], { id: 'S2' }), 'loaded'), serverCtx([]), 'identity'],
    ['another branch', () => buildReviewedDrawerWitness(shift([], { branchId: 'B2' }), 'loaded'), serverCtx([]), 'identity'],
    ['a server-only new payout (Return 81 after display)', () => buildReviewedDrawerWitness(shift([]), 'loaded'), serverCtx([RFD]), 'cash_entries'],
    ['a displayed entry the server lacks', () => buildReviewedDrawerWitness(shift([RFD]), 'loaded'), serverCtx([]), 'cash_entries'],
    ['a changed amount of the same id', () => buildReviewedDrawerWitness(shift([{ ...RFD, amount: 80 }]), 'loaded'), serverCtx([RFD]), 'cash_entries'],
    ['a changed type of the same id', () => buildReviewedDrawerWitness(shift([{ ...RFD, type: 'pay_in' }]), 'loaded'), serverCtx([RFD]), 'cash_entries'],
    ['a different entry id', () => buildReviewedDrawerWitness(shift([{ ...RFD, id: 'rfd_other' }]), 'loaded'), serverCtx([RFD]), 'cash_entries'],
    ['an altered startingCash', () => buildReviewedDrawerWitness(shift([]), 'loaded'), serverCtx([], 600), 'starting_cash'],
    ['a displayed total that is not the basis', () => ({ ...buildReviewedDrawerWitness(shift([]), 'loaded'), expectedDrawer: 1499.99 }), serverCtx([]), 'drawer'],
  ])('refuses %s', (_label, witness, ctx, reason) => {
    expect(checkReviewedDrawerWitness(witness(), ctx)).toEqual({ ok: false, reason });
  });
});
