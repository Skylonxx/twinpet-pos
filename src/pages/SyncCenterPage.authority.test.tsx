// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyncCenterAggregate,
  resolveActiveSyncScope,
  type SyncCenterReadResult,
  type SyncCenterRow,
} from '../lib/pos/offline/syncCenterModel';
import type { UseSyncCenterStateResult } from '../hooks/pos/useSyncCenterState';

const auth = vi.hoisted(() => ({
  role: 'staff' as 'manager' | 'staff' | 'admin',
}));

const hook = vi.hoisted(() => ({
  current: null as UseSyncCenterStateResult | null,
}));

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { role: auth.role, name: 'Tester' },
    branchId: 'A',
  }),
}));

vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branch: { name: 'สาขาทดสอบ' }, branchId: 'A' }),
}));

vi.mock('../lib/firebase', () => ({
  isFirebaseConfigured: true,
}));

vi.mock('../lib/pos/deviceId', () => ({
  getDeviceId: () => 'X',
}));

vi.mock('../hooks/pos/useSyncCenterState', () => ({
  useSyncCenterState: () => {
    if (!hook.current) throw new Error('hook fixture missing');
    return hook.current;
  },
}));

import SyncCenterPage from './SyncCenterPage';

const NOW = 1_700_000_000_000;

function scopeA() {
  const r = resolveActiveSyncScope('A', 'X');
  if (!r.ok) throw new Error(r.reason);
  return r.scope;
}

function emptyRead(over: Partial<SyncCenterReadResult> = {}): SyncCenterReadResult {
  return {
    scope: scopeA(),
    reversal: { ok: true, rows: [] },
    voidIntent: { ok: true, rows: [] },
    shiftClose: { ok: true, rows: [] },
    shiftOpen: { ok: true, rows: [] },
    saleIntent: { ok: true, rows: [] },
    orchestrator: { lastCycle: null, webLocksAvailable: true, ch4AttemptExhaustedIds: [] },
    isOnline: true,
    ...over,
  };
}

function row(over: Partial<SyncCenterRow> & Pick<SyncCenterRow, 'channel' | 'id' | 'state'>): SyncCenterRow {
  return {
    scopeKind: 'branch_device',
    branchId: 'A',
    deviceId: 'X',
    createdAtMs: NOW,
    updatedAtMs: NOW,
    attempts: 1,
    nextEligibleAtMs: NOW + 9_000,
    reasonCode: over.reasonCode ?? over.state,
    reasonTh: over.reasonTh ?? 'รายละเอียด',
    lastErrorAtMs: null,
    isStale: false,
    attemptCeilingReached: false,
    shiftKind: null,
    actionable: [],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  hook.current = null;
  auth.role = 'staff';
});

function renderWith(
  role: 'staff' | 'manager' | 'admin',
  rows: SyncCenterRow[],
  extra?: Partial<UseSyncCenterStateResult>,
) {
  auth.role = role;
  const aggregate = buildSyncCenterAggregate(emptyRead(), NOW);
  aggregate.rows = rows;
  aggregate.unifiedPending = rows.filter((r) =>
    r.state === 'pending' || r.state === 'waiting_retry' || r.state === 'in_flight',
  ).length;
  aggregate.unifiedAttention = rows.filter((r) => r.state === 'attention').length;
  hook.current = {
    view: { status: 'scoped', aggregate },
    status: 'ready',
    refresh: vi.fn(),
    isBusy: false,
    isOnline: true,
    scope: scopeA(),
    actor: { role },
    retryItem: vi.fn(),
    resweep: vi.fn(async () => ({ accepted: true, reason: null, cycle: 'requested' as const })),
    ...extra,
  };
  return render(createElement(MemoryRouter, null, createElement(SyncCenterPage)));
}

describe('SyncCenterPage authority rendering', () => {
  it('N-B1 cashier still gets the global resweep control', () => {
    renderWith('staff', []);
    expect(screen.getByRole('button', { name: 'ตรวจสอบและส่งใหม่ทั้งหมด' })).toBeTruthy();
  });

  it('N-C3 / N-B2 cashier never sees an item retry button — static text instead', () => {
    renderWith('staff', [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'waiting_retry',
        actionable: [],
      }),
    ]);
    expect(screen.queryByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' })).toBeNull();
    expect(screen.getAllByText('ต้องให้ผู้จัดการดำเนินการ').length).toBeGreaterThan(0);
  });

  it('N-B3 / N-R3-11 manager sees item retry on eligible non-terminal void and reversal', () => {
    renderWith('manager', [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'waiting_retry',
        actionable: ['item_retry_now'],
      }),
      row({
        channel: 'offline_reversal',
        id: 'r1',
        state: 'pending',
        reasonCode: 'queued',
        deviceId: null,
        scopeKind: 'branch',
        actionable: ['item_retry_now'],
      }),
    ]);
    expect(screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' }).length).toBeGreaterThanOrEqual(2);
  });

  it('N-R3-12 terminal void is static text for staff, manager, and admin — not a disabled button', () => {
    for (const role of ['staff', 'manager', 'admin'] as const) {
      cleanup();
      renderWith(role, [
        row({
          channel: 'void_intent',
          id: 'term',
          state: 'attention',
          reasonCode: 'terminal',
          reasonTh: 'เซิร์ฟเวอร์ปฏิเสธ',
          actionable: [],
        }),
      ]);
      expect(screen.queryByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' })).toBeNull();
      expect(screen.getAllByText('หยุดส่งแล้ว — ต้องให้เจ้าหน้าที่ตรวจสอบ').length).toBeGreaterThan(0);
    }
  });

  it('N-B4 admin-only server reconciliation link', () => {
    renderWith('manager', []);
    expect(screen.queryByRole('link', { name: /รายการค้างฝั่งเซิร์ฟเวอร์/ })).toBeNull();
    cleanup();
    renderWith('admin', []);
    expect(screen.getByRole('link', { name: /รายการค้างฝั่งเซิร์ฟเวอร์/ }).getAttribute('href')).toBe(
      '/admin/reconciliation-exceptions',
    );
  });

  it('exhausted reversal is read-only for every role', () => {
    renderWith('admin', [
      row({
        channel: 'offline_reversal',
        id: 'ex',
        state: 'attention',
        attemptCeilingReached: true,
        reasonCode: 'attempt_ceiling_reached',
        actionable: [],
      }),
    ]);
    expect(screen.queryByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' })).toBeNull();
    expect(screen.getAllByText('ระบบจะไม่ลองส่งรายการนี้อีก').length).toBeGreaterThan(0);
  });
});
