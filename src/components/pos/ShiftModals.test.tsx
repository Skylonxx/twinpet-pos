// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseShiftModal, ShiftBootBlockedModal } from './ShiftModals';
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

describe('CloseShiftModal — Packet 7C-B1 optimistic close + defensive timeout backstop', () => {
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

  test('Packet 7C-B1: offline no longer hard-blocks — closeShift is called optimistically', async () => {
    setOnline(false);
    mocks.closeShift.mockResolvedValue(
      makeShift({
        status: 'closed',
        actualCashCount: 1000,
        closedOffline: true,
        syncState: 'pending',
        closedAtLocal: Date.now(),
      }),
    );
    const confirmBtn = renderModal();

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mocks.closeShift).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('ปิดกะสำเร็จ — Z-Report')).toBeTruthy();
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

  test('copy audit: timeout backstop error does not claim synced/settled/server-accepted/guaranteed/global coverage', () => {
    const forbidden = [
      'ปิดกะแล้ว',
      'ซิงก์แล้ว',
      'บันทึกขึ้นระบบแล้ว',
      'ยืนยันจากเซิร์ฟเวอร์แล้ว',
      'ทุกเครื่อง',
      'ทุกอุปกรณ์',
    ];
    const timeoutMessage =
      'ปิดกะยังไม่สำเร็จ ระบบเชื่อมต่อมีปัญหา กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง';
    for (const word of forbidden) {
      expect(timeoutMessage).not.toContain(word);
    }
  });
});

describe('CloseShiftModal — Z-Report / ZReportView — Packet 7C-B1 pending-sync badge', () => {
  afterEach(() => {
    cleanup();
    mocks.closeShift.mockReset();
  });

  async function renderClosedZReport(closedShiftOverrides: Partial<Shift>) {
    mocks.closeShift.mockResolvedValue(makeShift(closedShiftOverrides));
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), {
      target: { value: '1000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
    });
  }

  test('renders the pending-sync badge when closedOffline && syncState is pending', async () => {
    await renderClosedZReport({
      status: 'closed',
      actualCashCount: 1000,
      closedOffline: true,
      syncState: 'pending',
      closedAtLocal: Date.now(),
    });

    expect(screen.getByTestId('shift-zreport-sync-pending')).toBeTruthy();
  });

  test('pending badge does not overclaim server acceptance/settlement', async () => {
    await renderClosedZReport({
      status: 'closed',
      actualCashCount: 1000,
      closedOffline: true,
      syncState: 'pending',
      closedAtLocal: Date.now(),
    });

    const badge = screen.getByTestId('shift-zreport-sync-pending');
    for (const forbidden of [
      'ซิงก์แล้ว',
      'ยืนยันจากเซิร์ฟเวอร์แล้ว',
      'settled',
      'guaranteed',
      'ทุกเครื่อง',
      'ทุกอุปกรณ์',
    ]) {
      expect(badge.textContent).not.toContain(forbidden);
    }
  });

  test('no pending badge for a normal (non-offline, non-pending) closed shift', async () => {
    await renderClosedZReport({ status: 'closed', actualCashCount: 1000 });

    expect(screen.queryByTestId('shift-zreport-sync-pending')).toBeNull();
  });

  test('shows device-time label (with the honest device-time qualifier) while pending', async () => {
    const closedAtLocal = new Date('2026-07-09T10:15:00.000Z').getTime();
    await renderClosedZReport({
      status: 'closed',
      actualCashCount: 1000,
      closedOffline: true,
      syncState: 'pending',
      closedAtLocal,
    });

    expect(screen.getByText(/\(เวลาเครื่อง\)/)).toBeTruthy();
  });

  test('a closeShift mock without whenServerConfirmed (legacy/plain shape) never crashes and stays on the pending badge', async () => {
    // makeShift(...) never sets whenServerConfirmed — this exercises the
    // guard in handleClose (`if (result.whenServerConfirmed) {...}`).
    await renderClosedZReport({
      status: 'closed',
      actualCashCount: 1000,
      closedOffline: true,
      syncState: 'pending',
      closedAtLocal: Date.now(),
    });

    expect(screen.getByTestId('shift-zreport-sync-pending')).toBeTruthy();
  });
});

describe('CloseShiftModal — Z-Report — Packet 7C-B2 same-runtime confirmation reconciliation', () => {
  afterEach(() => {
    cleanup();
    mocks.closeShift.mockReset();
    vi.useRealTimers();
  });

  async function renderWithConfirmation(whenServerConfirmed: Promise<unknown>) {
    // `closedAtLocal` is deliberately "now" (not a fixed past date) — the
    // Z-report's stale-badge threshold is age-based, and a fixed historical
    // timestamp would spuriously read as already-stale depending on when
    // this suite runs.
    mocks.closeShift.mockResolvedValue({
      ...makeShift({
        status: 'closed',
        actualCashCount: 1000,
        closedOffline: true,
        syncState: 'pending',
        closedAtLocal: Date.now(),
      }),
      whenServerConfirmed,
    });
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), {
      target: { value: '1000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
    });
  }

  test('flips from pending to confirmed once whenServerConfirmed resolves, showing the resolved server time', async () => {
    await renderWithConfirmation(
      Promise.resolve({ outcome: 'confirmed', closedAt: new Date('2026-07-09T10:20:00.000Z') }),
    );

    expect(await screen.findByTestId('shift-zreport-sync-confirmed')).toBeTruthy();
    expect(screen.queryByTestId('shift-zreport-sync-pending')).toBeNull();
    // Server time replaces the device-time label once confirmed.
    expect(screen.queryByText(/\(เวลาเครื่อง\)/)).toBeNull();
  });

  test('confirmed copy never overclaims settlement/backend/cross-device authority', async () => {
    await renderWithConfirmation(
      Promise.resolve({ outcome: 'confirmed', closedAt: new Date('2026-07-09T10:20:00.000Z') }),
    );

    const badge = await screen.findByTestId('shift-zreport-sync-confirmed');
    for (const forbidden of ['settled', 'guaranteed', 'ทุกเครื่อง', 'ทุกอุปกรณ์', 'Packet 5']) {
      expect(badge.textContent).not.toContain(forbidden);
    }
  });

  test('identity mismatch flips to the attention badge, never claims success', async () => {
    await renderWithConfirmation(Promise.resolve({ outcome: 'identity_mismatch' }));

    const badge = await screen.findByTestId('shift-zreport-sync-attention');
    expect(badge.textContent).toContain('ต้องตรวจสอบ');
    expect(screen.queryByTestId('shift-zreport-sync-confirmed')).toBeNull();
  });

  test('a genuine write rejection flips to the attention badge', async () => {
    await renderWithConfirmation(
      Promise.resolve({ outcome: 'rejected', message: 'permission-denied' }),
    );

    expect(await screen.findByTestId('shift-zreport-sync-attention')).toBeTruthy();
  });

  test('a still_pending confirmation outcome leaves the pending badge as-is (no false confirm)', async () => {
    await renderWithConfirmation(Promise.resolve({ outcome: 'still_pending' }));

    // Allow the resolved promise's .then() to flush.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('shift-zreport-sync-pending')).toBeTruthy();
  });

  test('stale badge appears once the pending close ages past the stale threshold, while still unconfirmed', async () => {
    vi.useFakeTimers();
    const closedAtLocal = Date.now();
    mocks.closeShift.mockResolvedValue({
      ...makeShift({
        status: 'closed',
        actualCashCount: 1000,
        closedOffline: true,
        syncState: 'pending',
        closedAtLocal,
      }),
      whenServerConfirmed: new Promise(() => {}), // never resolves — stays unconfirmed
    });
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), {
      target: { value: '1000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
    });

    expect(screen.getByTestId('shift-zreport-sync-pending')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000); // past the 10-minute stale threshold
    });

    expect(screen.getByTestId('shift-zreport-sync-stale')).toBeTruthy();
    expect(screen.queryByTestId('shift-zreport-sync-pending')).toBeNull();
  });

  // Codex Blocker 1 (semantic) — a closed shift with a null/unresolved
  // `closedAt` that is NOT sync-pending and has no confirmation must render the
  // em-dash fallback via `formatShiftTime`, never crash. (The type fix widened
  // `formatShiftTime` to accept `Timestamp | null`; this locks the behavior.)
  test('null/absent closedAt renders the em-dash fallback (no crash) when not sync-pending and unconfirmed', async () => {
    mocks.closeShift.mockResolvedValue({
      ...makeShift({ status: 'closed', actualCashCount: 1000, closedAt: null }),
      whenServerConfirmed: new Promise(() => {}), // never resolves — stays unconfirmed
    });
    render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), {
      target: { value: '1000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
    });

    expect(await screen.findByText('ปิดกะสำเร็จ — Z-Report')).toBeTruthy();
    // Not offline/pending → no device-time label; null closedAt → em-dash fallback.
    expect(screen.queryByTestId('shift-zreport-sync-pending')).toBeNull();
    const meta = document.querySelector('.shift-zreport-meta');
    expect(meta?.textContent).toContain('ปิดกะ —');
  });

  // Codex Finding 3 — a late `whenServerConfirmed` that resolves AFTER the modal
  // unmounts (cashier dismissed the Z-report) must not update state. The
  // positive companion — a current mounted report DOES flip to confirmed — is
  // proven by 'flips from pending to confirmed ...' above.
  test('late confirmation after unmount does not update state or warn (mounted guard)', async () => {
    let resolveConfirm!: (o: unknown) => void;
    const deferred = new Promise<unknown>((res) => {
      resolveConfirm = res;
    });
    mocks.closeShift.mockResolvedValue({
      ...makeShift({
        status: 'closed',
        actualCashCount: 1000,
        closedOffline: true,
        syncState: 'pending',
        closedAtLocal: Date.now(),
      }),
      whenServerConfirmed: deferred,
    });
    const { unmount } = render(
      createElement(CloseShiftModal, {
        shift: makeShift(),
        onClose: vi.fn(),
        onSuccess: vi.fn(),
      }),
    );
    fireEvent.change(screen.getByLabelText('นับเงินสดในลิ้นชัก (Actual Cash in Drawer)'), {
      target: { value: '1000' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'ปิดกะ' }));
    });
    expect(screen.getByTestId('shift-zreport-sync-pending')).toBeTruthy();

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    unmount();
    // Resolve AFTER unmount — the mounted guard must swallow the state update.
    await act(async () => {
      resolveConfirm({ outcome: 'confirmed', closedAt: new Date() });
      await deferred;
      await Promise.resolve();
    });

    // No React "state update on an unmounted component" warning, and no throw
    // (act() would have rejected on an unhandled error).
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe('ShiftBootBlockedModal — Packet 7C-B2 boot fail-closed / attention state', () => {
  afterEach(() => cleanup());

  test('renders honest unverifiable copy and a retry action; never claims the shift is safely open', () => {
    const onRetry = vi.fn();
    render(createElement(ShiftBootBlockedModal, { onRetry }));

    expect(screen.getByText('ไม่สามารถยืนยันสถานะกะได้')).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'ไม่สามารถยืนยันสถานะกะได้' });
    for (const forbidden of ['เปิดกะแล้ว', 'ซิงก์แล้ว', 'ยืนยันจากเซิร์ฟเวอร์แล้ว', 'ทุกเครื่อง']) {
      expect(dialog.textContent).not.toContain(forbidden);
    }
  });

  test('retry button invokes onRetry', () => {
    const onRetry = vi.fn();
    render(createElement(ShiftBootBlockedModal, { onRetry }));

    fireEvent.click(screen.getByRole('button', { name: 'ลองตรวจสอบอีกครั้ง' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
