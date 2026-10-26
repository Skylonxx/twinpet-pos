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
  listOnlineCloseAttempts: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  findRejectedOpenForDevice: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  findPendingOpenForStaff: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  listOpenIntents: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  claimLegacyNormalizationChecks: vi.fn().mockResolvedValue({ ok: false, code: 'unavailable', message: 'IndexedDB unavailable' }),
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
  useLocalLedger: () => ({ sales: [], loaded: false }),
}));

// ── Service / config mocks ────────────────────────────────────────────────
vi.mock('../lib/pos/shiftService', () => ({
  readActiveShiftForBoot: mocks.readActiveShiftForBoot,
  readShiftCloseConfirmation: mocks.readShiftCloseConfirmation,
  readShiftOpenConfirmation: mocks.readShiftOpenConfirmation,
  normalizeShiftCloseSyncState: mocks.normalizeShiftCloseSyncState,
  reissueShiftOpenWrite: mocks.reissueShiftOpenWrite,
  buildLocalOpenShiftSnapshot: mocks.buildLocalOpenShiftSnapshot,
}));
vi.mock('../lib/pos/offline/shiftCloseIntentStore', async (importOriginal) => ({
  // Gate 008-B: the real pure helpers (the real sweep imports them); only the journal is replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  createShiftCloseIntentJournal: () => ({
    getCloseIntent: mocks.getCloseIntent,
    listCloseIntents: mocks.listCloseIntents,
    listOnlineCloseAttempts: mocks.listOnlineCloseAttempts,
    upsertCloseIntent: vi.fn(),
    markSynced: vi.fn(),
    markRejectedManualAttention: vi.fn(),
    claimLegacyNormalizationChecks: mocks.claimLegacyNormalizationChecks,
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
vi.mock('../lib/pos/offline/shiftCloseReconciler', async (importOriginal) => ({
  // Gate 007-C / 008-B: the real (pure) reporters of the sweep's summary
  // (every real export); only the sweep itself is replaced.
  ...(await importOriginal<Record<string, unknown>>()),
  runShiftCloseReconciliationSweep: mocks.runShiftCloseReconciliationSweep,
}));
vi.mock('../lib/pos/offline/shiftOpenReconciler', () => ({
  runShiftOpenReconciliationSweep: mocks.runShiftOpenReconciliationSweep,
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
  OpenShiftModal: ({ attentionMessage }: { attentionMessage?: string | null }) => (
    <div data-testid="open-shift-modal">
      {attentionMessage ? <span data-testid="open-shift-attention-prop">{attentionMessage}</span> : null}
    </div>
  ),
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
  mocks.listOnlineCloseAttempts.mockResolvedValue({ ok: true, value: [] });
  mocks.findRejectedOpenForDevice.mockResolvedValue({ ok: true, value: undefined });
  mocks.findPendingOpenForStaff.mockResolvedValue({ ok: true, value: undefined });
  mocks.listOpenIntents.mockResolvedValue({ ok: true, value: [] });
  mocks.runShiftCloseReconciliationSweep.mockResolvedValue([]);
  mocks.runShiftOpenReconciliationSweep.mockResolvedValue([]);
});

describe('POSPage — Packet 7C-B2 boot fail-closed guard (RC-3)', () => {
  test('non-ok close-intent store read blocks live drawer reopen and does not open OpenShiftModal', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'found',
      shift: makeOpenShift(),
      provenance: 'server',
    });
    mocks.getCloseIntent.mockResolvedValue({ ok: false, code: 'unavailable' });

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
    expect(screen.queryByTestId('open-shift-modal')).toBeNull();
  });

  test('found/server with no local close-intent loads live drawer (no blocked/open-shift modal)', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'found',
      shift: makeOpenShift(),
      provenance: 'server',
    });
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });

    render(<POSPage />);

    await waitFor(() => {
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
      expect(screen.queryByTestId('open-shift-modal')).toBeNull();
    });
  });

  test('found/cache with no local close-intent loads live drawer (no blocked/open-shift modal)', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'found',
      shift: makeOpenShift(),
      provenance: 'cache',
    });
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });

    render(<POSPage />);

    await waitFor(() => {
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
      expect(screen.queryByTestId('open-shift-modal')).toBeNull();
    });
  });

  test('recovery gate B2: found/CACHE + an unresolved online close attempt for that shift → attention, never a live drawer', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'found', shift: makeOpenShift(), provenance: 'cache' });
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });
    mocks.listOnlineCloseAttempts.mockResolvedValue({ ok: true, value: [{ shiftId: makeOpenShift().id }] });

    render(<POSPage />);

    expect(await screen.findByTestId('open-shift-modal')).toBeTruthy();
    expect(await screen.findByTestId('open-shift-attention-prop')).toBeTruthy();
    expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
  });

  test('recovery gate B2: found/CACHE + unreadable attempt list → fail closed (blocked)', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'found', shift: makeOpenShift(), provenance: 'cache' });
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });
    mocks.listOnlineCloseAttempts.mockResolvedValue({ ok: false, code: 'unavailable' });

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
  });

  test('recovery gate B2: found/SERVER + an attempt (never committed) → live drawer restored; the server read is authoritative', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'found', shift: makeOpenShift(), provenance: 'server' });
    mocks.getCloseIntent.mockResolvedValue({ ok: true, value: undefined });
    mocks.listOnlineCloseAttempts.mockResolvedValue({ ok: true, value: [{ shiftId: makeOpenShift().id }] });

    render(<POSPage />);

    await waitFor(() => {
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
      expect(screen.queryByTestId('open-shift-modal')).toBeNull();
    });
    expect(mocks.listOnlineCloseAttempts).not.toHaveBeenCalled();
  });

  test('a locally-closed shift (intent present) stays closed on boot — OpenShiftModal renders with attention, not free open', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'found',
      shift: makeOpenShift(),
      provenance: 'server',
    });
    mocks.getCloseIntent.mockResolvedValue({
      ok: true,
      value: { shiftId: 'shift-1', status: 'local_closed_pending' },
    });

    render(<POSPage />);

    expect(await screen.findByTestId('open-shift-modal')).toBeTruthy();
    expect(await screen.findByTestId('open-shift-attention-prop')).toBeTruthy();
    expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
  });

  test('PK-1: pending local open is restored at boot without OpenShiftModal', async () => {
    mocks.findPendingOpenForStaff.mockResolvedValue({
      ok: true,
      value: {
        shiftId: 'pending-open-1',
        branchId: 'B1',
        staffId: 'U1',
        staffName: 'Test User',
        startingCash: 300,
        deviceId: 'DEV-TEST',
        openedAtLocal: Date.now(),
        status: 'local_open_pending',
        createdAtLocal: Date.now(),
        updatedAtLocal: Date.now(),
        lastErrorMessage: null,
      },
    });
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });

    render(<POSPage />);

    await waitFor(() => {
      expect(screen.queryByTestId('open-shift-modal')).toBeNull();
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
      expect(screen.getByTestId('shift-open-pending-banner')).toBeTruthy();
    });
    expect(mocks.buildLocalOpenShiftSnapshot).toHaveBeenCalled();
    expect(mocks.readActiveShiftForBoot).not.toHaveBeenCalled();
  });

  test('PK-1: rejected open surfaces durable attention and disables free open', async () => {
    mocks.findRejectedOpenForDevice.mockResolvedValue({
      ok: true,
      value: {
        shiftId: 'rej-open',
        status: 'rejected_manual_attention',
        lastErrorMessage: 'rules denied',
        deviceId: 'DEV-TEST',
      },
    });

    render(<POSPage />);

    expect(await screen.findByTestId('open-shift-attention-prop')).toBeTruthy();
    expect(screen.getByTestId('open-shift-attention-prop').textContent).toContain('rules denied');
  });

  test('retry re-runs the boot check and clears the blocked state once the store becomes readable', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'found',
      shift: makeOpenShift(),
      provenance: 'server',
    });
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

  test('absent active shift is unaffected by the close-intent guard', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });

    render(<POSPage />);

    expect(await screen.findByTestId('open-shift-modal')).toBeTruthy();
    expect(mocks.getCloseIntent).not.toHaveBeenCalled();
  });

  test('unverifiable/cache_empty blocks OpenShiftModal', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'unverifiable',
      reason: 'cache_empty',
    });

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
    expect(screen.queryByTestId('open-shift-modal')).toBeNull();
  });

  test('unverifiable/cache_unavailable blocks OpenShiftModal', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'unverifiable',
      reason: 'cache_unavailable',
    });

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
    expect(screen.queryByTestId('open-shift-modal')).toBeNull();
  });

  test('unverifiable/read_failed blocks OpenShiftModal', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({
      status: 'unverifiable',
      reason: 'read_failed',
    });

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
    expect(screen.queryByTestId('open-shift-modal')).toBeNull();
  });

  test('readActiveShiftForBoot promise rejection fails closed via catch', async () => {
    mocks.readActiveShiftForBoot.mockRejectedValue(new Error('unexpected boot failure'));

    render(<POSPage />);

    expect(await screen.findByTestId('shift-boot-blocked-modal')).toBeTruthy();
    expect(screen.queryByTestId('open-shift-modal')).toBeNull();
  });

  test('retry from unverifiable then absent clears blocker and opens free-open path', async () => {
    mocks.readActiveShiftForBoot
      .mockResolvedValueOnce({ status: 'unverifiable', reason: 'cache_empty' })
      .mockResolvedValue({ status: 'absent', provenance: 'server' });

    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<POSPage />);

    const retryBtn = await screen.findByTestId('shift-boot-blocked-retry');
    await user.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('shift-boot-blocked-modal')).toBeNull();
      expect(screen.getByTestId('open-shift-modal')).toBeTruthy();
    });
  });
});

describe('POSPage — Packet 7C-B2 + PK-1 boot/reconnect reconciliation sweep', () => {
  test('runs close and open reconciliation sweeps once shiftReady, scoped to this device', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });

    render(<POSPage />);

    await waitFor(() => {
      expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalled();
      expect(mocks.runShiftOpenReconciliationSweep).toHaveBeenCalled();
    });
    const closeCall = mocks.runShiftCloseReconciliationSweep.mock.calls[0]![0];
    expect(closeCall.deviceId).toBe('DEV-TEST');
    const openCall = mocks.runShiftOpenReconciliationSweep.mock.calls[0]![0];
    expect(openCall.deviceId).toBe('DEV-TEST');
    expect(typeof openCall.reissueOpenWrite).toBe('function');
  });

  test('re-runs both sweeps on a browser "online" event', async () => {
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });

    render(<POSPage />);

    await waitFor(() => {
      expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(1);
      expect(mocks.runShiftOpenReconciliationSweep).toHaveBeenCalledTimes(1);
    });

    window.dispatchEvent(new Event('online'));

    await waitFor(() => {
      expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(2);
      expect(mocks.runShiftOpenReconciliationSweep).toHaveBeenCalledTimes(2);
    });
  });
});

// Gate 007-C — POSPage does not discard the sweep's W4 normalization outcome.
describe('POSPage — shift-close W4 normalization outcome is observed (gate 007-C)', () => {
  const ATTENTION = '[POSPage] shift-close W4 normalization needs attention';
  /** The production sweep result: the pending-close array plus its non-enumerable `normalization`. */
  function sweepResult(normalization: Record<string, unknown>) {
    return Object.defineProperty([], 'normalization', { value: normalization, enumerable: false });
  }
  const DEGRADED = { status: 'degraded', results: [], counts: { claim_failed: 2 }, owed: 2 };

  test('a degraded summary (claim_failed) is logged once per distinct state — not again on every trigger; ok is silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });
    mocks.runShiftCloseReconciliationSweep.mockResolvedValue(sweepResult(DEGRADED));

    render(<POSPage />);

    await waitFor(() => {
      expect(warn.mock.calls.filter((c) => c[0] === ATTENTION)).toHaveLength(1);
    });
    // Parent: nothing was logged — the normalization outcome was dropped.
    expect(warn.mock.calls.find((c) => c[0] === ATTENTION)?.[1]).toBe('claim_failed=2');

    window.dispatchEvent(new Event('online')); // same state again
    await waitFor(() => expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 10));
    expect(warn.mock.calls.filter((c) => c[0] === ATTENTION)).toHaveLength(1);

    mocks.runShiftCloseReconciliationSweep.mockResolvedValue(sweepResult({ status: 'ok', results: [], counts: {}, owed: 0 }));
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(3));
    mocks.runShiftCloseReconciliationSweep.mockResolvedValue(sweepResult({ ...DEGRADED, counts: { local_write_failed: 1 } }));
    window.dispatchEvent(new Event('online'));
    await waitFor(() => {
      expect(warn.mock.calls.filter((c) => c[0] === ATTENTION).map((c) => c[1])).toEqual(['claim_failed=2', 'local_write_failed=1']);
    });
    warn.mockRestore();
  });
});

// Gate 008-B — the warning is scoped to WHICH close needs attention, and a
// failing sweep is reported, not swallowed. The REAL sweep runs over the
// mocked journal (claim persistence down), so the summary is production-built.
describe('POSPage — scoped shift-close attention warnings (gate 008-B)', () => {
  const ATTENTION = '[POSPage] shift-close W4 normalization needs attention';
  const SWEEP_FAILED = '[POSPage] shift-close reconciliation sweep failed';
  /** A pre-B2.2 `synced` close of this device (W4 never checked). */
  function legacyClose(shiftId: string, branchId: string) {
    return {
      shiftId, branchId, staffId: 'U1', staffName: 'Test User', startingCash: 0, expectedCash: 0, expectedQr: 0, expectedKbank: 0,
      expectedCard: 0, expectedCredit: 0, payInTotal: 0, payOutTotal: 0, totalBills: 0, actualCashCount: 0, variance: 0, note: '',
      deviceId: 'DEV-TEST', closedAtLocal: 1, closeCorrelationId: null, status: 'synced', createdAtLocal: 1, updatedAtLocal: 1,
      lastErrorMessage: null,
    };
  }
  async function useRealSweep() {
    const real = await vi.importActual<typeof import('../lib/pos/offline/shiftCloseReconciler')>('../lib/pos/offline/shiftCloseReconciler');
    mocks.runShiftCloseReconciliationSweep.mockImplementation(real.runShiftCloseReconciliationSweep);
  }
  const attentionCalls = (warn: { mock: { calls: unknown[][] } }) => warn.mock.calls.filter((c) => c[0] === ATTENTION);
  const scopeOf = (call: unknown[]) =>
    ((call[2] as { attention?: Array<{ shiftId: string | null; branchId: string | null; condition: string }> })?.attention ?? []).map(
      (a) => `${a.branchId}/${a.shiftId}:${a.condition}`,
    );

  test('shift A claim_failed=1 resolves, then shift B of ANOTHER branch develops the same count → a new warning naming B; unchanged B is not repeated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await useRealSweep();
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });
    mocks.listCloseIntents.mockResolvedValue({ ok: true, value: [legacyClose('shift-A', 'B1')] });

    render(<POSPage />);
    await waitFor(() => expect(attentionCalls(warn)).toHaveLength(1));
    expect(attentionCalls(warn)[0]![1]).toBe('claim_failed=1');
    expect(scopeOf(attentionCalls(warn)[0]!)).toEqual(['B1/shift-A:claim_failed']);
    expect(mocks.readShiftCloseConfirmation).not.toHaveBeenCalled(); // claim failed → nothing read

    // A resolves; B (branch B2, same device) now has the identical count.
    mocks.listCloseIntents.mockResolvedValue({ ok: true, value: [legacyClose('shift-B', 'B2')] });
    window.dispatchEvent(new Event('online'));
    // Parent: the issue string "claim_failed=1" is unchanged → B's problem is never reported.
    await waitFor(() => expect(attentionCalls(warn)).toHaveLength(2));
    expect(attentionCalls(warn)[1]![1]).toBe('claim_failed=1');
    expect(scopeOf(attentionCalls(warn)[1]!)).toEqual(['B2/shift-B:claim_failed']);

    // Unchanged B → no repeat.
    const calls = mocks.runShiftCloseReconciliationSweep.mock.calls.length;
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(mocks.runShiftCloseReconciliationSweep.mock.calls.length).toBe(calls + 1));
    await new Promise((r) => setTimeout(r, 20));
    expect(attentionCalls(warn)).toHaveLength(2);
    warn.mockRestore();
  });

  test('a sweep that throws is reported once (not swallowed), and not again while the failure is unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.readActiveShiftForBoot.mockResolvedValue({ status: 'absent', provenance: 'server' });
    mocks.runShiftCloseReconciliationSweep.mockRejectedValue(new Error('IndexedDB transaction aborted'));

    render(<POSPage />);
    // Parent: `.catch(() => {})` — the failure was invisible.
    await waitFor(() => expect(warn.mock.calls.filter((c) => c[0] === SWEEP_FAILED)).toHaveLength(1));
    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(mocks.runShiftCloseReconciliationSweep).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(warn.mock.calls.filter((c) => c[0] === SWEEP_FAILED)).toHaveLength(1);
    warn.mockRestore();
  });
});
