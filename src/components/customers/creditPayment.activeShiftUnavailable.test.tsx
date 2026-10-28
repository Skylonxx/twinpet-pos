// @vitest-environment jsdom
// Packet 023 fail-closed remediation (Codex re-review): `useActiveShift` and
// its two consumers (CreditPaymentModal, DebtorManagerDialog). A credit payment
// lands in the active shift's drawer (`shiftId`): when the active shift cannot
// be told (gate ON, close journal unreadable ⇒ ActiveShiftUnavailableError) the
// payment is refused with honest copy — never recorded against no shift, never
// against a shift this device closed locally.

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Customer } from '../../lib/types';

const getActiveShiftMock = vi.fn<(branchId: string, staffId: string) => Promise<unknown>>();
const receiveCreditPaymentMock = vi.fn<(input: Record<string, unknown>) => Promise<number>>();

vi.mock('../../lib/firebase', () => ({ isFirebaseConfigured: true, db: {} }));
vi.mock('../../lib/pos/shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftService')>();
  return { ...actual, getActiveShift: (b: string, s: string) => getActiveShiftMock(b, s) };
});
vi.mock('../../lib/customers/creditService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/customers/creditService')>();
  return {
    ...actual,
    receiveCreditPayment: (input: Record<string, unknown>) => receiveCreditPaymentMock(input),
    useCustomerCreditPayments: () => ({ payments: [], loading: false, error: null }),
  };
});

import { ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, ActiveShiftUnavailableError } from '../../lib/pos/shiftService';
import { useActiveShift } from '../../lib/hooks/useActiveShift';
import CreditPaymentModal from './CreditPaymentModal';
import DebtorManagerDialog from './DebtorManagerDialog';

const customer = { id: 'C1', firstName: 'ลูกค้า', lastName: 'ทดสอบ', outstandingBalance: 300, creditLimit: 1000 } as unknown as Customer;

beforeEach(() => {
  getActiveShiftMock.mockReset();
  receiveCreditPaymentMock.mockReset();
  receiveCreditPaymentMock.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
});

describe('useActiveShift', () => {
  test('ActiveShiftUnavailableError ⇒ `unavailable` (not "no shift"), loading settles, no shift', async () => {
    getActiveShiftMock.mockRejectedValue(new ActiveShiftUnavailableError());
    const { result } = renderHook(() => useActiveShift('LDP-001', 'staff-x'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ activeShift: null, loading: false, unavailable: true });
  });

  test('a readable result is unchanged: the shift, or null when none is open', async () => {
    getActiveShiftMock.mockResolvedValueOnce({ id: 'B' });
    const { result, rerender } = renderHook(({ s }) => useActiveShift('LDP-001', s), { initialProps: { s: 'staff-x' } });
    await waitFor(() => expect(result.current.activeShift).toEqual({ id: 'B' }));
    expect(result.current.unavailable).toBe(false);
    getActiveShiftMock.mockResolvedValueOnce(null);
    rerender({ s: 'staff-y' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual({ activeShift: null, loading: false, unavailable: false });
  });
});

const consumers = [
  {
    name: 'CreditPaymentModal',
    submit: 'ยืนยันรับชำระ',
    render: (onToast: (m: string, t?: string) => void) =>
      render(<CreditPaymentModal customer={customer} branchId="LDP-001" actorId="staff-x" isOpen onClose={() => undefined} onToast={onToast} />),
  },
  {
    name: 'DebtorManagerDialog',
    submit: 'บันทึกรับชำระ',
    render: (onToast: (m: string, t?: string) => void) =>
      render(<DebtorManagerDialog customer={customer} branchId="LDP-001" actorId="staff-x" isOpen onClose={() => undefined} onToast={onToast} />),
  },
];

describe.each(consumers)('$name — credit payment and the active shift', ({ submit, render: renderConsumer }) => {
  test.each(['cash', 'transfer'] as const)(
    'active shift unavailable (journal unreadable): a %s payment is refused with honest copy — receiveCreditPayment is never called',
    async (method) => {
      getActiveShiftMock.mockRejectedValue(new ActiveShiftUnavailableError());
      const onToast = vi.fn();
      renderConsumer(onToast);
      await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalledWith('LDP-001', 'staff-x'));
      await act(async () => undefined); // let the rejection settle into the hook state
      fireEvent.change(screen.getByDisplayValue('เงินสด (Cash)'), { target: { value: method } });
      await act(async () => {
        fireEvent.click(screen.getByText(submit));
      });
      expect(onToast).toHaveBeenCalledWith(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
      expect(receiveCreditPaymentMock).not.toHaveBeenCalled();
    },
  );

  test('positive control: a resolved active shift B is attached to the payment', async () => {
    getActiveShiftMock.mockResolvedValue({ id: 'B' });
    const onToast = vi.fn();
    renderConsumer(onToast);
    await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalled());
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'B', amount: 300, paymentMethod: 'cash' });
    expect(onToast).not.toHaveBeenCalledWith(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
  });

  test('legacy unchanged: no open shift (null) still records the payment without a shift', async () => {
    getActiveShiftMock.mockResolvedValue(null);
    renderConsumer(vi.fn());
    await waitFor(() => expect(getActiveShiftMock).toHaveBeenCalled());
    await act(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: undefined });
  });
});
