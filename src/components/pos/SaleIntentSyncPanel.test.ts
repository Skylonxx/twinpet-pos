// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createElement } from 'react';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { SaleIntentEntry, SaleIntentJournalStatus } from '../../lib/pos/offline/saleIntentJournalTypes';

const NOW_MS = new Date('2026-07-08T12:00:00.000Z').getTime();

function makeEntry(overrides: Partial<SaleIntentEntry> = {}): SaleIntentEntry {
  return {
    asyncOrderId: 'dev-1-1',
    localQueueId: 'dev-1-1',
    idempotencyKey: 'dev-1-1',
    billId: 'B-0001',
    branchId: 'branch-1',
    deviceId: 'dev-1',
    shiftId: 'shift-1',
    staffId: 'staff-1',
    createdAtLocal: NOW_MS,
    createdAtIso: new Date(NOW_MS).toISOString(),
    status: 'queued',
    payloadVersion: 1,
    salePayload: null,
    payloadStrippedAt: null,
    totalAmount: 250,
    retryCount: 0,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    rejectedAt: null,
    serverAcknowledgedAt: null,
    settledObservedAt: null,
    manualReviewReason: null,
    conflictState: null,
    supersededBy: null,
    nextEventSeq: 1,
    updatedAtLocal: new Date(NOW_MS).toISOString(),
    ...overrides,
  };
}

// Mutation spies: if the panel ever calls one of these, that's a boundary
// violation (Packet 6 requires closing/acknowledging the UI to never mutate
// the journal). Kept unimplemented on purpose so a call throws loudly.
const mutationSpies = {
  transitionStatus: vi.fn(() => {
    throw new Error('journal mutation must never be called from this read-only panel');
  }),
  markManualReview: vi.fn(() => {
    throw new Error('journal mutation must never be called from this read-only panel');
  }),
  pruneSaleIntents: vi.fn(() => {
    throw new Error('journal mutation must never be called from this read-only panel');
  }),
};

let fixtureEntries: SaleIntentEntry[] = [];

vi.mock('../../lib/pos/offline/saleIntentJournal', () => ({
  createSaleIntentJournal: () => ({
    listSaleIntentsByStatus: async (_statuses: SaleIntentJournalStatus[]) => ({
      ok: true,
      value: fixtureEntries,
    }),
    ...mutationSpies,
  }),
}));

vi.mock('../../lib/pos/deviceId', () => ({
  getDeviceId: () => 'dev-1',
}));

// Imported AFTER the mocks above so the component picks them up.
let SaleIntentSyncPanel: typeof import('./SaleIntentSyncPanel').default;

beforeAll(async () => {
  SaleIntentSyncPanel = (await import('./SaleIntentSyncPanel')).default;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('SaleIntentSyncPanel (Packet 6 UX · compact icon + badge + popover)', () => {
  afterEach(() => {
    cleanup();
    fixtureEntries = [];
    vi.clearAllMocks();
  });

  test('renders no trigger when the journal has nothing pending or needing attention', async () => {
    fixtureEntries = [];
    render(createElement(SaleIntentSyncPanel));
    await flush();
    expect(screen.queryByTestId('p6ss-trigger')).toBeNull();
    expect(screen.queryByTestId('p6ss-popover')).toBeNull();
  });

  test('shows a compact badge with the device-scoped pending count (not a wide text chip)', async () => {
    fixtureEntries = [
      makeEntry({ asyncOrderId: 'a', status: 'queued' }),
      makeEntry({ asyncOrderId: 'b', status: 'flushed_to_cache' }),
      makeEntry({ asyncOrderId: 'c', status: 'server_acknowledged' }),
      makeEntry({ asyncOrderId: 'd', status: 'queued', deviceId: 'dev-9' }), // other device
    ];
    render(createElement(SaleIntentSyncPanel));
    await flush();
    // Compact badge shows the count; the detail is behind the popover (not inline).
    expect(screen.getByTestId('p6ss-badge').textContent).toBe('3');
    expect(screen.queryByTestId('p6ss-popover')).toBeNull();
  });

  test('opens a popover on tap that shows the device-scoped pending detail', async () => {
    fixtureEntries = [makeEntry({ asyncOrderId: 'a', status: 'queued' })];
    render(createElement(SaleIntentSyncPanel));
    await flush();

    fireEvent.click(screen.getByTestId('p6ss-trigger'));
    const line = screen.getByTestId('p6ss-pending-line');
    expect(line.textContent).toContain('1');
    expect(line.textContent).toContain('บิลในเครื่องนี้รอซิงก์');
  });

  test('escalates copy for old pending entries without blocking anything', async () => {
    fixtureEntries = [
      makeEntry({ asyncOrderId: 'old', status: 'queued', createdAtLocal: NOW_MS - 20 * 60 * 1000 }),
    ];
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    render(createElement(SaleIntentSyncPanel));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByTestId('p6ss-trigger'));
    expect(screen.getByTestId('p6ss-pending-line').textContent).toContain('ค้างนานผิดปกติ');
    vi.useRealTimers();
  });

  test('shows an attention badge and a read-only popover list with billId/time/amount/reason', async () => {
    fixtureEntries = [
      makeEntry({
        asyncOrderId: 'rej-1',
        status: 'rejected_by_rules',
        billId: 'B-7777',
        totalAmount: 500,
        lastErrorMessage: 'permission-denied',
      }),
    ];
    render(createElement(SaleIntentSyncPanel));
    await flush();

    const trigger = screen.getByTestId('p6ss-trigger');
    expect(screen.getByTestId('p6ss-badge').textContent).toBe('1');
    // List is hidden until the popover is opened.
    expect(screen.queryByTestId('p6ss-attention-list')).toBeNull();

    fireEvent.click(trigger);
    const list = screen.getByTestId('p6ss-attention-list');
    expect(list.textContent).toContain('B-7777');
    expect(list.textContent).toContain('permission-denied');
    expect(list.textContent).toContain('500');
  });

  test('closing the popover via the close button does not mutate the journal', async () => {
    fixtureEntries = [makeEntry({ asyncOrderId: 'rev-1', status: 'manual_review', manualReviewReason: 'ตรวจสอบยอด' })];
    render(createElement(SaleIntentSyncPanel));
    await flush();

    fireEvent.click(screen.getByTestId('p6ss-trigger'));
    expect(screen.getByTestId('p6ss-popover')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('ปิด'));
    expect(screen.queryByTestId('p6ss-popover')).toBeNull();

    // The badge count is unchanged — nothing was resolved/deleted.
    expect(screen.getByTestId('p6ss-badge').textContent).toBe('1');
    expect(mutationSpies.transitionStatus).not.toHaveBeenCalled();
    expect(mutationSpies.markManualReview).not.toHaveBeenCalled();
    expect(mutationSpies.pruneSaleIntents).not.toHaveBeenCalled();
  });

  test('tapping outside the panel closes the popover (click-away) without mutating the journal', async () => {
    fixtureEntries = [makeEntry({ asyncOrderId: 'rev-1', status: 'manual_review', manualReviewReason: 'ตรวจสอบยอด' })];
    render(createElement(SaleIntentSyncPanel));
    await flush();

    fireEvent.click(screen.getByTestId('p6ss-trigger'));
    expect(screen.getByTestId('p6ss-popover')).toBeTruthy();

    // A pointer down anywhere outside the panel dismisses it.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('p6ss-popover')).toBeNull();

    // Badge unchanged; no journal mutation on click-away close.
    expect(screen.getByTestId('p6ss-badge').textContent).toBe('1');
    expect(mutationSpies.transitionStatus).not.toHaveBeenCalled();
    expect(mutationSpies.markManualReview).not.toHaveBeenCalled();
    expect(mutationSpies.pruneSaleIntents).not.toHaveBeenCalled();
  });

  test('Escape closes the popover (local state only)', async () => {
    fixtureEntries = [makeEntry({ asyncOrderId: 'a', status: 'queued' })];
    render(createElement(SaleIntentSyncPanel));
    await flush();

    fireEvent.click(screen.getByTestId('p6ss-trigger'));
    expect(screen.getByTestId('p6ss-popover')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('p6ss-popover')).toBeNull();
  });

  test('reports its device-local pending/attention snapshot via onStatusChange', async () => {
    fixtureEntries = [
      makeEntry({ asyncOrderId: 'a', status: 'queued' }),
      makeEntry({ asyncOrderId: 'b', status: 'flushed_to_cache' }),
      makeEntry({ asyncOrderId: 'rej', status: 'rejected_by_rules', lastErrorMessage: 'permission-denied' }),
    ];
    const onStatusChange = vi.fn();
    render(createElement(SaleIntentSyncPanel, { onStatusChange }));
    await flush();

    expect(onStatusChange).toHaveBeenCalled();
    const last = onStatusChange.mock.calls.at(-1)![0];
    expect(last.pendingCount).toBe(2);
    expect(last.attentionCount).toBe(1);
  });
});
