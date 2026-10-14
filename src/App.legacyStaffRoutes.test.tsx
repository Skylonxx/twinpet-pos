// @vitest-environment jsdom
/**
 * D-ASC7 + D-ASC10 — legacy staff routes land on the Admin & Security Center
 * for BOTH concrete-branch and ALL-workspace sessions, through the REAL
 * route guards: ProtectedRoute, PosShellGate → PosShellRoute (branch /
 * workspace guard), AdminLayout and SettingsLayout are not stubbed.
 *
 * Stubbed only: the auth hook (session fixture), AppShell (its POS boot
 * hooks; rendered as a marked Outlet so the real PosShellRoute still decides
 * whether it mounts), page bodies, and the center's service seam (the REAL
 * AdminSecurityCenter renders, with test deps injected).
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  auth: {
    user: null as null | { id: string; role: string; branchIds: string[]; firstName: string; lastName: string },
    branchId: null as string | null,
    isAuthenticated: true,
    isLoading: false,
    logout: async () => undefined,
  },
  passwordSession: false,
  logoutCalls: 0,
}));

vi.mock('./lib/firebase', () => ({
  app: undefined,
  auth: undefined,
  db: undefined,
  collections: { settings: 'settings', branches: 'branches' },
  isFirebaseConfigured: true,
  USE_EMULATOR: false,
  getEmulatorHost: () => 'localhost',
}));
vi.mock('./lib/hooks/useAuth', () => ({ useAuth: () => h.auth }));
vi.mock('./lib/branches', () => ({
  fetchActiveBranches: async () => [],
  getBranchLabel: (id: string) => id,
}));

const { stub } = vi.hoisted(() => ({
  stub: (name: string) => ({ default: () => `PAGE:${name}` }),
}));

vi.mock('./components/GuestRoute', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});
vi.mock('./components/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    default: () => (
      <div data-testid="pos-shell">
        <Outlet />
      </div>
    ),
  };
});
vi.mock('./components/ui/toaster', () => ({ Toaster: () => null }));
vi.mock('./pages/CustomerPage', () => stub('CustomerPage'));
vi.mock('./pages/DashboardPage', () => stub('DashboardPage'));
vi.mock('./pages/ExportReportPage', () => stub('ExportReportPage'));
vi.mock('./pages/inventory/TransferPage', () => stub('TransferPage'));
vi.mock('./pages/inventory/InventoryAdjustmentPage', () => stub('InventoryAdjustmentPage'));
vi.mock('./pages/inventory/InventoryPage', () => stub('InventoryPage'));
vi.mock('./pages/LoginPage', () => stub('LoginPage'));
vi.mock('./pages/POSPage', () => stub('POSPage'));
vi.mock('./pages/ProductCRUDPage', () => stub('ProductCRUDPage'));
vi.mock('./pages/ProfitReportPage', () => stub('ProfitReportPage'));
vi.mock('./pages/ReceivingPage', () => stub('ReceivingPage'));
vi.mock('./pages/ReceivingHistoryPage', () => stub('ReceivingHistoryPage'));
vi.mock('./pages/ReceivingEditPage', () => stub('ReceivingEditPage'));
vi.mock('./pages/SalesHistoryPage', () => stub('SalesHistoryPage'));
vi.mock('./pages/ReceivablesPage', () => stub('ReceivablesPage'));
vi.mock('./pages/admin/AdminDashboardPage', () => stub('AdminDashboardPage'));
vi.mock('./pages/WorkspaceSelector', () => stub('WorkspaceSelector'));
vi.mock('./pages/admin/AdminProductManagementPage', () => stub('AdminProductManagementPage'));
vi.mock('./pages/admin/AdminReceivingPage', () => stub('AdminReceivingPage'));
vi.mock('./pages/admin/AdminTransferPage', () => stub('AdminTransferPage'));
vi.mock('./pages/admin/AdminTransferCreatePage', () => stub('AdminTransferCreatePage'));
vi.mock('./pages/admin/AdminStockReportPage', () => stub('AdminStockReportPage'));
vi.mock('./pages/admin/ReconciliationExceptionsPage', () => stub('ReconciliationExceptionsPage'));
vi.mock('./pages/admin/BranchManagementPage', () => stub('BranchManagementPage'));
vi.mock('./pages/admin/TierManagementPage', () => stub('TierManagementPage'));
vi.mock('./pages/admin/AdminSupplierManagementPage', () => stub('AdminSupplierManagementPage'));
vi.mock('./pages/admin/SortingSettingsPage', () => stub('SortingSettingsPage'));
vi.mock('./pages/admin/QuickMenuSettingsPage', () => stub('QuickMenuSettingsPage'));
vi.mock('./pages/settings/DocumentSettings', () => stub('DocumentSettings'));
vi.mock('./pages/ManualReviewOpsPage', () => stub('ManualReviewOpsPage'));
vi.mock('./pages/StockReportPage', () => stub('StockReportPage'));
vi.mock('./pages/SupplierPage', () => stub('SupplierPage'));
vi.mock('./pages/ShiftCloseReviewPage', () => stub('ShiftCloseReviewPage'));
vi.mock('./pages/ShiftCloseAlertDetailPage', () => stub('ShiftCloseAlertDetailPage'));
vi.mock('./pages/SyncCenterPage', () => stub('SyncCenterPage'));
// Legacy pages: if anything still routed to them, this marker would render.
vi.mock('./pages/StaffManagementPage', () => stub('StaffManagementPage'));
vi.mock('./pages/admin/AdminStaffManagementPage', () => stub('AdminStaffManagementPage'));

// The REAL AdminSecurityCenter, with only its service / native seams injected.
vi.mock('./pages/settings/AdminSecurityCenter', async () => {
  const actual = await vi.importActual<typeof import('./pages/settings/AdminSecurityCenter')>(
    './pages/settings/AdminSecurityCenter',
  );
  const Real = actual.default;
  function WithTestDeps(props: { operator: { id: string; role: string } | null | undefined; branchId: string | null }) {
    return (
      <Real
        {...props}
        deps={{
          service: {
            isAdminPasswordSession: async () => h.passwordSession,
            fetchOverview: async () => ({
              ok: true,
              users: [
                {
                  userId: 'admin1', firstName: 'Ad', lastName: 'Min', username: 'admin', role: 'admin', branchIds: ['ALL'],
                  isActive: true, authVersion: 2, quickPinState: 'set', securityAdminClassification: 'PASSWORD_ADMIN',
                },
                {
                  userId: 'mgr1', firstName: 'Na', lastName: 'Ra', username: 'nara', role: 'manager', branchIds: ['LDP-001'],
                  isActive: true, authVersion: 1, quickPinState: 'set',
                },
              ],
              events: [],
            }),
          },
          invoke: async (cmd: string, args?: Record<string, unknown>) => {
            if (cmd !== 'native_get_manager_oac_status') throw new Error(`unexpected native command ${cmd}`);
            return {
              ok: true, managerStaffId: args?.managerStaffId, capability: 'PRESENT', branchId: 'LDP-001', fresh: true,
              authVersionAtIssue: 1, lockedOut: false, consecutiveFailedAttempts: 0, maxFailedAttempts: 5,
            };
          },
          fetchBranches: async () => [],
        }}
      />
    );
  }
  return { ...actual, default: WithTestDeps };
});

vi.mock('./pages/SettingsPage', async () => {
  const { default: AdminSecurityCenter } = await import('./pages/settings/AdminSecurityCenter');
  const { navItemBySlug } = await vi.importActual<typeof import('./lib/settings/settingsNav')>('./lib/settings/settingsNav');
  function SettingsPageStub() {
    const location = useLocation();
    const slug = location.pathname.split('/').pop() ?? '';
    return (
      <div data-testid="settings-page">
        {navItemBySlug(slug)?.section === 'admin' ? (
          <AdminSecurityCenter operator={h.auth.user} branchId={h.auth.branchId} />
        ) : (
          `SETTINGS:${slug}`
        )}
      </div>
    );
  }
  return { default: SettingsPageStub };
});

import { AppRoutes } from './App';
import { ALL_NAV_ITEMS } from './config/navigation';
import { ADMIN_NAV } from './config/adminNavigation';
import { ADMIN_SECURITY_CENTER_PATH, navItemBySlug } from './lib/settings/settingsNav';
import { __resetAdminSecurityServiceForTests } from './lib/adminSecurity/adminSecurityService';

const LEGACY_CONTROL_TEXT = /สิทธิ์ตาม Role|PAGE:(Admin)?StaffManagementPage/;
const GLOBAL_ADMIN = { id: 'admin1', role: 'admin', branchIds: ['ALL'], firstName: 'Ad', lastName: 'Min' };

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId('location').textContent;

function session(kind: 'password' | 'quickpin', branchId: string) {
  h.passwordSession = kind === 'password';
  h.auth.user = GLOBAL_ADMIN;
  h.auth.branchId = branchId;
}

async function expectCenterLanding(kind: 'password' | 'quickpin') {
  await waitFor(() => expect(location()).toBe('/settings/admin-security'));
  if (kind === 'password') {
    expect(await screen.findByText('Admin password session')).toBeTruthy();
    expect(await screen.findByText('Security Admin')).toBeTruthy();
    expect(screen.getByTestId('admin-security-center')).toBeTruthy();
    expect(screen.queryByTestId('admin-password-required')).toBeNull();
  } else {
    expect(await screen.findByTestId('admin-password-required')).toBeTruthy();
    expect(screen.queryByText('เพิ่มผู้ใช้งาน')).toBeNull();
  }
  expect(screen.queryByText('PAGE:AdminDashboardPage')).toBeNull();
  expect(screen.queryByText(/PAGE:(Admin)?StaffManagementPage/)).toBeNull();
  expect(document.body.textContent ?? '').not.toMatch(LEGACY_CONTROL_TEXT);
}

beforeEach(() => {
  __resetAdminSecurityServiceForTests();
  h.passwordSession = false;
  h.auth.user = GLOBAL_ADMIN;
  h.auth.branchId = 'ALL';
  h.auth.isAuthenticated = true;
  h.logoutCalls = 0;
  h.auth.logout = async () => {
    h.logoutCalls += 1;
  };
});
afterEach(cleanup);

describe('D-ASC10 — ALL-workspace sessions, real branch guard', () => {
  for (const path of ['/staff', '/admin/staff']) {
    for (const kind of ['password', 'quickpin'] as const) {
      it(`ALL + ${kind} admin deep-linking ${path} → /settings/admin-security (${kind === 'password' ? 'center' : 'password-required'})`, async () => {
        session(kind, 'ALL');
        renderAt(path);
        await expectCenterLanding(kind);
        // Rendered in the Admin back-office shell, never the POS shell.
        expect(screen.getByTestId('admin-security-all-workspace')).toBeTruthy();
        expect(screen.queryByTestId('pos-shell')).toBeNull();
        expect(screen.queryByTestId('settings-page')).toBeNull();
      });
    }
  }

  it('direct /settings/admin-security under ALL is not redirected to /admin and passes no terminal branch', async () => {
    session('password', 'ALL');
    renderAt('/settings/admin-security');
    await expectCenterLanding('password');
    const mgrRow = (await screen.findByText('Na Ra')).closest('[data-testid="admin-user-row"]') as HTMLElement;
    expect(within(mgrRow).getByTestId('admin-oac-branch-required').textContent).toBe('เลือกสาขาจริงก่อนจัดการสิทธิ์อนุมัติบนเครื่องนี้');
    expect(within(mgrRow).queryByText('ออกสิทธิ์ Offline ใหม่')).toBeNull();
    // Back-office nav offers the center; the legacy staff pages stay absent.
    const nav = screen.getByRole('complementary', { name: 'เมนู Admin' });
    expect(within(nav).getByText('Admin & ความปลอดภัย').closest('a')?.getAttribute('href')).toBe('/settings/admin-security');
    expect(within(nav).queryByText('Staff')).toBeNull();
  });

  for (const path of ['/pos', '/dashboard', '/settings/general', '/settings/branch-info', '/sales-history']) {
    it(`unrelated POS route ${path} under ALL still follows the existing /admin redirect`, async () => {
      session('password', 'ALL');
      renderAt(path);
      expect(await screen.findByText('PAGE:AdminDashboardPage')).toBeTruthy();
      expect(location()).toBe('/admin');
      expect(screen.queryByTestId('pos-shell')).toBeNull();
      expect(screen.queryByTestId('admin-security-center')).toBeNull();
    });
  }

  it('/admin dashboard is unchanged under ALL', async () => {
    session('password', 'ALL');
    renderAt('/admin');
    expect(await screen.findByText('PAGE:AdminDashboardPage')).toBeTruthy();
    expect(location()).toBe('/admin');
  });

  it('a non-global user with branchId=ALL gets no exemption (PosShellRoute fails closed: logout, no center)', async () => {
    h.passwordSession = true;
    h.auth.user = { ...GLOBAL_ADMIN, branchIds: ['LDP-001'] };
    h.auth.branchId = 'ALL';
    renderAt('/settings/admin-security');
    await waitFor(() => expect(h.logoutCalls).toBe(1));
    expect(screen.queryByTestId('admin-security-center')).toBeNull();
    expect(screen.queryByTestId('pos-shell')).toBeNull();
  });
});

describe('D-ASC7 — concrete-branch sessions behave the same, inside the unchanged POS shell', () => {
  for (const path of ['/staff', '/admin/staff', '/settings/admin-security']) {
    for (const kind of ['password', 'quickpin'] as const) {
      it(`LDP-001 + ${kind} admin at ${path} → center in POS shell + Settings`, async () => {
        session(kind, 'LDP-001');
        renderAt(path);
        await expectCenterLanding(kind);
        expect(screen.getByTestId('pos-shell')).toBeTruthy();
        expect(screen.getByTestId('settings-page')).toBeTruthy();
        expect(screen.getByRole('complementary', { name: 'เมนูตั้งค่า' })).toBeTruthy();
        expect(screen.queryByTestId('admin-security-all-workspace')).toBeNull();
        if (kind === 'password') {
          const mgrRow = (await screen.findByText('Na Ra')).closest('[data-testid="admin-user-row"]') as HTMLElement;
          expect(await within(mgrRow).findByTestId('admin-oac-state')).toBeTruthy();
          expect(within(mgrRow).queryByTestId('admin-oac-branch-required')).toBeNull();
        }
      });
    }
  }

  it('unrelated routes are unaffected', async () => {
    session('password', 'LDP-001');
    renderAt('/dashboard');
    expect(await screen.findByText('PAGE:DashboardPage')).toBeTruthy();
    expect(screen.getByTestId('pos-shell')).toBeTruthy();
    cleanup();
    renderAt('/settings/general');
    expect(await screen.findByText('PAGE:DocumentSettings')).toBeTruthy();
    cleanup();
    renderAt('/admin/branches');
    expect(await screen.findByText('PAGE:BranchManagementPage')).toBeTruthy();
  });
});

describe('D-ASC7 — no entry point to the legacy pages', () => {
  it('the center path is the settings admin section', () => {
    expect(ADMIN_SECURITY_CENTER_PATH).toBe('/settings/admin-security');
    expect(navItemBySlug('admin-security')?.section).toBe('admin');
  });

  it('no navigation entry points at the legacy pages', () => {
    const mainPaths = ALL_NAV_ITEMS.map((i) => i.path);
    const adminPaths = ADMIN_NAV.map((i) => i.path as string);
    for (const legacy of ['/staff', '/admin/staff']) {
      expect(mainPaths).not.toContain(legacy);
      expect(adminPaths).not.toContain(legacy);
    }
  });

  it('the route tree no longer imports or renders the legacy mutation pages, and gates the POS tree with PosShellGate', () => {
    const src = readFileSync(resolve(__dirname, 'App.tsx'), 'utf8');
    expect(src).not.toMatch(/StaffManagementPage/);
    expect(src).toMatch(/path="\/staff" element={<Navigate to={ADMIN_SECURITY_CENTER_PATH} replace \/>}/);
    expect(src).toMatch(/path="staff" element={<Navigate to={ADMIN_SECURITY_CENTER_PATH} replace \/>}/);
    expect(src).toMatch(/<Route element={<PosShellGate \/>}>/);
    expect(src).not.toMatch(/<PosShellRoute \/>/);
  });

  it('the gate exempts exactly the center path (no /settings/* or POS wildcard)', () => {
    const gate = readFileSync(resolve(__dirname, 'components/PosShellGate.tsx'), 'utf8');
    expect(gate).toMatch(/pathname === ADMIN_SECURITY_CENTER_PATH/);
    expect(gate).not.toMatch(/startsWith|matchPath|useMatch/);
  });
});
