// @vitest-environment jsdom

// Return/Refund V1 packet 015 — F2: the cashier confirms the SAME drawer the
// server-authoritative close uses. The close modal hands `closeShift` an
// immutable witness of the exact `displayShift` that rendered the shown
// "expected drawer" (and the freshness of its server refresh), and after a
// refused (changed) drawer it refreshes the display so the next Confirm is a
// new, explicit review. While the gate is OFF the call stays exactly
// `closeShift(shift, count, note)`.
//
// Provenance: only symbols that exist at the parent commit (a844855) are
// imported (the gate constant is mocked by name); on the parent the modal
// passes no witness at all, so the ON cases fail on BEHAVIOUR.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseShiftModal } from './ShiftModals';
import type { Shift, ShiftCashEntry } from '../../lib/types';

const mocks = vi.hoisted(() => ({
  closeShift: vi.fn(),
  readServerShiftCash: vi.fn(),
  gate: { on: false },
}));

vi.mock('../../lib/pos/shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftService')>();
  return { ...actual, closeShift: mocks.closeShift, openShift: vi.fn() };
});

vi.mock('../../lib/pos/shiftCashFreshness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftCashFreshness')>();
  return { ...actual, readServerShiftCash: mocks.readServerShiftCash };
});

vi.mock('../../lib/pos/shiftCloseAuthoritativeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftCloseAuthoritativeClient')>();
  return {
    ...actual,
    get SERVER_AUTHORITATIVE_CLOSE_ENABLED() {
      return mocks.gate.on;
    },
  };
});

const RFD81: ShiftCashEntry = { id: 'rfd_ret1', type: 'pay_out', amount: 81, note: 'คืนเงินสด', staffId: 'staff-1', staffName: 'ทดสอบ', at: 2 };

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return {
    id: 'shift-1',
    branchId: 'LDP-001',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
    status: 'open',
    openedAt: new Date() as unknown as Shift['openedAt'],
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
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries: [],
    ...overrides,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online });
}

const loaded = (cashEntries: ShiftCashEntry[]) => ({ ok: true as const, exists: true, status: 'open', cashEntries });

function renderModal(shift = makeShift()) {
  return render(createElement(CloseShiftModal, { shift, onClose: vi.fn(), onSuccess: vi.fn() }));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function confirm(count: string) {
  fireEvent.change(screen.getByLabelText(/นับเงินสดในลิ้นชัก/), { target: { value: count } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
  });
}

type CloseCall = [Shift, number, string, { authoritativeClose?: { reviewedDrawer?: Record<string, unknown> } }?];

beforeEach(() => {
  setOnline(true);
  mocks.gate.on = false;
  mocks.closeShift.mockReset();
  mocks.readServerShiftCash.mockReset();
  mocks.readServerShiftCash.mockResolvedValue(loaded([]));
});

afterEach(() => cleanup());

describe('F2 — gate OFF: the close call is unchanged', () => {
  test('[GREEN-guard] closeShift(shift, count, note) with exactly three arguments', async () => {
    mocks.closeShift.mockReturnValue(new Promise(() => undefined));
    const shift = makeShift();
    renderModal(shift);
    await flush();
    await confirm('1500');
    expect(mocks.closeShift).toHaveBeenCalledTimes(1);
    expect(mocks.closeShift.mock.calls[0]).toEqual([shift, 1500, '']);
  });
});

describe('F2 — gate ON: the witness is the exact displayed drawer', () => {
  beforeEach(() => {
    mocks.gate.on = true;
  });

  test('[RED-parent] the server refresh loaded Return 81 ⇒ the shown drawer is 1,419.00 and the witness carries exactly that basis', async () => {
    mocks.readServerShiftCash.mockResolvedValue(loaded([RFD81]));
    mocks.closeShift.mockReturnValue(new Promise(() => undefined));
    renderModal();
    await flush();
    expect(document.body.textContent).toContain('1,419.00');
    await confirm('1419');
    const call = mocks.closeShift.mock.calls[0] as CloseCall;
    const witness = call[3]?.authoritativeClose?.reviewedDrawer;
    expect(witness).toMatchObject({
      shiftId: 'shift-1',
      branchId: 'LDP-001',
      startingCash: 500,
      serverRefresh: 'loaded',
      expectedDrawer: 1419,
      payInTotal: 0,
      payOutTotal: 81,
      cashEntries: [{ id: 'rfd_ret1', type: 'pay_out', amount: 81 }],
    });
  });

  test('[RED-parent] the refresh is still pending at Confirm ⇒ the witness says so (the close refuses an unconfirmed display)', async () => {
    mocks.readServerShiftCash.mockReturnValue(new Promise(() => undefined));
    mocks.closeShift.mockReturnValue(new Promise(() => undefined));
    renderModal();
    await flush();
    await confirm('1500');
    const call = mocks.closeShift.mock.calls[0] as CloseCall;
    expect(call[3]?.authoritativeClose?.reviewedDrawer).toMatchObject({ serverRefresh: 'pending', expectedDrawer: 1500, payOutTotal: 0 });
  });

  test('[RED-parent] a failed refresh and an offline modal are "unavailable"', async () => {
    mocks.readServerShiftCash.mockResolvedValue({ ok: false });
    mocks.closeShift.mockReturnValue(new Promise(() => undefined));
    renderModal();
    await flush();
    await confirm('1500');
    expect((mocks.closeShift.mock.calls[0] as CloseCall)[3]?.authoritativeClose?.reviewedDrawer).toMatchObject({ serverRefresh: 'unavailable' });
    cleanup();
    mocks.closeShift.mockClear();
    setOnline(false);
    renderModal();
    await flush();
    await confirm('1500');
    expect((mocks.closeShift.mock.calls[0] as CloseCall)[3]?.authoritativeClose?.reviewedDrawer).toMatchObject({ serverRefresh: 'unavailable' });
  });

  test('[RED-parent] a refused (changed) drawer refreshes the display; the NEXT Confirm carries the newly shown basis — the old confirmation is not reused', async () => {
    mocks.readServerShiftCash.mockResolvedValueOnce(loaded([])).mockResolvedValue(loaded([RFD81]));
    mocks.closeShift
      .mockRejectedValueOnce(Object.assign(new Error('ยอดเงินสดในลิ้นชักที่แสดงอยู่ไม่ตรงกับข้อมูลล่าสุดบนเซิร์ฟเวอร์'), { cause: { reviewRequired: true } }))
      .mockReturnValue(new Promise(() => undefined));
    renderModal();
    await flush();
    expect(document.body.textContent).toContain('1,500.00');
    await confirm('1500');
    await flush();
    // The refusal is visible and the display now shows the changed drawer.
    expect(document.body.textContent).toContain('ไม่ตรงกับข้อมูลล่าสุดบนเซิร์ฟเวอร์');
    expect(document.body.textContent).toContain('1,419.00');
    expect(mocks.readServerShiftCash).toHaveBeenCalledTimes(2);
    // A second Confirm is a new explicit action over the refreshed display.
    await confirm('1419');
    const second = mocks.closeShift.mock.calls[1] as CloseCall;
    expect(second[2]).toBe('');
    expect(second[1]).toBe(1419);
    expect(second[3]?.authoritativeClose?.reviewedDrawer).toMatchObject({ expectedDrawer: 1419, payOutTotal: 81, serverRefresh: 'loaded' });
  });

  test('[GREEN-guard] an ordinary failure (no review flag) does not trigger a display refresh', async () => {
    mocks.closeShift.mockRejectedValue(new Error('บริการปิดกะของเซิร์ฟเวอร์ไม่พร้อมใช้งาน'));
    renderModal();
    await flush();
    await confirm('1500');
    await flush();
    expect(mocks.readServerShiftCash).toHaveBeenCalledTimes(1);
  });
});
