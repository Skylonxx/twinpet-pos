// @vitest-environment jsdom
// Packet 023 — the close modal's view of a server-authoritative close RECORDED
// LOCALLY (deferred, nothing sent yet): truthful local / pending copy, never the
// success title, never the plain "pending sync" or a confirmed Z badge.

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseShiftModal } from './ShiftModals';
import type { Shift } from '../../lib/types';

const mocks = vi.hoisted(() => ({ closeShift: vi.fn() }));

vi.mock('../../lib/pos/shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftService')>();
  return { ...actual, closeShift: mocks.closeShift };
});

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

async function closeWith(result: Record<string, unknown>) {
  mocks.closeShift.mockResolvedValue(result);
  render(createElement(CloseShiftModal, { shift: makeShift(), onClose: vi.fn(), onSuccess: vi.fn() }));
  fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), { target: { value: '1500' } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
  });
}

const DEFERRED = {
  ...makeShift({ status: 'closed', actualCashCount: 1500, closedOffline: true, syncState: 'pending', closedAtLocal: Date.now() }),
  authoritativeDeferred: true,
  whenServerConfirmed: Promise.resolve({ outcome: 'still_pending' }),
};

describe('CloseShiftModal — packet 023 deferred server-authoritative close', () => {
  afterEach(() => {
    cleanup();
    mocks.closeShift.mockReset();
  });

  test('shows the local-record title and the deferred badge; never "ปิดกะสำเร็จ", the plain pending badge or a confirmed badge', async () => {
    await closeWith(DEFERRED);
    expect(screen.getByText('บันทึกการปิดกะในเครื่องแล้ว — รอเซิร์ฟเวอร์ยืนยัน')).toBeTruthy();
    expect(screen.queryByText(/ปิดกะสำเร็จ/)).toBeNull();
    const badge = screen.getByTestId('shift-zreport-sync-deferred');
    expect(badge.textContent).toContain('ยังไม่ได้ส่งถึงเซิร์ฟเวอร์');
    expect(badge.textContent).toContain('ยังไม่ใช่รายงานปิดกะ (Z) ที่เซิร์ฟเวอร์ยืนยัน');
    for (const forbidden of ['ซิงก์แล้ว', 'ยืนยันจากเซิร์ฟเวอร์แล้ว', 'สำเร็จ', 'settled', 'guaranteed']) {
      expect(badge.textContent).not.toContain(forbidden);
    }
    expect(screen.queryByTestId('shift-zreport-sync-pending')).toBeNull();
    expect(screen.queryByTestId('shift-zreport-sync-confirmed')).toBeNull();
    expect(screen.getByText(/\(เวลาเครื่อง\)/)).toBeTruthy();
  });

  test('a non-deferred close keeps the existing Z-report title and pending badge', async () => {
    const legacy: Record<string, unknown> = { ...DEFERRED };
    delete legacy.authoritativeDeferred;
    await closeWith(legacy);
    expect(screen.getByText('ปิดกะสำเร็จ — Z-Report')).toBeTruthy();
    expect(screen.getByTestId('shift-zreport-sync-pending')).toBeTruthy();
    expect(screen.queryByTestId('shift-zreport-sync-deferred')).toBeNull();
  });
});
