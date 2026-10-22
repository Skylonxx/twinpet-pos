// Return/Refund V1 packet 014 — pure pieces of the server-authoritative close
// adapter. GREEN-only contract tests (the module is new in 014): the parent has
// no such module, so an import failure there is NOT claimed as a useful RED.
// The money converters are checked against the PRODUCTION server core so the
// client never sends a value the server refuses, nor accepts one it would not.
import { describe, expect, test, vi } from 'vitest';
import type { Shift } from '../types';
import type { LocalSale } from './localLedger';
import { deriveShiftDrawer } from './shiftLedger';
import {
  AUTHORITATIVE_REFUSAL_CODES,
  SERVER_AUTHORITATIVE_CLOSE_ENABLED,
  authoritativeCloseRequest,
  authoritativeRefusalMessage,
  buildAuthoritativeCloseRequestBody,
  buildAuthoritativeExpectation,
  canonicalEntryMinor,
  canonicalTotalMinor,
  foldAttestedSalesMinor,
  invokeCloseShiftAuthoritative,
  sameAuthoritativeRequestBody,
} from './shiftCloseAuthoritativeClient';
import { validateCloseShiftRequest } from '../../../functions/src/closeShiftAuthoritativeCore';

const UUID = '0f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7b';

function adjacentDouble(x: number, dir: 1 | -1): number {
  const f = new Float64Array([x]);
  const b = new BigInt64Array(f.buffer);
  b[0] = b[0]! + BigInt(dir);
  return f[0]!;
}

function sale(id: string, payments: Array<{ method: string; amount: unknown }>, changeAmt: unknown = 0, shiftId = 'S1'): LocalSale {
  return { id, shiftId, payments, changeAmt } as unknown as LocalSale;
}

function shiftOf(sales: LocalSale[]): Shift {
  return deriveShiftDrawer(
    {
      id: 'S1',
      branchId: 'B1',
      staffId: 's1',
      staffName: 'Staff',
      status: 'open',
      openedAt: null as unknown as Shift['openedAt'],
      closedAt: null,
      startingCash: 500,
      actualCashCount: 0,
      expectedCash: 0,
      expectedQr: 0,
      expectedKbank: 0,
      expectedCard: 0,
      expectedCredit: 0,
      totalBills: 0,
      payInTotal: 0,
      payOutTotal: 0,
      variance: 0,
      note: '',
      cashEntries: [],
    },
    sales,
  );
}

describe('014 gate', () => {
  test('the hardcoded source gate is OFF', () => {
    expect(SERVER_AUTHORITATIVE_CLOSE_ENABLED).toBe(false);
  });
});

describe('014 canonical satang (client mirror of the 013 server converters)', () => {
  test.each([0, 0.01, 0.1, 0.3, 19.99, 81, 1419.25, 10_000_000])('canonical %s accepted as a total and (when > 0) an entry', (x) => {
    expect(canonicalTotalMinor(x)).toBe(Math.round(x * 100));
    if (x > 0) expect(canonicalEntryMinor(x)).toBe(Math.round(x * 100));
  });

  test.each([
    0.010000001,
    81.000000001,
    0.100000001,
    0.009999999,
    0.1 + 0.2,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0.01,
    10_000_000_000.01,
    '10',
    null,
    undefined,
  ])('non-canonical / out-of-range %s refused (never rounded)', (x) => {
    expect(canonicalTotalMinor(x)).toBeNull();
    expect(canonicalEntryMinor(x)).toBeNull();
  });

  test('both neighbouring doubles of canonical values are refused', () => {
    for (const x of [0.01, 0.3, 81, 1419.25, 9_999_999.99]) {
      for (const d of [1, -1] as const) {
        expect(canonicalTotalMinor(adjacentDouble(x, d))).toBeNull();
        expect(canonicalEntryMinor(adjacentDouble(x, d))).toBeNull();
      }
    }
  });

  test('−0 is a zero total and never a positive movement; entry upper bound ฿10,000,000', () => {
    expect(canonicalTotalMinor(-0)).toBe(0);
    expect(canonicalEntryMinor(-0)).toBeNull();
    expect(canonicalEntryMinor(0)).toBeNull();
    expect(canonicalEntryMinor(10_000_000.01)).toBeNull();
    expect(canonicalTotalMinor(10_000_000_000)).toBe(1_000_000_000_000);
  });

  test('agrees with the PRODUCTION server request validator on every sampled total', () => {
    const samples = [0, 0.01, 0.3, 81, 0.1 + 0.2, 81.000000001, 1e9 + 0.07, 9_116_789_933.55, 9_116_789_933.56, 1e10];
    for (const x of samples) {
      const server = validateCloseShiftRequest({
        contractVersion: 1,
        shiftId: 'S1',
        closeCorrelationId: UUID,
        actualCashCount: x,
        note: '',
        attestedSales: { expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 0 },
        deviceId: 'D1',
      });
      expect(canonicalTotalMinor(x) !== null, `x=${x}`).toBe(server.ok);
    }
  });
});

describe('014 attested sales — integer-satang fold of ledger line items', () => {
  test('0.1 + 0.2 cash lines ⇒ exactly 30 satang (0.3), never 0.30000000000000004', () => {
    const r = foldAttestedSalesMinor('S1', [sale('a', [{ method: 'cash', amount: 0.1 }]), sale('b', [{ method: 'cash', amount: 0.2 }])]);
    expect(r).toEqual({
      ok: true,
      value: { expectedCashMinor: 30, expectedQrMinor: 0, expectedKbankMinor: 0, expectedCardMinor: 0, expectedCreditMinor: 0, totalBills: 2 },
    });
  });

  test('net cash per sale = max(0, cash tendered − change) (the summarizeDrawer formula)', () => {
    const r = foldAttestedSalesMinor('S1', [
      sale('a', [{ method: 'cash', amount: 500 }], 55.5),
      sale('b', [{ method: 'qr', amount: 100 }], 10), // change from a non-cash tender never makes cash negative
    ]);
    expect(r.ok && r.value).toMatchObject({ expectedCashMinor: 44_450, expectedQrMinor: 10_000, totalBills: 2 });
  });

  test.each([
    ['empty id', [{ ...sale('', [{ method: 'cash', amount: 1 }]) }], 'sale_malformed'],
    ['wrong shift', [sale('a', [{ method: 'cash', amount: 1 }], 0, 'S0')], 'sale_wrong_shift'],
    ['duplicate', [sale('a', [{ method: 'cash', amount: 1 }]), sale('a', [{ method: 'cash', amount: 1 }])], 'sale_duplicate'],
    ['payments missing', [{ ...sale('a', []), payments: undefined }], 'payment_malformed'],
    ['payment null', [sale('a', [null as never])], 'payment_malformed'],
    ['unknown method', [sale('a', [{ method: 'transfer', amount: 1 }])], 'payment_malformed'],
    ['off-cent line', [sale('a', [{ method: 'cash', amount: 81.000000001 }])], 'amount_not_canonical'],
    ['change missing', [{ ...sale('a', [{ method: 'cash', amount: 1 }]), changeAmt: undefined }], 'amount_not_canonical'],
    ['NaN line', [sale('a', [{ method: 'card', amount: Number.NaN }])], 'amount_not_canonical'],
  ])('%s ⇒ %s', (_l, sales, reason) => {
    expect(foldAttestedSalesMinor('S1', sales as LocalSale[])).toEqual({ ok: false, reason });
  });

  test('bill count above the server cap refuses', () => {
    const many = Array.from({ length: 100_001 }, (_, i) => sale(`s${i}`, []));
    expect(foldAttestedSalesMinor('S1', many)).toEqual({ ok: false, reason: 'too_many_bills' });
  });
});

describe('014 request body', () => {
  const SALES = [sale('a', [{ method: 'cash', amount: 0.1 }, { method: 'credit', amount: 5 }]), sale('b', [{ method: 'cash', amount: 0.2 }])];

  test('exact v1 shape; canonical money; the server validator accepts it', () => {
    const built = buildAuthoritativeCloseRequestBody({ shift: shiftOf(SALES), sales: SALES, actualCashCount: 500.3, note: 'n', deviceId: 'D1' });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const request = authoritativeCloseRequest(built.body, UUID);
    expect(request).toEqual({
      contractVersion: 1,
      shiftId: 'S1',
      closeCorrelationId: UUID,
      actualCashCount: 500.3,
      note: 'n',
      attestedSales: { expectedCash: 0.3, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 5, totalBills: 2 },
      deviceId: 'D1',
    });
    expect(validateCloseShiftRequest(JSON.parse(JSON.stringify(request))).ok).toBe(true);
  });

  test('a shown drawer carrying a raw float aggregate is refused, not "fixed"', () => {
    const shown = { ...shiftOf(SALES), expectedCash: 0.1 + 0.2 };
    expect(buildAuthoritativeCloseRequestBody({ shift: shown, sales: SALES, actualCashCount: 1, note: '', deviceId: 'D1' })).toMatchObject({
      ok: false,
      reason: 'attested_differs_from_drawer',
      field: 'expectedCash',
    });
  });

  test.each([
    [{ actualCashCount: 1.005 }, 'count_not_canonical'],
    [{ actualCashCount: -1 }, 'count_not_canonical'],
    [{ note: 'x'.repeat(1001) }, 'note_too_long'],
    [{ deviceId: ' D1' }, 'device_id_invalid'],
    [{ deviceId: '' }, 'device_id_invalid'],
    [{ deviceId: 'x'.repeat(201) }, 'device_id_invalid'],
  ])('%o ⇒ %s', (over, reason) => {
    const input = { shift: shiftOf(SALES), sales: SALES, actualCashCount: 1, note: '', deviceId: 'D1', ...over };
    expect(buildAuthoritativeCloseRequestBody(input)).toMatchObject({ ok: false, reason });
  });

  test('a note of exactly 1000 chars is accepted (server bound)', () => {
    const built = buildAuthoritativeCloseRequestBody({ shift: shiftOf(SALES), sales: SALES, actualCashCount: 1, note: 'x'.repeat(1000), deviceId: 'D1' });
    expect(built.ok).toBe(true);
  });

  test('sameAuthoritativeRequestBody is field-for-field', () => {
    const a = buildAuthoritativeCloseRequestBody({ shift: shiftOf(SALES), sales: SALES, actualCashCount: 1, note: '', deviceId: 'D1' });
    const b = buildAuthoritativeCloseRequestBody({ shift: shiftOf(SALES), sales: SALES, actualCashCount: 1.01, note: '', deviceId: 'D1' });
    if (!a.ok || !b.ok) throw new Error('fixture');
    expect(sameAuthoritativeRequestBody(a.body, { ...a.body, attestedSales: { ...a.body.attestedSales } })).toBe(true);
    expect(sameAuthoritativeRequestBody(a.body, b.body)).toBe(false);
    expect(sameAuthoritativeRequestBody(a.body, { ...a.body, attestedSales: { ...a.body.attestedSales, totalBills: 3 } })).toBe(false);
  });
});

describe('014 expected close (mirror of planAuthoritativeClose)', () => {
  const identity = { shiftId: 'S1', branchId: 'B1', staffId: 's1', staffName: 'Staff', deviceId: 'D1' };
  const body = {
    contractVersion: 1 as const,
    shiftId: 'S1',
    actualCashCount: 1419,
    note: '',
    attestedSales: { expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 3 },
    deviceId: 'D1',
  };

  test('starting 500 + sales 1000 − Return 81 ⇒ payOut 81, variance 0 at count 1419', () => {
    const r = buildAuthoritativeExpectation({
      identity,
      body,
      serverData: { startingCash: 500, cashEntries: [{ id: 'rfd_r1', type: 'pay_out', amount: 81 }] },
    });
    expect(r).toMatchObject({ ok: true, expected: { payInTotal: 0, payOutTotal: 81, variance: 0, startingCash: 500, expectedCash: 1000 } });
  });

  test('pay-in / pay-out are minor / 100 (0.1 + 0.2 pay-ins ⇒ 0.3)', () => {
    const r = buildAuthoritativeExpectation({
      identity,
      body: { ...body, actualCashCount: 1500.3 },
      serverData: { startingCash: 500, cashEntries: [{ id: 'a', type: 'pay_in', amount: 0.1 }, { id: 'b', type: 'pay_in', amount: 0.2 }] },
    });
    expect(r.ok && r.expected.payInTotal).toBe(0.3);
  });

  test.each([
    [{ startingCash: 0.010000001 }, 'starting_cash_invalid'],
    [{ startingCash: 500, cashEntries: 'x' }, 'cash_entries_invalid'],
    [{ startingCash: 500, cashEntries: [{ id: 'a', type: 'pay_out', amount: 81.000000001 }] }, 'cash_entries_invalid'],
    [{ startingCash: 500, cashEntries: [{ id: '', type: 'pay_out', amount: 1 }] }, 'cash_entries_invalid'],
    [{ startingCash: 500, cashEntries: [{ id: 'a', type: 'refund', amount: 1 }] }, 'cash_entries_invalid'],
    [{ startingCash: 500, cashEntries: [{ id: 'a', type: 'pay_in', amount: 1 }, { id: 'a', type: 'pay_in', amount: 1 }] }, 'cash_entry_duplicate'],
    [{ startingCash: 500, cashEntries: Array.from({ length: 1001 }, (_, i) => ({ id: `e${i}`, type: 'pay_in', amount: 1 })) }, 'cash_entries_over_cap'],
  ])('%o ⇒ %s', (serverData, reason) => {
    expect(buildAuthoritativeExpectation({ identity, body, serverData })).toEqual({ ok: false, reason });
  });
});

describe('014 response classification', () => {
  const request = { shiftId: 'S1', closeCorrelationId: UUID };
  const snapshot = {
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
    note: '',
    deviceId: 'D1',
  };
  const success = {
    ok: true,
    contractVersion: 1,
    closeProtocol: 'server_authoritative_v1',
    idempotentReplay: false,
    shiftId: 'S1',
    closeCorrelationId: UUID,
    closedAtMillis: 1,
    snapshot,
    persistedClose: { status: 'closed', closedOffline: true, syncStateAtClose: 'pending' },
    money: {},
    provenance: { salesTotals: { status: 'attested_unverified', reason: 'sale_sync_completeness_not_provable' } },
  };
  const call = (raw: unknown) => invokeCloseShiftAuthoritative(async () => raw, request);

  test('well-formed ok:true (first commit and replay)', async () => {
    await expect(call(success)).resolves.toEqual({ kind: 'committed', success: { idempotentReplay: false, closedAtMillis: 1, snapshot } });
    await expect(call({ ...success, idempotentReplay: true })).resolves.toMatchObject({ kind: 'committed', success: { idempotentReplay: true } });
  });

  test.each([
    ['other correlation id', { ...success, closeCorrelationId: '1f8c2a4e-5b6d-4c3e-9a1b-2c3d4e5f6a7c' }],
    ['other shift', { ...success, shiftId: 'S2' }],
    ['missing snapshot field', { ...success, snapshot: { ...snapshot, variance: undefined } }],
    ['extra snapshot field', { ...success, snapshot: { ...snapshot, payOutMinor: 8100 } }],
    ['non-finite money', { ...success, snapshot: { ...snapshot, payOutTotal: Number.NaN } }],
    ['sales claimed verified', { ...success, provenance: { salesTotals: { status: 'server_verified' } } }],
    ['wrong protocol', { ...success, closeProtocol: 'client_w3' }],
  ])('ok:true with %s ⇒ malformed_success (never trusted)', async (_l, raw) => {
    await expect(call(raw)).resolves.toEqual({ kind: 'malformed_success' });
  });

  test('every contract refusal code is definitive; committed_unconfirmed is not a refusal', async () => {
    for (const code of AUTHORITATIVE_REFUSAL_CODES) {
      await expect(call({ ok: false, code })).resolves.toEqual({ kind: 'refused', code });
      expect(authoritativeRefusalMessage(code)).toContain(`รหัส: ${code}`);
    }
    await expect(call({ ok: false, code: 'committed_unconfirmed' })).resolves.toEqual({ kind: 'committed_unconfirmed' });
  });

  test('a thrown call, an unknown code or a non-object is UNKNOWN (never a definitive refusal)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      invokeCloseShiftAuthoritative(async () => {
        throw Object.assign(new Error('x'), { code: 'functions/unavailable' });
      }, request),
    ).resolves.toEqual({ kind: 'unknown', cause: 'transport' });
    await expect(call({ ok: false, code: 'brand_new_code' })).resolves.toEqual({ kind: 'unknown', cause: 'unrecognized_response' });
    await expect(call(null)).resolves.toEqual({ kind: 'unknown', cause: 'unrecognized_response' });
    await expect(call('ok')).resolves.toEqual({ kind: 'unknown', cause: 'unrecognized_response' });
  });

  test('cashier copy says nothing was closed, except for the closed-with-this-id codes', () => {
    expect(authoritativeRefusalMessage('refund_audit_unavailable')).toContain('ยังไม่ได้ปิดกะ');
    expect(authoritativeRefusalMessage('idempotency_conflict')).not.toContain('ยังไม่ได้ปิดกะ');
    expect(authoritativeRefusalMessage('closed_outside_authority')).not.toContain('ยังไม่ได้ปิดกะ');
    expect(authoritativeRefusalMessage('close_record_inconsistent')).not.toContain('ยังไม่ได้ปิดกะ');
  });
});
