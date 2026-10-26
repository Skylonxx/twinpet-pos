// @vitest-environment jsdom

// Return/Refund V1 packet 022-REPAIR (Codex 022 BLOCKED) — the branch / shift
// identity race of the server-authoritative close handoff, driven through the
// REAL producer → page → modal chain:
//   - REAL `useLocalLedger` (only the Firestore `onSnapshot` transport is a
//     deterministic fake whose callbacks the test fires),
//   - REAL `POSPage` shift boot (`readActiveShiftForBoot` is a deferred promise
//     per call, resolved by the test — no sleeps),
//   - REAL `CloseShiftModal` (wrapped only to record its props),
//   - `closeShift` is MOCKED at the service boundary (it records and rejects);
//     what the adapter would do with the handed list is shown with the REAL
//     `buildAuthoritativeCloseRequestBody`. `sales: undefined` is refused by the
//     real service before any write/attempt/callable/Z
//     (`shiftService.authoritativeClose.test.ts` › "ON without the ledger sales").
// The source gate is switched ON only through the module getter mock below.
//
// Provenance: on the parent (2f47412) the selected branch's ledger is folded
// against whatever shift is still mounted, so B's empty answer reaches an
// ON close of shift A as `sales: []` — a zero the real builder accepts.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AsyncOrder, Shift } from '../lib/types';
import type { LocalSale } from '../lib/pos/localLedger';

type Sub = {
  branchId: unknown;
  next: (snap: { docs: Array<{ id: string; data: () => unknown }> }) => void;
  error: (err: unknown) => void;
  unsub: ReturnType<typeof vi.fn>;
};
type BootCall = { branchId: string; resolve: (v: unknown) => void };
type CloseCall = [Shift, number, string, { authoritativeClose?: { sales?: readonly LocalSale[] } }?];

const USER = { id: 'U1', firstName: 'Test', lastName: 'User' };

const mocks = vi.hoisted(() => ({
  auth: { branchId: 'BR-A' as string | null },
  gate: { on: false },
  subs: [] as Sub[],
  boots: [] as BootCall[],
  closeShift: vi.fn(),
  getCallable: vi.fn(),
  modalProps: [] as Array<Record<string, unknown>>,
}));

// ── Firestore transport: only the ledger listener is faked ─────────────────
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  collection: (_db: unknown, name: string) => ({ name }),
  where: (field: string, op: string, value: unknown) => ({ field, op, value }),
  query: (_c: unknown, ...constraints: Array<{ field: string; value: unknown }>) => ({ constraints }),
  onSnapshot: (q: { constraints: Array<{ field: string; value: unknown }> }, next: Sub['next'], error: Sub['error']) => {
    const unsub = vi.fn();
    mocks.subs.push({ branchId: q.constraints.find((c) => c.field === 'branchId')?.value, next, error, unsub });
    return unsub;
  },
}));
vi.mock('../lib/firebase', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  db: {},
  isFirebaseConfigured: true,
}));

// ── Page dependencies ──────────────────────────────────────────────────────
vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: USER, branchId: mocks.auth.branchId }),
}));
vi.mock('../lib/hooks/useBranch', () => ({ useBranch: () => ({ branch: { name: 'สาขาทดสอบ' } }) }));
vi.mock('../hooks/pos/usePosInventory', () => ({
  usePosInventory: () => ({
    products: [], categories: [], richCategories: [], sorting: {}, quickMenus: [],
    fromCache: false, loading: false, refreshing: false, error: null, refreshInventory: vi.fn(),
  }),
}));
vi.mock('../hooks/pos/usePosSyncSignal', () => ({ usePosSyncSignal: () => ({ lastForceUpdate: null, initialized: true }) }));
vi.mock('../hooks/pos/usePOSPreferences', () => ({
  usePOSPreferences: () => ({ gridColumns: 4, fontSize: 'md', showStock: true, productNameFontSize: 'md', priceFontSize: 'md' }),
}));
vi.mock('../lib/pricing/priceLevels', () => ({ usePriceLevels: () => ({ priceLevels: [] }), priceLevelLabel: () => '' }));
vi.mock('../lib/pos/useSuspendedBills', () => ({
  useSuspendedBills: () => ({ bills: [], count: 0, addBill: vi.fn(), removeBill: vi.fn(), reload: vi.fn() }),
}));
vi.mock('../hooks/pos/useCart', () => ({
  getActivePriceForCustomer: () => ({ unitPrice: 0, originalPrice: 0 }),
  useCart: () => ({
    cart: {}, cartLines: [],
    totals: { subtotal: 0, billDiscount: 0, fee: 0, grandTotal: 0, itemCount: 0, totalQty: 0 },
    receiptLines: [], cartQtyByProduct: new Map(),
    billDiscValue: 0, setBillDiscValue: vi.fn(), billDiscPercent: false, setBillDiscPercent: vi.fn(),
    feeRate: 0, setFeeRate: vi.fn(), addToCart: vi.fn(), changeQty: vi.fn(), removeLine: vi.fn(),
    setLineQty: vi.fn(() => true), setLineDiscount: vi.fn(), clearCart: vi.fn(), restoreCart: vi.fn(),
  }),
}));
vi.mock('../hooks/pos/useCheckout', () => ({
  useCheckout: () => ({
    customer: null, setCustomer: vi.fn(), selectCustomer: vi.fn(), clearCustomer: vi.fn(),
    customerModalOpen: false, openCustomerModal: vi.fn(), closeCustomerModal: vi.fn(),
    processing: false, confirmSale: vi.fn(),
  }),
}));
vi.mock('../components/ui/use-toast', () => ({ useToastDispatcher: () => vi.fn() }));

vi.mock('../lib/pos/shiftService', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readActiveShiftForBoot: (branchId: string) =>
    new Promise((resolve) => {
      mocks.boots.push({ branchId, resolve });
    }),
  readShiftCloseConfirmation: vi.fn(),
  readShiftOpenConfirmation: vi.fn(),
  normalizeShiftCloseSyncState: vi.fn(),
  reissueShiftOpenWrite: vi.fn(),
  closeShift: mocks.closeShift,
  openShift: vi.fn(),
}));
vi.mock('../lib/pos/shiftCashFreshness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readServerShiftCash: vi.fn().mockResolvedValue({ ok: true, exists: true, status: 'open', cashEntries: [] }),
}));
vi.mock('../lib/pos/shiftCloseAuthoritativeClient', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getDefaultCloseShiftAuthoritativeCallable: mocks.getCallable,
    get SERVER_AUTHORITATIVE_CLOSE_ENABLED() {
      return mocks.gate.on;
    },
  };
});
vi.mock('../lib/pos/offline/shiftCloseIntentStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createShiftCloseIntentJournal: () => ({
    getCloseIntent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    listCloseIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    listOnlineCloseAttempts: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    upsertCloseIntent: vi.fn(), markSynced: vi.fn(), markRejectedManualAttention: vi.fn(),
    claimLegacyNormalizationChecks: vi.fn().mockResolvedValue({ ok: false, code: 'unavailable', message: 'IndexedDB unavailable' }),
  }),
}));
vi.mock('../lib/pos/offline/shiftOpenIntentStore', () => ({
  createShiftOpenIntentJournal: () => ({
    findRejectedOpenForDevice: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    findPendingOpenForStaff: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    listOpenIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    getOpenIntent: vi.fn(), upsertOpenIntent: vi.fn(), markSynced: vi.fn(), markRejectedManualAttention: vi.fn(),
  }),
}));
vi.mock('../lib/pos/offline/shiftCloseReconciler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({ runShiftOpenReconciliationSweep: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'DEV-TEST' }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/branches', () => ({ getBranchLabel: (b: string) => b }));
vi.mock('../lib/config/features', () => ({ POS_FEATURES: { enableLoyaltyPoints: false } }));

vi.mock('flowbite-react', () => ({ Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../components/pos/SuspendedBillModals', () => ({ HoldBillNoteModal: () => null, SuspendedBillsListModal: () => null }));
vi.mock('../components/pos/ItemDiscountModal', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerPickerModal', () => ({ default: () => null, PosCustomerPick: undefined }));
vi.mock('../components/PaymentModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductPickerDialog', () => ({ default: () => null, posProductToPickerItem: (p: unknown) => p }));
vi.mock('../components/pos/CashTransactionModal', () => ({ default: () => null }));
vi.mock('../components/pos/ShiftModals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/pos/ShiftModals')>();
  return {
    ...actual,
    // The REAL modal; only its props are recorded.
    CloseShiftModal: (props: Parameters<typeof actual.CloseShiftModal>[0]) => {
      mocks.modalProps.push(props as unknown as Record<string, unknown>);
      return createElement(actual.CloseShiftModal, props);
    },
    OpenShiftModal: () => <div data-testid="open-shift-modal" />,
    ShiftBootBlockedModal: () => <div data-testid="shift-boot-blocked-modal" />,
  };
});
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));

import POSPage from './POSPage';
import { buildAuthoritativeCloseRequestBody } from '../lib/pos/shiftCloseAuthoritativeClient';

// ── Fixtures ───────────────────────────────────────────────────────────────

function shiftOf(id: string, branchId: string): Shift {
  return {
    id, branchId, staffId: 'U1', staffName: 'Test User', status: 'open',
    openedAt: new Date() as unknown as Shift['openedAt'], closedAt: null,
    startingCash: 500, actualCashCount: 0,
    // Stale stored totals: the drawer is derived from the ledger.
    expectedCash: 9999, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0, totalBills: 99,
    payInTotal: 0, payOutTotal: 0, variance: 0, note: '', cashEntries: [],
  };
}
const SHIFT_A = shiftOf('shift-A', 'BR-A');
const SHIFT_B = shiftOf('shift-B', 'BR-B');

function order(id: string, shiftId: string, branchId: string, cash: number): AsyncOrder {
  return {
    id, billId: `bill-${id}`, deviceId: 'DEV-TEST', branchId, shiftId, staffId: 'U1', staffName: 'Test User',
    customerId: null, status: 'completed', reconcileStatus: 'pending_reconcile',
    total: cash, paidAmt: cash, changeAmt: 0, creditAmt: 0, payments: [{ method: 'cash', amount: cash }],
    serverCreatedAt: null, clientCreatedAt: 1,
  } as unknown as AsyncOrder;
}
const A1 = order('DEV-TEST-1', 'shift-A', 'BR-A', 400);
const B1 = order('DEV-TEST-7', 'shift-B', 'BR-B', 700);

const snap = (...orders: AsyncOrder[]) => ({ docs: orders.map((o) => ({ id: o.id, data: () => o })) });
const subsOf = (branchId: string) => mocks.subs.filter((s) => s.branchId === branchId);
const currentSub = (branchId: string) => subsOf(branchId).at(-1)!;
const bootsOf = (branchId: string) => mocks.boots.filter((b) => b.branchId === branchId);

// ── Drivers (no sleeps: every async step is a resolved promise / fired callback) ──

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

async function resolveBoot(b: BootCall, shift: Shift | null) {
  await act(async () => {
    b.resolve(shift ? { status: 'found', shift, provenance: 'server' } : { status: 'absent', provenance: 'server' });
  });
  await settle();
}

async function emit(sub: Sub, ...orders: AsyncOrder[]) {
  await act(async () => sub.next(snap(...orders)));
}

/** Select another branch; returns once that branch's shift boot is waiting on its (deferred) read. */
async function switchBranch(view: ReturnType<typeof render>, branchId: string) {
  const before = bootsOf(branchId).length;
  mocks.auth.branchId = branchId;
  view.rerender(<POSPage />);
  await waitFor(() => expect(bootsOf(branchId)).toHaveLength(before + 1));
  await settle();
}

/** Branch A booted with shift A, its ledger answered with A1, the close modal open. */
async function bootAWithModal() {
  const view = render(<POSPage />);
  await waitFor(() => expect(bootsOf('BR-A')).toHaveLength(1));
  await resolveBoot(bootsOf('BR-A')[0]!, SHIFT_A);
  await emit(currentSub('BR-A'), A1);
  const button = await waitFor(() => {
    const b = view.container.querySelector('.ti-door-exit')?.closest('button');
    if (!b) throw new Error('close-shift button not rendered yet');
    return b;
  });
  fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'ปิดกะ' })).toBeTruthy());
  return view;
}

async function confirm(count: string): Promise<CloseCall> {
  const dialog = screen.getByRole('dialog', { name: 'ปิดกะ' });
  fireEvent.change(within(dialog).getByLabelText(/นับเงินสดในลิ้นชัก/), { target: { value: count } });
  const before = mocks.closeShift.mock.calls.length;
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'ปิดกะ' }));
  });
  await settle();
  expect(mocks.closeShift.mock.calls.length).toBe(before + 1);
  return mocks.closeShift.mock.calls.at(-1) as CloseCall;
}

/** What the REAL adapter request builder makes of the handed (shift, sales) pair. */
function adapterProbe(call: CloseCall) {
  const sales = call[3]?.authoritativeClose?.sales;
  if (sales === undefined) return { refused: 'sales_unavailable' };
  return buildAuthoritativeCloseRequestBody({ shift: call[0], sales, actualCashCount: call[1], note: call[2], deviceId: 'DEV-TEST' });
}

/** The list the page currently offers the modal (whatever the prop is called). */
function offeredList(): unknown {
  const p = mocks.modalProps.at(-1)!;
  if ('closeSales' in p && p.closeSales !== undefined) return (p.closeSales as { sales: unknown }).sales;
  return p.sales;
}

beforeEach(() => {
  mocks.auth.branchId = 'BR-A';
  mocks.gate.on = false;
  mocks.subs.length = 0;
  mocks.boots.length = 0;
  mocks.modalProps.length = 0;
  mocks.closeShift.mockReset();
  mocks.closeShift.mockRejectedValue(new Error('probe: close not executed'));
  mocks.getCallable.mockReset();
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('022-R1/R2 — A→B: B\'s ledger answers before B\'s shift boot', () => {
  test('[RED-parent] B empty first, shift A still mounted, modal already open ⇒ no list is offered and the ON close of A gets `undefined` (never a zero attestation); after B\'s boot a genuinely empty B shift is offered only bound to shift B', async () => {
    mocks.gate.on = true;
    const view = await bootAWithModal();
    expect(offeredList()).toEqual([expect.objectContaining({ id: 'DEV-TEST-1', shiftId: 'shift-A' })]);

    await switchBranch(view, 'BR-B');
    expect(bootsOf('BR-B')).toHaveLength(1); // B's boot is pending
    await emit(currentSub('BR-B')); // B answers EMPTY before its boot settles

    // Soft: on the parent every one of these is reported (prop, submitted list, adapter verdict).
    expect.soft(offeredList()).toBeUndefined(); // rendered prop
    const call = await confirm('900'); // submit-time
    expect(call[0].id).toBe('shift-A');
    expect.soft(call[3]?.authoritativeClose?.sales).toBeUndefined();
    // Parent: { ok: true, attestedSales: 0 } — a false zero for shift A.
    expect.soft(adapterProbe(call)).toEqual({ refused: 'sales_unavailable' });
    expect(mocks.getCallable).not.toHaveBeenCalled();

    // B's boot settles with shift B: B's genuine empty ledger may now be offered, bound to B.
    await resolveBoot(bootsOf('BR-B')[0]!, SHIFT_B);
    const callB = await confirm('500');
    expect(callB[0]).toMatchObject({ id: 'shift-B', branchId: 'BR-B', expectedCash: 0, totalBills: 0 });
    expect(callB[3]?.authoritativeClose?.sales).toEqual([]);
    expect(adapterProbe(callB)).toMatchObject({ ok: true, body: { shiftId: 'shift-B', attestedSales: { expectedCash: 0, totalBills: 0 } } });
  });

  test('[RED-parent] B NON-empty first (a sale of shift B), shift A still mounted ⇒ the filtered [] is never offered for A', async () => {
    mocks.gate.on = true;
    const view = await bootAWithModal();
    await switchBranch(view, 'BR-B');
    await emit(currentSub('BR-B'), B1);

    expect(offeredList()).toBeUndefined();
    const call = await confirm('900');
    expect(call[0].id).toBe('shift-A');
    expect(call[3]?.authoritativeClose?.sales).toBeUndefined();
    expect(adapterProbe(call)).toEqual({ refused: 'sales_unavailable' });
  });

  test('[GREEN-guard] the switch render itself (before B answers) offers nothing', async () => {
    mocks.gate.on = true;
    const view = await bootAWithModal();
    await switchBranch(view, 'BR-B');
    expect(offeredList()).toBeUndefined();
    expect((await confirm('900'))[3]?.authoritativeClose?.sales).toBeUndefined();
  });
});

describe('022-R3 — A→B→A: generations, out-of-order boots, stale callbacks', () => {
  test('[RED-parent] back on A, the NEW A listener answered but A\'s re-boot is still pending ⇒ nothing offered; a late B boot is ignored; after A\'s re-boot the list is offered again', async () => {
    mocks.gate.on = true;
    const view = await bootAWithModal();
    await switchBranch(view, 'BR-B');
    await switchBranch(view, 'BR-A');
    expect(bootsOf('BR-A')).toHaveLength(2);
    expect(subsOf('BR-A')).toHaveLength(2);
    await emit(currentSub('BR-A'), A1); // the second A generation answers

    // Parent: [A1] — the earlier boot of A is reused as if it were fresh.
    expect(offeredList()).toBeUndefined();
    expect((await confirm('900'))[3]?.authoritativeClose?.sales).toBeUndefined();

    // Out of order: B's (cancelled) boot resolves now — ignored.
    await resolveBoot(bootsOf('BR-B')[0]!, SHIFT_B);
    expect(offeredList()).toBeUndefined();

    await resolveBoot(bootsOf('BR-A')[1]!, SHIFT_A);
    const call = await confirm('900');
    expect(call[0]).toMatchObject({ id: 'shift-A', expectedCash: 400, totalBills: 1 });
    expect(call[3]?.authoritativeClose?.sales?.map((s) => s.id)).toEqual(['DEV-TEST-1']);
    expect(adapterProbe(call)).toMatchObject({ ok: true, body: { attestedSales: { expectedCash: 400, totalBills: 1 } } });
  });

  test('[RED-parent] late callbacks of superseded listeners (old B snapshot, old A snapshot, old B error) change neither the list nor its availability', async () => {
    mocks.gate.on = true;
    const view = await bootAWithModal();
    await switchBranch(view, 'BR-B');
    await switchBranch(view, 'BR-A');
    await resolveBoot(bootsOf('BR-A')[1]!, SHIFT_A);
    await emit(currentSub('BR-A'), A1);
    const [oldA, newA] = subsOf('BR-A');
    expect(newA).not.toBe(oldA);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await emit(currentSub('BR-B'), B1); // superseded B listener
    await emit(oldA!); // superseded first A listener, empty
    await act(async () => currentSub('BR-B').error(new Error('late')));

    expect(offeredList()).toEqual([expect.objectContaining({ id: 'DEV-TEST-1' })]);
    const call = await confirm('900');
    // Parent: the old B snapshot replaced the ledger (A's drawer folds 0) and un-loaded it.
    expect(call[0]).toMatchObject({ id: 'shift-A', expectedCash: 400, totalBills: 1 });
    expect(call[3]?.authoritativeClose?.sales?.map((s) => s.id)).toEqual(['DEV-TEST-1']);
  });
});

describe('022-R1 — same branch, availability states', () => {
  test('[GREEN-guard] stable branch: the loaded list is offered exactly; drawer and integer-satang attestation agree', async () => {
    mocks.gate.on = true;
    await bootAWithModal();
    const call = await confirm('900');
    expect(call[0]).toMatchObject({ id: 'shift-A', branchId: 'BR-A', expectedCash: 400, totalBills: 1 });
    expect(call[3]?.authoritativeClose?.sales?.map((s) => s.id)).toEqual(['DEV-TEST-1']);
    expect(adapterProbe(call)).toMatchObject({ ok: true, body: { attestedSales: { expectedCash: 400, totalBills: 1 } } });
  });

  test('[GREEN-guard] before the first snapshot ⇒ undefined; the current listener erroring after success ⇒ undefined (never [])', async () => {
    mocks.gate.on = true;
    const view = render(<POSPage />);
    await waitFor(() => expect(bootsOf('BR-A')).toHaveLength(1));
    await resolveBoot(bootsOf('BR-A')[0]!, SHIFT_A);
    const button = await waitFor(() => {
      const b = view.container.querySelector('.ti-door-exit')?.closest('button');
      if (!b) throw new Error('not yet');
      return b;
    });
    fireEvent.click(button);
    expect((await confirm('500'))[3]?.authoritativeClose?.sales).toBeUndefined();

    await emit(currentSub('BR-A'), A1);
    expect((await confirm('900'))[3]?.authoritativeClose?.sales?.map((s) => s.id)).toEqual(['DEV-TEST-1']);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await act(async () => currentSub('BR-A').error(new Error('permission-denied')));
    expect((await confirm('900'))[3]?.authoritativeClose?.sales).toBeUndefined();
  });
});

describe('022-R4 — gate OFF: the legacy close is unchanged through the race', () => {
  test('[GREEN-guard] A→B with B empty first: exactly closeShift(shift, count, note) on the shown drawer; no callable', async () => {
    const view = await bootAWithModal();
    await switchBranch(view, 'BR-B');
    await emit(currentSub('BR-B'));
    const call = await confirm('900');
    expect(call).toHaveLength(3);
    expect(call[0]).toBe(mocks.modalProps.at(-1)!.shift);
    expect([call[1], call[2]]).toEqual([900, '']);
    expect(mocks.getCallable).not.toHaveBeenCalled();
  });

  test('[GREEN-guard] stable branch, online and offline: exactly three arguments; no callable', async () => {
    await bootAWithModal();
    expect(await confirm('900')).toHaveLength(3);
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
    const call = await confirm('900');
    expect(call).toHaveLength(3);
    expect(call[0]).toMatchObject({ id: 'shift-A', expectedCash: 400 });
    expect(mocks.getCallable).not.toHaveBeenCalled();
  });
});
