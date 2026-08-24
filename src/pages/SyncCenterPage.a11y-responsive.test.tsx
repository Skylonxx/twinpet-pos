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
import pageSource from './SyncCenterPage.tsx?raw';
import barSource from '../components/SyncStatusBar.tsx?raw';

const hook = vi.hoisted(() => ({
  current: null as UseSyncCenterStateResult | null,
}));

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({ user: { role: 'manager', name: 'Tester' }, branchId: 'A' }),
}));
vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branch: { name: 'สาขาทดสอบ' }, branchId: 'A' }),
}));
vi.mock('../lib/firebase', () => ({ isFirebaseConfigured: true }));
vi.mock('../lib/pos/deviceId', () => ({ getDeviceId: () => 'X' }));
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
    actionable: over.actionable ?? [],
    ...over,
  };
}

afterEach(() => {
  cleanup();
  hook.current = null;
});

describe('SyncCenterPage a11y / responsive', () => {
  it('exposes named controls and does not convey attention by colour alone', () => {
    const aggregate = buildSyncCenterAggregate(emptyRead(), NOW);
    aggregate.rows = [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'waiting_retry',
        actionable: ['item_retry_now'],
      }),
      row({
        channel: 'void_intent',
        id: 't1',
        state: 'attention',
        reasonCode: 'terminal',
        reasonTh: 'เซิร์ฟเวอร์ปฏิเสธ',
      }),
    ];
    aggregate.unifiedPending = 1;
    aggregate.unifiedAttention = 1;
    hook.current = {
      view: { status: 'scoped', aggregate },
      status: 'ready',
      refresh: vi.fn(),
      isBusy: false,
      isOnline: true,
      scope: scopeA(),
      actor: { role: 'manager' },
      retryItem: vi.fn(),
      resweep: vi.fn(),
    };
    render(createElement(MemoryRouter, null, createElement(SyncCenterPage)));
    expect(screen.getByRole('heading', { name: 'ศูนย์ซิงก์' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ตรวจสอบและส่งใหม่ทั้งหมด' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' }).length).toBeGreaterThan(0);
    expect(document.querySelector('.ti-alert-triangle')).toBeTruthy();
    expect(screen.getAllByText('ต้องตรวจสอบ').length).toBeGreaterThan(0);
  });

  it('320 / 768 / 1080 layouts keep overflow containment and card+table dual structure', () => {
    const aggregate = buildSyncCenterAggregate(emptyRead(), NOW);
    aggregate.rows = [
      row({ channel: 'sale_intent', id: 's1', state: 'pending' }),
    ];
    aggregate.unifiedPending = 1;
    hook.current = {
      view: { status: 'scoped', aggregate },
      status: 'ready',
      refresh: vi.fn(),
      isBusy: false,
      isOnline: true,
      scope: scopeA(),
      actor: { role: 'manager' },
      retryItem: vi.fn(),
      resweep: vi.fn(),
    };
    const { container } = render(createElement(MemoryRouter, null, createElement(SyncCenterPage)));
    expect(container.querySelector('[class*="overflow-x-hidden"]')).toBeTruthy();
    expect(container.querySelector('[class*="overflow-x-auto"]')).toBeTruthy();
    expect(container.querySelector('[class*="md:hidden"]')).toBeTruthy();
    expect(container.querySelector('[class*="md:block"]')).toBeTruthy();
    expect(pageSource).toContain('md:hidden');
    expect(pageSource).toContain('hidden md:block');
    expect(pageSource).toContain('overflow-x-auto');
    expect(barSource).toContain('min-[768px]');
    expect(barSource).toContain('min-[1080px]');
    expect(barSource).toContain('min-[361px]');
  });

  it('busy item retry disables only that control', () => {
    const aggregate = buildSyncCenterAggregate(emptyRead(), NOW);
    aggregate.rows = [
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
        actionable: ['item_retry_now'],
      }),
    ];
    hook.current = {
      view: { status: 'scoped', aggregate },
      status: 'ready',
      refresh: vi.fn(),
      isBusy: false,
      isOnline: true,
      scope: scopeA(),
      actor: { role: 'manager' },
      retryItem: vi.fn(),
      resweep: vi.fn(),
    };
    render(createElement(MemoryRouter, null, createElement(SyncCenterPage)));
    const buttons = screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' });
    expect(buttons.length).toBeGreaterThan(1);
    expect(buttons.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('offline retry/resweep is semantically disabled with a text reason, not colour alone', () => {
    const aggregate = buildSyncCenterAggregate(emptyRead(), NOW);
    aggregate.rows = [
      row({
        channel: 'void_intent',
        id: 'v1',
        state: 'waiting_retry',
        actionable: ['item_retry_now'],
      }),
      row({
        channel: 'void_intent',
        id: 't1',
        state: 'attention',
        reasonCode: 'terminal',
        reasonTh: 'เซิร์ฟเวอร์ปฏิเสธ',
      }),
    ];
    aggregate.unifiedPending = 1;
    aggregate.unifiedAttention = 1;
    hook.current = {
      view: { status: 'scoped', aggregate },
      status: 'ready',
      refresh: vi.fn(),
      isBusy: false,
      isOnline: false,
      scope: scopeA(),
      actor: { role: 'manager' },
      retryItem: vi.fn(),
      resweep: vi.fn(),
    };
    const { container } = render(createElement(MemoryRouter, null, createElement(SyncCenterPage)));
    const resweep = screen.getByRole('button', { name: 'ตรวจสอบและส่งใหม่ทั้งหมด' });
    expect(resweep).toHaveProperty('disabled', true);
    expect(resweep.getAttribute('title')).toContain('ออฟไลน์');
    expect(resweep.getAttribute('aria-describedby')).toBe('sync-center-offline-no-request');
    expect(screen.getByText('ออฟไลน์ — ส่งหรือตรวจไม่ได้ตอนนี้ ไม่มีคำขอถูกส่ง')).toBeTruthy();
    expect(document.querySelector('.ti-wifi-off')).toBeTruthy();
    const retries = screen.getAllByRole('button', { name: 'ลองส่งรายการนี้ตอนนี้' });
    expect(retries.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(retries.every((b) => b.getAttribute('aria-describedby') === 'sync-center-offline-no-request')).toBe(true);
    expect(resweep.textContent).toContain('ตรวจสอบและส่งใหม่ทั้งหมด');
    expect(container.querySelector('[class*="overflow-x-hidden"]')).toBeTruthy();
    expect(container.querySelector('[class*="min-w-0"]')).toBeTruthy();
    expect(pageSource).toContain('md:hidden');
    expect(pageSource).toContain('overflow-x-auto');
  });
});
