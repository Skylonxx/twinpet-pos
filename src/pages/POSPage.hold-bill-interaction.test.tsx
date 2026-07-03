// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Spy variables (vi.hoisted ensures availability in vi.mock factories) ────────────
const mocks = vi.hoisted(() => ({
  addBill: vi.fn(),
  clearCart: vi.fn(),
  clearCustomer: vi.fn(),
  showToast: vi.fn(),
}));

// ── Hook mocks ──────────────────────────────────────────────────────────────────────
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
  useSuspendedBills: () => ({
    bills: [],
    count: 0,
    addBill: mocks.addBill,
    removeBill: vi.fn(),
    reload: vi.fn(),
  }),
}));
vi.mock('../hooks/pos/useCart', () => ({
  getActivePriceForCustomer: () => ({ unitPrice: 10, originalPrice: 10 }),
  useCart: () => ({
    cart: {
      'P1::ชิ้น': {
        lineKey: 'P1::ชิ้น', productId: 'P1', productName: 'สินค้าทดสอบ',
        category: 'cat', sku: 'SKU1', barcode: null, unit: 'ชิ้น', unitFactor: 1,
        unitPrice: 10, originalPrice: 10, qty: 3,
        discount: { type: 'none' as const, val: 0 },
      },
    },
    cartLines: [{
      lineKey: 'P1::ชิ้น', productId: 'P1', productName: 'สินค้าทดสอบ',
      category: 'cat', sku: 'SKU1', barcode: null, unit: 'ชิ้น', unitFactor: 1,
      unitPrice: 10, originalPrice: 10, qty: 3,
      discount: { type: 'none' as const, val: 0 },
    }],
    totals: { subtotal: 30, billDiscount: 0, fee: 0, grandTotal: 30, itemCount: 1, totalQty: 3 },
    receiptLines: [],
    cartQtyByProduct: new Map([['P1', 3]]),
    billDiscValue: 0, setBillDiscValue: vi.fn(),
    billDiscPercent: false, setBillDiscPercent: vi.fn(),
    feeRate: 0, setFeeRate: vi.fn(),
    addToCart: vi.fn(), changeQty: vi.fn(), removeLine: vi.fn(),
    setLineQty: vi.fn(() => true), setLineDiscount: vi.fn(),
    clearCart: mocks.clearCart, restoreCart: vi.fn(),
  }),
}));

let checkoutCustomer: { id: string; name: string; phone: string; customerType: string; lifetimeValue: number; points: number; creditLimit: number; outstandingBalance: number } | null = null;

vi.mock('../hooks/pos/useCheckout', () => ({
  useCheckout: () => ({
    customer: checkoutCustomer,
    setCustomer: vi.fn(), selectCustomer: vi.fn(),
    clearCustomer: mocks.clearCustomer,
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

// ── Service / config mocks ──────────────────────────────────────────────────────────
vi.mock('../lib/pos/shiftService', () => ({
  getActiveShift: vi.fn().mockResolvedValue({
    id: 'shift-1', branchId: 'B1', staffId: 'U1', staffName: 'Test User',
    openedAt: new Date().toISOString(), status: 'open', cashEntries: [],
    initialCash: 1000, expectedCash: 1000, expectedTransfer: 0, expectedCredit: 0,
    totalSales: 0, totalOrders: 0,
  }),
}));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: false }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/pos/shiftLedger', () => ({ deriveShiftDrawer: (s: unknown) => s }));
vi.mock('../lib/branches', () => ({ getBranchLabel: () => 'B1' }));
vi.mock('../lib/config/features', () => ({ POS_FEATURES: { enableLoyaltyPoints: false } }));

// ── Component stubs ─────────────────────────────────────────────────────────────────
vi.mock('flowbite-react', () => ({
  Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('../components/pos/SuspendedBillModals', () => ({
  HoldBillNoteModal: ({ open, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (note: string) => void }) => {
    if (!open) return null;
    return (
      <div data-testid="hold-note-modal">
        <input data-testid="hold-note-input" />
        <button data-testid="hold-note-confirm" onClick={() => {
          const input = document.querySelector<HTMLInputElement>('[data-testid="hold-note-input"]');
          onConfirm(input?.value?.trim() || '—');
        }}>ยืนยัน</button>
      </div>
    );
  },
  SuspendedBillsListModal: () => null,
}));
vi.mock('../components/pos/ItemDiscountModal', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerPickerModal', () => ({
  default: () => null,
  PosCustomerPick: undefined,
}));
vi.mock('../components/PaymentModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductPickerDialog', () => ({
  default: () => null,
  posProductToPickerItem: (p: unknown) => p,
}));
vi.mock('../components/pos/CashTransactionModal', () => ({ default: () => null }));
vi.mock('../components/pos/ShiftModals', () => ({
  CloseShiftModal: () => null,
  OpenShiftModal: () => null,
}));
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));

// ── Import the component under test AFTER all mocks are declared ────────────────────
import POSPage from './POSPage';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  checkoutCustomer = null;
});

describe('Hold Bill · modal flow (DOM interaction)', () => {
  test('clicking Hold Bill opens the note modal; Confirm with blank note saves bill (customer selected)', async () => {
    checkoutCustomer = {
      id: 'C1', name: 'ลูกค้าทดสอบ', phone: '', customerType: 'retail',
      lifetimeValue: 0, points: 0, creditLimit: 0, outstandingBalance: 0,
    };
    const user = userEvent.setup();
    render(<POSPage />);

    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await user.click(holdBtn);

    // Modal must appear; addBill must NOT be called yet
    expect(screen.getByTestId('hold-note-modal')).toBeTruthy();
    expect(mocks.addBill).not.toHaveBeenCalled();

    // Leave note blank and click Confirm
    const confirmBtn = screen.getByTestId('hold-note-confirm');
    await user.click(confirmBtn);

    // addBill called once after Confirm
    expect(mocks.addBill).toHaveBeenCalledTimes(1);
    const bill = mocks.addBill.mock.calls[0]![0];

    // Blank note accepted (modal falls back to '—')
    expect(typeof bill.note).toBe('string');
    expect(bill.note.length).toBeGreaterThan(0);

    // Customer data captured
    expect(bill.customerId).toBe('C1');
    expect(bill.customer).toBeTruthy();
    expect(bill.customer.id).toBe('C1');
    expect(bill.customer.name).toBe('ลูกค้าทดสอบ');

    // Cart items captured
    expect(bill.cartItems).toHaveLength(1);
    expect(bill.cartItems[0].productName).toBe('สินค้าทดสอบ');
    expect(bill.cartItems[0].qty).toBe(3);

    // Bill-level state captured
    expect(bill.discount).toBe(0);
    expect(bill.discountPercent).toBe(false);
    expect(bill.feeRate).toBe(0);
    expect(bill.totalAmount).toBe(30);
    expect(bill.itemCount).toBe(3);

    // Cart cleared after suspend
    expect(mocks.clearCart).toHaveBeenCalled();

    // Modal closed after confirm
    expect(screen.queryByTestId('hold-note-modal')).toBeNull();

    // Success toast shown
    expect(mocks.showToast).toHaveBeenCalled();
  });

  test('Hold Bill with no customer selected: bill.customer is null, bill.customerId is null', async () => {
    checkoutCustomer = null;
    const user = userEvent.setup();
    render(<POSPage />);

    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await user.click(holdBtn);

    expect(screen.getByTestId('hold-note-modal')).toBeTruthy();
    expect(mocks.addBill).not.toHaveBeenCalled();

    const confirmBtn = screen.getByTestId('hold-note-confirm');
    await user.click(confirmBtn);

    expect(mocks.addBill).toHaveBeenCalledTimes(1);
    const bill = mocks.addBill.mock.calls[0]![0];

    expect(bill.customer).toBeNull();
    expect(bill.customerId).toBeNull();

    expect(bill.cartItems).toHaveLength(1);
    expect(mocks.clearCart).toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalled();
  });

  test('Hold Bill with typed note preserves the note in the bill', async () => {
    checkoutCustomer = null;
    const user = userEvent.setup();
    render(<POSPage />);

    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await user.click(holdBtn);

    const noteInput = screen.getByTestId('hold-note-input');
    await user.type(noteInput, 'โต๊ะ 5');

    const confirmBtn = screen.getByTestId('hold-note-confirm');
    await user.click(confirmBtn);

    expect(mocks.addBill).toHaveBeenCalledTimes(1);
    const bill = mocks.addBill.mock.calls[0]![0];
    expect(bill.note).toBe('โต๊ะ 5');
  });
});
