// @vitest-environment jsdom

// Return/Refund V1 packet 022 — the close modal hands the server-authoritative
// close the shift's ledger sales it was given (the same list the shown drawer
// was derived from), and NOTHING when it was given none: an unavailable ledger
// stays `undefined` (the adapter refuses it), never an invented `[]`. While the
// gate is OFF the call stays exactly `closeShift(shift, count, note)` and no
// callable transport is ever resolved.
//
// Provenance: on the parent (6376403) the modal has no `sales` input, so the
// ON cases that expect the list fail on BEHAVIOUR (the adapter would refuse
// every authoritative close with "sales unavailable").
//
// 022-REPAIR: the input is now `closeSales` — the list bound to the shift /
// branch it belongs to — and is forwarded only when that binding is the shift
// being closed (Confirm-time check). Against 2f47412 (which reads `sales`)
// the list cases fail on the CONTRACT (renamed input), not on behaviour.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CloseShiftModal } from './ShiftModals';
import type { LocalSale } from '../../lib/pos/localLedger';
import type { Shift } from '../../lib/types';

const mocks = vi.hoisted(() => ({
  closeShift: vi.fn(),
  readServerShiftCash: vi.fn(),
  getCallable: vi.fn(),
  httpsCallable: vi.fn(),
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
    getDefaultCloseShiftAuthoritativeCallable: mocks.getCallable,
    get SERVER_AUTHORITATIVE_CLOSE_ENABLED() {
      return mocks.gate.on;
    },
  };
});

vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(),
  connectFunctionsEmulator: vi.fn(),
  httpsCallable: mocks.httpsCallable,
}));

function sale(id: string, cash: number): LocalSale {
  return {
    id,
    billId: `bill-${id}`,
    deviceId: 'DEV-1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    staffName: 'ทดสอบ ระบบ',
    customerId: null,
    status: 'completed',
    reconcileStatus: 'pending_reconcile',
    total: cash,
    paidAmt: cash,
    changeAmt: 0,
    creditAmt: 0,
    payments: [{ method: 'cash', amount: cash }],
    pendingSync: false,
    clientCreatedAt: 1,
    occurredAt: 1,
    sortSeq: 1,
  } as LocalSale;
}

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
    totalBills: 2,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries: [],
    ...overrides,
  };
}

const SALES = [sale('DEV-1-1', 400), sale('DEV-1-2', 600)];

type CloseSales = { shiftId: string; branchId: string; sales: readonly LocalSale[] };
type Props = { shift: Shift; sales?: readonly LocalSale[]; closeSales?: CloseSales };

/** 022-REPAIR: sales is shorthand for a list the page bound to this very shift. */
function modal({ sales, ...props }: Props) {
  const closeSales = props.closeSales ?? (sales ? { shiftId: props.shift.id, branchId: props.shift.branchId, sales } : undefined);
  return createElement(CloseShiftModal, { onClose: vi.fn(), onSuccess: vi.fn(), ...props, closeSales } as Parameters<typeof CloseShiftModal>[0]);
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

type CloseCall = [Shift, number, string, { authoritativeClose?: { sales?: readonly LocalSale[]; reviewedDrawer?: unknown } }?];
const lastCall = () => mocks.closeShift.mock.calls.at(-1) as CloseCall;

beforeEach(() => {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
  mocks.gate.on = false;
  mocks.closeShift.mockReset();
  mocks.closeShift.mockReturnValue(new Promise(() => undefined));
  mocks.readServerShiftCash.mockReset();
  mocks.readServerShiftCash.mockResolvedValue({ ok: true, exists: true, status: 'open', cashEntries: [] });
  mocks.getCallable.mockReset();
  mocks.httpsCallable.mockReset();
});

afterEach(() => cleanup());

describe('022 — gate OFF: the legacy close call is unchanged by the sales input', () => {
  test('[GREEN-guard] loaded sales given ⇒ still exactly closeShift(shift, count, note); no callable transport is resolved', async () => {
    const shift = makeShift();
    render(modal({ shift, sales: SALES }));
    await flush();
    await confirm('1500');
    expect(mocks.closeShift).toHaveBeenCalledTimes(1);
    expect(mocks.closeShift.mock.calls[0]).toEqual([shift, 1500, '']);
    expect(mocks.getCallable).not.toHaveBeenCalled();
    expect(mocks.httpsCallable).not.toHaveBeenCalled();
  });

  test('[GREEN-guard] unavailable sales ⇒ the same three-argument legacy call', async () => {
    const shift = makeShift();
    render(modal({ shift }));
    await flush();
    await confirm('1500');
    expect(mocks.closeShift.mock.calls[0]).toEqual([shift, 1500, '']);
    expect(mocks.getCallable).not.toHaveBeenCalled();
  });
});

describe('022 — gate ON: the adapter receives the scoped ledger sales', () => {
  beforeEach(() => {
    mocks.gate.on = true;
  });

  test('[RED-parent] loaded sales ⇒ the exact list (same reference) beside the reviewed-drawer witness', async () => {
    render(modal({ shift: makeShift(), sales: SALES }));
    await flush();
    await confirm('1500');
    const ac = lastCall()[3]?.authoritativeClose;
    expect(ac?.sales).toBe(SALES);
    expect(ac?.reviewedDrawer).toMatchObject({ shiftId: 'shift-1', branchId: 'LDP-001', serverRefresh: 'loaded', expectedDrawer: 1500 });
  });

  test('[RED-parent] a loaded EMPTY ledger is passed as that empty list (a genuine zero, never dropped)', async () => {
    const none: LocalSale[] = [];
    render(modal({ shift: makeShift({ expectedCash: 0, totalBills: 0 }), sales: none }));
    await flush();
    await confirm('500');
    expect(lastCall()[3]?.authoritativeClose?.sales).toBe(none);
  });

  test('[GREEN-guard] unavailable sales ⇒ `undefined` reaches the adapter (it refuses) — never an invented []', async () => {
    render(modal({ shift: makeShift() }));
    await flush();
    await confirm('1500');
    const ac = lastCall()[3]?.authoritativeClose;
    expect(ac).toBeDefined();
    expect(ac?.sales).toBeUndefined();
  });

  test('[RED-parent] the list is live: a sale arriving before Confirm is in the handed list (with its re-derived drawer)', async () => {
    const { rerender } = render(modal({ shift: makeShift({ expectedCash: 400, totalBills: 1 }), sales: SALES.slice(0, 1) }));
    await flush();
    const updatedShift = makeShift();
    rerender(modal({ shift: updatedShift, sales: SALES }));
    await flush();
    await confirm('1500');
    const call = lastCall();
    expect(call[0]).toBe(updatedShift);
    expect(call[3]?.authoritativeClose?.sales).toBe(SALES);
  });

  test('[GREEN-guard] the ledger going unavailable before Confirm is honoured (no stale list is sent)', async () => {
    const { rerender } = render(modal({ shift: makeShift(), sales: SALES }));
    await flush();
    rerender(modal({ shift: makeShift() }));
    await flush();
    await confirm('1500');
    expect(lastCall()[3]?.authoritativeClose?.sales).toBeUndefined();
    expect(mocks.closeShift).toHaveBeenCalledTimes(1);
  });
});

describe('022-REPAIR — Confirm-time binding: a list is only ever handed to the shift it was bound to', () => {
  beforeEach(() => {
    mocks.gate.on = true;
  });

  test.each([
    ['another shift', { shiftId: 'shift-OTHER', branchId: 'LDP-001' }],
    ['another branch', { shiftId: 'shift-1', branchId: 'LDP-002' }],
  ])('[GREEN-guard] a list bound to %s ⇒ `undefined` (refused), even when it is empty', async (_label, binding) => {
    for (const sales of [SALES, [] as LocalSale[]]) {
      render(modal({ shift: makeShift(), closeSales: { ...binding, sales } }));
      await flush();
      await confirm('1500');
      expect(lastCall()[3]?.authoritativeClose?.sales).toBeUndefined();
      cleanup();
    }
  });

  test('[GREEN-guard] an open modal whose shift changes under it hands the old shift\'s list to nobody', async () => {
    const { rerender } = render(modal({ shift: makeShift(), sales: SALES }));
    await flush();
    const other = makeShift({ id: 'shift-2', branchId: 'LDP-002' });
    // The page re-rendered with another shift but (wrongly) the old binding.
    rerender(modal({ shift: other, closeSales: { shiftId: 'shift-1', branchId: 'LDP-001', sales: SALES } }));
    await flush();
    await confirm('1500');
    expect(lastCall()[0]).toBe(other);
    expect(lastCall()[3]?.authoritativeClose?.sales).toBeUndefined();
  });

  test('[GREEN-guard] gate OFF: a bound list never reaches the legacy close (three arguments)', async () => {
    mocks.gate.on = false;
    const shift = makeShift();
    render(modal({ shift, sales: SALES }));
    await flush();
    await confirm('1500');
    expect(mocks.closeShift.mock.calls[0]).toEqual([shift, 1500, '']);
  });
});
