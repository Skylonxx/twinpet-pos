// @vitest-environment jsdom
// Return/Refund V1 — recovery gate C2: two tabs/windows on the SAME sale can
// never mint/send, overwrite, lose or clear each other's unresolved attempt.
//
// Each "window" is an independently rendered SaleReturnModal (its own React
// root, its own state) — both may be mounted BEFORE any attempt exists — and
// they share what real windows of one origin share: the REAL reversal-domain
// IndexedDB store (fake-indexeddb: every transact opens its own connection, so
// readwrite serialization across connections is what is exercised) and
// localStorage (cash guards). The server is a model of submitSaleReturn's
// per-attempt contract: commit-once per attemptId, committed replay, fence,
// remaining-quantity cap — and counts every physical effect.

import 'fake-indexeddb/auto';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SaleReturnContextResult, SubmitSaleReturnResult } from '../../lib/saleReturn/saleReturnService';
import type { SaleReturnContextView } from '../../lib/saleReturn/saleReturnTypes';

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>();
  // Render portals inline so each window's DOM stays inside its own container.
  return { ...actual, createPortal: (children: ReactNode) => children };
});
vi.mock('../../lib/firebase', () => ({ isFirebaseConfigured: true, db: null, collections: { shifts: 'shifts' } }));
vi.mock('../../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'staff1', role: 'staff', name: 'Dao' }, branchId: 'LDP-001' }),
}));
vi.mock('../../lib/auth/useApproverRoster', () => ({
  useApproverRoster: () => ({
    status: 'ready',
    fromCache: false,
    candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
  }),
}));
vi.mock('../../lib/pos/shiftService', () => ({ getActiveShift: async () => ({ id: 'SH1' }) }));

// ── Server model (per-attempt contract of submitSaleReturn / resolve) ──

type Effects = { stockRestored: number; refunds: string[]; cashEntries: string[]; ledger: string[]; customerDecrements: number };
const server = vi.hoisted(() => ({
  soldQty: 5,
  remaining: 5,
  committed: new Map<string, { qty: number }>(),
  fenced: new Set<string>(),
  effects: { stockRestored: 0, refunds: [], cashEntries: [], ledger: [], customerDecrements: 0 } as Effects,
  sends: [] as Array<{ attemptId: string; pin: unknown; qty: number }>,
  /** What the client SEES for the next commits (`lose` = committed, response lost). */
  responses: [] as Array<'ok' | 'lose'>,
  attemptIds: [] as string[],
}));

function committedResult(idempotent: boolean): SubmitSaleReturnResult {
  return { kind: 'ok', returnId: 'r'.repeat(40), returnNo: 'RT-BILL-1', refundId: 'f'.repeat(40), refundAmount: 162, refundMethod: 'cash', idempotent };
}

vi.mock('../../lib/saleReturn/saleReturnService', () => ({
  newReturnAttemptId: () => server.attemptIds.shift() ?? `att-${Math.random()}`,
  refreshShiftFromServer: vi.fn(async () => undefined),
  fetchSaleReturnContext: async (orderId: string): Promise<SaleReturnContextResult> => ({
    kind: 'ok',
    classification: 'RETURN_ELIGIBLE',
    reason: null,
    context: contextFor(orderId),
  }),
  submitSaleReturnRequest: async (input: { attemptId: string; pin: unknown; lines: { qty: number }[] }): Promise<SubmitSaleReturnResult> => {
    const qty = input.lines.reduce((a, l) => a + l.qty, 0);
    server.sends.push({ attemptId: input.attemptId, pin: input.pin, qty });
    if (server.fenced.has(input.attemptId)) return { kind: 'error', code: 'attempt_not_committed' };
    if (server.committed.has(input.attemptId)) return committedResult(true);
    if (qty > server.remaining) return { kind: 'error', code: 'over_return' };
    server.remaining -= qty;
    server.committed.set(input.attemptId, { qty });
    server.effects.stockRestored += qty;
    server.effects.refunds.push(input.attemptId);
    server.effects.cashEntries.push(`rfd_${input.attemptId}`);
    server.effects.ledger.push(`ret_${input.attemptId}`);
    server.effects.customerDecrements += 1;
    return (server.responses.shift() ?? 'ok') === 'lose' ? { kind: 'unknown' } : committedResult(false);
  },
  resolveSaleReturnAttempt: async (input: { attemptId: string }): Promise<SubmitSaleReturnResult> => {
    if (server.committed.has(input.attemptId)) return committedResult(true);
    server.fenced.add(input.attemptId);
    return { kind: 'error', code: 'attempt_not_committed' };
  },
}));

function contextFor(orderId: string): SaleReturnContextView {
  const returned = server.soldQty - server.remaining;
  return {
    orderId, billId: orderId, branchId: 'LDP-001', customerName: '', saleCreatedAtMs: Date.now() - 86_400_000,
    total: 405, refundedTotal: 0, returnCount: 0, fullyReturned: false,
    lines: [
      {
        lineIndex: 0, productId: 'P1', productName: 'อาหารแมว', sku: 'CF', unit: 'ถุง', soldQty: server.soldQty, returnedQty: returned,
        returnableQty: server.remaining, soldQtyMilli: server.soldQty * 1000, returnedQtyMilli: returned * 1000, unitPrice: 81,
        lineDiscount: 0, lineTotal: 405, billDiscountAlloc: 0, feeAlloc: 0, refundableShareMinor: 40500, refundedAmount: 0,
      },
    ],
    refundMethods: [{ method: 'cash', remaining: 405 }, { method: 'qr', remaining: 405 }],
  } as SaleReturnContextView;
}

import SaleReturnModal, { SALE_RETURN_OTHER_WINDOW_COPY } from './SaleReturnModal';
import {
  __setReturnAttemptStoreForTests,
  claimUnresolvedReturnAttempt,
  createReversalBackedReturnAttemptStore,
  readUnresolvedReturnAttempt,
  releaseUnresolvedReturnAttempt,
  type ReturnAttemptPayload,
} from '../../lib/saleReturn/unresolvedReturnAttempt';
import { hasShiftServerCashPending } from '../../lib/pos/shiftCashFreshness';
import { REVERSAL_DB_NAME } from '../../lib/pos/offline/reversalLocalStore';

// ── Window helpers ──

type Win = { el: HTMLElement; unmount: () => void };

function openWindow(orderId = 'BILL-1'): Win {
  const r = render(
    createElement(SaleReturnModal, {
      target: { orderId, branchId: 'LDP-001', billLabel: orderId, saleDateLabel: 'เมื่อวาน' },
      onClose: () => undefined,
    }),
  );
  return { el: r.container, unmount: r.unmount };
}

async function draftToPin(w: Win, qty: number, method: 'cash' | 'qr' = 'cash'): Promise<void> {
  const line = await within(w.el).findByTestId('sale-return-line-0');
  fireEvent.change(within(line).getByLabelText('จำนวนคืน'), { target: { value: String(qty) } });
  await waitFor(() => expect(within(w.el).getByLabelText(/ช่องทางคืนเงิน/).querySelector(`option[value="${method}"]`)).toBeTruthy());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0)); // active shift loaded (cash)
  });
  fireEvent.change(within(w.el).getByLabelText(/ช่องทางคืนเงิน/), { target: { value: method } });
  if (method === 'qr') fireEvent.change(within(w.el).getByLabelText(/เลขอ้างอิงการคืนเงิน/), { target: { value: 'QR-1' } });
  fireEvent.change(within(w.el).getByLabelText(/เหตุผลการคืน/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
  fireEvent.change(within(w.el).getByLabelText(/ผู้จัดการที่อนุมัติ/), { target: { value: 'mgr-1' } });
  fireEvent.click(within(w.el).getByTestId('sale-return-request-approval'));
  const pin = await within(w.el).findByTestId('sale-return-pin-modal');
  for (const d of ['1', '2', '3', '4']) fireEvent.click(within(pin).getByText(d));
}

function confirmPin(w: Win): void {
  fireEvent.click(within(within(w.el).getByTestId('sale-return-pin-modal')).getByText('ยืนยัน'));
}

async function storedAttempt(orderId = 'BILL-1') {
  return readUnresolvedReturnAttempt('LDP-001', orderId);
}

function deleteDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(REVERSAL_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

/** One localStorage shared by every window (same origin). */
function sharedStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
  };
}

beforeEach(async () => {
  await deleteDb();
  __setReturnAttemptStoreForTests(null); // the REAL IndexedDB store
  vi.stubGlobal('localStorage', sharedStorage());
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  server.remaining = 5;
  server.committed.clear();
  server.fenced.clear();
  server.effects = { stockRestored: 0, refunds: [], cashEntries: [], ledger: [], customerDecrements: 0 };
  server.sends.length = 0;
  server.responses.length = 0;
  server.attemptIds.length = 0;
});

afterEach(() => {
  cleanup();
  __setReturnAttemptStoreForTests(null);
  vi.unstubAllGlobals();
});

describe('C2 — same sale, two windows', () => {
  test('A commits a partial cash Return, response LOST; B (open before A existed) is blocked, cannot overwrite/clear A; a new window recovers A’s SAME attempt — one physical Return', async () => {
    server.attemptIds.push('att-A', 'att-B', 'att-C');
    server.responses.push('lose');
    const A = openWindow();
    const B = openWindow(); // both mounted while NO attempt exists
    await within(A.el).findByTestId('sale-return-line-0');
    await within(B.el).findByTestId('sale-return-line-0');

    await draftToPin(A, 2);
    await act(async () => confirmPin(A));
    await within(A.el).findByTestId('sale-return-unknown');
    expect(server.effects).toMatchObject({ stockRestored: 2, refunds: ['att-A'] });
    expect(await storedAttempt()).toMatchObject({ attemptId: 'att-A' });

    // B drafts ANOTHER Return for the same units from its stale form.
    await draftToPin(B, 2);
    await act(async () => confirmPin(B));
    const bView = await within(B.el).findByTestId('sale-return-unknown');
    expect(bView.textContent).toContain(SALE_RETURN_OTHER_WINDOW_COPY);
    expect(within(B.el).getByTestId('sale-return-locked-summary').textContent).toContain('× 2');
    expect(server.sends.map((s) => s.attemptId)).toEqual(['att-A']); // B sent NOTHING
    expect(await storedAttempt()).toMatchObject({ attemptId: 'att-A' }); // not overwritten
    expect(hasShiftServerCashPending('SH1')).toBe(true);

    // B: retry → PIN → cancel must not clear A.
    fireEvent.click(within(B.el).getByTestId('sale-return-retry-same'));
    await within(B.el).findByTestId('sale-return-pin-modal');
    fireEvent.click(within(within(B.el).getByTestId('sale-return-pin-modal')).getByText('ยกเลิก'));
    await within(B.el).findByTestId('sale-return-unknown');
    expect(await storedAttempt()).toMatchObject({ attemptId: 'att-A' });

    // Both windows go away (A crashes). The record survives.
    A.unmount();
    B.unmount();
    expect(await storedAttempt()).toMatchObject({ attemptId: 'att-A' });

    // A fresh window recovers A's SAME attemptId and resolves it before any new attempt.
    const C = openWindow();
    await within(C.el).findByTestId('sale-return-unknown');
    await act(async () => {
      fireEvent.click(within(C.el).getByTestId('sale-return-resolve'));
    });
    await within(C.el).findByTestId('sale-return-success');
    expect(within(C.el).getByTestId('sale-return-success').textContent).toContain('ไม่ได้คืนซ้ำ');
    await waitFor(async () => expect(await storedAttempt()).toBeNull());

    // Exactly ONE physical Return: no duplicate stock, refund, customer decrement, cash entry or ledger.
    expect(server.effects).toEqual({ stockRestored: 2, refunds: ['att-A'], cashEntries: ['rfd_att-A'], ledger: ['ret_att-A'], customerDecrements: 1 });
    expect(server.remaining).toBe(3);
    // No PIN ever reached durable storage.
    for (let i = 0; i < localStorage.length; i += 1) expect(localStorage.getItem(localStorage.key(i)!)).not.toContain('1234');
  });

  test('SIMULTANEOUS first sends from two windows → exactly one claim, one send; the other adopts it', async () => {
    server.attemptIds.push('att-A', 'att-B');
    const A = openWindow();
    const B = openWindow();
    await draftToPin(A, 1, 'qr');
    await draftToPin(B, 1, 'qr');
    await act(async () => {
      confirmPin(A);
      confirmPin(B); // both claims are in flight at the same time
    });
    await waitFor(() => expect(server.sends).toHaveLength(1));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(server.sends).toHaveLength(1);
    const winner = server.sends[0]!.attemptId;
    const loser = winner === 'att-A' ? B : A;
    const loserView = await within(loser.el).findByTestId('sale-return-unknown');
    expect(loserView.textContent).toContain(SALE_RETURN_OTHER_WINDOW_COPY);
    expect(server.effects.refunds).toEqual([winner]);
  });

  test('two UNRELATED sales in two windows operate independently', async () => {
    server.attemptIds.push('att-1', 'att-2');
    const A = openWindow('BILL-1');
    const B = openWindow('BILL-2');
    await draftToPin(A, 1, 'qr');
    await draftToPin(B, 1, 'qr');
    await act(async () => {
      confirmPin(A);
      confirmPin(B);
    });
    await within(A.el).findByTestId('sale-return-success');
    await within(B.el).findByTestId('sale-return-success');
    expect(server.sends.map((s) => s.attemptId).sort()).toEqual(['att-1', 'att-2']);
  });

  test('first-send persistence failure (store throws / no IndexedDB) → refused, nothing sent', async () => {
    server.attemptIds.push('att-A', 'att-B');
    __setReturnAttemptStoreForTests({
      transact: async () => {
        throw new Error('IndexedDB unavailable');
      },
    });
    const A = openWindow();
    // An unreadable store blocks the window before any form.
    expect((await within(A.el).findByTestId('sale-return-blocked')).textContent).toContain('ตรวจสอบรายการคืนสินค้าที่ค้างในเครื่องนี้ไม่ได้');
    A.unmount();

    // Reads work but the claim's write fails at the send boundary.
    const real = createReversalBackedReturnAttemptStore();
    __setReturnAttemptStoreForTests({
      transact: (mode, fn) => (mode === 'readwrite' ? Promise.reject(new Error('QuotaExceededError')) : real.transact(mode, fn)),
    });
    const B = openWindow();
    await draftToPin(B, 1);
    await act(async () => confirmPin(B));
    expect((await within(B.el).findByTestId('sale-return-error')).textContent).toContain('ยังไม่ได้ส่งรายการคืนสินค้า');
    expect(server.sends).toHaveLength(0);
    expect(hasShiftServerCashPending('SH1')).toBe(false);

    const saved = globalThis.indexedDB;
    vi.stubGlobal('indexedDB', undefined);
    try {
      const noIdb = createReversalBackedReturnAttemptStore();
      expect(await readUnresolvedReturnAttempt('LDP-001', 'BILL-1', noIdb)).toBeUndefined();
    } finally {
      vi.stubGlobal('indexedDB', saved);
    }
  });
});

describe('C2 — ownership store contract (real IndexedDB)', () => {
  const payload = (attemptId: string): ReturnAttemptPayload => ({
    attemptId,
    orderId: 'BILL-1',
    branchId: 'LDP-001',
    lines: [{ lineIndex: 0, productId: 'P1', qty: 1 }],
    refundMethod: 'cash',
    refundReference: '',
    reason: 'x',
    note: '',
    expectedRefundAmount: 81,
    shiftId: 'SH1',
    approverStaffId: 'mgr-1',
  });
  const meta = { requesterStaffId: 'staff1', approverDisplayName: 'Manager One' };

  test('N concurrent claims (separate connections) → exactly one owner; the rest see that owner', async () => {
    const stores = Array.from({ length: 6 }, () => createReversalBackedReturnAttemptStore());
    const results = await Promise.all(stores.map((s, i) => claimUnresolvedReturnAttempt(payload(`att-${i}`), meta, s)));
    const owners = results.filter((r) => r.kind === 'owned');
    expect(owners).toHaveLength(1);
    const ownerId = owners[0]!.kind === 'owned' ? owners[0]!.record.attemptId : '';
    for (const r of results) {
      if (r.kind === 'other') expect(r.record.attemptId).toBe(ownerId);
      else expect(r.kind).toBe('owned');
    }
    expect(await readUnresolvedReturnAttempt('LDP-001', 'BILL-1')).toMatchObject({ attemptId: ownerId });
  });

  test('a stale owner’s release never erases a different owner’s record; re-claim of the same id is idempotent', async () => {
    expect((await claimUnresolvedReturnAttempt(payload('att-old'), meta)).kind).toBe('owned');
    expect(await releaseUnresolvedReturnAttempt('LDP-001', 'BILL-1', 'att-old')).toBe('released');
    expect((await claimUnresolvedReturnAttempt(payload('att-new'), meta)).kind).toBe('owned');
    // A late release from the old window (e.g. its delayed PIN-cancel) cannot touch the new attempt.
    expect(await releaseUnresolvedReturnAttempt('LDP-001', 'BILL-1', 'att-old')).toBe('not_owner');
    expect(await readUnresolvedReturnAttempt('LDP-001', 'BILL-1')).toMatchObject({ attemptId: 'att-new' });
    expect(await claimUnresolvedReturnAttempt(payload('att-new'), meta)).toMatchObject({ kind: 'owned', record: { attemptId: 'att-new' } });
  });
});
