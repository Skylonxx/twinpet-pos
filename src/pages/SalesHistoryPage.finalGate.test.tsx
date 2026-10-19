// @vitest-environment jsdom

/**
 * Return/Refund V1 — final release gates, through the REAL page/hook/modal
 * stack with a mocked Firestore listener adapter (snapshot METADATA included):
 *
 *  §1 Reporting completeness: Sales History and the Profit report may claim
 *     NET only after a server-confirmed (fromCache === false) branch snapshot.
 *  §3 Unknown cash Return: the shift cash guard is written BEFORE the send,
 *     survives modal close/reopen and page reload, blocks an OFFLINE close
 *     (real `closeShift`), and is released only by a definitive outcome
 *     (not-committed) or by the post-commit server sync of the shift.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaleRecord } from '../lib/salesHistory/types';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';
import type { ApproverRosterState } from '../lib/auth/useApproverRoster';
import type { SaleReturnContextResult, SubmitSaleReturnResult } from '../lib/saleReturn/saleReturnService';
import type { SaleReturnContextView } from '../lib/saleReturn/saleReturnTypes';
import type { Shift } from '../lib/types';

// ── Firestore listener adapter (records every onSnapshot with its options) ──

type Listener = {
  name: string;
  opts: Record<string, unknown> | null;
  next: (snap: unknown) => void;
  error: (err: unknown) => void;
  active: boolean;
};

const fs = vi.hoisted(() => ({
  listeners: [] as Listener[],
  orderItems: new Map<string, unknown[]>(),
  getDocFromServer: vi.fn(),
  getDocFromCache: vi.fn(),
  updateDoc: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  const ref = (...segs: unknown[]) => ({ name: segs.filter((s) => typeof s === 'string').join('/') });
  return {
    ...actual,
    collection: (_db: unknown, ...segs: string[]) => ref(...segs),
    doc: (_db: unknown, ...segs: string[]) => ref(...segs),
    query: (c: { name: string }) => c,
    where: () => ({}),
    orderBy: () => ({}),
    onSnapshot: (q: { name: string }, a: unknown, b?: unknown, c?: unknown) => {
      const withOpts = typeof a !== 'function';
      const l: Listener = {
        name: q.name,
        opts: withOpts ? (a as Record<string, unknown>) : null,
        next: (withOpts ? b : a) as Listener['next'],
        error: ((withOpts ? c : b) ?? (() => {})) as Listener['error'],
        active: true,
      };
      fs.listeners.push(l);
      return () => {
        l.active = false;
      };
    },
    getDocs: async (c: { name: string }) => {
      const orderId = c.name.split('/')[1] ?? '';
      const items = fs.orderItems.get(orderId) ?? [];
      return { docs: items.map((it, i) => ({ id: `it${i}`, data: () => it })) };
    },
    getDoc: async () => ({ exists: () => false, data: () => undefined }),
    getDocFromServer: fs.getDocFromServer,
    getDocFromCache: fs.getDocFromCache,
    updateDoc: fs.updateDoc,
  };
});

vi.mock('../lib/firebase', () => ({
  isFirebaseConfigured: true,
  db: {},
  collections: { orders: 'orders', orderItems: 'orderItems', products: 'products', shifts: 'shifts', cashTransactions: 'cashTransactions' },
}));

// ── Page dependencies (same seams as SalesHistoryPage.saleReturn.test.tsx) ──

const historyState = { records: [] as SaleRecord[], loading: false, error: null as Error | null, refresh: vi.fn(), syncDevRecords: vi.fn() };
const rosterState: ApproverRosterState = {
  status: 'ready',
  fromCache: false,
  candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
};
const auth = { branchId: 'LDP-001' };
const fetchContextMock = vi.fn<(orderId: string, branchId: string) => Promise<SaleReturnContextResult>>();
const submitMock = vi.fn<(input: Record<string, unknown>) => Promise<SubmitSaleReturnResult>>();
const resolveMock = vi.fn<(input: Record<string, unknown>) => Promise<SubmitSaleReturnResult>>();
const attemptIds: string[] = [];

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff1', role: 'staff', name: 'Dao', firstName: 'Dao', lastName: 'K' },
    branchId: auth.branchId,
    ensurePrivilegedStaffSession: async () => 'ready',
    invalidateStaffSession: () => undefined,
  }),
}));
vi.mock('../lib/salesHistory/useSalesHistory', () => ({ useSalesHistory: () => historyState }));
// Records the Return map of EVERY summary computation (pass-through), so a
// single render that mixes a stale generation into "net" is observable.
const summaryCalls = vi.hoisted(() => [] as Array<Map<string, unknown> | null>);
vi.mock('../lib/salesHistory/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/salesHistory/types')>();
  return {
    ...actual,
    computeSummary: (...args: Parameters<typeof actual.computeSummary>) => {
      summaryCalls.push((args[1] as Map<string, unknown> | null | undefined) ?? null);
      return actual.computeSummary(...args);
    },
  };
});
vi.mock('../lib/salesHistory/useOrderItemsLive', () => ({ useOrderItemsLive: () => ({ items: [], state: 'live', fromCache: false }) }));
vi.mock('../lib/pos/usePosProducts', () => ({ usePosProducts: () => ({ products: [] }) }));
vi.mock('../lib/documents/receiptFetch', () => ({ fetchOrderReceipt: vi.fn() }));
vi.mock('../lib/documents/receiptSettings', () => ({ loadReceiptSettingsForOrderBranch: vi.fn() }));
vi.mock('../components/documents/ThermalReceipt', () => ({ default: () => null }));
vi.mock('../components/common/DateRangeDropdown', () => ({
  DateRangeDropdown: (props: { onChange: (v: { preset: string; from: string; to: string }) => void }) =>
    createElement('button', { 'data-testid': 'date-range', type: 'button', onClick: () => props.onChange({ preset: '7d', from: '', to: '' }) }),
}));
vi.mock('../lib/voidOrder', () => ({ voidOrderSafe: vi.fn() }));
vi.mock('../lib/branches', () => ({ getBranchLabel: (id: string) => id }));
vi.mock('../lib/pos/offline/voidIntentStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/voidIntentStore')>();
  return { ...actual, listVoidIntents: async () => [] as VoidIntentRecord[], subscribeVoidIntentStore: () => () => {} };
});
vi.mock('../lib/auth/useApproverRoster', () => ({ useApproverRoster: () => rosterState }));
vi.mock('../lib/pos/deviceId', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/deviceId')>();
  return { ...actual, getDeviceId: () => 'DEV1' };
});
vi.mock('../lib/pos/shiftService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/shiftService')>();
  return { ...actual, getActiveShift: async () => ({ id: 'SH1' }) as never };
});
vi.mock('../lib/saleReturn/saleReturnService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/saleReturn/saleReturnService')>();
  return {
    ...actual, // REAL refreshShiftFromServer (guard → committed_unsynced → server read → clear)
    fetchSaleReturnContext: (orderId: string, branchId: string) => fetchContextMock(orderId, branchId),
    submitSaleReturnRequest: (input: Record<string, unknown>) => submitMock(input),
    resolveSaleReturnAttempt: (input: Record<string, unknown>) => resolveMock(input),
    newReturnAttemptId: () => attemptIds.shift() ?? 'attempt-fallback',
  };
});

import SalesHistoryPage from './SalesHistoryPage';
import { closeShift, CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE } from '../lib/pos/shiftService';
import { createInMemoryShiftCloseIntentJournal } from '../lib/pos/offline/shiftCloseIntentStore';
import { hasShiftServerCashPending, withMergedCashEntries } from '../lib/pos/shiftCashFreshness';
import { useSaleReturnAdjustments } from '../lib/saleReturn/returnAdjustments';
import { useProfitReport } from '../lib/profitReport/useProfitReport';
import { computeKpi } from '../lib/profitReport/types';
import {
  __setReturnAttemptStoreForTests,
  createInMemoryReturnAttemptStore,
} from '../lib/saleReturn/unresolvedReturnAttempt';

let attemptStore: ReturnType<typeof createInMemoryReturnAttemptStore>;

// ── Fixtures ──

function record(id: string, total = 945): SaleRecord {
  const createdAt = new Date(Date.now() - 3 * 86_400_000);
  return {
    order: {
      id, billId: id, branchId: 'LDP-001', customerId: null, customerSnap: null, staffId: 's', staffName: 'Dao',
      status: 'completed', subtotal: 1050, discountAmt: 50, billDiscount: 105, vatRate: 0, vatAmt: 0, surcharge: 0,
      total, paidAmt: 1000, changeAmt: 55, creditAmt: 0, priceLevelId: 'RETAIL', note: '', voidReason: null,
      voidedBy: null, voidedAt: null, printCount: 0, createdAt: createdAt as never, updatedAt: createdAt as never,
    },
    payments: [{ id: 'p1', orderId: id, branchId: 'LDP-001', method: 'cash', amount: 1000, ref: null, createdAt: createdAt as never }],
    items: [],
    pendingSync: false,
    verdict: 'CURRENT',
    verdictReason: null,
  };
}

function returnDoc(returnId: string, orderId: string, branchId = 'LDP-001', refund = 81) {
  return {
    id: returnId,
    data: () => ({
      schemaVersion: 1,
      status: 'completed',
      returnId,
      returnNo: `RT-${orderId}-1`,
      originalOrderId: orderId,
      branchId,
      originalSaleCreatedAtMillis: 1,
      createdAtMillis: 2,
      refund: { method: 'cash', amount: refund },
      totals: { lineRevenueReversed: 105, costRestored: 60 },
      lines: [
        {
          lineIndex: 0, productId: 'P1', productName: 'อาหารแมว', sku: 'CF', category: 'อาหาร', unit: 'ถุง', returnedQty: 1,
          pricing: { lineRevenueReversed: 105, refundAmount: refund, unitPrice: 105 },
          cost: { total: 60 },
        },
      ],
    }),
  };
}

const MALFORMED = { id: 'bad', data: () => ({ schemaVersion: 1, status: 'completed', returnId: 'bad' }) };

function snap(docs: unknown[], fromCache: boolean) {
  return { docs, metadata: { fromCache, hasPendingWrites: false } };
}

function returnsListeners(): Listener[] {
  return fs.listeners.filter((l) => l.name === 'saleReturns');
}

function emitReturns(docs: unknown[], fromCache: boolean, which = returnsListeners().filter((l) => l.active)): void {
  act(() => {
    for (const l of which) l.next(snap(docs, fromCache));
  });
}

let storage: Map<string, string>;
let setItemFails: (key: string) => boolean = () => false;

function memoryStorage(): Storage {
  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (k: string) => storage.get(k) ?? null,
    key: (i: number) => [...storage.keys()][i] ?? null,
    removeItem: (k: string) => void storage.delete(k),
    setItem: (k: string, v: string) => {
      if (setItemFails(k)) throw new DOMException('quota', 'QuotaExceededError');
      storage.set(k, String(v));
    },
  };
}

beforeEach(() => {
  fs.listeners.length = 0;
  fs.orderItems.clear();
  fs.getDocFromServer.mockReset();
  fs.getDocFromServer.mockResolvedValue({ exists: () => true, data: () => ({ status: 'open' }) });
  fs.getDocFromCache.mockReset();
  fs.getDocFromCache.mockResolvedValue({ exists: () => true, data: () => ({ status: 'open', cashEntries: [] }) });
  fs.updateDoc.mockReset();
  fs.updateDoc.mockResolvedValue(undefined);
  storage = new Map();
  setItemFails = () => false;
  vi.stubGlobal('localStorage', memoryStorage());
  attemptStore = createInMemoryReturnAttemptStore();
  __setReturnAttemptStoreForTests(attemptStore);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  auth.branchId = 'LDP-001';
  historyState.records = [];
  fetchContextMock.mockReset();
  submitMock.mockReset();
  resolveMock.mockReset();
  attemptIds.length = 0;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderHistory(records: SaleRecord[]): Promise<void> {
  historyState.records = records;
  render(createElement(SalesHistoryPage));
  fireEvent.click(screen.getByTestId('date-range'));
  await waitFor(() => expect(screen.getByText(records[0]!.order.id)).toBeTruthy());
}

const totalCard = () => screen.getByTestId('sh-metric-total').textContent ?? '';
const grossNote = () => screen.queryByTestId('sh-returns-gross-note')?.textContent ?? null;

// ═══ §1 Reporting completeness ═══════════════════════════════════════════════

describe('§1 Sales History — net only after a server-confirmed branch snapshot', () => {
  test('listener subscribes WITH metadata changes, scoped to the branch', async () => {
    await renderHistory([record('BILL-R1')]);
    expect(returnsListeners()).toHaveLength(1);
    expect(returnsListeners()[0]!.opts).toEqual({ includeMetadataChanges: true });
    expect(grossNote()).toContain('กำลังโหลดรายการคืนสินค้า');
  });

  test('offline partial cache OMITTING an accepted Return stays gross (never claims net)', async () => {
    await renderHistory([record('BILL-R1')]);
    emitReturns([], true); // cache does not yet hold the accepted Return
    expect(totalCard()).toContain('ก่อนหักคืนสินค้า');
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('ยังยืนยันรายการคืนสินค้าครบถ้วนกับเซิร์ฟเวอร์ไม่ได้');
    expect(screen.queryByTestId('sh-returned-BILL-R1')).toBeNull();

    emitReturns([returnDoc('R1', 'BILL-R1')], false); // server answer: the Return exists
    expect(totalCard()).toContain('ยอดขายสุทธิ');
    expect(totalCard()).toContain('864');
    expect(grossNote()).toBeNull();
    expect(screen.getByTestId('sh-returned-BILL-R1').textContent).toContain('คืน -฿81.00');
  });

  test('cache snapshot WITH the Return is still gross; the metadata-only fromCache:true→false flip (same docs) makes it net', async () => {
    await renderHistory([record('BILL-R1')]);
    const docs = [returnDoc('R1', 'BILL-R1')];
    emitReturns(docs, true);
    expect(totalCard()).toContain('945');
    expect(screen.queryByTestId('sh-returned-BILL-R1')).toBeNull(); // incomplete set never mixed in
    emitReturns(docs, false);
    expect(totalCard()).toContain('864');
  });

  test('empty CACHE vs empty CONFIRMED server dataset', async () => {
    await renderHistory([record('BILL-R1')]);
    emitReturns([], true);
    expect(totalCard()).toContain('ยอดขายรวม');
    emitReturns([], false);
    expect(totalCard()).toContain('ยอดขายสุทธิ');
    expect(totalCard()).toContain('945');
    expect(grossNote()).toBeNull();
  });

  test('connectivity lost after confirmation demotes to gross; reconnect re-confirms net', async () => {
    await renderHistory([record('BILL-R1')]);
    const docs = [returnDoc('R1', 'BILL-R1')];
    emitReturns(docs, false);
    expect(totalCard()).toContain('864');
    emitReturns(docs, true); // SDK re-raises with fromCache:true when it goes offline
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('ยังยืนยัน');
    emitReturns(docs, false);
    expect(totalCard()).toContain('864');
  });

  test('malformed record (even server-confirmed) and listener error fail to explicit gross', async () => {
    await renderHistory([record('BILL-R1')]);
    emitReturns([returnDoc('R1', 'BILL-R1'), MALFORMED], false);
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('โหลดรายการคืนสินค้าไม่ได้');
    cleanup();
    fs.listeners.length = 0;
    await renderHistory([record('BILL-R1')]);
    act(() => returnsListeners()[0]!.error(new Error('permission-denied')));
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('โหลดรายการคืนสินค้าไม่ได้');
  });

  test('a record of ANOTHER branch in the result fails closed', async () => {
    await renderHistory([record('BILL-R1')]);
    emitReturns([returnDoc('RX', 'BILL-R1', 'OTHER-BRANCH')], false);
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('โหลดรายการคืนสินค้าไม่ได้');
  });
});

describe('§1 useSaleReturnAdjustments — branch / subscription generation', () => {
  test('branch switch: A ready is never reused for B; late A events are dropped', () => {
    const { result, rerender } = renderHook(({ b }) => useSaleReturnAdjustments(b), { initialProps: { b: 'A' } });
    const [lA] = returnsListeners();
    act(() => lA!.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    expect(result.current).toMatchObject({ branchId: 'A', status: 'ready' });

    rerender({ b: 'B' });
    expect(result.current).toMatchObject({ branchId: 'B', status: 'loading', adjustments: [] });
    expect(lA!.active).toBe(false);
    // Late event from the prior subscription (e.g. queued metadata flip) — suppressed.
    act(() => lA!.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    expect(result.current).toMatchObject({ branchId: 'B', status: 'loading' });

    const lB = returnsListeners()[1]!;
    act(() => lB.next(snap([], true)));
    expect(result.current.status).toBe('unconfirmed');
    act(() => lB.next(snap([], false)));
    expect(result.current).toMatchObject({ branchId: 'B', status: 'ready', adjustments: [] });

    // A → B → A again: the first A generation's late events stay suppressed.
    rerender({ b: 'A' });
    act(() => lA!.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    expect(result.current).toMatchObject({ branchId: 'A', status: 'loading' });
  });

  // Recovery gate A1: A ready → B (NO B snapshot) → A (NO fresh A snapshot).
  // Every render — not only the settled one — must be gross/loading for the
  // new generation until that generation's own server-confirmed event.
  test('A ready → B (no event) → A (no event): no render reuses the old A ready; only the NEW A server event is net', () => {
    const renders: Array<{ b: string; branchId: string | null; status: string; n: number }> = [];
    const { result, rerender } = renderHook(
      ({ b }) => {
        const s = useSaleReturnAdjustments(b);
        renders.push({ b, branchId: s.branchId, status: s.status, n: s.adjustments.length });
        return s;
      },
      { initialProps: { b: 'A' } },
    );
    const lA1 = returnsListeners()[0]!;
    act(() => lA1.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    expect(result.current).toMatchObject({ branchId: 'A', status: 'ready' });
    expect(result.current.adjustments).toHaveLength(1);

    const mark = renders.length;
    rerender({ b: 'B' });
    rerender({ b: 'A' });
    const after = renders.slice(mark);
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) expect(r).toMatchObject({ branchId: r.b, status: 'loading', n: 0 });
    expect(result.current).toMatchObject({ branchId: 'A', status: 'loading', adjustments: [] });

    const [, lB, lA2] = returnsListeners();
    expect(lA1.active).toBe(false);
    expect(lB!.active).toBe(false);
    expect(lA2!.active).toBe(true);

    // Late callbacks from the old A and old B generations are dropped.
    const mark2 = renders.length;
    act(() => lA1.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    act(() => lB!.next(snap([], false)));
    act(() => lB!.error(new Error('late')));
    for (const r of renders.slice(mark2)) expect(r).toMatchObject({ status: 'loading', n: 0 });
    expect(result.current.status).toBe('loading');

    // New A generation: cache-only stays gross; only server-confirmed is net.
    act(() => lA2!.next(snap([returnDoc('RA', 'O1', 'A'), returnDoc('RA2', 'O2', 'A')], true)));
    expect(result.current).toMatchObject({ status: 'unconfirmed', adjustments: [] });
    act(() => lA2!.next(snap([returnDoc('RA', 'O1', 'A'), returnDoc('RA2', 'O2', 'A')], false)));
    expect(result.current).toMatchObject({ branchId: 'A', status: 'ready' });
    expect(result.current.adjustments.map((a) => a.returnId)).toEqual(['RA', 'RA2']);

    // Metadata-only demotion/promotion, malformed demotion and error demotion on the new generation.
    act(() => lA2!.next(snap([returnDoc('RA', 'O1', 'A'), returnDoc('RA2', 'O2', 'A')], true)));
    expect(result.current).toMatchObject({ status: 'unconfirmed', adjustments: [] });
    act(() => lA2!.next(snap([returnDoc('RA', 'O1', 'A'), returnDoc('RA2', 'O2', 'A')], false)));
    expect(result.current.status).toBe('ready');
    act(() => lA2!.next(snap([returnDoc('RA', 'O1', 'A'), MALFORMED], false)));
    expect(result.current).toMatchObject({ status: 'unavailable', adjustments: [] });
    act(() => lA2!.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    expect(result.current.status).toBe('ready');
    act(() => lA2!.error(new Error('permission-denied')));
    expect(result.current).toMatchObject({ status: 'unavailable', adjustments: [] });
    // Bounded: no render loop.
    expect(renders.length).toBeLessThan(40);
  });

  test('A → B → A where B emitted only from cache: the A switch-back is still loading, not the old A ready', () => {
    const { result, rerender } = renderHook(({ b }) => useSaleReturnAdjustments(b), { initialProps: { b: 'A' } });
    act(() => returnsListeners()[0]!.next(snap([returnDoc('RA', 'O1', 'A')], false)));
    rerender({ b: 'B' });
    act(() => returnsListeners()[1]!.next(snap([], true)));
    expect(result.current).toMatchObject({ branchId: 'B', status: 'unconfirmed' });
    rerender({ b: 'A' });
    expect(result.current).toMatchObject({ branchId: 'A', status: 'loading', adjustments: [] });
  });
});

describe('§1 A1 — real Sales History + Profit consumers across A → B → A with no fresh snapshot', () => {
  const A = 'LDP-001';
  const B = 'LDP-002';

  test('Sales History: every summary computation and the rendered cards stay gross until the NEW A generation is server-confirmed', async () => {
    const rec = record('BILL-R1');
    historyState.records = [rec];
    const { rerender } = render(createElement(SalesHistoryPage));
    fireEvent.click(screen.getByTestId('date-range'));
    await waitFor(() => expect(screen.getByText('BILL-R1')).toBeTruthy());
    emitReturns([returnDoc('R1', 'BILL-R1', A)], false);
    expect(totalCard()).toContain('864');
    expect(screen.getByTestId('sh-returned-BILL-R1')).toBeTruthy();

    const mark = summaryCalls.length;
    auth.branchId = B;
    rerender(createElement(SalesHistoryPage));
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('กำลังโหลดรายการคืนสินค้า');
    auth.branchId = A;
    rerender(createElement(SalesHistoryPage));
    // Old A generation is never reused: every computation since the switch is gross.
    for (const c of summaryCalls.slice(mark)) expect(c).toBeNull();
    expect(totalCard()).toContain('945');
    expect(totalCard()).toContain('ก่อนหักคืนสินค้า');
    expect(grossNote()).toContain('กำลังโหลดรายการคืนสินค้า');
    expect(screen.queryByTestId('sh-returned-BILL-R1')).toBeNull();

    const listeners = returnsListeners();
    const oldA = listeners[0]!;
    const oldB = listeners[1]!;
    const newA = listeners[2]!;
    // Late old-generation callbacks change nothing.
    emitReturns([returnDoc('R1', 'BILL-R1', A)], false, [oldA]);
    emitReturns([], false, [oldB]);
    for (const c of summaryCalls.slice(mark)) expect(c).toBeNull();
    expect(totalCard()).toContain('945');

    // New A: cache-only (even holding a new Return) stays gross.
    emitReturns([returnDoc('R1', 'BILL-R1', A), returnDoc('R2', 'BILL-R1', A, 19)], true, [newA]);
    expect(totalCard()).toContain('945');
    expect(grossNote()).toContain('ยังยืนยันรายการคืนสินค้าครบถ้วนกับเซิร์ฟเวอร์ไม่ได้');
    for (const c of summaryCalls.slice(mark)) expect(c).toBeNull();

    // Only the new A server-confirmed event produces net — including the Return accepted meanwhile.
    emitReturns([returnDoc('R1', 'BILL-R1', A), returnDoc('R2', 'BILL-R1', A, 19)], false, [newA]);
    expect(totalCard()).toContain('ยอดขายสุทธิ');
    expect(totalCard()).toContain('845');
    expect(grossNote()).toBeNull();
  });

  test('Profit hook: every render across A → B → A is gross (no Return lines) until the NEW A server event', async () => {
    fs.orderItems.set('O1', [
      { id: 'i1', productId: 'P1', productSnap: { name: 'อาหารแมว', sku: 'CF', category: 'อาหาร' }, qty: 10, unitPrice: 105, lineTotal: 1050, fifoCost: 600 },
    ]);
    const seen: Array<{ b: string; net: boolean; status: string; returnLines: number }> = [];
    const { result, rerender } = renderHook(
      ({ b }) => {
        const r = useProfitReport(b);
        seen.push({ b, net: r.netOfReturns, status: r.returnsStatus, returnLines: r.lines.filter((l) => l.revenue < 0).length });
        return r;
      },
      { initialProps: { b: A } },
    );
    const created = new Date();
    const order = { id: 'O1', billId: 'O1', branchId: A, status: 'completed', subtotal: 1050, cogs: 600, profit: 450, customerSnap: null, createdAt: { toDate: () => created } };
    act(() => {
      for (const l of fs.listeners.filter((x) => x.name === 'orders' && x.active)) l.next({ docs: [{ id: 'O1', data: () => order }] });
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    emitReturns([returnDoc('R1', 'O1', A)], false);
    expect(result.current.netOfReturns).toBe(true);
    expect(computeKpi(result.current.lines)).toMatchObject({ revenue: 945 });

    const mark = seen.length;
    rerender({ b: B });
    rerender({ b: A });
    for (const s of seen.slice(mark)) expect(s).toMatchObject({ net: false, status: 'loading', returnLines: 0 });
    // Late old-A callback (first saleReturns listener) is dropped.
    emitReturns([returnDoc('R1', 'O1', A)], false, [returnsListeners()[0]!]);
    expect(result.current).toMatchObject({ netOfReturns: false, returnsStatus: 'loading' });

    const newA = returnsListeners()[2]!;
    emitReturns([returnDoc('R1', 'O1', A)], true, [newA]);
    expect(result.current).toMatchObject({ netOfReturns: false, returnsStatus: 'unconfirmed' });
    for (const s of seen.slice(mark)) expect(s.returnLines).toBe(0);
    emitReturns([returnDoc('R1', 'O1', A)], false, [newA]);
    expect(result.current).toMatchObject({ netOfReturns: true, returnsStatus: 'ready' });
  });

  test('Profit page caption: A ready → B → A shows the loading (gross) caption, then net only after the new A server event', async () => {
    vi.doMock('react-chartjs-2', () => ({ Bar: () => null, Doughnut: () => null }));
    const { default: ProfitReportPage } = await import('./ProfitReportPage');
    const { rerender } = render(createElement(ProfitReportPage));
    act(() => {
      for (const l of fs.listeners.filter((x) => x.name === 'orders' && x.active)) l.next({ docs: [] });
    });
    await screen.findByTestId('pr-returns-basis');
    emitReturns([], false);
    expect(screen.getByTestId('pr-returns-basis').textContent).toContain('สุทธิหลังหักคืนสินค้า');
    auth.branchId = B;
    rerender(createElement(ProfitReportPage));
    auth.branchId = A;
    rerender(createElement(ProfitReportPage));
    act(() => {
      for (const l of fs.listeners.filter((x) => x.name === 'orders' && x.active)) l.next({ docs: [] });
    });
    const basis = await screen.findByTestId('pr-returns-basis');
    expect(basis.textContent).toContain('กำลังโหลดรายการคืนสินค้า');
    emitReturns([], false, [returnsListeners()[0]!]); // late old-A event
    expect(screen.getByTestId('pr-returns-basis').textContent).toContain('กำลังโหลดรายการคืนสินค้า');
    emitReturns([], false, [returnsListeners()[2]!]);
    expect(screen.getByTestId('pr-returns-basis').textContent).toContain('สุทธิหลังหักคืนสินค้า');
  });
});

describe('§1 Profit report — same gate, numbers and caption', () => {
  function seedOrder(): void {
    fs.orderItems.set('O1', [
      { id: 'i1', productId: 'P1', productSnap: { name: 'อาหารแมว', sku: 'CF', category: 'อาหาร' }, qty: 10, unitPrice: 105, lineTotal: 1050, fifoCost: 600 },
    ]);
  }
  function emitOrders(): void {
    const created = new Date();
    const order = { id: 'O1', billId: 'O1', branchId: 'LDP-001', status: 'completed', subtotal: 1050, cogs: 600, profit: 450, customerSnap: null, createdAt: { toDate: () => created } };
    act(() => {
      for (const l of fs.listeners.filter((x) => x.name === 'orders')) l.next({ docs: [{ id: 'O1', data: () => order }] });
    });
  }

  test('cache-only → gross lines; server-confirmed → negative Return lines (net revenue / COGS / profit)', async () => {
    seedOrder();
    const { result } = renderHook(() => useProfitReport('LDP-001'));
    emitOrders();
    await waitFor(() => expect(result.current.loading).toBe(false));

    emitReturns([returnDoc('R1', 'O1')], true);
    expect(result.current).toMatchObject({ netOfReturns: false, returnsStatus: 'unconfirmed' });
    expect(computeKpi(result.current.lines)).toMatchObject({ revenue: 1050, cogs: 600, profit: 450 });

    emitReturns([returnDoc('R1', 'O1')], false);
    expect(result.current).toMatchObject({ netOfReturns: true, returnsStatus: 'ready' });
    expect(computeKpi(result.current.lines)).toMatchObject({ revenue: 945, cogs: 540, profit: 405 });

    emitReturns([returnDoc('R1', 'O1')], true); // lost connectivity → demoted
    expect(result.current.netOfReturns).toBe(false);
    expect(computeKpi(result.current.lines)).toMatchObject({ revenue: 1050 });
  });
});

describe('§1 Profit page caption follows the same state', () => {
  test('caption: unconfirmed → gross copy; confirmed → net copy', async () => {
    vi.doMock('react-chartjs-2', () => ({ Bar: () => null, Doughnut: () => null }));
    const { default: ProfitReportPage } = await import('./ProfitReportPage');
    fs.orderItems.set('O1', [
      { id: 'i1', productId: 'P1', productSnap: { name: 'อาหารแมว', sku: 'CF', category: 'อาหาร' }, qty: 10, unitPrice: 105, lineTotal: 1050, fifoCost: 600 },
    ]);
    render(createElement(ProfitReportPage));
    const created = new Date();
    const order = { id: 'O1', billId: 'O1', branchId: 'LDP-001', status: 'completed', subtotal: 1050, cogs: 600, profit: 450, customerSnap: null, createdAt: { toDate: () => created } };
    act(() => {
      for (const l of fs.listeners.filter((x) => x.name === 'orders')) l.next({ docs: [{ id: 'O1', data: () => order }] });
    });
    const basis = await screen.findByTestId('pr-returns-basis');
    expect(basis.textContent).toContain('กำลังโหลดรายการคืนสินค้า');
    emitReturns([returnDoc('R1', 'O1')], true);
    expect(screen.getByTestId('pr-returns-basis').textContent).toContain('ยังยืนยันรายการคืนสินค้าครบถ้วนกับเซิร์ฟเวอร์ไม่ได้');
    emitReturns([returnDoc('R1', 'O1')], false);
    expect(screen.getByTestId('pr-returns-basis').textContent).toContain('สุทธิหลังหักคืนสินค้า');
  });
});

// ═══ §3 Unknown cash Return → shift cash guard ═══════════════════════════════

function context(orderId: string, over: Partial<SaleReturnContextView> = {}): SaleReturnContextView {
  return {
    orderId, billId: orderId, branchId: 'LDP-001', customerName: '', saleCreatedAtMs: Date.now() - 3 * 86_400_000,
    total: 945, refundedTotal: 0, returnCount: 0, fullyReturned: false,
    lines: [
      {
        lineIndex: 0, productId: 'P1', productName: 'อาหารแมว', sku: 'CF', unit: 'ถุง', soldQty: 5, returnedQty: 0,
        returnableQty: 5, soldQtyMilli: 5000, returnedQtyMilli: 0, unitPrice: 100, lineDiscount: 50, lineTotal: 450,
        billDiscountAlloc: 45, feeAlloc: 0, refundableShareMinor: 40500, refundedAmount: 0,
      },
    ],
    refundMethods: [{ method: 'cash', remaining: 945 }, { method: 'qr', remaining: 945 }],
    ...over,
  };
}

const RETURN_ID = 'a1'.repeat(20);
const committed = (orderId: string): SubmitSaleReturnResult => ({
  kind: 'ok', returnId: RETURN_ID, returnNo: `RT-${orderId}-1`, refundId: RETURN_ID, refundAmount: 81, refundMethod: 'cash', idempotent: true,
});

/** The authoritative shift as a committed cash Return leaves it (`rfd_<returnId>` pay-out). */
function provenShiftDoc(over: Record<string, unknown> = {}, entry: Record<string, unknown> = {}) {
  const data = {
    status: 'open',
    branchId: 'LDP-001',
    cashEntries: [{ id: `rfd_${RETURN_ID}`, type: 'pay_out', amount: 81, note: 'คืนเงินสด', staffId: 'staff1', staffName: 'Dao', at: 1, ...entry }],
    ...over,
  };
  return { exists: () => true, data: () => data };
}

const guardKeys = () => [...storage.keys()].filter((k) => k.startsWith('twinpet.shift.serverCashPending.v2:'));

function shift(): Shift {
  return {
    id: 'SH1', branchId: 'LDP-001', staffId: 'staff1', staffName: 'Dao', status: 'open', openedAt: new Date() as never, closedAt: null,
    startingCash: 500, actualCashCount: 0, expectedCash: 1000, expectedQr: 0, expectedKbank: 0, expectedCard: 0, expectedCredit: 0,
    totalBills: 1, payInTotal: 0, payOutTotal: 0, variance: 0, note: '', cashEntries: [],
  };
}

/** The REAL closeShift, OFFLINE (navigator / isOnline false), on the same localStorage scope. */
async function offlineClose(): Promise<'closed' | string> {
  try {
    const r = await closeShift(shift(), 1500, '', { journal: createInMemoryShiftCloseIntentJournal(), isOnline: () => false });
    return r.status === 'closed' ? 'closed' : 'not-closed';
  } catch (err) {
    return (err as Error).message;
  }
}

async function openBill(orderId: string): Promise<void> {
  fireEvent.click(screen.getAllByText(orderId)[0]!);
  await waitFor(() => expect(screen.getByTestId('sale-return-open')).toBeTruthy());
  fireEvent.click(screen.getByTestId('sale-return-open'));
  await screen.findByTestId('sale-return-modal');
}

async function draftAndSubmit(method: 'cash' | 'qr' = 'cash'): Promise<void> {
  const modal = screen.getByTestId('sale-return-modal');
  const line = await within(modal).findByTestId('sale-return-line-0');
  fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: '1' } });
  if (method === 'cash') {
    await waitFor(() =>
      expect(within(modal).getByLabelText(/ช่องทางคืนเงิน/).querySelector('option[value="cash"]')).toBeTruthy(),
    );
  }
  fireEvent.change(within(modal).getByLabelText(/ช่องทางคืนเงิน/), { target: { value: method } });
  if (method === 'qr') fireEvent.change(within(modal).getByLabelText(/เลขอ้างอิงการคืนเงิน/), { target: { value: 'QR-123' } });
  fireEvent.change(within(modal).getByLabelText(/เหตุผลการคืน/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
  fireEvent.change(within(modal).getByLabelText(/ผู้จัดการที่อนุมัติ/), { target: { value: 'mgr-1' } });
  // Cash needs the requester's active shift to have loaded.
  if (method === 'cash') {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  fireEvent.click(within(modal).getByTestId('sale-return-request-approval'));
  const pin = await screen.findByTestId('sale-return-pin-modal');
  for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pin).getByText(d));
  await act(async () => {
    fireEvent.click(within(pin).getByText('ยืนยัน'));
  });
}

async function closeModal(): Promise<void> {
  fireEvent.click(screen.getByText('ปิด (เก็บรายการไว้)'));
  await waitFor(() => expect(screen.queryByTestId('sale-return-modal')).toBeNull());
}

async function resolveRecovered(orderId: string): Promise<void> {
  await openBill(orderId);
  expect(screen.getByTestId('sale-return-unknown')).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByTestId('sale-return-resolve'));
  });
}

describe('§3 unknown cash Return — pre-send guard and resolution', () => {
  beforeEach(() => {
    fetchContextMock.mockImplementation(async (orderId) => ({ kind: 'ok', classification: 'RETURN_ELIGIBLE', reason: null, context: context(orderId) }));
  });

  test('commit with LOST response → modal close/reopen + page reload → offline close blocked; resolve committed + server sync → allowed', async () => {
    attemptIds.push('att-1');
    let guardAtSend: string[] = [];
    submitMock.mockImplementation(async () => {
      guardAtSend = guardKeys(); // the guard is durable BEFORE the request leaves
      return { kind: 'unknown' };
    });
    await renderHistory([record('BILL-R1')]);
    await openBill('BILL-R1');
    await draftAndSubmit('cash');
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    expect(guardAtSend).toEqual(['twinpet.shift.serverCashPending.v2:SH1:att-1']);
    expect(storage.get(guardAtSend[0]!)).not.toContain('1234');
    expect(JSON.parse(storage.get(guardAtSend[0]!)!)).toMatchObject({ state: 'in_flight', attemptId: 'att-1', shiftId: 'SH1' });

    await closeModal();
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);

    // "Reload": unmount the whole page; localStorage scope survives.
    cleanup();
    await renderHistory([record('BILL-R1')]);
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);

    // Server sync after the resolve FAILS first → guard stays (committed_unsynced).
    fs.getDocFromServer.mockRejectedValueOnce(new Error('unavailable'));
    resolveMock.mockResolvedValueOnce(committed('BILL-R1'));
    await resolveRecovered('BILL-R1');
    await waitFor(() => expect(screen.getByTestId('sale-return-success')).toBeTruthy());
    await waitFor(() => expect(JSON.parse(storage.get(guardKeys()[0]!)!).state).toBe('committed_unsynced'));
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
    expect(fs.updateDoc).not.toHaveBeenCalled();
    cleanup();

    // Same committed attempt resolved again later (replay), sync succeeds → released.
    await renderHistory([record('BILL-R1')]);
    expect(hasShiftServerCashPending('SH1')).toBe(true);
    // The recovery record was cleared on commit; the guard is released by the sync of a replay
    // only once the server read PROVES this Return's pay-out is on the shift (C1 cleanup proof).
    const { refreshShiftFromServer } = await import('../lib/saleReturn/saleReturnService');
    const proof = { branchId: 'LDP-001', returnId: RETURN_ID, refundAmount: 81 };
    await refreshShiftFromServer('SH1', 'att-1', proof); // default server doc: no pay-out entry
    expect(guardKeys()).toEqual(['twinpet.shift.serverCashPending.v2:SH1:att-1']);
    fs.getDocFromServer.mockResolvedValueOnce(provenShiftDoc());
    await refreshShiftFromServer('SH1', 'att-1', proof);
    expect(guardKeys()).toEqual([]);
    expect(await offlineClose()).toBe('closed');
  });

  test('C1 cleanup proof: a successful server read alone never clears the guard — only THIS Return’s pay-out on the matching shift does', async () => {
    const { refreshShiftFromServer, cashRefundEntryIdFor } = await import('../lib/saleReturn/saleReturnService');
    const proof = { branchId: 'LDP-001', returnId: RETURN_ID, refundAmount: 81 };
    const guarded = () => guardKeys().length === 1;
    const refreshWith = async (snap: unknown, p = proof) => {
      fs.getDocFromServer.mockResolvedValueOnce(snap);
      await refreshShiftFromServer('SH1', 'att-1', p);
    };
    expect(cashRefundEntryIdFor(RETURN_ID)).toBe(`rfd_${RETURN_ID}`);
    expect(cashRefundEntryIdFor('not-a-return-id')).toBeNull();

    await refreshWith({ exists: () => false, data: () => undefined }); // missing doc
    expect(guarded()).toBe(true);
    expect(JSON.parse(storage.get(guardKeys()[0]!)!).state).toBe('committed_unsynced');
    await refreshWith(provenShiftDoc({ branchId: 'LDP-999' })); // wrong identity (branch)
    expect(guarded()).toBe(true);
    await refreshWith(provenShiftDoc({ cashEntries: [] })); // entry missing
    expect(guarded()).toBe(true);
    await refreshWith(provenShiftDoc({}, { id: 'rfd_' + 'b2'.repeat(20) })); // another Return's entry
    expect(guarded()).toBe(true);
    await refreshWith(provenShiftDoc({}, { amount: 80 })); // different amount
    expect(guarded()).toBe(true);
    await refreshWith(provenShiftDoc({}, { type: 'pay_in' })); // wrong type
    expect(guarded()).toBe(true);
    const reads = fs.getDocFromServer.mock.calls.length;
    await refreshShiftFromServer('SH1', 'att-1', { ...proof, returnId: 'garbage' }); // unusable returnId
    expect(fs.getDocFromServer.mock.calls.length).toBe(reads); // nothing can be proven → not even read
    expect(guarded()).toBe(true);
    fs.getDocFromServer.mockRejectedValueOnce(new Error('unavailable')); // read failure
    await refreshShiftFromServer('SH1', 'att-1', proof);
    expect(guarded()).toBe(true);
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);

    await refreshWith(provenShiftDoc()); // confirmed entry on the matching shift
    expect(guardKeys()).toEqual([]);
    expect(await offlineClose()).toBe('closed');
  });

  // Gate C1-A — the offline close folds the FIRST entry of an id (mergeCashEntries)
  // and the raw drawer fold counts every element; a single some() match on the
  // committed amount is therefore not proof. Each case starts from a fresh guard.
  const refund = (amount: unknown, extra: Record<string, unknown> = {}) => ({
    id: `rfd_${RETURN_ID}`, type: 'pay_out', amount, note: 'คืนเงินสด', staffId: 'staff1', staffName: 'Dao', at: 1, ...extra,
  });
  const C1A_CASES: Array<[string, 'clears' | 'keeps', unknown[]]> = [
    ['unique id, correct amount', 'clears', [refund(81)]],
    ['unique id + unrelated (even malformed) entries of OTHER ids', 'clears', [{ id: 'cash-1', type: 'pay_in', amount: 5 }, null, 'junk', refund(81)]],
    ['duplicate id: EARLIER amount 1, later correct 81', 'keeps', [refund(1), refund(81)]],
    ['duplicate id: correct 81 first, later amount 1', 'keeps', [refund(81), refund(1)]],
    ['exact duplicate objects with the same id', 'keeps', [refund(81), refund(81)]],
    ['matching id but malformed amount (string)', 'keeps', [refund('81')]],
    ['matching id but non-finite amount', 'keeps', [refund(Number.NaN)]],
    ['correct entry + a malformed same-id entry (no amount)', 'keeps', [refund(81), { id: `rfd_${RETURN_ID}`, type: 'pay_out' }]],
    ['correct entry + a same-id entry of the wrong type', 'keeps', [refund(81), refund(81, { type: 'pay_in' })]],
    ['matching id as an array-shaped entry', 'keeps', [Object.assign([], { id: `rfd_${RETURN_ID}`, type: 'pay_out', amount: 81 })]],
  ];

  test.each(C1A_CASES)('C1-A duplicate-ID proof: %s → guard %s', async (_label, expected, cashEntries) => {
    const { refreshShiftFromServer } = await import('../lib/saleReturn/saleReturnService');
    const proof = { branchId: 'LDP-001', returnId: RETURN_ID, refundAmount: 81 };
    fs.getDocFromServer.mockResolvedValueOnce(provenShiftDoc({ cashEntries }));
    await refreshShiftFromServer('SH1', 'att-1', proof);
    expect(fs.updateDoc).not.toHaveBeenCalled(); // the proof itself writes nothing (no cash / shift / inventory write)
    if (expected === 'clears') {
      expect(guardKeys()).toEqual([]);
      expect(await offlineClose()).toBe('closed');
    } else {
      expect(guardKeys()).toEqual(['twinpet.shift.serverCashPending.v2:SH1:att-1']);
      expect(JSON.parse(storage.get(guardKeys()[0]!)!).state).toBe('committed_unsynced');
      expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
      expect(fs.updateDoc).not.toHaveBeenCalled(); // refused offline close: nothing queued
    }
  });

  test('C1-A counterexample (pre-005 some() defect): server [rfd amount 1, rfd amount 81] → the offline fold would freeze pay-out 1, so the guard must stay', async () => {
    const { refreshShiftFromServer } = await import('../lib/saleReturn/saleReturnService');
    const entries = [refund(1), refund(81)];
    // What an offline close of this device would fold from that server list: the FIRST same-id entry.
    expect(withMergedCashEntries(shift(), entries as never).payOutTotal).toBe(1);
    fs.getDocFromServer.mockResolvedValueOnce(provenShiftDoc({ cashEntries: entries }));
    await refreshShiftFromServer('SH1', 'att-1', { branchId: 'LDP-001', returnId: RETURN_ID, refundAmount: 81 });
    expect(guardKeys()).toHaveLength(1); // pre-005: [] (cleared on the second entry's match)
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
    // Ambiguity persists across later reads of the same evidence; an unreachable shift keeps it too.
    fs.getDocFromServer.mockResolvedValueOnce(provenShiftDoc({ cashEntries: entries }));
    await refreshShiftFromServer('SH1', 'att-1', { branchId: 'LDP-001', returnId: RETURN_ID, refundAmount: 81 });
    fs.getDocFromServer.mockRejectedValueOnce(new Error('unavailable'));
    await refreshShiftFromServer('SH1', 'att-1', { branchId: 'LDP-001', returnId: RETURN_ID, refundAmount: 81 });
    expect(guardKeys()).toHaveLength(1);
    expect(fs.updateDoc).not.toHaveBeenCalled();
  });

  test('unknown → resolved NOT committed (server fence), no other attempt → guard released, offline close allowed', async () => {
    attemptIds.push('att-1');
    submitMock.mockResolvedValueOnce({ kind: 'unknown' });
    resolveMock.mockResolvedValueOnce({ kind: 'error', code: 'attempt_not_committed' });
    await renderHistory([record('BILL-R1')]);
    await openBill('BILL-R1');
    await draftAndSubmit('cash');
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    await closeModal();
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
    await resolveRecovered('BILL-R1');
    await waitFor(() => expect(screen.getByTestId('sale-return-error').textContent).toContain('เริ่มรายการใหม่ได้'));
    expect(guardKeys()).toEqual([]);
    expect(await offlineClose()).toBe('closed');
  });

  test('failed first send detected BEFORE the network (offline) → no phantom guard', async () => {
    attemptIds.push('att-1');
    submitMock.mockResolvedValueOnce({ kind: 'offline' });
    await renderHistory([record('BILL-R1')]);
    await openBill('BILL-R1');
    await draftAndSubmit('cash');
    await waitFor(() => expect(screen.getByTestId('sale-return-error')).toBeTruthy());
    expect(guardKeys()).toEqual([]);
    expect(await offlineClose()).toBe('closed');
  });

  test('two unknown cash attempts on the shift: the guard holds until BOTH are safe', async () => {
    attemptIds.push('att-1', 'att-2');
    submitMock.mockResolvedValue({ kind: 'unknown' });
    await renderHistory([record('BILL-R1'), record('BILL-R2')]);
    await openBill('BILL-R1');
    await draftAndSubmit('cash');
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    await closeModal();
    await openBill('BILL-R2');
    await draftAndSubmit('cash');
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    await closeModal();
    expect(guardKeys().sort()).toEqual(['twinpet.shift.serverCashPending.v2:SH1:att-1', 'twinpet.shift.serverCashPending.v2:SH1:att-2']);

    resolveMock.mockResolvedValueOnce({ kind: 'error', code: 'attempt_not_committed' });
    await resolveRecovered('BILL-R1');
    await waitFor(() => expect(screen.getByTestId('sale-return-error')).toBeTruthy());
    expect(guardKeys()).toEqual(['twinpet.shift.serverCashPending.v2:SH1:att-2']);
    expect(await offlineClose()).toBe(CLOSE_SHIFT_SERVER_CASH_PENDING_MESSAGE);
    fireEvent.click(within(screen.getByTestId('sale-return-modal')).getByText('ปิด'));
    await waitFor(() => expect(screen.queryByTestId('sale-return-modal')).toBeNull());

    resolveMock.mockResolvedValueOnce({ kind: 'error', code: 'attempt_not_committed' });
    await resolveRecovered('BILL-R2');
    await waitFor(() => expect(screen.getByTestId('sale-return-error')).toBeTruthy());
    expect(guardKeys()).toEqual([]);
    expect(await offlineClose()).toBe('closed');
  });

  test('a NON-cash Return with an unknown outcome never guards the cash close', async () => {
    attemptIds.push('att-q');
    submitMock.mockResolvedValueOnce({ kind: 'unknown' });
    await renderHistory([record('BILL-R1')]);
    await openBill('BILL-R1');
    await draftAndSubmit('qr');
    await waitFor(() => expect(screen.getByTestId('sale-return-unknown')).toBeTruthy());
    expect(submitMock.mock.calls[0]![0]).toMatchObject({ refundMethod: 'qr', shiftId: null });
    expect(guardKeys()).toEqual([]);
    expect(await offlineClose()).toBe('closed');
  });

  test('guard cannot be persisted → the cash Return is NOT sent (visible error, nothing pending)', async () => {
    attemptIds.push('att-1');
    setItemFails = (k) => k.startsWith('twinpet.shift.serverCashPending.v2:');
    await renderHistory([record('BILL-R1')]);
    await openBill('BILL-R1');
    await draftAndSubmit('cash');
    await waitFor(() => expect(screen.getByTestId('sale-return-error').textContent).toContain('ยังไม่ได้ส่งรายการคืนสินค้า'));
    expect(submitMock).not.toHaveBeenCalled();
    expect([...storage.keys()]).toEqual([]);
    await waitFor(() => expect(attemptStore.dump()).toEqual({})); // recovery record rolled back too
  });
});
