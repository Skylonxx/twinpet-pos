// @vitest-environment jsdom
// Packet 023 pending-lookup race remediation (Codex second re-review).
// Gate ON: a credit payment (cash / transfer) lands in the active shift's drawer,
// so it may be submitted only after a SETTLED lookup for the CURRENT
// (branchId, staffId). While the lookup is unresolved — or after an identity
// change, or when a late response from a superseded identity arrives — the
// payment must not be sent with `shiftId: undefined` or a stale shift.
// The lookup Promise is held genuinely unresolved and the click is fired BEFORE it settles.

import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Customer } from '../../lib/types';

const gate = { on: true };
const getActiveShiftMock = vi.fn<(branchId: string, staffId: string) => Promise<unknown>>();
const receiveCreditPaymentMock = vi.fn<(input: Record<string, unknown>) => Promise<number>>();

vi.mock('../../lib/firebase', () => ({ isFirebaseConfigured: true, db: {} }));
vi.mock('../../lib/pos/shiftCloseAuthoritativeClient', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/pos/shiftCloseAuthoritativeClient')>();
  return {
    ...actual,
    get SERVER_AUTHORITATIVE_CLOSE_ENABLED() {
      return gate.on;
    },
  };
});
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
import { ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, useActiveShift } from '../../lib/hooks/useActiveShift';
import CreditPaymentModal from './CreditPaymentModal';
import DebtorManagerDialog from './DebtorManagerDialog';

const customer = { id: 'C1', firstName: 'ลูกค้า', lastName: 'ทดสอบ', outstandingBalance: 300, creditLimit: 1000 } as unknown as Customer;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Each `getActiveShift` call gets its own held-open Promise, in call order. */
function holdLookups() {
  const lookups: Array<Deferred<unknown> & { branchId: string; staffId: string }> = [];
  getActiveShiftMock.mockImplementation((branchId, staffId) => {
    const d = deferred<unknown>();
    lookups.push({ ...d, branchId, staffId });
    return d.promise;
  });
  return lookups;
}

/** Calls the button's React `onClick` directly — the path a disabled button's DOM click never reaches. */
async function invokeHandler(el: HTMLElement) {
  const propsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'));
  const onClick = (el as unknown as Record<string, { onClick?: () => void }>)[propsKey!]?.onClick;
  expect(onClick).toBeTypeOf('function');
  await act(async () => {
    onClick!();
  });
}

beforeEach(() => {
  gate.on = true;
  getActiveShiftMock.mockReset();
  receiveCreditPaymentMock.mockReset();
  receiveCreditPaymentMock.mockResolvedValue(0);
});

afterEach(() => {
  cleanup();
});

describe('useActiveShift — current-identity state', () => {
  test('identity change: the previous identity\'s shift is never exposed, not even in the render that changes it', async () => {
    const lookups = holdLookups();
    const seen: Array<{ staff: string; activeShift: unknown; loading: boolean }> = [];
    const { result, rerender } = renderHook(
      ({ s }) => {
        const r = useActiveShift('LDP-001', s);
        seen.push({ staff: s, ...r });
        return r;
      },
      { initialProps: { s: 'staff-x' } },
    );
    expect(result.current).toEqual({ activeShift: null, loading: true, unavailable: false });
    await act(async () => lookups[0]!.resolve({ id: 'X1' }));
    expect(result.current).toEqual({ activeShift: { id: 'X1' }, loading: false, unavailable: false });

    seen.length = 0;
    rerender({ s: 'staff-y' });
    expect(lookups).toHaveLength(2);
    expect(result.current).toEqual({ activeShift: null, loading: true, unavailable: false });
    expect(seen.length).toBeGreaterThan(0);
    for (const r of seen) expect(r).toMatchObject({ staff: 'staff-y', activeShift: null, loading: true });
  });

  test('a late response (resolve or reject) of a superseded identity cannot overwrite the current one', async () => {
    const lookups = holdLookups();
    const { result, rerender } = renderHook(({ s }) => useActiveShift('LDP-001', s), { initialProps: { s: 'staff-x' } });
    rerender({ s: 'staff-y' });
    await act(async () => lookups[1]!.resolve({ id: 'Y1' }));
    await act(async () => lookups[0]!.resolve({ id: 'X-LATE' }));
    expect(result.current).toEqual({ activeShift: { id: 'Y1' }, loading: false, unavailable: false });

    const lookups2 = holdLookups();
    rerender({ s: 'staff-z' });
    rerender({ s: 'staff-w' });
    await act(async () => lookups2[1]!.resolve({ id: 'W1' }));
    await act(async () => lookups2[0]!.reject(new ActiveShiftUnavailableError()));
    expect(result.current).toEqual({ activeShift: { id: 'W1' }, loading: false, unavailable: false });
  });

  test('A→B→A: the first A result is not "current" for the second A; only the latest lookup settles it', async () => {
    const lookups = holdLookups();
    const { result, rerender } = renderHook(({ s }) => useActiveShift('LDP-001', s), { initialProps: { s: 'A' } });
    await act(async () => lookups[0]!.resolve({ id: 'A1' }));
    expect(result.current.activeShift).toEqual({ id: 'A1' });
    rerender({ s: 'B' });
    rerender({ s: 'A' });
    expect(lookups).toHaveLength(3);
    expect(result.current).toEqual({ activeShift: null, loading: true, unavailable: false });
    await act(async () => lookups[1]!.resolve({ id: 'B1' }));
    expect(result.current).toEqual({ activeShift: null, loading: true, unavailable: false });
    await act(async () => lookups[2]!.resolve({ id: 'A2' }));
    expect(result.current).toEqual({ activeShift: { id: 'A2' }, loading: false, unavailable: false });
  });

  test('a completed readable null is "no open shift" — neither pending nor unavailable', async () => {
    getActiveShiftMock.mockResolvedValue(null);
    const { result } = renderHook(() => useActiveShift('LDP-001', 'staff-x'));
    await act(async () => undefined);
    expect(result.current).toEqual({ activeShift: null, loading: false, unavailable: false });
  });
});

type Mount = { branchId: string; actorId: string };
const consumers = [
  {
    name: 'CreditPaymentModal',
    submit: 'ยืนยันรับชำระ',
    el: (p: Mount, onToast: (m: string, t?: string) => void) => (
      <CreditPaymentModal customer={customer} branchId={p.branchId} actorId={p.actorId} isOpen onClose={() => undefined} onToast={onToast} />
    ),
  },
  {
    name: 'DebtorManagerDialog',
    submit: 'บันทึกรับชำระ',
    el: (p: Mount, onToast: (m: string, t?: string) => void) => (
      <DebtorManagerDialog customer={customer} branchId={p.branchId} actorId={p.actorId} isOpen onClose={() => undefined} onToast={onToast} />
    ),
  },
];

const PENDING_LABEL = 'กำลังตรวจสอบกะ...';

describe.each(consumers)('$name — gate ON, pending / stale active-shift lookup', ({ submit, el }) => {
  const mount = (p: Mount = { branchId: 'LDP-001', actorId: 'staff-x' }) => {
    const onToast = vi.fn();
    const view = render(el(p, onToast));
    return { onToast, rerenderAs: (next: Mount) => view.rerender(el(next, onToast)) };
  };
  const selectMethod = (method: 'cash' | 'transfer') =>
    fireEvent.change(screen.getByDisplayValue('เงินสด (Cash)'), { target: { value: method } });

  test.each(['cash', 'transfer'] as const)(
    '%s: submit BEFORE the lookup settles is refused (button + handler); a later rejection still pays nothing',
    async (method) => {
      const lookups = holdLookups();
      const { onToast } = mount();
      selectMethod(method);
      const button = screen.getByText(PENDING_LABEL) as HTMLButtonElement;
      expect((button as HTMLButtonElement).disabled).toBe(true);

      fireEvent.click(button);
      await invokeHandler(button);
      expect(receiveCreditPaymentMock).not.toHaveBeenCalled();
      expect(onToast).toHaveBeenCalledWith(ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, 'warn');

      await act(async () => lookups[0]!.reject(new ActiveShiftUnavailableError()));
      expect(receiveCreditPaymentMock).not.toHaveBeenCalled();

      // After it settles unavailable the honest unavailable copy applies and still nothing is paid.
      await act(async () => {
        fireEvent.click(screen.getByText(submit));
      });
      expect(onToast).toHaveBeenCalledWith(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
      expect(receiveCreditPaymentMock).not.toHaveBeenCalled();
    },
  );

  test.each(['cash', 'transfer'] as const)(
    '%s: after a resolved lookup the single payment carries the current shift (exactly one call)',
    async (method) => {
      const lookups = holdLookups();
      mount();
      selectMethod(method);
      await act(async () => lookups[0]!.resolve({ id: 'B' }));
      await act(async () => {
        fireEvent.click(screen.getByText(submit));
      });
      expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
      expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'B', amount: 300, paymentMethod: method });
    },
  );

  test('completed readable null (no open shift) is NOT pending/unavailable: existing policy — payment recorded without a shift', async () => {
    const lookups = holdLookups();
    const { onToast } = mount();
    await act(async () => lookups[0]!.resolve(null));
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: undefined });
    expect(onToast).not.toHaveBeenCalledWith(ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, 'warn');
    expect(onToast).not.toHaveBeenCalledWith(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
  });

  test.each(['cash', 'transfer'] as const)(
    '%s: staff change after B was available — B is not usable while the new lookup is pending',
    async (method) => {
      const lookups = holdLookups();
      const { rerenderAs } = mount({ branchId: 'LDP-001', actorId: 'staff-x' });
      selectMethod(method);
      await act(async () => lookups[0]!.resolve({ id: 'B' }));
      expect((screen.getByText(submit) as HTMLButtonElement).disabled).toBe(false);

      rerenderAs({ branchId: 'LDP-001', actorId: 'staff-y' });
      const button = screen.getByText(PENDING_LABEL) as HTMLButtonElement;
      expect((button as HTMLButtonElement).disabled).toBe(true);
      await invokeHandler(button);
      expect(receiveCreditPaymentMock).not.toHaveBeenCalled();

      // the new lookup settles for the new identity
      await act(async () => lookups[1]!.resolve({ id: 'Y' }));
      await act(async () => {
        fireEvent.click(screen.getByText(submit));
      });
      expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
      expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'Y', createdBy: 'staff-y', paymentMethod: method });
    },
  );

  // Late-response cases: the OLD lookup is still genuinely unsettled when the identity changes,
  // so resolving / rejecting it afterwards really is a late response (a settled promise cannot be settled again).
  test.each(['cash', 'transfer'] as const)(
    '%s: staff change while the old lookup is still unsettled — its late RESOLVE cannot supply the shift',
    async (method) => {
      const lookups = holdLookups();
      const { rerenderAs } = mount({ branchId: 'LDP-001', actorId: 'staff-x' });
      selectMethod(method);
      rerenderAs({ branchId: 'LDP-001', actorId: 'staff-y' });
      expect(lookups).toHaveLength(2);
      expect((screen.getByText(PENDING_LABEL) as HTMLButtonElement).disabled).toBe(true);

      // the new lookup settles first, then the still-unsettled OLD one resolves late with a stale shift
      await act(async () => lookups[1]!.resolve({ id: 'Y' }));
      await act(async () => lookups[0]!.resolve({ id: 'B-LATE' }));
      await act(async () => {
        fireEvent.click(screen.getByText(submit));
      });
      expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
      expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'Y', createdBy: 'staff-y', paymentMethod: method });
    },
  );

  test.each(['cash', 'transfer'] as const)(
    '%s: staff change — an old lookup resolving late while the new one is still pending does not unblock the payment',
    async (method) => {
      const lookups = holdLookups();
      const { rerenderAs } = mount({ branchId: 'LDP-001', actorId: 'staff-x' });
      selectMethod(method);
      rerenderAs({ branchId: 'LDP-001', actorId: 'staff-y' });

      await act(async () => lookups[0]!.resolve({ id: 'B-LATE' }));
      const button = screen.getByText(PENDING_LABEL) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await invokeHandler(button);
      expect(receiveCreditPaymentMock).not.toHaveBeenCalled();
    },
  );

  test('branch change: submit blocked while pending', async () => {
    const lookups = holdLookups();
    const { rerenderAs } = mount({ branchId: 'LDP-001', actorId: 'staff-x' });
    await act(async () => lookups[0]!.resolve({ id: 'B' }));
    rerenderAs({ branchId: 'LDP-002', actorId: 'staff-x' });
    const button = screen.getByText(PENDING_LABEL) as HTMLButtonElement;
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await invokeHandler(button);
    expect(receiveCreditPaymentMock).not.toHaveBeenCalled();

    await act(async () => lookups[1]!.resolve({ id: 'L2' }));
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'L2', branchId: 'LDP-002' });
  });

  test('branch change while the old lookup is still unsettled — its late REJECT does not poison the new result', async () => {
    const lookups = holdLookups();
    const { rerenderAs, onToast } = mount({ branchId: 'LDP-001', actorId: 'staff-x' });
    rerenderAs({ branchId: 'LDP-002', actorId: 'staff-x' });
    expect(lookups).toHaveLength(2);
    expect((screen.getByText(PENDING_LABEL) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => lookups[1]!.resolve({ id: 'L2' }));
    await act(async () => lookups[0]!.reject(new ActiveShiftUnavailableError()));
    expect(onToast).not.toHaveBeenCalledWith(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'L2', branchId: 'LDP-002' });
  });

  test('branch change — an old lookup rejecting late while the new one is still pending does not read as unavailable or unblock', async () => {
    const lookups = holdLookups();
    const { rerenderAs, onToast } = mount({ branchId: 'LDP-001', actorId: 'staff-x' });
    rerenderAs({ branchId: 'LDP-002', actorId: 'staff-x' });

    await act(async () => lookups[0]!.reject(new ActiveShiftUnavailableError()));
    const button = screen.getByText(PENDING_LABEL) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await invokeHandler(button);
    expect(receiveCreditPaymentMock).not.toHaveBeenCalled();
    expect(onToast).toHaveBeenCalledWith(ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, 'warn');
    expect(onToast).not.toHaveBeenCalledWith(ACTIVE_SHIFT_LOCAL_STATE_UNAVAILABLE_MESSAGE, 'warn');
  });

  test('A→B→A: the earlier A result does not make the second A "ready"', async () => {
    const lookups = holdLookups();
    const { rerenderAs } = mount({ branchId: 'LDP-001', actorId: 'A' });
    await act(async () => lookups[0]!.resolve({ id: 'SA1' }));
    rerenderAs({ branchId: 'LDP-001', actorId: 'B' });
    rerenderAs({ branchId: 'LDP-001', actorId: 'A' });
    const button = screen.getByText(PENDING_LABEL) as HTMLButtonElement;
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await invokeHandler(button);
    expect(receiveCreditPaymentMock).not.toHaveBeenCalled();

    await act(async () => lookups[1]!.resolve({ id: 'SB' }));
    expect((screen.getByText(PENDING_LABEL) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => lookups[2]!.resolve({ id: 'SA2' }));
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'SA2' });
  });
});

describe.each(consumers)('$name — gate OFF keeps the legacy behavior', ({ submit, el }) => {
  const mount = () => {
    const onToast = vi.fn();
    render(el({ branchId: 'LDP-001', actorId: 'staff-x' }, onToast));
    return { onToast };
  };

  test('lookup still pending: NOT newly restricted — button enabled, payment recorded without a shift, no pending copy', async () => {
    gate.on = false;
    holdLookups();
    const { onToast } = mount();
    expect((screen.getByText(submit) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock).toHaveBeenCalledTimes(1);
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: undefined, paymentMethod: 'cash' });
    expect(onToast).not.toHaveBeenCalledWith(ACTIVE_SHIFT_LOOKUP_PENDING_MESSAGE, 'warn');
  });

  test('resolved shift and resolved null: attribution unchanged', async () => {
    gate.on = false;
    const lookups = holdLookups();
    mount();
    await act(async () => lookups[0]!.resolve({ id: 'B' }));
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: 'B' });
    cleanup();
    receiveCreditPaymentMock.mockClear();

    const lookups2 = holdLookups();
    mount();
    await act(async () => lookups2[0]!.resolve(null));
    await act(async () => {
      fireEvent.click(screen.getByText(submit));
    });
    expect(receiveCreditPaymentMock.mock.calls[0]![0]).toMatchObject({ shiftId: undefined });
  });
});
