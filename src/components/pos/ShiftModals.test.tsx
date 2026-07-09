// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseShiftModal } from './ShiftModals';
import type { Shift } from '../../lib/types';

// Packet 7C-A — offline-safe close-shift UX guard. `closeShift` is mocked so
// these tests can control resolve/reject/hang timing without touching
// Firestore; every other export of shiftService (e.g. calcShiftDrawerExpected,
// used for the drawer-expected display copy) stays real via importActual.
const mocks = vi.hoisted(() => ({
  closeShift: vi.fn(),
}));

vi.mock('../../lib/pos/shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftService')>();
  return {
    ...actual,
    closeShift: mocks.closeShift,
  };
});

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value: online,
  });
}

// Packet 7A — this-terminal pending-sync warning in the pre-close view.
// These tests exercise only the read-only warning prop surface: they never
// click "ปิดกะ" (which would invoke the real closeShift write path), so shift
// totals/variance/close payload are never touched by this suite.

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

describe('CloseShiftModal — Packet 7A pending-sync warning', () => {
  afterEach(() => cleanup());

  test('warning hidden when pendingSyncCount is omitted', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    expect(screen.queryByTestId('shift-close-pending-warning')).toBeNull();
  });

  test('warning hidden when pendingSyncCount is 0', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        pendingSyncCount: 0,
      }),
    );
    expect(screen.queryByTestId('shift-close-pending-warning')).toBeNull();
  });

  test('warning visible when pendingSyncCount > 0', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        pendingSyncCount: 2,
      }),
    );
    const warning = screen.getByTestId('shift-close-pending-warning');
    expect(warning).toBeTruthy();
    expect(warning.classList.contains('shift-close-warning--stale')).toBe(false);
  });

  test('warning copy uses this-terminal / device-local framing, not global claims', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        pendingSyncCount: 2,
      }),
    );
    const warning = screen.getByTestId('shift-close-pending-warning');
    expect(warning.textContent).toContain('จากเครื่องนี้');
    expect(warning.textContent).toContain('2 บิล');
    expect(warning.textContent).toContain('อาจยังไม่ซิงก์ขึ้นระบบ');
    // Must not overclaim server acceptance/settlement or cross-terminal awareness.
    for (const forbidden of ['ทุกเครื่อง', 'ทุกอุปกรณ์', 'ซิงก์แล้ว', 'ยืนยันจากเซิร์ฟเวอร์แล้ว']) {
      expect(warning.textContent).not.toContain(forbidden);
    }
  });

  test('stale variant renders escalated copy and styling when pendingSyncStale is true', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        pendingSyncCount: 5,
        pendingSyncStale: true,
      }),
    );
    const warning = screen.getByTestId('shift-close-pending-warning');
    expect(warning.classList.contains('shift-close-warning--stale')).toBe(true);
    expect(warning.textContent).toContain('นานผิดปกติ');
    expect(warning.textContent).toContain('5 บิล');
  });

  test('confirm/close button remains enabled when the warning is present', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        pendingSyncCount: 3,
        pendingSyncStale: true,
      }),
    );
    const confirmBtn = screen.getByRole('button', { name: 'ปิดกะ' });
    expect(confirmBtn.hasAttribute('disabled')).toBe(false);
  });

  test('warning is absent from the Z-report / success view', () => {
    // The Z-report view only renders once `closedShift` is set (post-confirm),
    // which this suite never triggers — asserting its absence here documents
    // that the warning JSX lives exclusively in the pre-close branch (see
    // ShiftModals.tsx: it is not rendered inside ZReportView).
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
        pendingSyncCount: 4,
      }),
    );
    expect(screen.queryByText('ปิดกะสำเร็จ — Z-Report')).toBeNull();
    expect(screen.getByTestId('shift-close-pending-warning')).toBeTruthy();
  });

  test('existing modal behavior is unaffected: title, drawer-expected copy, and cash input still render', () => {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    expect(screen.getByText('ปิดกะขาย')).toBeTruthy();
    expect(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ปิดกะ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ยกเลิก' })).toBeTruthy();
  });
});

describe('CloseShiftModal — Packet 7C-A offline-safe close guard', () => {
  afterEach(() => {
    cleanup();
    mocks.closeShift.mockReset();
    setOnline(true);
    vi.useRealTimers();
  });

  function renderModal(onSuccess = vi.fn()) {
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess,
      }),
    );
    fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), {
      target: { value: '1000' },
    });
    return screen.getByRole('button', { name: 'ปิดกะ' });
  }

  test('offline guard shows honest Thai error and does not call closeShift', () => {
    setOnline(false);
    const confirmBtn = renderModal();

    fireEvent.click(confirmBtn);

    expect(screen.getByText(
      'ไม่สามารถปิดกะขณะออฟไลน์ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง',
    )).toBeTruthy();
    expect(mocks.closeShift).not.toHaveBeenCalled();
  });

  test('offline guard does not render Z-report', () => {
    setOnline(false);
    const confirmBtn = renderModal();

    fireEvent.click(confirmBtn);

    expect(screen.queryByText('ปิดกะสำเร็จ — Z-Report')).toBeNull();
  });

  test('online happy path still calls closeShift and renders Z-report', async () => {
    setOnline(true);
    mocks.closeShift.mockResolvedValue(makeShift({ status: 'closed', actualCashCount: 1000 }));
    const confirmBtn = renderModal();

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mocks.closeShift).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('ปิดกะสำเร็จ — Z-Report')).toBeTruthy();
  });

  test('timeout backstop releases submitting and shows honest connectivity error when closeShift never resolves', async () => {
    vi.useFakeTimers();
    setOnline(true);
    mocks.closeShift.mockImplementation(() => new Promise(() => {}));
    const confirmBtn = renderModal();

    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    expect(screen.getByRole('button', { name: 'กำลังปิดกะ...' })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(screen.getByText(
      'ปิดกะยังไม่สำเร็จ ระบบเชื่อมต่อมีปัญหา กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง',
    )).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ปิดกะ' })).toBeTruthy();
    expect(screen.queryByText('ปิดกะสำเร็จ — Z-Report')).toBeNull();
  });

  test('retry after timeout remains possible and can still succeed', async () => {
    vi.useFakeTimers();
    setOnline(true);
    mocks.closeShift.mockImplementationOnce(() => new Promise(() => {}));
    const confirmBtn = renderModal();

    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    vi.useRealTimers();

    mocks.closeShift.mockResolvedValueOnce(makeShift({ status: 'closed', actualCashCount: 1000 }));
    const retryBtn = screen.getByRole('button', { name: 'ปิดกะ' });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    expect(await screen.findByText('ปิดกะสำเร็จ — Z-Report')).toBeTruthy();
  });

  test('copy audit: offline and timeout errors do not claim synced/settled/server-accepted/guaranteed/global coverage', () => {
    setOnline(false);
    const confirmBtn = renderModal();
    fireEvent.click(confirmBtn);
    const offlineText = screen.getByText(
      'ไม่สามารถปิดกะขณะออฟไลน์ กรุณาเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง',
    ).textContent;

    const forbidden = [
      'ปิดกะแล้ว',
      'ซิงก์แล้ว',
      'บันทึกขึ้นระบบแล้ว',
      'ยืนยันจากเซิร์ฟเวอร์แล้ว',
      'ทุกเครื่อง',
      'ทุกอุปกรณ์',
    ];
    for (const word of forbidden) {
      expect(offlineText).not.toContain(word);
    }

    const timeoutMessage =
      'ปิดกะยังไม่สำเร็จ ระบบเชื่อมต่อมีปัญหา กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง';
    for (const word of forbidden) {
      expect(timeoutMessage).not.toContain(word);
    }
  });
});
