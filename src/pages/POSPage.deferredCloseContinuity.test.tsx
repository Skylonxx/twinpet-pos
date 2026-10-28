// @vitest-environment jsdom
// Packet 023 parity remediation — POS screen acceptance (Codex 023
// MASTER_PLAN_PARITY_BLOCKER): shift A of this cashier was closed OFFLINE by the
// server-authoritative close (deferred: journal record, NO client W3, so the
// cached doc still reads `open`). With the device still offline, the cashier
// must reach a usable POS: the REAL boot does not restore A, the REAL
// OpenShiftModal → REAL `openShift` opens a NEW shift B, the checkout button is
// enabled and the payment confirm reaches checkout bound to B (never A) — also
// after a restart (re-mount over the same IndexedDB).
//
// Real: POSPage boot, ShiftModals, shiftService (`readActiveShiftForBoot`,
// `openShift`), close + open journals (fake-indexeddb). Faked: Firestore (this
// device's offline cache only), inventory / cart (one line) / payment modal /
// `useCheckout` (records the shift it is bound to and the confirm), sweeps
// (no server). Not proven here: the real sale write path inside `useCheckout`
// (unchanged; it uses `activeShift.id`), real WebView2 / Tauri, real devices.

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  cache: new Map<string, Record<string, unknown>>(),
  checkoutShiftIds: [] as Array<string | null>,
  confirmSale: vi.fn(),
  autoId: 0,
}));

// ── Firestore: offline, this device's cache only ──
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  type Q = { constraints: Array<{ field?: string; value?: unknown; limit?: number }> };
  const snapOf = (q: Q) => {
    const lim = q.constraints.find((c) => c.limit !== undefined)?.limit ?? Infinity;
    const docs = [...h.cache.entries()]
      .filter(([, d]) => q.constraints.every((c) => c.field === undefined || d[c.field] === c.value))
      .slice(0, lim)
      .map(([id, d]) => ({ id, data: () => ({ ...d }) }));
    return { empty: docs.length === 0, docs, metadata: { fromCache: true } };
  };
  return {
    ...actual,
    collection: vi.fn((_db: unknown, name: string) => ({ collection: name })),
    doc: vi.fn((a: unknown, b?: string, id?: string) =>
      b === undefined ? { collection: (a as { collection: string }).collection, id: `B-${(h.autoId += 1)}` } : { collection: b, id: id! },
    ),
    query: vi.fn((_c: unknown, ...constraints: unknown[]) => ({ constraints })),
    where: vi.fn((field: string, _op: string, value: unknown) => ({ field, value })),
    limit: vi.fn((n: number) => ({ limit: n })),
    serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
    getDocs: vi.fn(async (q: Q) => snapOf(q)),
    getDocsFromCache: vi.fn(async (q: Q) => snapOf(q)),
    getDocFromCache: vi.fn(async (ref: { id: string }) => {
      const d = h.cache.get(ref.id);
      return { exists: () => d !== undefined, data: () => d };
    }),
    getDocFromServer: vi.fn(async () => {
      throw Object.assign(new Error('offline'), { code: 'unavailable' });
    }),
    setDoc: vi.fn((ref: { collection: string; id: string }, payload: Record<string, unknown>) => {
      if (ref.collection === 'shifts') h.cache.set(ref.id, { ...payload });
      return new Promise<void>(() => undefined); // queued, never acknowledged offline
    }),
    updateDoc: vi.fn(() => new Promise<void>(() => undefined)),
  };
});
vi.mock('../lib/firebase', () => ({
  isFirebaseConfigured: true,
  db: {},
  collections: { shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'DEV-TEST' }));

// ── Page dependencies not under test ──
vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'U1', firstName: 'Test', lastName: 'User' }, branchId: 'B1' }),
}));
vi.mock('../lib/hooks/useBranch', () => ({ useBranch: () => ({ branch: { name: 'สาขาทดสอบ' } }) }));
vi.mock('../hooks/pos/usePosInventory', () => ({
  usePosInventory: () => ({
    products: [], categories: [], richCategories: [], sorting: {}, quickMenus: [], fromCache: true,
    loading: false, refreshing: false, error: null, refreshInventory: vi.fn(),
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
const CART_LINE = {
  lineKey: 'L1', productId: 'P1', productName: 'อาหารแมว', category: 'cat', sku: 'SKU1', unit: 'ชิ้น', unitFactor: 1,
  qty: 1, unitPrice: 100, originalPrice: 100, discount: { type: 'none', val: 0 },
};
vi.mock('../hooks/pos/useCart', () => ({
  getActivePriceForCustomer: () => ({ unitPrice: 100, originalPrice: 100 }),
  useCart: () => ({
    cart: { L1: CART_LINE },
    cartLines: [CART_LINE],
    totals: { subtotal: 100, billDiscount: 0, fee: 0, grandTotal: 100, itemCount: 1, totalQty: 1 },
    receiptLines: [],
    cartQtyByProduct: new Map([['P1', 1]]),
    billDiscValue: 0, setBillDiscValue: vi.fn(), billDiscPercent: false, setBillDiscPercent: vi.fn(),
    feeRate: 0, setFeeRate: vi.fn(), addToCart: vi.fn(), changeQty: vi.fn(), removeLine: vi.fn(),
    setLineQty: vi.fn(() => true), setLineDiscount: vi.fn(), clearCart: vi.fn(), restoreCart: vi.fn(),
  }),
}));
vi.mock('../hooks/pos/useCheckout', () => ({
  useCheckout: ({ activeShift }: { activeShift: { id: string } | null }) => {
    h.checkoutShiftIds.push(activeShift?.id ?? null);
    return {
      customer: null, setCustomer: vi.fn(), selectCustomer: vi.fn(), clearCustomer: vi.fn(),
      customerModalOpen: false, openCustomerModal: vi.fn(), closeCustomerModal: vi.fn(), processing: false,
      confirmSale: (...args: unknown[]) => h.confirmSale(activeShift?.id ?? null, ...args),
    };
  },
}));
vi.mock('../components/PaymentModal', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: (p: unknown[]) => void }) =>
    open ? (
      <button type="button" data-testid="payment-confirm" onClick={() => onConfirm([{ method: 'cash', amount: 100 }])}>
        confirm
      </button>
    ) : null,
}));
vi.mock('../components/ui/use-toast', () => ({ useToastDispatcher: () => vi.fn() }));
vi.mock('../lib/hooks/useLocalLedger', () => ({ useLocalLedger: () => ({ sales: [], loaded: true }) }));
vi.mock('../lib/pos/offline/shiftCloseReconciler', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runShiftCloseReconciliationSweep: vi.fn().mockResolvedValue(Object.assign([], { normalization: undefined })),
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({ runShiftOpenReconciliationSweep: vi.fn().mockResolvedValue([]) }));
vi.mock('../lib/pos/billId', () => ({ refreshReceiptConfigCache: vi.fn() }));
vi.mock('../lib/pos/shiftLedger', () => ({ deriveShiftDrawer: (s: unknown) => s }));
vi.mock('../lib/branches', () => ({ getBranchLabel: () => 'B1' }));
vi.mock('../lib/config/features', () => ({ POS_FEATURES: { enableLoyaltyPoints: false } }));
vi.mock('flowbite-react', () => ({ Badge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span> }));
vi.mock('../components/pos/SuspendedBillModals', () => ({ HoldBillNoteModal: () => null, SuspendedBillsListModal: () => null }));
vi.mock('../components/pos/ItemDiscountModal', () => ({ default: () => null }));
vi.mock('../components/customers/CustomerPickerModal', () => ({ default: () => null, PosCustomerPick: undefined }));
vi.mock('../components/products/ProductPickerDialog', () => ({ default: () => null, posProductToPickerItem: (p: unknown) => p }));
vi.mock('../components/pos/CashTransactionModal', () => ({ default: () => null }));
vi.mock('../components/pos/NumpadDialog', () => ({ default: () => null }));
vi.mock('../components/pos/UomModal', () => ({ default: () => null }));
vi.mock('../components/pos/SortingSettingsModal', () => ({ default: () => null }));
vi.mock('../components/common/DestructiveConfirmModal', () => ({ default: () => null }));
vi.mock('../components/products/ProductImageThumb', () => ({ default: () => null }));
vi.mock('../components/pos/SyncIndicator', () => ({ default: () => null }));
vi.mock('../components/pos/ConnectivityChip', () => ({ default: () => null }));
vi.mock('../components/pos/SaleIntentSyncPanel', () => ({ default: () => null }));

import POSPage from './POSPage';
import { SHIFT_CLOSE_INTENT_DB_NAME, createShiftCloseIntentJournal } from '../lib/pos/offline/shiftCloseIntentStore';
import { createShiftOpenIntentJournal } from '../lib/pos/offline/shiftOpenIntentStore';

const noTrustedSweep = vi.fn(async () => ({ ok: true }) as never);

function shiftA(over: Record<string, unknown> = {}) {
  return {
    id: 'A', branchId: 'B1', staffId: 'U1', staffName: 'Test User', status: 'open', openedAt: { toMillis: () => 1 }, closedAt: null,
    startingCash: 500, actualCashCount: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
    totalBills: 0, payInTotal: 0, payOutTotal: 0, variance: 0, note: '', cashEntries: [], ...over,
  };
}

/** The durable record a gate-ON offline close of A leaves (shiftService.deferredAuthoritativeClose.test.ts produces it end to end). */
async function seedDeferredCloseOfA() {
  const r = await createShiftCloseIntentJournal().upsertCloseIntent(
    {
      shiftId: 'A', branchId: 'B1', staffId: 'U1', staffName: 'Test User', startingCash: 500, expectedCash: 1000, expectedQr: 0,
      expectedKbank: 0, expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 2, actualCashCount: 1500,
      variance: 0, note: '', deviceId: 'DEV-TEST',
    },
    undefined,
    undefined,
    { closeProtocol: 'server_authoritative_v1' },
  );
  expect(r).toMatchObject({ ok: true, value: { status: 'local_closed_pending', closeProtocol: 'server_authoritative_v1' } });
}

async function openShiftThroughTheModal(startingCash = '300') {
  fireEvent.change(await screen.findByLabelText('เงินทอนเริ่มต้น (Starting Cash)'), { target: { value: startingCash } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'เปิดกะ' }));
  });
}

async function checkout() {
  const pay = await screen.findByRole('button', { name: /ชำระเงิน \(F12\)/ });
  await waitFor(() => expect((pay as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(pay);
  });
  await act(async () => {
    fireEvent.click(await screen.findByTestId('payment-confirm'));
  });
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await deleteDb(SHIFT_CLOSE_INTENT_DB_NAME);
  for (const d of (await indexedDB.databases?.()) ?? []) if (d.name) await deleteDb(d.name);
  h.cache.clear();
  h.checkoutShiftIds.length = 0;
  h.confirmSale.mockReset();
  h.autoId = 0;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('POSPage — 023 offline continuity after a deferred close (A pending, device offline)', () => {
  test('[RED at the pre-remediation 023 source] restart after A\'s offline close: no boot block / attention, cashier opens NEW shift B and the sale is confirmed against B — never A', async () => {
    h.cache.set('A', shiftA()); // cached doc still `open` (no client W3 was queued)
    await seedDeferredCloseOfA();

    render(<POSPage trustedResumeSweep={noTrustedSweep} />);
    await openShiftThroughTheModal();
    expect(screen.queryByTestId('shift-open-attention')).toBeNull();

    await checkout();
    expect(h.confirmSale).toHaveBeenCalledTimes(1);
    const [boundShiftId] = h.confirmSale.mock.calls[0]!;
    expect(boundShiftId).toMatch(/^B-/);
    expect(boundShiftId).not.toBe('A');
    expect(h.checkoutShiftIds).not.toContain('A');
    // A is still a pending local close (not confirmed, not reopened)
    const a = await createShiftCloseIntentJournal().getCloseIntent('A');
    expect(a).toMatchObject({ ok: true, value: { status: 'local_closed_pending' } });
    expect(h.cache.get('A')?.status).toBe('open');
  });

  test('restart AFTER B was opened: boot restores B (its pending offline open), never A, and checkout works again', async () => {
    h.cache.set('A', shiftA());
    await seedDeferredCloseOfA();
    const first = render(<POSPage trustedResumeSweep={noTrustedSweep} />);
    await openShiftThroughTheModal();
    await waitFor(() => expect(h.checkoutShiftIds.at(-1)).toMatch(/^B-/));
    const bId = h.checkoutShiftIds.at(-1);
    first.unmount();
    h.checkoutShiftIds.length = 0;

    render(<POSPage trustedResumeSweep={noTrustedSweep} />);
    await checkout();
    expect(h.confirmSale.mock.calls.at(-1)![0]).toBe(bId);
    expect(screen.queryByLabelText('เงินทอนเริ่มต้น (Starting Cash)')).toBeNull();
  });

  test('[RED at the pre-remediation 023 source] A itself had been opened offline (pending open intent): boot never restores A; a new shift is opened', async () => {
    const open = await createShiftOpenIntentJournal().upsertOpenIntent({
      shiftId: 'A', branchId: 'B1', staffId: 'U1', staffName: 'Test User', startingCash: 500, deviceId: 'DEV-TEST',
    });
    expect(open.ok).toBe(true);
    h.cache.set('A', shiftA());
    await seedDeferredCloseOfA();

    render(<POSPage trustedResumeSweep={noTrustedSweep} />);
    await openShiftThroughTheModal();
    await checkout();
    expect(h.confirmSale.mock.calls[0]![0]).toMatch(/^B-/);
    expect(h.checkoutShiftIds).not.toContain('A');
  });

  test('no deferred record and an empty cache: the PK-2A boot block is unchanged (unverifiable, no open)', async () => {
    render(<POSPage trustedResumeSweep={noTrustedSweep} />);
    expect(await screen.findByText('ไม่สามารถยืนยันสถานะกะได้')).toBeTruthy();
    expect(screen.queryByLabelText('เงินทอนเริ่มต้น (Starting Cash)')).toBeNull();
  });
});
