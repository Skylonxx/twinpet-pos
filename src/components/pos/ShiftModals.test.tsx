// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { CloseShiftModal } from './ShiftModals';
import type { Shift } from '../../lib/types';

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
