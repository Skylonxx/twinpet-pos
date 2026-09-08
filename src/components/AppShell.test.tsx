// @vitest-environment jsdom

/**
 * SEC-001 Packet E / GD-E-005 — proves the relocated canonical-sync-context
 * mount actually behaves correctly from inside `AppShell`: the context
 * becomes available while mounted (reading the CURRENT `useAuth().branchId`)
 * and is cleared on unmount, so a retained action closure fails closed. The
 * STATIC "exactly one production call site" gate lives separately in
 * `syncCenterClosedGateConfinement.test.ts` (T-LIFE-5) — this file is the
 * behavioral counterpart.
 */
import { createElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetCanonicalSyncContextForTests,
  getCanonicalSyncContext,
} from '../lib/pos/offline/canonicalSyncContext';

let authBranchId: string | null = 'LDP-001';

vi.mock('../lib/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { firstName: 'Dao', lastName: 'K', role: 'staff' },
    branchId: authBranchId,
    logout: vi.fn(),
  }),
}));

vi.mock('../lib/hooks/useBranch', () => ({
  useBranch: () => ({ branch: { name: 'Test Branch' } }),
}));

vi.mock('../lib/branches', () => ({
  getBranchLabel: (id: string) => id,
}));

vi.mock('../config/navigation', () => ({
  ALL_NAV_ITEMS: [],
  NAV_CATEGORIES: [],
  isNavItemActive: () => false,
}));

vi.mock('../lib/pos/offline/deviceSeqReconcileBoot', () => ({
  useDeviceSeqReconcileBoot: () => {},
}));

vi.mock('../lib/pos/offline/saleIntentSweepBoot', () => ({
  useSaleIntentSweepBoot: () => {},
}));

vi.mock('../lib/platform/adapters/browser/browserConnectivityPort', () => ({
  createBrowserSyncOrchestratorDeps: () => ({}),
}));

vi.mock('../lib/pos/offline/syncOrchestrator', () => ({
  useSyncOrchestrator: () => {},
}));

vi.mock('./SyncStatusBar', () => ({
  default: () => null,
}));

vi.mock('./ui', () => {
  const passthrough = (props: { children?: React.ReactNode }) => createElement('div', null, props.children);
  return {
    Sidebar: passthrough,
    SidebarItems: passthrough,
    SidebarItemGroup: passthrough,
    SidebarItem: passthrough,
    SidebarCollapse: passthrough,
  };
});

import AppShell from './AppShell';

afterEach(() => {
  cleanup();
  __resetCanonicalSyncContextForTests();
  authBranchId = 'LDP-001';
});

function renderAppShell() {
  return render(createElement(MemoryRouter, null, createElement(AppShell)));
}

describe('AppShell — GD-E-005 canonical sync-context relocation', () => {
  it('mounts the canonical sync context, reflecting the CURRENT useAuth().branchId', () => {
    expect(getCanonicalSyncContext()).toBeNull();
    renderAppShell();
    const ctx = getCanonicalSyncContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.branchId).toBe('LDP-001');
  });

  it('clears the canonical sync context on unmount, so a retained action closure fails closed', () => {
    const { unmount } = renderAppShell();
    expect(getCanonicalSyncContext()).not.toBeNull();
    unmount();
    expect(getCanonicalSyncContext()).toBeNull();
  });

  it('never mounts the context for the "ALL" pseudo-branch (fails closed, not a permissive default)', () => {
    authBranchId = 'ALL';
    renderAppShell();
    expect(getCanonicalSyncContext()).toBeNull();
  });
});
