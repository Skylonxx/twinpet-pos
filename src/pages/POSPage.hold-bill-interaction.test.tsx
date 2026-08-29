// @vitest-environment jsdom
import { describe, test, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { renderHook, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ── Spy variables (vi.hoisted ensures availability in vi.mock factories) ────────────
const mocks = vi.hoisted(() => ({
  addBill: vi.fn(),
  removeBill: vi.fn(),
  clearCart: vi.fn(),
  restoreCart: vi.fn(),
  setCustomer: vi.fn(),
  showToast: vi.fn(),
  cartHasItems: true,
  useRealSuspendedBills: false,
  bills: [] as Array<{
    id: string;
    note: string;
    cartItems: unknown[];
    customerId: string | null;
    discount: number;
    createdAt: string;
    customer: null;
    discountPercent: boolean;
    feeRate: number;
    totalAmount: number;
    itemCount: number;
  }>,
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
vi.mock('../lib/pos/useSuspendedBills', async () => {
  const actual = await vi.importActual<typeof import('../lib/pos/useSuspendedBills')>(
    '../lib/pos/useSuspendedBills',
  );
  return {
    useSuspendedBills: (branchId: string | null) => {
      if (mocks.useRealSuspendedBills) {
        return actual.useSuspendedBills(branchId);
      }
      return {
        bills: mocks.bills,
        count: mocks.bills.length,
        status: 'ready',
        addBill: mocks.addBill,
        removeBill: mocks.removeBill,
        reload: vi.fn(),
      };
    },
  };
});
vi.mock('../hooks/pos/useCart', () => ({
  getActivePriceForCustomer: () => ({ unitPrice: 10, originalPrice: 10 }),
  useCart: () => {
    const line = {
      lineKey: 'P1::ชิ้น', productId: 'P1', productName: 'สินค้าทดสอบ',
      category: 'cat', sku: 'SKU1', barcode: null, unit: 'ชิ้น', unitFactor: 1,
      unitPrice: 10, originalPrice: 10, qty: 3,
      discount: { type: 'none' as const, val: 0 },
    };
    return {
      cart: {
        ...(mocks.cartHasItems ? { 'P1::ชิ้น': line } : {}),
        billDiscValue: 0,
        billDiscPercent: false,
        feeRate: 0,
        restoreCart: mocks.restoreCart,
        clearCart: mocks.clearCart,
      },
      cartLines: mocks.cartHasItems ? [line] : [],
      totals: mocks.cartHasItems
        ? { subtotal: 30, billDiscount: 0, fee: 0, grandTotal: 30, itemCount: 1, totalQty: 3 }
        : { subtotal: 0, billDiscount: 0, fee: 0, grandTotal: 0, itemCount: 0, totalQty: 0 },
      receiptLines: [],
      cartQtyByProduct: mocks.cartHasItems ? new Map([['P1', 3]]) : new Map(),
      billDiscValue: 0, setBillDiscValue: vi.fn(),
      billDiscPercent: false, setBillDiscPercent: vi.fn(),
      feeRate: 0, setFeeRate: vi.fn(),
      addToCart: vi.fn(), changeQty: vi.fn(), removeLine: vi.fn(),
      setLineQty: vi.fn(() => true), setLineDiscount: vi.fn(),
      clearCart: mocks.clearCart, restoreCart: mocks.restoreCart,
    };
  },
}));

let checkoutCustomer: { id: string; name: string; phone: string; customerType: string; lifetimeValue: number; points: number; creditLimit: number; outstandingBalance: number } | null = null;

vi.mock('../hooks/pos/useCheckout', () => ({
  useCheckout: () => ({
    customer: checkoutCustomer,
    setCustomer: mocks.setCustomer, selectCustomer: vi.fn(),
    clearCustomer: mocks.setCustomer,
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
  // Claude R1 M-01: restore active-shift boot precondition with provenance result.
  readActiveShiftForBoot: vi.fn().mockResolvedValue({
    status: 'found',
    shift: {
      id: 'shift-1', branchId: 'B1', staffId: 'U1', staffName: 'Test User',
      openedAt: new Date().toISOString(), status: 'open', cashEntries: [],
      initialCash: 1000, expectedCash: 1000, expectedTransfer: 0, expectedCredit: 0,
      totalSales: 0, totalOrders: 0,
    },
    provenance: 'server',
  }),
  // Packet 7C-B2 — POSPage's boot/reconnect sweep imports these; not exercised
  // by this hold-bill suite, so they're inert stand-ins.
  readShiftCloseConfirmation: vi.fn().mockResolvedValue({ ok: false }),
  readShiftOpenConfirmation: vi.fn().mockResolvedValue({ ok: false }),
  normalizeShiftCloseSyncState: vi.fn().mockResolvedValue(undefined),
  reissueShiftOpenWrite: vi.fn().mockResolvedValue('skipped'),
}));
// Packet 7C-B2 — jsdom has no real IndexedDB, so the unmocked journal would
// fail every read and (correctly) trip the RC-3 fail-closed boot guard,
// blocking `activeShift` for this entire suite. Stand in with an always-ok,
// no-local-intent journal so the boot effect proceeds to load `activeShift`.
vi.mock('../lib/pos/offline/shiftCloseIntentStore', () => ({
  createShiftCloseIntentJournal: () => ({
    getCloseIntent: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    listCloseIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    upsertCloseIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
  }),
}));
// Claude R1 M-01: empty readable open-intent journal (no real IndexedDB).
vi.mock('../lib/pos/offline/shiftOpenIntentStore', () => ({
  createShiftOpenIntentJournal: () => ({
    findRejectedOpenForDevice: vi.fn().mockResolvedValue({
      ok: true,
      value: undefined,
    }),
    findPendingOpenForStaff: vi.fn().mockResolvedValue({
      ok: true,
      value: undefined,
    }),
    listOpenIntents: vi.fn().mockResolvedValue({
      ok: true,
      value: [],
    }),
    getOpenIntent: vi.fn(),
    upsertOpenIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
  }),
}));
vi.mock('../lib/pos/offline/shiftCloseReconciler', () => ({
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue([]),
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({
  runShiftOpenReconciliationSweep: vi.fn().mockResolvedValue([]),
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
  SuspendedBillsListModal: ({
    open,
    onRestore,
  }: {
    open: boolean;
    bills: unknown[];
    onRestore: (bill: (typeof mocks.bills)[number]) => void;
  }) => {
    if (!open) return null;
    return (
      <div data-testid="suspended-list-modal">
        <button
          data-testid="restore-bill"
          onClick={() => {
            if (mocks.bills[0]) onRestore(mocks.bills[0]);
          }}
        >
          เรียกคืน
        </button>
      </div>
    );
  },
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
  ShiftBootBlockedModal: () => null,
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
  mocks.cartHasItems = true;
  mocks.useRealSuspendedBills = false;
  mocks.bills = [];
  mocks.addBill.mockResolvedValue(undefined);
  mocks.removeBill.mockResolvedValue(undefined);
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

  test('native addBill rejection preserves the active cart and does not report success', async () => {
    mocks.addBill.mockRejectedValueOnce(new Error('native put failed'));
    const user = userEvent.setup();
    render(<POSPage />);
    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await user.click(holdBtn);
    await user.click(screen.getByTestId('hold-note-confirm'));
    await waitFor(() => expect(mocks.addBill).toHaveBeenCalledTimes(1));
    expect(mocks.clearCart).not.toHaveBeenCalled();
    expect(screen.getByTestId('hold-note-modal')).toBeTruthy();
    expect(mocks.showToast).toHaveBeenCalledWith({ title: 'พักบิลไม่สำเร็จ' });
    expect(mocks.showToast.mock.calls.some((call) => JSON.stringify(call[0]).includes('เรียบร้อย'))).toBe(false);
  });

  test('native removeBill rejection does not restore the cart or report success', async () => {
    mocks.cartHasItems = false;
    mocks.bills = [{
      id: 'bill-1',
      note: 'held',
      cartItems: [],
      customerId: null,
      discount: 0,
      createdAt: '2026-08-28T00:00:00.000Z',
      customer: null,
      discountPercent: false,
      feeRate: 0,
      totalAmount: 0,
      itemCount: 0,
    }];
    mocks.removeBill.mockRejectedValueOnce(new Error('native delete failed'));
    const user = userEvent.setup();
    render(<POSPage />);
    const listBtn = await screen.findByRole('button', { name: /บิลที่พักไว้/ });
    await user.click(listBtn);
    await user.click(screen.getByTestId('restore-bill'));
    await waitFor(() => expect(mocks.removeBill).toHaveBeenCalledWith('bill-1'));
    expect(mocks.restoreCart).not.toHaveBeenCalled();
    expect(mocks.setCustomer).not.toHaveBeenCalled();
    expect(screen.getByTestId('suspended-list-modal')).toBeTruthy();
    expect(mocks.showToast).toHaveBeenCalledWith({ title: 'เรียกคืนบิลไม่สำเร็จ' });
    expect(mocks.bills).toHaveLength(1);
  });
});

describe('useSuspendedBills native mutation propagation', () => {
  const sampleBill = {
    id: 'bill-1',
    note: 'held',
    cartItems: [],
    customerId: null,
    discount: 0,
    createdAt: '2026-08-28T00:00:00.000Z',
    customer: null,
    discountPercent: false,
    feeRate: 0,
    totalAmount: 0,
    itemCount: 0,
  };

  afterEach(async () => {
    const boot = await vi.importActual<typeof import('../lib/platform/durableStore/bootDurableStore')>(
      '../lib/platform/durableStore/bootDurableStore',
    );
    boot.__resetBootDurableStoreForTests();
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  });

  test('addBill native failure rejects and does not resolve as success', async () => {
    const boot = await vi.importActual<typeof import('../lib/platform/durableStore/bootDurableStore')>(
      '../lib/platform/durableStore/bootDurableStore',
    );
    const { useSuspendedBills } = await vi.importActual<typeof import('../lib/pos/useSuspendedBills')>(
      '../lib/pos/useSuspendedBills',
    );
    boot.__setNativeCommittedForTests('epoch-1700000000000-0123456789abcdef0123456789abcdef');
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's1' };
      if (cmd === 'durable_kv_txn_get_all_keys') return [];
      if (cmd === 'durable_kv_txn_put') throw new Error('native put failed');
      return undefined;
    });
    (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
      core: { invoke },
    };
    const { result } = renderHook(() => useSuspendedBills('B1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await expect(result.current.addBill(sampleBill)).rejects.toThrow('native put failed');
    });
    expect(result.current.status).toBe('error');
  });

  test('removeBill native failure rejects and leaves the bill available', async () => {
    const boot = await vi.importActual<typeof import('../lib/platform/durableStore/bootDurableStore')>(
      '../lib/platform/durableStore/bootDurableStore',
    );
    const { useSuspendedBills } = await vi.importActual<typeof import('../lib/pos/useSuspendedBills')>(
      '../lib/pos/useSuspendedBills',
    );
    const { encodeDurableKey } = await vi.importActual<typeof import('../lib/platform/durableStore/kvKeyCodec')>(
      '../lib/platform/durableStore/kvKeyCodec',
    );
    boot.__setNativeCommittedForTests('epoch-1700000000000-0123456789abcdef0123456789abcdef');
    const encoded = encodeDurableKey(['B1', 'bill-1']);
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'durable_kv_txn_begin') return { sessionId: 's1' };
      if (cmd === 'durable_kv_txn_get_all_keys') return [encoded];
      if (cmd === 'durable_kv_txn_get') return sampleBill;
      if (cmd === 'durable_kv_txn_delete') throw new Error('native delete failed');
      return undefined;
    });
    (globalThis as unknown as { __TAURI__: { core: { invoke: typeof invoke } } }).__TAURI__ = {
      core: { invoke },
    };
    const { result } = renderHook(() => useSuspendedBills('B1'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.bills).toHaveLength(1);
    await act(async () => {
      await expect(result.current.removeBill('bill-1')).rejects.toThrow('native delete failed');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.bills).toHaveLength(1);
  });
});

const LEGACY_KEY_B1 = 'twinpet-suspended-bills:B1';
const LEGACY_KEY_B2 = 'twinpet-suspended-bills:B2';

const legacySampleBill = {
  id: 'bill-1',
  note: 'held',
  cartItems: [],
  customerId: null,
  discount: 0,
  createdAt: '2026-08-28T00:00:00.000Z',
  customer: null,
  discountPercent: false,
  feeRate: 0,
  totalAmount: 0,
  itemCount: 0,
};

function spySetItemThrowOn(targetKey: string, message = 'legacy setItem failed') {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (key === targetKey) throw new Error(message);
    return original.call(this, key, value);
  });
}

describe('useSuspendedBills legacy localStorage mutation', () => {
  afterEach(async () => {
    localStorage.removeItem(LEGACY_KEY_B1);
    localStorage.removeItem(LEGACY_KEY_B2);
    vi.restoreAllMocks();
    const boot = await vi.importActual<typeof import('../lib/platform/durableStore/bootDurableStore')>(
      '../lib/platform/durableStore/bootDurableStore',
    );
    boot.__resetBootDurableStoreForTests();
    delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  });

  async function mountLegacyHook(branchId = 'B1') {
    const boot = await vi.importActual<typeof import('../lib/platform/durableStore/bootDurableStore')>(
      '../lib/platform/durableStore/bootDurableStore',
    );
    const { useSuspendedBills } = await vi.importActual<typeof import('../lib/pos/useSuspendedBills')>(
      '../lib/pos/useSuspendedBills',
    );
    boot.__resetBootDurableStoreForTests();
    const hook = renderHook(() => useSuspendedBills(branchId));
    await waitFor(() => expect(hook.result.current.status).toBe('ready'));
    return hook;
  }

  test('successful legacy addBill persists then updates state', async () => {
    const { result } = await mountLegacyHook();
    await act(async () => {
      await result.current.addBill(legacySampleBill);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.bills).toHaveLength(1);
    expect(result.current.bills[0]?.id).toBe('bill-1');
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(1);
  });

  test('failed legacy addBill rejects and does not advance state', async () => {
    localStorage.setItem(LEGACY_KEY_B1, JSON.stringify([]));
    spySetItemThrowOn(LEGACY_KEY_B1);
    const { result } = await mountLegacyHook();
    await act(async () => {
      await expect(result.current.addBill(legacySampleBill)).rejects.toThrow('legacy setItem failed');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.bills).toHaveLength(0);
    expect(localStorage.getItem(LEGACY_KEY_B1)).toBe('[]');
  });

  test('successful legacy removeBill persists then removes from state', async () => {
    localStorage.setItem(LEGACY_KEY_B1, JSON.stringify([legacySampleBill]));
    const { result } = await mountLegacyHook();
    expect(result.current.bills).toHaveLength(1);
    await act(async () => {
      await result.current.removeBill('bill-1');
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.bills).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(0);
  });

  test('failed legacy removeBill rejects and leaves the bill durable', async () => {
    const raw = JSON.stringify([legacySampleBill]);
    localStorage.setItem(LEGACY_KEY_B1, raw);
    const { result } = await mountLegacyHook();
    expect(result.current.bills).toHaveLength(1);
    spySetItemThrowOn(LEGACY_KEY_B1);
    await act(async () => {
      await expect(result.current.removeBill('bill-1')).rejects.toThrow('legacy setItem failed');
    });
    expect(result.current.status).toBe('error');
    expect(result.current.bills).toHaveLength(1);
    expect(localStorage.getItem(LEGACY_KEY_B1)).toBe(raw);
  });

  test('failed persist on one branch does not rewrite another branch key', async () => {
    const otherRaw = JSON.stringify([{ ...legacySampleBill, id: 'bill-other' }]);
    localStorage.setItem(LEGACY_KEY_B2, otherRaw);
    localStorage.setItem(LEGACY_KEY_B1, JSON.stringify([]));
    spySetItemThrowOn(LEGACY_KEY_B1);
    const { result } = await mountLegacyHook('B1');
    await act(async () => {
      await expect(result.current.addBill(legacySampleBill)).rejects.toThrow('legacy setItem failed');
    });
    expect(localStorage.getItem(LEGACY_KEY_B2)).toBe(otherRaw);
    expect(localStorage.getItem(LEGACY_KEY_B1)).toBe('[]');
    expect(result.current.bills).toHaveLength(0);
  });
});

describe('Hold Bill · legacy localStorage failure (DOM interaction)', () => {
  afterEach(async () => {
    localStorage.removeItem(LEGACY_KEY_B1);
    localStorage.removeItem(LEGACY_KEY_B2);
    vi.restoreAllMocks();
    mocks.useRealSuspendedBills = false;
    const boot = await vi.importActual<typeof import('../lib/platform/durableStore/bootDurableStore')>(
      '../lib/platform/durableStore/bootDurableStore',
    );
    boot.__resetBootDurableStoreForTests();
  });

  test('legacy addBill setItem failure preserves the active cart and does not report success', async () => {
    mocks.useRealSuspendedBills = true;
    spySetItemThrowOn(LEGACY_KEY_B1);
    const user = userEvent.setup();
    render(<POSPage />);
    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await waitFor(() => expect((holdBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(holdBtn);
    await user.click(screen.getByTestId('hold-note-confirm'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({ title: 'พักบิลไม่สำเร็จ' }));
    expect(mocks.clearCart).not.toHaveBeenCalled();
    expect(screen.getByTestId('hold-note-modal')).toBeTruthy();
    expect(mocks.showToast.mock.calls.some((call) => JSON.stringify(call[0]).includes('เรียบร้อย'))).toBe(false);
    expect(localStorage.getItem(LEGACY_KEY_B1)).toBeNull();
  });

  test('failed hold preserves cart contents and does not assume a persisted bill', async () => {
    mocks.useRealSuspendedBills = true;
    spySetItemThrowOn(LEGACY_KEY_B1);
    const user = userEvent.setup();
    render(<POSPage />);
    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await waitFor(() => expect((holdBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(holdBtn);
    await user.click(screen.getByTestId('hold-note-confirm'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({ title: 'พักบิลไม่สำเร็จ' }));
    expect(mocks.cartHasItems).toBe(true);
    expect(mocks.clearCart).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(0);
  });

  test('legacy removeBill setItem failure does not restore cart or customer', async () => {
    mocks.useRealSuspendedBills = true;
    mocks.cartHasItems = false;
    localStorage.setItem(LEGACY_KEY_B1, JSON.stringify([legacySampleBill]));
    mocks.bills = [legacySampleBill];
    spySetItemThrowOn(LEGACY_KEY_B1);
    const user = userEvent.setup();
    render(<POSPage />);
    const listBtn = await screen.findByRole('button', { name: /บิลที่พักไว้/ });
    await waitFor(() => expect((listBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(listBtn);
    await user.click(screen.getByTestId('restore-bill'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({ title: 'เรียกคืนบิลไม่สำเร็จ' }));
    expect(mocks.restoreCart).not.toHaveBeenCalled();
    expect(mocks.setCustomer).not.toHaveBeenCalled();
    expect(screen.getByTestId('suspended-list-modal')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(1);
    expect(mocks.bills).toHaveLength(1);
  });

  test('failed restore does not restore cart and leaves a single restore opportunity', async () => {
    mocks.useRealSuspendedBills = true;
    mocks.cartHasItems = false;
    const raw = JSON.stringify([legacySampleBill]);
    localStorage.setItem(LEGACY_KEY_B1, raw);
    mocks.bills = [legacySampleBill];
    spySetItemThrowOn(LEGACY_KEY_B1);
    const user = userEvent.setup();
    render(<POSPage />);
    const listBtn = await screen.findByRole('button', { name: /บิลที่พักไว้/ });
    await waitFor(() => expect((listBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(listBtn);
    await user.click(screen.getByTestId('restore-bill'));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith({ title: 'เรียกคืนบิลไม่สำเร็จ' }));
    expect(mocks.restoreCart).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY_B1)).toBe(raw);
    await user.click(screen.getByTestId('restore-bill'));
    await waitFor(() => expect(mocks.showToast.mock.calls.filter((call) =>
      JSON.stringify(call[0]).includes('เรียกคืนบิลไม่สำเร็จ'),
    ).length).toBeGreaterThanOrEqual(2));
    expect(mocks.restoreCart).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(1);
  });

  test('successful legacy addBill still persists and clears the cart', async () => {
    mocks.useRealSuspendedBills = true;
    const user = userEvent.setup();
    render(<POSPage />);
    const holdBtn = await screen.findByRole('button', { name: /พักบิล/ });
    await waitFor(() => expect((holdBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(holdBtn);
    await user.click(screen.getByTestId('hold-note-confirm'));
    await waitFor(() => expect(mocks.clearCart).toHaveBeenCalled());
    expect(screen.queryByTestId('hold-note-modal')).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledWith({ title: 'พักบิลเรียบร้อย' });
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(1);
  });

  test('successful legacy removeBill still restores cart after durable delete', async () => {
    mocks.useRealSuspendedBills = true;
    mocks.cartHasItems = false;
    localStorage.setItem(LEGACY_KEY_B1, JSON.stringify([legacySampleBill]));
    mocks.bills = [legacySampleBill];
    const user = userEvent.setup();
    render(<POSPage />);
    const listBtn = await screen.findByRole('button', { name: /บิลที่พักไว้/ });
    await waitFor(() => expect((listBtn as HTMLButtonElement).disabled).toBe(false));
    await user.click(listBtn);
    await user.click(screen.getByTestId('restore-bill'));
    await waitFor(() => expect(mocks.restoreCart).toHaveBeenCalled());
    expect(mocks.setCustomer).toHaveBeenCalled();
    expect(screen.queryByTestId('suspended-list-modal')).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledWith({ title: 'เรียกคืนบิลแล้ว' });
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY_B1) ?? '[]')).toHaveLength(0);
  });
});
