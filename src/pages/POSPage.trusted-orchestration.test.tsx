// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  readActiveShiftForBoot: vi.fn(),
  readShiftCloseConfirmation: vi.fn(),
  readShiftOpenConfirmation: vi.fn(),
  normalizeShiftCloseSyncState: vi.fn(),
  reissueShiftOpenWrite: vi.fn(),
  buildLocalOpenShiftSnapshot: vi.fn((entry: { shiftId: string }) => ({
    id: entry.shiftId,
    branchId: 'B1',
    staffId: 'U1',
    staffName: 'Test User',
    status: 'open' as const,
    openedAt: new Date() as unknown,
    closedAt: null,
    startingCash: 0,
    actualCashCount: 0,
    expectedCash: 0,
    expectedQr: 0,
    expectedKbank: 0,
    expectedCard: 0,
    expectedCredit: 0,
    totalBills: 0,
    payInTotal: 0,
    payOutTotal: 0,
    variance: 0,
    note: '',
    cashEntries: [],
    openedOffline: true,
    syncState: 'pending' as const,
  })),
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue([]),
  runShiftOpenReconciliationSweep: vi.fn().mockResolvedValue([]),
  getCloseIntent: vi.fn(),
  listCloseIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  findRejectedOpenForDevice: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  findPendingOpenForStaff: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  listOpenIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  runTrustedResumeSweep: vi.fn().mockResolvedValue({ ok: true, outcome: 'not_eligible' }),
  beginTrustedSaleSubmission: vi.fn().mockResolvedValue({ ok: false, reason: 'generation_refused' }),
  auth: { branchId: 'B1' },
}));

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'U1', firstName: 'Test', lastName: 'User' }, branchId: mocks.auth.branchId }),
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
  useLocalLedger: () => [],
}));
vi.mock('../lib/pos/shiftService', () => ({
  readActiveShiftForBoot: mocks.readActiveShiftForBoot,
  readShiftCloseConfirmation: mocks.readShiftCloseConfirmation,
  readShiftOpenConfirmation: mocks.readShiftOpenConfirmation,
  normalizeShiftCloseSyncState: mocks.normalizeShiftCloseSyncState,
  reissueShiftOpenWrite: mocks.reissueShiftOpenWrite,
  buildLocalOpenShiftSnapshot: mocks.buildLocalOpenShiftSnapshot,
}));
vi.mock('../lib/pos/offline/shiftCloseIntentStore', () => ({
  createShiftCloseIntentJournal: () => ({
    getCloseIntent: mocks.getCloseIntent,
    listCloseIntents: mocks.listCloseIntents,
    upsertCloseIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
  }),
}));
vi.mock('../lib/pos/offline/shiftOpenIntentStore', () => ({
  createShiftOpenIntentJournal: () => ({
    findRejectedOpenForDevice: mocks.findRejectedOpenForDevice,
    findPendingOpenForStaff: mocks.findPendingOpenForStaff,
    listOpenIntents: mocks.listOpenIntents,
    getOpenIntent: vi.fn(),
    upsertOpenIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
  }),
}));
vi.mock('../lib/pos/offline/shiftCloseReconciler', () => ({
  runShiftCloseReconciliationSweep: mocks.runShiftCloseReconciliationSweep,
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({
  runShiftOpenReconciliationSweep: mocks.runShiftOpenReconciliationSweep,
}));
vi.mock('../lib/pos/offline/trustedSaleSubmissionOrchestrator', () => ({
  runTrustedResumeSweep: mocks.runTrustedResumeSweep,
  beginTrustedSaleSubmission: mocks.beginTrustedSaleSubmission,
}));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'DEV-TEST' }));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: false }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/pos/shiftLedger', () => ({ deriveShiftDrawer: (s: unknown) => s }));
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
  CloseShiftModal: () => null,
  OpenShiftModal: () => null,
  ShiftBootBlockedModal: () => null,
}));
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));

import POSPage from './POSPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.auth.branchId = 'B1';
  mocks.listCloseIntents.mockResolvedValue({ ok: true, value: [] });
  mocks.findRejectedOpenForDevice.mockResolvedValue({ ok: true, value: undefined });
  mocks.findPendingOpenForStaff.mockResolvedValue({ ok: true, value: undefined });
  mocks.listOpenIntents.mockResolvedValue({ ok: true, value: [] });
  mocks.runShiftCloseReconciliationSweep.mockResolvedValue([]);
  mocks.runShiftOpenReconciliationSweep.mockResolvedValue([]);
  mocks.runTrustedResumeSweep.mockResolvedValue({ ok: true, outcome: 'not_eligible' });
  mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });
});

describe('POSPage trusted orchestration sweep', () => {
  test('P-2 / NV-3 production default calls runTrustedResumeSweep after shiftReady with current branch/device', async () => {
    render(<POSPage />);
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep).toHaveBeenCalled();
    });
    expect(mocks.runTrustedResumeSweep).toHaveBeenCalledWith({
      branchId: 'B1',
      deviceId: 'DEV-TEST',
    });
  });

  test('P-1 registers one trusted online listener and removes it on unmount', async () => {
    const { unmount } = render(<POSPage />);
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep).toHaveBeenCalledTimes(1);
    });
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep).toHaveBeenCalledTimes(2);
    });
    unmount();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(mocks.runTrustedResumeSweep).toHaveBeenCalledTimes(2);
  });

  test('P-3 sweep rejection never blocks render or toasts', async () => {
    mocks.runTrustedResumeSweep.mockRejectedValue(new Error('sweep failed'));
    render(<POSPage />);
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep).toHaveBeenCalled();
    });
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  test('P-4 injected sweep is used when provided', async () => {
    const injected = vi.fn().mockResolvedValue({ ok: true, outcome: 'not_eligible' });
    render(<POSPage trustedResumeSweep={injected} />);
    await waitFor(() => {
      expect(injected).toHaveBeenCalledWith({ branchId: 'B1', deviceId: 'DEV-TEST' });
    });
    expect(mocks.runTrustedResumeSweep).not.toHaveBeenCalled();
  });

  test('NV-10 changing branchId within one mount re-runs the sweep for the new key', async () => {
    const { rerender } = render(<POSPage />);
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep).toHaveBeenCalledWith({
        branchId: 'B1',
        deviceId: 'DEV-TEST',
      });
    });
    mocks.runTrustedResumeSweep.mockClear();
    mocks.auth.branchId = 'B2';
    rerender(<POSPage />);
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep).toHaveBeenCalledWith({
        branchId: 'B2',
        deviceId: 'DEV-TEST',
      });
    });
  });

  test('StrictMode duplicate invocation does not throw or write operator-facing state', async () => {
    render(
      <StrictMode>
        <POSPage />
      </StrictMode>,
    );
    await waitFor(() => {
      expect(mocks.runTrustedResumeSweep.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
    expect(mocks.showToast).not.toHaveBeenCalled();
    for (const call of mocks.runTrustedResumeSweep.mock.calls) {
      expect(call[0]).toEqual({ branchId: 'B1', deviceId: 'DEV-TEST' });
    }
  });

  test('does not run the trusted sweep before shiftReady', () => {
    mocks.readActiveShiftForBoot.mockImplementation(() => new Promise(() => {}));
    render(<POSPage />);
    expect(mocks.runTrustedResumeSweep).not.toHaveBeenCalled();
  });
});
