// @vitest-environment jsdom

// Return/Refund V1 packet 022 — POSPage hands the close modal THIS shift's
// ledger sales: exactly the list its displayed drawer was derived from (so the
// server-authoritative adapter's attested totals equal the shown drawer), only
// once the branch-scoped ledger listener has answered, and never another
// shift's sale. While the ledger is not loaded the modal gets `undefined`
// (the adapter refuses), never an invented empty list. The drawer itself is
// derived exactly as before.
//
// Harness trimmed from `POSPage.shift-boot-reconciliation.test.tsx`; the drawer
// derivation (`deriveShiftDrawer`) and the adapter's request builder are REAL.
// The ledger mock is an array that also carries `{ sales, loaded }`, so the
// parent (6376403), which folds the hook's array, renders the same drawer and
// fails on BEHAVIOUR: it never passes any sales to the modal.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { LocalSale } from '../lib/pos/localLedger';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  readActiveShiftForBoot: vi.fn(),
  getCloseIntent: vi.fn(),
  ledger: [] as unknown,
  ledgerBranches: [] as Array<string | null>,
  closeModalProps: [] as Array<Record<string, unknown>>,
}));

// ── Hook mocks ──────────────────────────────────────────────────────────────
vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'U1', firstName: 'Test', lastName: 'User' }, branchId: 'B1' }),
}));
vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branch: { name: 'สาขาทดสอบ' } }),
}));
vi.mock('../hooks/pos/usePosInventory', () => ({
  usePosInventory: () => ({
    products: [],
    categories: [],
    richCategories: [],
    sorting: {},
    quickMenus: [],
    fromCache: false,
    loading: false,
    refreshing: false,
    error: null,
    refreshInventory: vi.fn(),
  }),
}));
vi.mock('../hooks/pos/usePosSyncSignal', () => ({
  usePosSyncSignal: () => ({ lastForceUpdate: null, initialized: true }),
}));
vi.mock('../hooks/pos/usePOSPreferences', () => ({
  usePOSPreferences: () => ({
    gridColumns: 4,
    fontSize: 'md',
    showStock: true,
    productNameFontSize: 'md',
    priceFontSize: 'md',
  }),
}));
vi.mock('../lib/pricing/priceLevels', () => ({
  usePriceLevels: () => ({ priceLevels: [] }),
  priceLevelLabel: () => '',
}));
vi.mock('../lib/pos/useSuspendedBills', () => ({
  useSuspendedBills: () => ({ bills: [], count: 0, addBill: vi.fn(), removeBill: vi.fn(), reload: vi.fn() }),
}));
vi.mock('../hooks/pos/useCart', () => ({
  getActivePriceForCustomer: () => ({ unitPrice: 0, originalPrice: 0 }),
  useCart: () => ({
    cart: {},
    cartLines: [],
    totals: { subtotal: 0, billDiscount: 0, fee: 0, grandTotal: 0, itemCount: 0, totalQty: 0 },
    receiptLines: [],
    cartQtyByProduct: new Map(),
    billDiscValue: 0, setBillDiscValue: vi.fn(),
    billDiscPercent: false, setBillDiscPercent: vi.fn(),
    feeRate: 0, setFeeRate: vi.fn(),
    addToCart: vi.fn(), changeQty: vi.fn(), removeLine: vi.fn(),
    setLineQty: vi.fn(() => true), setLineDiscount: vi.fn(),
    clearCart: vi.fn(), restoreCart: vi.fn(),
  }),
}));
vi.mock('../hooks/pos/useCheckout', () => ({
  useCheckout: () => ({
    customer: null,
    setCustomer: vi.fn(), selectCustomer: vi.fn(),
    clearCustomer: vi.fn(),
    customerModalOpen: false, openCustomerModal: vi.fn(), closeCustomerModal: vi.fn(),
    processing: false, confirmSale: vi.fn(),
  }),
}));
vi.mock('../components/ui/use-toast', () => ({
  useToastDispatcher: () => mocks.showToast,
}));
vi.mock('../lib/hooks/useLocalLedger', () => ({
  useLocalLedger: (branchId: string | null) => {
    mocks.ledgerBranches.push(branchId);
    return mocks.ledger;
  },
}));

// ── Service / config mocks ────────────────────────────────────────────────
vi.mock('../lib/pos/shiftService', () => ({
  readActiveShiftForBoot: mocks.readActiveShiftForBoot,
  readShiftCloseConfirmation: vi.fn(),
  readShiftOpenConfirmation: vi.fn(),
  normalizeShiftCloseSyncState: vi.fn(),
  reissueShiftOpenWrite: vi.fn(),
  buildLocalOpenShiftSnapshot: vi.fn(),
}));
vi.mock('../lib/pos/offline/shiftCloseIntentStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createShiftCloseIntentJournal: () => ({
    getCloseIntent: mocks.getCloseIntent,
    listCloseIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    listOnlineCloseAttempts: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    upsertCloseIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
    claimLegacyNormalizationChecks: vi.fn().mockResolvedValue({ ok: false, code: 'unavailable', message: 'IndexedDB unavailable' }),
  }),
}));
vi.mock('../lib/pos/offline/shiftOpenIntentStore', () => ({
  createShiftOpenIntentJournal: () => ({
    findRejectedOpenForDevice: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    findPendingOpenForStaff: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    listOpenIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    getOpenIntent: vi.fn(),
    upsertOpenIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
  }),
}));
vi.mock('../lib/pos/offline/shiftCloseReconciler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({
  runShiftOpenReconciliationSweep: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'DEV-TEST' }));
// The ledger-derived drawer path (the production one).
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: true }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/branches', () => ({ getBranchLabel: () => 'B1' }));
vi.mock('../lib/config/features', () => ({ POS_FEATURES: { enableLoyaltyPoints: false } }));

vi.mock('flowbite-react', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../components/pos/SuspendedBillModals', () => ({
  HoldBillNoteModal: () => null,
  SuspendedBillsListModal: () => null,
}));
vi.mock('../components/pos/ItemDiscountModal', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerPickerModal', () => ({ default: () => null, PosCustomerPick: undefined }));
vi.mock('../components/PaymentModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductPickerDialog', () => ({
  default: () => null,
  posProductToPickerItem: (p: unknown) => p,
}));
vi.mock('../components/pos/CashTransactionModal', () => ({ default: () => null }));
vi.mock('../components/pos/ShiftModals', () => ({
  CloseShiftModal: (props: Record<string, unknown>) => {
    mocks.closeModalProps.push(props);
    return <div data-testid="close-shift-modal" />;
  },
  OpenShiftModal: () => <div data-testid="open-shift-modal" />,
  ShiftBootBlockedModal: () => <div data-testid="shift-boot-blocked-modal" />,
}));
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));

// ── Import the component under test AFTER all mocks are declared ───────────
import POSPage from './POSPage';
import { buildAuthoritativeCloseRequestBody } from '../lib/pos/shiftCloseAuthoritativeClient';
import type { Shift } from '../lib/types';

function makeOpenShift() {
  return {
    id: 'shift-1',
    branchId: 'B1',
    staffId: 'U1',
    staffName: 'Test User',
    status: 'open' as const,
    openedAt: new Date() as unknown,
    closedAt: null,
    startingCash: 500,
    actualCashCount: 0,
    // Stored doc totals are stale on purpose: the drawer is derived from the ledger.
    expectedCash: 9999,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 99,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries: [],
  };
}

function sale(id: string, shiftId: string, payments: LocalSale['payments'], changeAmt = 0): LocalSale {
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  return {
    id,
    billId: `bill-${id}`,
    deviceId: 'DEV-TEST',
    shiftId,
    staffId: 'U1',
    staffName: 'Test User',
    customerId: null,
    status: 'completed',
    reconcileStatus: 'pending_reconcile',
    total: paid - changeAmt,
    paidAmt: paid,
    changeAmt,
    creditAmt: 0,
    payments,
    pendingSync: false,
    clientCreatedAt: 1,
    occurredAt: 1,
    sortSeq: 1,
  } as LocalSale;
}

/** What `useLocalLedger` returns: the candidate's `{ sales, loaded }`, readable as the parent's bare array too. */
function ledger(sales: LocalSale[], loaded: boolean) {
  return Object.assign([...sales], { sales, loaded });
}

const S1 = sale('DEV-TEST-1', 'shift-1', [{ method: 'cash', amount: 500 }], 100);
const S2 = sale('DEV-TEST-2', 'shift-1', [{ method: 'qr', amount: 250 }]);
// Another (earlier / other-branch) shift's sale still in the listener's list.
const FOREIGN = sale('DEV-TEST-0', 'shift-OTHER', [{ method: 'cash', amount: 7000 }]);

async function openCloseModal() {
  mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'found', shift: makeOpenShift(), provenance: 'server' });
  mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });
  const view = render(<POSPage />);
  const button = await waitFor(() => {
    const b = view.container.querySelector('.ti-door-exit')?.closest('button');
    if (!b) throw new Error('close-shift button not rendered yet');
    return b;
  });
  fireEvent.click(button);
  await waitFor(() => expect(mocks.closeModalProps.length).toBeGreaterThan(0));
  // 022-REPAIR: the list now travels bound to its shift (`closeSales`); `sales`
  // below is that bound list, so the 022 assertions read unchanged.
  const p = mocks.closeModalProps.at(-1)! as { shift: Shift; closeSales?: { shiftId: string; branchId: string; sales: readonly LocalSale[] } };
  return { ...p, sales: p.closeSales?.sales };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.ledgerBranches.length = 0;
  mocks.closeModalProps.length = 0;
});

describe('022 — POSPage → CloseShiftModal sales handoff', () => {
  test('[RED-parent] loaded ledger ⇒ exactly this shift\'s sales, the same ones its drawer folded; the adapter accepts the pair', async () => {
    mocks.ledger = ledger([FOREIGN, S1, S2], true);
    const props = await openCloseModal();
    expect(mocks.ledgerBranches.every((b) => b === 'B1')).toBe(true);
    expect(props.shift).toMatchObject({ id: 'shift-1', branchId: 'B1', expectedCash: 400, expectedQr: 250, totalBills: 2 });
    expect(props.sales?.map((s) => s.id)).toEqual(['DEV-TEST-1', 'DEV-TEST-2']);
    expect(props.sales?.every((s) => s.shiftId === 'shift-1')).toBe(true);
    expect(props.closeSales).toMatchObject({ shiftId: 'shift-1', branchId: 'B1' });
    // The real request builder: attested totals == the shown drawer (no
    // `attested_differs_from_drawer`), and the foreign 7,000 is nowhere.
    const built = buildAuthoritativeCloseRequestBody({ shift: props.shift, sales: props.sales!, actualCashCount: 900, note: '', deviceId: 'DEV-TEST' });
    expect(built).toMatchObject({ ok: true, body: { attestedSales: { expectedCash: 400, expectedQr: 250, totalBills: 2 } } });
  });

  test('[RED-parent] loaded ledger without a sale of this shift ⇒ a genuine empty list (zero drawer)', async () => {
    mocks.ledger = ledger([FOREIGN], true);
    const props = await openCloseModal();
    expect(props.shift).toMatchObject({ expectedCash: 0, expectedQr: 0, totalBills: 0 });
    expect(props.sales).toEqual([]);
  });

  test('[GREEN-guard] ledger NOT loaded ⇒ no sales handed over (undefined, never []); the drawer is derived exactly as before', async () => {
    mocks.ledger = ledger([], false);
    const props = await openCloseModal();
    expect(props.shift).toMatchObject({ id: 'shift-1', expectedCash: 0, totalBills: 0, startingCash: 500 });
    expect(props.sales).toBeUndefined();
  });

  test('[GREEN-guard] not loaded but a stale list is present ⇒ still undefined (the drawer keeps its existing derivation)', async () => {
    mocks.ledger = ledger([S1], false);
    const props = await openCloseModal();
    expect(props.shift).toMatchObject({ expectedCash: 400, totalBills: 1 });
    expect(props.sales).toBeUndefined();
  });
});
