// @vitest-environment jsdom

import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { VoidIntentRecord } from '../lib/pos/offline/voidIntentStore';

let terminalRows: VoidIntentRecord[] = [];
let storeListener: (() => void) | null = null;

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'mgr-1', role: 'manager', name: 'Manager' },
  }),
}));

vi.mock('../lib/pos/offline/reversalLocalStore', () => ({
  createIndexedDbReversalStore: () => ({}),
}));

vi.mock('../lib/pos/offline/offlineReversalQueue', () => ({
  listQueue: async () => [],
  resolveManualReview: vi.fn(),
}));

vi.mock('../lib/pos/offline/reversalRejectionLog', () => ({
  listReversalRejections: async () => [],
}));

vi.mock('../lib/pos/offline/voidIntentStore', () => ({
  listTerminalVoidIntents: async () => terminalRows,
  subscribeVoidIntentStore: (fn: () => void) => {
    storeListener = fn;
    return () => {
      storeListener = null;
    };
  },
}));

import ManualReviewOpsPage from './ManualReviewOpsPage';

function terminalIntent(orderId: string): VoidIntentRecord {
  return {
    orderId,
    branchId: 'LDP-001',
    deviceId: 'dev-1',
    reason: 'ลูกค้าเปลี่ยนใจ',
    note: null,
    voidedBy: 'staff-1',
    status: 'terminal',
    attempts: 1,
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    nextEligibleAtMs: 0,
    claimOwner: null,
    claimExpiresAtMs: null,
    lastErrorClass: 'permission_denied',
    lastErrorAtMs: Date.now(),
    terminalReason: 'staff_identity_mismatch',
    confirmedAtMs: null,
    observedServerCreatedAtMs: null,
    schemaVersion: 1,
  };
}

afterEach(() => {
  cleanup();
  terminalRows = [];
  storeListener = null;
});

describe('ManualReviewOpsPage PK-3 same-tab terminal void freshness', () => {
  beforeEach(() => {
    terminalRows = [];
  });

  test('already-mounted Manager surface refreshes when a void becomes terminal', async () => {
    render(createElement(ManualReviewOpsPage));
    await waitFor(() => {
      expect(screen.getByText('ไม่มีคำขอยกเลิกบิลที่หยุดส่งบนอุปกรณ์นี้')).toBeTruthy();
    });
    expect(screen.queryByText('VOID-TERM-1')).toBeNull();
    expect(screen.queryByRole('button', { name: /ซิงก์|Sync Center|ส่งซ้ำ/ })).toBeNull();

    terminalRows = [terminalIntent('VOID-TERM-1')];
    await act(async () => {
      storeListener?.();
    });

    await waitFor(() => {
      expect(screen.getByText('VOID-TERM-1')).toBeTruthy();
      expect(screen.getByText('พนักงานผู้ขอไม่ตรงกับรอบปัจจุบัน')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /ซิงก์|Sync Center|ส่งซ้ำ/ })).toBeNull();
    expect(screen.getAllByText(/อ่านอย่างเดียว/).length).toBeGreaterThan(0);
  });

  test('unmount unsubscribes and ignores a later store notification', async () => {
    const view = render(createElement(ManualReviewOpsPage));
    await waitFor(() => {
      expect(screen.getByText('ไม่มีคำขอยกเลิกบิลที่หยุดส่งบนอุปกรณ์นี้')).toBeTruthy();
    });
    const leaked = storeListener;
    expect(leaked).toBeTypeOf('function');
    view.unmount();
    expect(storeListener).toBeNull();

    terminalRows = [terminalIntent('VOID-TERM-1')];
    await act(async () => {
      leaked?.();
    });
    expect(screen.queryByText('VOID-TERM-1')).toBeNull();
  });
});
