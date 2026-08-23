// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSyncCenterAggregate,
  resolveActiveSyncScope,
  type SyncCenterReadResult,
  type SyncCenterView,
} from '../lib/pos/offline/syncCenterModel';
import type { UseSyncCenterStateResult } from '../hooks/pos/useSyncCenterState';
import barSource from './SyncStatusBar.tsx?raw';

const hook = vi.hoisted(() => ({
  current: null as UseSyncCenterStateResult | null,
}));

vi.mock('../hooks/pos/useSyncCenterState', () => ({
  useSyncCenterState: () => {
    if (!hook.current) throw new Error('hook fixture missing');
    return hook.current;
  },
}));

import SyncStatusBar from './SyncStatusBar';

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

function fixture(over: Partial<UseSyncCenterStateResult> = {}, view?: SyncCenterView): UseSyncCenterStateResult {
  return {
    view: view ?? { status: 'scoped', aggregate: buildSyncCenterAggregate(emptyRead(), NOW) },
    status: 'ready',
    refresh: vi.fn(),
    isBusy: false,
    isOnline: true,
    scope: scopeA(),
    actor: { role: 'staff' },
    retryItem: vi.fn(),
    resweep: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  hook.current = null;
});

describe('SyncStatusBar', () => {
  it('is a read-only link to /sync-center with live status', () => {
    hook.current = fixture();
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    const link = screen.getByRole('link', { name: /ศูนย์ซิงก์/ });
    expect(link.getAttribute('href')).toBe('/sync-center');
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('N-S2 pending count is present in the accessible name', () => {
    const agg = buildSyncCenterAggregate(
      emptyRead({
        reversal: {
          ok: true,
          rows: [
            {
              id: 'r1',
              businessId: 'biz',
              sourceType: 'receiving',
              sourceId: 'src',
              action: 'void',
              branchId: 'A',
              reasonCode: 'x',
              createdAt: new Date(NOW).toISOString(),
              createdByStaffId: 's1',
              createdByRole: 'manager',
              idempotencyKey: 'k',
              localMutationId: 'm',
              localCorrection: { applied: true, reversed: false, stockDelta: [] },
              status: 'queued',
            },
          ],
        },
      }),
      NOW,
    );
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.getByRole('link', { name: /รอส่ง 1/ })).toBeTruthy();
  });

  it('N-S3 syncing appears in the accessible name only when this tab is busy', () => {
    hook.current = fixture({ isBusy: true });
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.getByRole('link', { name: /กำลังส่ง/ })).toBeTruthy();
    cleanup();
    hook.current = fixture({ isBusy: false });
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.queryByRole('link', { name: /กำลังส่ง/ })).toBeNull();
  });

  it('N-S4 attention includes icon, text, and count', () => {
    const agg = buildSyncCenterAggregate(
      emptyRead({
        voidIntent: {
          ok: true,
          rows: [
            {
              orderId: 't1',
              branchId: 'A',
              deviceId: 'X',
              reason: 'x',
              note: null,
              voidedBy: 's',
              status: 'terminal',
              attempts: 1,
              createdAtMs: NOW,
              updatedAtMs: NOW,
              nextEligibleAtMs: 0,
              claimOwner: null,
              claimExpiresAtMs: null,
              lastErrorClass: null,
              lastErrorAtMs: null,
              terminalReason: 'authority_refused',
              confirmedAtMs: null,
              observedServerCreatedAtMs: null,
              schemaVersion: 1,
            },
          ],
        },
      }),
      NOW,
    );
    hook.current = fixture({}, { status: 'scoped', aggregate: agg });
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.getAllByLabelText(/ต้องตรวจสอบ 1/).length).toBeGreaterThan(0);
    expect(document.querySelector('.ti-alert-triangle')).toBeTruthy();
  });

  it('N-S5 offline is alongside pending, not instead of it', () => {
    hook.current = fixture({ isOnline: false });
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.getByRole('link', { name: /ออฟไลน์/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /รอส่ง 0/ })).toBeTruthy();
  });

  it('N-S6 lastSyncCheckAtMs null never claims clean completion', () => {
    hook.current = fixture();
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.getByRole('link', { name: /ยังไม่ได้ตรวจสอบ/ })).toBeTruthy();
    expect(screen.queryByText('ไม่มีรายการค้าง')).toBeNull();
  });

  it('scope_unavailable shows honest copy and no pending=0', () => {
    hook.current = fixture(
      { scope: null },
      { status: 'scope_unavailable', reason: 'branch_all' },
    );
    render(createElement(MemoryRouter, null, createElement(SyncStatusBar)));
    expect(screen.getByText(/โหมดทุกสาขา/)).toBeTruthy();
    expect(screen.queryByText(/รอส่ง 0/)).toBeNull();
  });

  it('source has no mutation controls and does not mount canonical context', () => {
    expect(barSource).not.toMatch(/item_retry_now/);
    expect(barSource).not.toMatch(/useMountCanonicalSyncContext/);
    expect(barSource).not.toMatch(/<Button/);
    expect(barSource).not.toContain('ซิงก์แล้ว');
  });
});
