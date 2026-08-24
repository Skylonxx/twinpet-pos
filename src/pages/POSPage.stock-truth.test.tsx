// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PosProduct } from '../lib/pos/types';
import { UNKNOWN_STOCK_LABEL } from '../lib/pos/stockTruthDisplay';

const state = vi.hoisted(() => ({
  pendingRetirementRefresh: false,
  refreshInventory: vi.fn(),
  products: [] as PosProduct[],
  cartLines: [] as Array<{
    lineKey: string;
    productId: string;
    productName: string;
    category: string;
    sku: string;
    barcode: null;
    unit: string;
    unitFactor: number;
    unitPrice: number;
    originalPrice: number;
    qty: number;
    discount: { type: 'none'; val: number };
  }>,
  fromCache: false,
  provenance: {
    products: { fromCache: false },
    stock: { fromCache: false },
    categories: { fromCache: false },
    observedAtLocal: 1,
  },
}));

function knownProduct(id: string, stock: number): PosProduct {
  return {
    id,
    name: id,
    sku: id,
    barcode: null,
    category: 'อาหารสัตว์',
    emoji: '🐕',
    imageUrl: null,
    stock,
    stockTruth: { state: 'known', asOf: 'server', localDeltaApplied: false },
    baseUnit: 'ชิ้น',
    uomOptions: [{ unit: 'ชิ้น', factor: 1, price: 10 }],
    allowNegativeStock: false,
    isBestSeller: true,
  };
}

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'U1', firstName: 'Test', lastName: 'User' }, branchId: 'B1' }),
}));
vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branch: { name: 'สาขาทดสอบ' } }),
}));
vi.mock('../hooks/pos/usePosInventory', () => ({
  usePosInventory: () => ({
    products: state.products,
    categories: ['', 'อาหารสัตว์'],
    richCategories: [{ id: 'อาหารสัตว์', name: 'อาหารสัตว์' }],
    sorting: {},
    quickMenus: [],
    fromCache: state.fromCache,
    provenance: state.provenance,
    loading: false,
    refreshing: false,
    error: null,
    refreshInventory: state.refreshInventory,
    pendingRetirementRefresh: state.pendingRetirementRefresh,
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
  getActivePriceForCustomer: () => ({ unitPrice: 10, originalPrice: 10 }),
  useCart: () => ({
    cart: {},
    cartLines: state.cartLines,
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
  useToastDispatcher: () => vi.fn(),
}));
vi.mock('../lib/hooks/useLocalLedger', () => ({ useLocalLedger: () => [] }));
vi.mock('../lib/pos/shiftService', () => ({
  readActiveShiftForBoot: vi.fn().mockResolvedValue({
    status: 'found',
    shift: {
      id: 'shift-1', branchId: 'B1', staffId: 'U1', staffName: 'Test User',
      openedAt: new Date().toISOString(), status: 'open', cashEntries: [],
    },
    provenance: 'server',
  }),
  readShiftCloseConfirmation: vi.fn().mockResolvedValue({ ok: false }),
  readShiftOpenConfirmation: vi.fn().mockResolvedValue({ ok: false }),
  normalizeShiftCloseSyncState: vi.fn(),
  reissueShiftOpenWrite: vi.fn(),
  buildLocalOpenShiftSnapshot: vi.fn(),
}));
vi.mock('../lib/pos/offline/shiftCloseIntentStore', () => ({
  createShiftCloseIntentJournal: () => ({
    getCloseIntent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    listCloseIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    upsertCloseIntent: vi.fn(), markSynced: vi.fn(), markRejectedManualAttention: vi.fn(),
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
vi.mock('../lib/pos/offline/shiftCloseReconciler', () => ({
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({
  runShiftOpenReconciliationSweep: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/pos/offline/trustedSaleSubmissionOrchestrator', () => ({
  runTrustedResumeSweep: vi.fn().mockResolvedValue({ ok: true, outcome: 'not_eligible' }),
  beginTrustedSaleSubmission: vi.fn(),
}));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: false }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/pos/shiftLedger', () => ({ deriveShiftDrawer: (s: unknown) => s }));
vi.mock('../lib/branches', () => ({ getBranchLabel: () => 'B1' }));
vi.mock('../lib/config/features', () => ({ POS_FEATURES: { enableLoyaltyPoints: false } }));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'DEV-TEST' }));
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
  posProductToPickerItem: (p: PosProduct) => p,
}));
vi.mock('../components/pos/CashTransactionModal', () => ({ default: () => null }));
vi.mock('../components/pos/ShiftModals', () => ({
  CloseShiftModal: () => null, OpenShiftModal: () => null, ShiftBootBlockedModal: () => null,
}));
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));
vi.mock('../components/pos/ConnectivityChip', () => ({ default: () => null }));
vi.mock('../components/pos/SaleIntentSyncPanel', () => ({ default: () => null }));

import POSPage from './POSPage';

const posSource = readFileSync(resolve(process.cwd(), 'src/pages/POSPage.tsx'), 'utf8');

afterEach(() => {
  cleanup();
  state.pendingRetirementRefresh = false;
  state.refreshInventory.mockClear();
  state.products = [];
  state.cartLines = [];
  state.fromCache = false;
  state.provenance = {
    products: { fromCache: false },
    stock: { fromCache: false },
    categories: { fromCache: false },
    observedAtLocal: 1,
  };
});

describe('POSPage stock truth', () => {
  test('T11/T12 source: grid and oversold badge are truth-gated; oversell arithmetic is preserved', () => {
    expect(posSource).toContain('formatStockTruth(p.stockTruth, p.stock)');
    expect(posSource).toContain('formatStockTruth(product.stockTruth, product.stock)');
    expect(posSource).toContain('product.stock < neededBase');
    expect(posSource).toContain('pendingRetirementRefresh');
    expect(posSource).not.toContain('{p.stock}');
  });

  test('T11 known zero renders 0; unknown renders placeholder', () => {
    state.products = [
      knownProduct('zero', 0),
      { ...knownProduct('unk', 0), name: 'unknown-item', stockTruth: { state: 'unknown' } },
    ];
    render(<POSPage />);
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getByText(UNKNOWN_STOCK_LABEL)).toBeTruthy();
  });

  test('T31 empty cart + pendingRetirementRefresh refreshes immediately', () => {
    state.products = [knownProduct('p1', 5)];
    state.pendingRetirementRefresh = true;
    render(<POSPage />);
    expect(state.refreshInventory).toHaveBeenCalled();
  });

  test('T32/T37 non-empty cart defers refresh and preserves product identity', () => {
    const products = [knownProduct('p1', 5)];
    state.products = products;
    state.cartLines = [{
      lineKey: 'p1::ชิ้น',
      productId: 'p1',
      productName: 'p1',
      category: 'อาหารสัตว์',
      sku: 'p1',
      barcode: null,
      unit: 'ชิ้น',
      unitFactor: 1,
      unitPrice: 10,
      originalPrice: 10,
      qty: 1,
      discount: { type: 'none', val: 0 },
    }];
    state.pendingRetirementRefresh = true;
    render(<POSPage />);
    expect(state.refreshInventory).not.toHaveBeenCalled();
    expect(state.products).toBe(products);
    expect(screen.getByText('อัปเดตข้อมูลหน้าจอ')).toBeTruthy();
  });

  test('T33 coalesced flag still produces a single refreshInventory call', () => {
    state.products = [knownProduct('p1', 5)];
    state.pendingRetirementRefresh = true;
    const { rerender } = render(<POSPage />);
    rerender(<POSPage />);
    expect(state.refreshInventory).toHaveBeenCalledTimes(1);
  });

  test('T12 oversold arithmetic still uses product.stock; badge text is truth-gated', () => {
    state.products = [knownProduct('p1', 1)];
    state.cartLines = [{
      lineKey: 'p1::ชิ้น',
      productId: 'p1',
      productName: 'p1',
      category: 'อาหารสัตว์',
      sku: 'p1',
      barcode: null,
      unit: 'ชิ้น',
      unitFactor: 1,
      unitPrice: 10,
      originalPrice: 10,
      qty: 5,
      discount: { type: 'none', val: 0 },
    }];
    render(<POSPage />);
    expect(screen.getByText(/ขายเกินสต๊อก/)).toBeTruthy();
    expect(screen.getByText(/ขายเกินสต๊อก \(1\)/)).toBeTruthy();
  });
});
