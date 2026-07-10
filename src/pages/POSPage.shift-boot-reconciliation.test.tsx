// @vitest-environment jsdom

// Packet 7C-B2 — focused POSPage coverage for the boot fail-closed guard
// (RC-3 fix) and the boot/reconnect reconciliation sweep wiring. Mirrors the
// mock harness in `POSPage.hold-bill-interaction.test.tsx`; trimmed to what's
// needed to mount POSPage, plus dedicated shift/reconciliation mocks. The
// pure reconciliation LOGIC (confirm/mismatch/unreachable branches) is
// covered by `shiftCloseReconciler.test.ts` — this file only asserts that
// POSPage wires the boot-blocked render guard and the sweep triggers
// correctly.

import { describe, test, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  getActiveShift: vi.fn(),
  readShiftCloseConfirmation: vi.fn(),
  normalizeShiftCloseSyncState: vi.fn(),
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue([]),
  getCloseIntent: vi.fn(),
  listCloseIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
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
  useLocalLedger: () => [],
}));

// ── Service / config mocks ────────────────────────────────────────────────
vi.mock('../lib/pos/shiftService', () => ({
  getActiveShift: mocks.getActiveShift,
  readShiftCloseConfirmation: mocks.readShiftCloseConfirmation,
  normalizeShiftCloseSyncState: mocks.normalizeShiftCloseSyncState,
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
vi.mock('../lib/pos/offline/shiftCloseReconciler', () => ({
  runShiftCloseReconciliationSweep: mocks.runShiftCloseReconciliationSweep,
}));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'DEV-TEST' }));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: false }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/pos/shiftLedger', () => ({ deriveShiftDrawer: (s: unknown) => s }));
vi.mock('../lib/branches', () => ({ getBranchLabel: () => 'B1' }));
vi.mock('../lib/config/features', () => ({ POS_FEATURES: { enableLoyaltyPoints: false } }));

// ── Component stubs ─────────────────────────────────────────────────────────
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
  OpenShiftModal: () => <div data-testid="open-shift-modal" />,
  ShiftBootBlockedModal: ({ onRetry }: { onRetry: () => void }) => (
    <div data-testid="shift-boot-blocked-modal">
      <button type="button" data-testid="shift-boot-blocked-retry" onClick={onRetry}>
        retry
      </button>
    </div>
  ),
}));
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));

// ── Import the component under test AFTER all mocks are declared ───────────
import POSPage from './POSPage';

function makeOpenShift() {
  return {
    id: 'shift-1',
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
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.listCloseIntents.mockResolvedValue({ ok: true, value: [] });
});

describe('POSPage — Packet 7C-B2 boot fail-closed guard (RC-3)', () => {
  test('non-ok close-intent store read blocks live drawer reopen and does not open OpenShiftModal', async () => {
    mocks.getActiveShift.mockResolvedValue(makeOpenShift());
    mocks.getCloseIntent.mockResolvedValue({ ok: false, code: 'unavailable' });

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
    expect(screen.queryByTestId('open-shift-modal')).toBeNull();
  });

  test('readable store with no local close-intent loads the shift as an active live drawer (no blocked/open-shift modal)', async () => {
    mocks.getActiveShift.mockResolvedValue(makeOpenShift());
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });

    render(<POSPage />);

    await waitFor(() => {
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
      expect(screen.queryByTestId('open-shift-modal')).toBeNull();
    });
  });

  test('a locally-closed shift (intent present) stays closed on boot — OpenShiftModal renders, not blocked', async () => {
    mocks.getActiveShift.mockResolvedValue(makeOpenShift());
    mocks.getCloseIntent.mockResolvedValue({
      ok: true,
      value: { shiftId: 'shift-1', status: 'local_closed_pending' },
    });

    render(<POSPage />);

    expect(await screen.findByTestId('open-shift-modal')).toBeTruthy();
    expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
  });

  test('retry re-runs the boot check and clears the blocked state once the store becomes readable', async () => {
    mocks.getActiveShift.mockResolvedValue(makeOpenShift());
    mocks.getCloseIntent.mockResolvedValueOnce({ ok: false, code: 'unavailable' });
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<POSPage />);

    const retryBtn = await screen.findByTestId('shift-boot-blocked-retry');
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
    });
  });

  test('no active shift at all (getActiveShift resolves null) is unaffected by the close-intent guard', async () => {
    mocks.getActiveShift.mockResolvedValue(null);

    render(<POSPage />);

    expect(await screen.findByTestId('open-shift-modal')).toBeTruthy();
    expect(mocks.getCloseIntent).not.toHaveBeenCalled();
  });
});

describe('POSPage — Packet 7C-B2 boot/reconnect reconciliation sweep', () => {
  test('runs the reconciliation sweep once shiftReady, scoped to this device', async () => {
    mocks.getActiveShift.mockResolvedValue(null);

    render(<POSPage />);

    await waitFor(() => {
      expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalled();
    });
    const call = mocks.runShiftCloseReconciliationSweep.mock.calls[0]![0];
    expect(call.deviceId).toBe('DEV-TEST');
    expect(typeof call.readConfirmation).toBe('function');
    expect(typeof call.normalizeSyncState).toBe('function');
  });

  test('re-runs the sweep on a browser "online" event', async () => {
    mocks.getActiveShift.mockResolvedValue(null);

    render(<POSPage />);

    await waitFor(() => {
      expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(2);
    });
  });
});
