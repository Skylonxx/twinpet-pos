// @vitest-environment jsdom

/**
 * SEC-001 Packet E / E-1 — end-to-end privileged void through the real
 * `SalesHistoryPage` + `usePrivilegedVoidFlow` + `PrivilegedVoidModal` stack
 * (only D-3's `projectPrivilegedOfflineAction`, the roster's Firestore
 * subscription, and the durable store factory are mocked/faked). Complements
 * the narrower CTA-plumbing tests in `SalesHistoryPage.test.tsx`.
 */
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createInMemoryReversalStore, type ReversalLocalStore } from '../lib/pos/offline/reversalLocalStore';
import type { SaleRecord } from '../lib/salesHistory/types';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';
import type { PrivilegedEvidenceJournalRecordV1 } from '../lib/pos/offline/privilegedEvidenceTypes';
import type { ProjectPrivilegedOfflineActionOutcome } from '../lib/pos/offline/projectPrivilegedOfflineAction';
import type { ApproverRosterState } from '../lib/auth/useApproverRoster';

const historyState = {
  records: [] as SaleRecord[],
  loading: false,
  error: null as Error | null,
  refresh: vi.fn(),
  syncDevRecords: vi.fn(),
};

let store: ReversalLocalStore = createInMemoryReversalStore();
let rosterState: ApproverRosterState = {
  status: 'ready',
  fromCache: false,
  candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
};
const projectMock = vi.fn<(input: unknown) => Promise<ProjectPrivilegedOfflineActionOutcome>>();

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff1', role: 'staff', name: 'Dao', firstName: 'Dao', lastName: 'K' },
    branchId: 'LDP-001',
  }),
}));

vi.mock('../lib/salesHistory/useSalesHistory', () => ({ useSalesHistory: () => historyState }));
vi.mock('../lib/salesHistory/useOrderItemsLive', () => ({ useOrderItemsLive: () => ({ items: [], state: 'live', fromCache: false }) }));
vi.mock('../lib/pos/usePosProducts', () => ({ usePosProducts: () => ({ products: [] }) }));
vi.mock('../lib/documents/receiptFetch', () => ({ fetchOrderReceipt: vi.fn() }));
vi.mock('../lib/documents/receiptSettings', () => ({ loadReceiptSettingsForOrderBranch: vi.fn() }));
vi.mock('../components/documents/ThermalReceipt', () => ({ default: () => null }));
vi.mock('../components/common/DateRangeDropdown', () => ({
  DateRangeDropdown: () => createElement('div', { 'data-testid': 'date-range' }),
}));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: true }));
vi.mock('../lib/voidOrder', () => ({ voidOrderSafe: vi.fn() }));
vi.mock('../lib/branches', () => ({ getBranchLabel: (id: string) => id }));

vi.mock('../lib/pos/offline/reversalLocalStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/reversalLocalStore')>();
  return { ...actual, createIndexedDbReversalStore: () => store };
});

vi.mock('../lib/pos/offline/voidIntentStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/voidIntentStore')>();
  return {
    ...actual,
    listVoidIntents: async () => [] as VoidIntentRecord[],
    subscribeVoidIntentStore: () => () => {},
  };
});

vi.mock('../lib/auth/useApproverRoster', () => ({
  useApproverRoster: () => rosterState,
}));

vi.mock('../lib/pos/offline/projectPrivilegedOfflineAction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/pos/offline/projectPrivilegedOfflineAction')>();
  return { ...actual, projectPrivilegedOfflineAction: (input: unknown) => projectMock(input) };
});

import SalesHistoryPage from './SalesHistoryPage';

function record(id: string, orderBranchId: string, pendingSync = false): SaleRecord {
  const createdAt = new Date();
  return {
    order: {
      id,
      billId: id,
      branchId: orderBranchId,
      customerId: null,
      customerSnap: null,
      staffId: 's',
      staffName: 'Dao',
      status: 'completed',
      subtotal: 100,
      discountAmt: 0,
      billDiscount: 0,
      vatRate: 0,
      vatAmt: 0,
      surcharge: 0,
      total: 100,
      paidAmt: 100,
      changeAmt: 0,
      creditAmt: 0,
      priceLevelId: 'RETAIL',
      note: '',
      voidReason: null,
      voidedBy: null,
      voidedAt: null,
      printCount: 0,
      createdAt: createdAt as never,
      updatedAt: createdAt as never,
    },
    payments: [
      { id: 'p1', orderId: id, branchId: orderBranchId, method: 'cash', amount: 100, ref: null, createdAt: createdAt as never },
    ],
    items: [],
    pendingSync,
    verdict: pendingSync ? 'PROVISIONAL' : 'CURRENT',
    verdictReason: null,
  };
}

function evidenceRow(over: Partial<PrivilegedEvidenceJournalRecordV1>): PrivilegedEvidenceJournalRecordV1 {
  return {
    schemaVersion: 1,
    adjudicationId: 'a'.repeat(32),
    localIntentId: 'intent-x',
    paa1Base64: 'PAA1',
    ssa1Base64: 'SSA1',
    oacEnvelopeBytesBase64: 'OAC1',
    evidenceBindingDigest: 'DIGEST1',
    actionId: 'VOID_SETTLED_SALE',
    targetOrderId: 'BILL-X',
    targetOrderUtc7Date: '2026-09-07',
    branchId: 'LDP-001',
    approvingManagerStaffId: 'mgr-1',
    oacId: 'oac-1',
    oacSchemaVersion: 1,
    revocationEpochAtIssue: 0,
    managerAuthVersionAtIssue: 0,
    managerCredentialVersionAtIssue: 0,
    nonce: 'nonce-1',
    approvalProofDigest: 'proof-1',
    attestationAttemptCount: 1,
    approvalResult: 'APPROVED_LOCAL',
    trustedApprovalLowerMs: 1_000,
    trustedApprovalUpperMs: 2_000,
    pendingExecutionExpiresAtMs: 100_000,
    syncStatus: 'PRIVILEGED_INTENT_QUEUED',
    manualReviewStatus: 'NOT_REQUIRED',
    localTerminalReason: null,
    submissionClaims: 0,
    unresolvedClaimCount: 0,
    retryableFailureCount: 0,
    relayDeferrals: 0,
    deferredCycleCount: 0,
    nextAttemptAtMs: 0,
    claimOwner: null,
    claimGeneration: null,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
    lastAttemptAtMs: null,
    lastDispositionKind: null,
    lastRelayCallerStaffId: null,
    lastCallerDependentStaffId: null,
    integrityConflict: false,
    ingestStaffId: 'staff-1',
    ingestDeviceId: 'device-1',
    resultingVoidIntentId: null,
    serverVerdict: null,
    serverReason: null,
    serverAdjudicationId: null,
    serverTargetOrderId: null,
    offlineExecutionId: null,
    outcomeKind: null,
    serverAdjudicatedAtMs: null,
    serverObservedAtMs: null,
    serverIdempotentReplay: null,
    ...over,
  };
}

beforeEach(() => {
  store = createInMemoryReversalStore();
  rosterState = {
    status: 'ready',
    fromCache: false,
    candidates: [{ userId: 'mgr-1', displayName: 'Manager One', username: 'm1', role: 'manager' }],
  };
  projectMock.mockReset();
});

afterEach(() => {
  cleanup();
  historyState.records = [];
});

async function openDrawer(billId: string): Promise<void> {
  fireEvent.click(screen.getByText(billId));
  await waitFor(() => expect(screen.getByText(/^ยกเลิกบิล/)).toBeTruthy());
}

describe('SalesHistoryPage — end-to-end privileged void (settled sale)', () => {
  test('reason -> manager -> PIN -> projected reaches a pending-adjudication result, never a completed-void message', async () => {
    projectMock.mockResolvedValue({
      kind: 'projected',
      record: evidenceRow({ targetOrderId: 'BILL-E2E', actionId: 'VOID_SETTLED_SALE' }),
    });
    historyState.records = [record('BILL-E2E', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-E2E')).toBeTruthy());
    await openDrawer('BILL-E2E');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ถัดไป'));

    await waitFor(() => expect(screen.getByText('Manager One')).toBeTruthy());
    fireEvent.click(screen.getByText('Manager One'));

    const pinModal = await screen.findByTestId('privileged-void-pin-modal');
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(within(pinModal).getByText(d));
    await act(async () => {
      fireEvent.click(within(pinModal).getByText('ยืนยัน'));
    });

    await waitFor(() => expect(screen.getByText('บันทึกคำขอยกเลิกแล้ว รอการตรวจสอบ')).toBeTruthy());
    expect(screen.queryByText(/ยกเลิกบิลสำเร็จ/)).toBeNull();
    expect(projectMock).toHaveBeenCalledTimes(1);
    const call = projectMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.actionId).toBe('VOID_SETTLED_SALE');
    expect(call.targetOrderId).toBe('BILL-E2E');
    expect(call.managerStaffId).toBe('mgr-1');
    expect(call.pin).toBe('123456');
  });

  test('RC-E1-003: the row becoming ineligible (e.g. voided) after the modal opens fails the final pre-D-3 gate with ZERO D-3 calls', async () => {
    const bill = record('BILL-STALE-ELIG', 'LDP-001');
    historyState.records = [bill];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-STALE-ELIG')).toBeTruthy());
    await openDrawer('BILL-STALE-ELIG');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ถัดไป'));

    await waitFor(() => expect(screen.getByText('Manager One')).toBeTruthy());
    // The row is voided/becomes ineligible WHILE the modal is open (e.g. a
    // real-time sync update landing mid-flow) — same order id/branch/action,
    // only the verdict changed.
    historyState.records = [{ ...bill, verdict: 'ERROR' as const }];
    fireEvent.click(screen.getByText('Manager One'));

    const pinModal = await screen.findByTestId('privileged-void-pin-modal');
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(within(pinModal).getByText(d));
    fireEvent.click(within(pinModal).getByText('ยืนยัน'));

    await waitFor(() => expect(screen.getByText('ข้อมูลไม่ตรงกับปัจจุบันแล้ว')).toBeTruthy());
    expect(projectMock).not.toHaveBeenCalled();
  });

  test('RC-E1-003: the same-day window expiring after the modal opens (with identity otherwise unchanged) fails the final pre-D-3 gate with ZERO D-3 calls', async () => {
    const bill = record('BILL-SAMEDAY-EXPIRE', 'LDP-001');
    historyState.records = [bill];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-SAMEDAY-EXPIRE')).toBeTruthy());
    await openDrawer('BILL-SAMEDAY-EXPIRE');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ถัดไป'));

    await waitFor(() => expect(screen.getByText('Manager One')).toBeTruthy());
    // The order rolls into "yesterday" relative to now WHILE the modal is
    // open — the same-day window expires before PIN submission, with the
    // order id/branch/action all still identical.
    const yesterday = new Date(bill.order.createdAt as unknown as Date);
    yesterday.setDate(yesterday.getDate() - 1);
    historyState.records = [
      { ...bill, order: { ...bill.order, createdAt: yesterday as never, updatedAt: yesterday as never } },
    ];
    fireEvent.click(screen.getByText('Manager One'));

    const pinModal = await screen.findByTestId('privileged-void-pin-modal');
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(within(pinModal).getByText(d));
    fireEvent.click(within(pinModal).getByText('ยืนยัน'));

    await waitFor(() => expect(screen.getByText('ข้อมูลไม่ตรงกับปัจจุบันแล้ว')).toBeTruthy());
    expect(projectMock).not.toHaveBeenCalled();
  });

  test('RC-E1-003: the row becoming ACTUALLY voided (order.status flips to voided) after the modal opens fails the final pre-D-3 gate with ZERO D-3 calls', async () => {
    const bill = record('BILL-ACTUAL-VOID-FLIP', 'LDP-001');
    historyState.records = [bill];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-ACTUAL-VOID-FLIP')).toBeTruthy());
    await openDrawer('BILL-ACTUAL-VOID-FLIP');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ถัดไป'));

    await waitFor(() => expect(screen.getByText('Manager One')).toBeTruthy());
    // Same order id/branch/action, still a CURRENT verdict — only the actual
    // order status itself flips to voided (the landed equivalent of
    // `saleDisplayStatus(order) === 'void'`), independent of the freshness
    // verdict machinery covered by the test above.
    historyState.records = [{ ...bill, order: { ...bill.order, status: 'voided' } }];
    fireEvent.click(screen.getByText('Manager One'));

    const pinModal = await screen.findByTestId('privileged-void-pin-modal');
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(within(pinModal).getByText(d));
    fireEvent.click(within(pinModal).getByText('ยืนยัน'));

    await waitFor(() => expect(screen.getByText('ข้อมูลไม่ตรงกับปัจจุบันแล้ว')).toBeTruthy());
    expect(projectMock).not.toHaveBeenCalled();
  });

  test('RC-E1-003: voidPendingSync flipping true after the modal opens fails the final pre-D-3 gate with ZERO D-3 calls', async () => {
    const bill = record('BILL-VOID-PENDING-SYNC-FLIP', 'LDP-001');
    historyState.records = [bill];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-VOID-PENDING-SYNC-FLIP')).toBeTruthy());
    await openDrawer('BILL-VOID-PENDING-SYNC-FLIP');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ถัดไป'));

    await waitFor(() => expect(screen.getByText('Manager One')).toBeTruthy());
    // Identity (order id/branch/action) unchanged — only `voidPendingSync`
    // flips true, meaning a void sync is already in flight for this exact
    // row and a second privileged authority attempt must never be minted.
    historyState.records = [{ ...bill, voidPendingSync: true }];
    fireEvent.click(screen.getByText('Manager One'));

    const pinModal = await screen.findByTestId('privileged-void-pin-modal');
    for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(within(pinModal).getByText(d));
    fireEvent.click(within(pinModal).getByText('ยืนยัน'));

    await waitFor(() => expect(screen.getByText('ข้อมูลไม่ตรงกับปัจจุบันแล้ว')).toBeTruthy());
    expect(projectMock).not.toHaveBeenCalled();
  });

  // RC-E1-003 — timezone-invariant: `SalesHistoryPage`'s shared same-day
  // predicate (`isSameUtc7BusinessDay`) compares UTC+7 calendar dates via
  // `utcPlus7Date`, never the process/device-local calendar day. All system
  // times below are explicit UTC instants (`vi.setSystemTime(new Date(...Z))`),
  // so this test's rollover boundary (`...T17:00:01.000Z` == UTC+7 00:00:01)
  // is exercised identically under any host `TZ` — verified to PASS both
  // under the host's default timezone and under an explicit `TZ=UTC` process
  // environment (pre-fix, `TZ=UTC` reproduced the defect: the old
  // process-local `Date.toDateString()` comparison misread the rolled-over
  // instant as still same-day and reached D-3).
  test('RC-E1-003: a real business-day midnight rollover (order/createdAt never mutated) fails the final pre-D-3 gate with ZERO D-3 calls', async () => {
    vi.useFakeTimers();
    try {
      // 23:50 on 2026-09-07 (UTC+7) — well inside the business day. The
      // order itself is otherwise fully eligible (settled, CURRENT verdict,
      // not void, not pending sync).
      vi.setSystemTime(new Date('2026-09-07T16:50:00.000Z'));
      const bill = record('BILL-MIDNIGHT-ROLLOVER', 'LDP-001');
      // Fixed at 10:00 on the SAME business day — this value is NEVER
      // mutated again; only the system clock moves.
      const fixedCreatedAt = new Date('2026-09-07T03:00:00.000Z');
      bill.order.createdAt = fixedCreatedAt as never;
      bill.order.updatedAt = fixedCreatedAt as never;
      historyState.records = [bill];

      render(createElement(SalesHistoryPage));
      fireEvent.click(screen.getByText('BILL-MIDNIGHT-ROLLOVER'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByText(/^ยกเลิกบิล/)).toBeTruthy();

      fireEvent.click(screen.getByText(/^ยกเลิกบิล/));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
      fireEvent.click(screen.getByText('ถัดไป'));
      expect(screen.getByText('Manager One')).toBeTruthy();

      // Advance the fake clock PAST the UTC+7 business-day midnight boundary
      // — 00:00:01 on 2026-09-08. The order's own `createdAt` is untouched.
      vi.setSystemTime(new Date('2026-09-07T17:00:01.000Z'));

      fireEvent.click(screen.getByText('Manager One'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const pinModal = screen.getByTestId('privileged-void-pin-modal');
      for (const d of ['1', '2', '3', '4', '5', '6']) fireEvent.click(within(pinModal).getByText(d));
      await act(async () => {
        fireEvent.click(within(pinModal).getByText('ยืนยัน'));
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('ข้อมูลไม่ตรงกับปัจจุบันแล้ว')).toBeTruthy();
      expect(projectMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('restart recovery: an existing active D-2 row for this order skips straight to a recovered/read-only state, offering no manager controls', async () => {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'a'.repeat(32), evidenceRow({ targetOrderId: 'BILL-ACTIVE', branchId: 'LDP-001' }));
    });
    historyState.records = [record('BILL-ACTIVE', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-ACTIVE')).toBeTruthy());
    await openDrawer('BILL-ACTIVE');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByText('มีคำขอยกเลิกที่ยังดำเนินการอยู่')).toBeTruthy());
    expect(screen.queryByLabelText(/เหตุผลการยกเลิก/)).toBeNull();
    expect(screen.queryByText('Manager One')).toBeNull();
    expect(projectMock).not.toHaveBeenCalled();
  });

  test('wrong-branch D-2 rows never block this order — a row belonging to a different branch is ignored', async () => {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put(
        'privilegedEvidence',
        'b'.repeat(32),
        evidenceRow({ targetOrderId: 'BILL-CROSS', branchId: 'LDP-002', adjudicationId: 'b'.repeat(32) }),
      );
    });
    historyState.records = [record('BILL-CROSS', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-CROSS')).toBeTruthy());
    await openDrawer('BILL-CROSS');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
  });

  test('roster fails closed on a cache-only empty result — the operator cannot proceed to PIN entry', async () => {
    rosterState = { status: 'ready', fromCache: true, candidates: [] };
    historyState.records = [record('BILL-ROSTER', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-ROSTER')).toBeTruthy());
    await openDrawer('BILL-ROSTER');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByLabelText(/เหตุผลการยกเลิก/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/เหตุผลการยกเลิก/), { target: { value: 'ลูกค้าเปลี่ยนใจ' } });
    fireEvent.click(screen.getByText('ถัดไป'));

    await waitFor(() => expect(screen.getByTestId('pvm-roster-fail-closed')).toBeTruthy());
    expect(screen.queryByTestId('privileged-void-pin-modal')).toBeNull();
  });

  test('an integrity fault (unreadable D-2 row) fails the branch closed with no manager approval offered', async () => {
    await store.transact(['privilegedEvidence'], 'readwrite', async (txn) => {
      await txn.put('privilegedEvidence', 'garbage', { not: 'valid' });
    });
    historyState.records = [record('BILL-FAULT', 'LDP-001')];

    render(createElement(SalesHistoryPage));
    await waitFor(() => expect(screen.getByText('BILL-FAULT')).toBeTruthy());
    await openDrawer('BILL-FAULT');
    fireEvent.click(screen.getByText(/^ยกเลิกบิล/));

    await waitFor(() => expect(screen.getByText('พบความไม่สอดคล้องของข้อมูล')).toBeTruthy());
    expect(screen.queryByLabelText(/เหตุผลการยกเลิก/)).toBeNull();
  });
});
